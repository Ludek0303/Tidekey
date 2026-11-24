//! Query parsing (phrases, exclusions, operators) and ranking. Filters look at the chunk's document.

use std::ops::Not;
use std::collections::BTreeMap;

use std::borrow::Cow;

use super::bm25::{Posting, bm25};
use super::graph::{self, Scope};
use super::text::{self as text, normalize, tokens};
use super::{Chunk, Hit, Kind, SearchIndex, SearchPage, approx_tokens};

/// Longer queries are cut to this many characters.
const MAX_QUERY_CHARS: usize = 1000;
/// A word with fewer matching chunks than this also gets the trigram fallback (OCR §4.3).
const FUZZY_BELOW: usize = 3;
/// Distinct terms a query is scored on, and how many of them may use the fuzzy fallback: each fuzzy term scans the
/// vocabulary, so a long query of nonsense words must not cost seconds (an agent writes the query).
const MAX_TERMS: usize = 16;
const MAX_FUZZY_TERMS: usize = 4;
/// Hits per page (OCR §5.1).
pub(super) const MAX_PAGE: usize = 50;
/// Shortest word that gets the trigram fallback.
const FUZZY_MIN_CHARS: usize = 4;

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Filter {
    pub kinds: Vec<Kind>,
    pub tags: Vec<String>,
    /// Note path prefixes; for files the file name prefix.
    pub paths: Vec<String>,
    pub names: Vec<String>,
    pub pdf: bool,
    pub image: bool,
}

impl Filter {
    pub fn is_empty(&self) -> bool {
        self.kinds.is_empty() && self.tags.is_empty() && self.paths.is_empty() && self.names.is_empty() && !self.pdf && !self.image
    }
}

#[derive(Debug, Default)]
pub(super) struct Query {
    /// Scoring tokens. The flag marks the last plain word, which also matches as a prefix.
    pub terms: Vec<(String, bool)>,
    /// `"fraza"`: tokens that must follow each other.
    pub phrases: Vec<Vec<String>>,
    /// `-słowo`: a chunk holding all tokens of a group is left out.
    pub excluded: Vec<Vec<String>>,
    pub filter: Filter,
}

enum Tok {
    /// Raw word, negated.
    Word(String, bool),
    /// Raw text of a quoted run, negated.
    Phrase(String, bool),
}

fn tokenize(query: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut neg = false;
    let mut in_quote = false;
    for c in query.chars() {
        if in_quote {
            if c == '"' {
                out.push(Tok::Phrase(std::mem::take(&mut cur), neg));
                neg = false;
                in_quote = false;
            } else {
                cur.push(c);
            }
            continue;
        }
        match c {
            '"' => {
                if !cur.is_empty() {
                    out.push(Tok::Word(std::mem::take(&mut cur), neg));
                    neg = false;
                }
                in_quote = true;
            }
            c if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(Tok::Word(std::mem::take(&mut cur), neg));
                }
                neg = false;
            }
            '-' if cur.is_empty() && !neg => neg = true,
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(if in_quote { Tok::Phrase(cur, neg) } else { Tok::Word(cur, neg) });
    }
    out
}

/// Applies `tag:`, `path:`, `file:`, `typ:` and `w:` when the value is known. Anything else is a plain word.
fn operator(raw: &str, f: &mut Filter) -> bool {
    let Some((op, val)) = raw.split_once(':') else { return false };
    let (op, val) = (normalize(op), normalize(val));
    match (op.as_str(), val.as_str()) {
        ("tag", v) if !v.is_empty() => f.tags.push(v.to_string()),
        ("path", v) if !v.is_empty() => f.paths.push(v.to_string()),
        ("file", "") => f.kinds.push(Kind::File),
        ("file", v) => {
            f.kinds.push(Kind::File);
            f.names.push(v.to_string());
        }
        ("typ", "pdf") => f.pdf = true,
        ("typ", "obraz") => f.image = true,
        ("w", "pliki") => f.kinds.push(Kind::File),
        ("w", "notatki") => f.kinds.push(Kind::Note),
        _ => return false,
    }
    true
}

pub(super) fn parse(query: &str, stem: bool) -> Query {
    let query: String = query.chars().take(MAX_QUERY_CHARS).collect();
    let mut q = Query::default();
    let mut plain: Vec<String> = Vec::new();
    for tok in tokenize(&query) {
        match tok {
            Tok::Phrase(raw, neg) => {
                let t = tokens(&raw, stem);
                if t.is_empty() {
                    continue;
                }
                if neg {
                    q.excluded.push(t);
                } else {
                    q.phrases.push(t);
                }
            }
            Tok::Word(raw, neg) => {
                if !neg && operator(&raw, &mut q.filter) {
                    continue;
                }
                let t = tokens(&raw, stem);
                if neg {
                    if !t.is_empty() {
                        q.excluded.push(t);
                    }
                } else {
                    plain.extend(t);
                }
            }
        }
    }
    let last = plain.len().checked_sub(1);
    for (i, t) in plain.into_iter().enumerate() {
        let prefix = Some(i) == last && t.chars().count() >= 2;
        q.terms.push((t, prefix));
    }
    let phrase_tokens: Vec<String> = q.phrases.iter().flatten().cloned().collect();
    q.terms.extend(phrase_tokens.into_iter().map(|t| (t, false)));
    // each distinct term once, at most MAX_TERMS (the same word with and without the prefix flag counts as two)
    let mut seen = std::collections::HashSet::new();
    q.terms.retain(|t| seen.contains(t).not() && seen.insert(t.clone()));
    q.terms.truncate(MAX_TERMS);
    q.phrases.truncate(MAX_TERMS);
    q.excluded.truncate(MAX_TERMS);
    q
}

impl SearchIndex {
    /// Chunks ranked by BM25, best first, ties by chunk id. `limit` 0 gives only the total.
    pub fn search(&self, query: &str, limit: usize, offset: usize, scope: Option<&Scope>) -> SearchPage {
        let q = parse(query, self.stem);
        if q.terms.is_empty() && q.filter.is_empty() {
            return SearchPage { hits: vec![], total: 0 };
        }
        let mut scores: BTreeMap<u32, f32> = BTreeMap::new();
        let stats = self.stats_in(scope);
        let limit = limit.min(MAX_PAGE);
        for (i, (term, prefix)) in q.terms.iter().enumerate() {
            for (cid, s) in self.term_scores(term, *prefix, i < MAX_FUZZY_TERMS, scope, stats) {
                *scores.entry(cid).or_insert(0.0) += s;
            }
        }
        // A filter-only query ranks every chunk equally.
        let candidates: Vec<(u32, f32)> = if q.terms.is_empty() {
            (0..self.chunks.len() as u32).filter(|c| self.chunk(*c).is_some()).map(|c| (c, 0.0)).collect()
        } else {
            scores.into_iter().collect()
        };
        let mut ranked: Vec<(u32, f32)> = candidates.into_iter().filter(|(c, _)| self.accepts(*c, &q, scope)).collect();
        ranked.sort_by(|a, b| {
            b.1.total_cmp(&a.1).then_with(|| {
                let ia = self.chunk(a.0).map(|c| &c.id);
                let ib = self.chunk(b.0).map(|c| &c.id);
                ia.cmp(&ib)
            })
        });
        let total = ranked.len();
        let hits = ranked
            .iter()
            .skip(offset)
            .take(limit)
            .filter_map(|(c, s)| self.hit(*c, *s, &q.terms))
            .collect();
        SearchPage { hits, total }
    }

    /// BM25 weight of a term in a chunk, times `weight`, keeping the best weight per chunk.
    /// Only chunks the scope shows count, so the document frequency (and, via `stats_in`, the chunk count and average
    /// length) are the visible ones: a score never tells how much text lies outside the scope (OCR §5.2).
    fn accumulate(&self, best: &mut BTreeMap<u32, f32>, term: u32, weight: f32, scope: Option<&Scope>, (n, avg): (f32, f32)) {
        let all = self.inv.postings(term);
        let postings: Cow<[Posting]> = if scope.is_none() {
            Cow::Borrowed(all)
        } else {
            Cow::Owned(all.iter().filter(|p| self.chunk_visible(p.chunk, scope)).copied().collect())
        };
        let df = postings.len();
        for p in postings.iter() {
            let dl = self.chunk(p.chunk).map_or(0, |c| c.tokens);
            let s = weight * bm25(df, p.tf, dl, n, avg);
            let e = best.entry(p.chunk).or_insert(0.0);
            if s > *e {
                *e = s;
            }
        }
    }

    /// Per chunk, the score of one query term: exact (and prefix) matches, plus trigram and edit-distance
    /// neighbours when the word matches fewer than `FUZZY_BELOW` chunks.
    fn term_scores(&self, term: &str, prefix: bool, fuzzy: bool, scope: Option<&Scope>, stats: (f32, f32)) -> BTreeMap<u32, f32> {
        let mut best: BTreeMap<u32, f32> = BTreeMap::new();
        if prefix {
            for t in self.inv.prefix_terms(term) {
                self.accumulate(&mut best, t, 1.0, scope, stats);
            }
        } else if let Some(t) = self.inv.term_id(term) {
            self.accumulate(&mut best, t, 1.0, scope, stats);
        }
        if fuzzy && best.len() < FUZZY_BELOW {
            if term.chars().count() >= FUZZY_MIN_CHARS {
                for (t, sim) in self.inv.similar_terms(term) {
                    self.accumulate(&mut best, t, sim, scope, stats);
                }
            }
            // A distance-1 match weighs 0.6 and a distance-2 match 0.4, so exact and close matches rank first.
            for (t, d) in self.inv.edit_terms(term) {
                self.accumulate(&mut best, t, if d == 1 { 0.6 } else { 0.4 }, scope, stats);
            }
        }
        best
    }

    /// Whether a chunk passes the filters, the phrases and the exclusions.
    fn accepts(&self, cid: u32, q: &Query, scope: Option<&Scope>) -> bool {
        let Some(ch) = self.chunk(cid) else { return false };
        graph::visible(scope, ch.kind, &ch.doc)
            && self.doc_accepts(ch, &q.filter)
            && (q.phrases.is_empty() || self.has_phrases(ch, &q.phrases))
            && q.excluded.iter().all(|g| {
                !g.iter().all(|t| self.inv.term_id(t).is_some_and(|id| self.inv.contains(id, cid)))
            })
    }

    /// Phrases are matched on the chunk's own tokens, so they see the same normalization as the index.
    fn chunk_visible(&self, cid: u32, scope: Option<&Scope>) -> bool {
        self.chunk(cid).is_some_and(|c| graph::visible(scope, c.kind, &c.doc))
    }

    fn has_phrases(&self, ch: &Chunk, phrases: &[Vec<String>]) -> bool {
        let toks = text::tokens(&ch.text, self.stem);
        phrases.iter().all(|p| !p.is_empty() && toks.windows(p.len()).any(|w| w == p.as_slice()))
    }

    fn doc_accepts(&self, ch: &Chunk, f: &Filter) -> bool {
        if !f.kinds.iter().all(|k| *k == ch.kind) {
            return false;
        }
        match ch.kind {
            Kind::Note => {
                let Some(d) = self.notes.get(&*ch.doc) else { return false };
                !f.pdf
                    && !f.image
                    && f.tags.iter().all(|t| d.tags.iter().any(|dt| dt == t || dt.strip_prefix(t.as_str()).is_some_and(|r| r.starts_with('/'))))
                    && f.paths.iter().all(|p| d.path_key.starts_with(p.as_str()))
            }
            Kind::File => {
                let Some(d) = self.files.get(&*ch.doc) else { return false };
                f.tags.is_empty()
                    && f.paths.iter().chain(&f.names).all(|p| d.name_key.starts_with(p.as_str()))
                    && (!f.pdf || d.mime == "application/pdf")
                    && (!f.image || d.mime.starts_with("image/"))
            }
        }
    }

    fn hit(&self, cid: u32, score: f32, terms: &[(String, bool)]) -> Option<Hit> {
        let ch = self.chunk(cid)?;
        let (title, doc_tokens) = match ch.kind {
            Kind::Note => {
                let d = self.notes.get(&*ch.doc)?;
                (d.path.clone(), d.tokens)
            }
            Kind::File => {
                let d = self.files.get(&*ch.doc)?;
                (d.name.clone(), d.tokens)
            }
        };
        Some(Hit {
            chunk_id: ch.id.to_string(),
            kind: ch.kind,
            doc_id: ch.doc.to_string(),
            title,
            place: ch.place.to_string(),
            snippet: snippet(&ch.text, terms, self.stem),
            score,
            tokens_approx: approx_tokens(ch.chars as usize),
            doc_tokens_approx: doc_tokens,
        })
    }
}

/// Up to about 200 characters around the word that matches best, cut at whitespace, with `…` where text was cut.
fn snippet(text: &str, terms: &[(String, bool)], stem: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut best = (0usize, 0usize);
    let mut i = 0;
    while i < n {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        while i < n && !chars[i].is_whitespace() {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        let toks = tokens(&word, stem);
        let hits = terms
            .iter()
            .filter(|(t, prefix)| toks.iter().any(|w| w == t || (*prefix && w.starts_with(t.as_str()))))
            .count();
        if hits > best.1 {
            best = (start, hits);
        }
    }
    let s0 = best.0.saturating_sub(70);
    let e0 = (s0 + 190).min(n);
    let mut s = if s0 == 0 { 0 } else { (s0..e0).find(|&k| chars[k].is_whitespace()).map_or(s0, |k| k + 1) };
    let mut e = if e0 == n { n } else { (s + 1..e0).rev().find(|&k| chars[k].is_whitespace()).unwrap_or(e0) };
    if e <= s {
        s = s0;
        e = e0;
    }
    let body = chars[s..e].iter().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    if s > 0 {
        out.push('…');
    }
    out.push_str(&body);
    if e < n {
        out.push('…');
    }
    out
}

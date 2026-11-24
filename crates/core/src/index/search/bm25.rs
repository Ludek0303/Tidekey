//! Inverted index over chunk numbers: interned terms, one flat posting list per term (sorted by chunk, since
//! chunks are only appended), BM25 weights and the term lookups that query ranking needs. Chunk lengths and texts
//! live in `SearchIndex`.

use std::collections::BTreeMap;
use std::ops::Bound;

use super::text::{trigram_similarity, trigrams};

const K1: f32 = 1.2;
const B: f32 = 0.75;

/// One chunk containing a term, with the term's count in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Posting {
    pub chunk: u32,
    pub tf: u32,
}

#[derive(Default)]
pub(super) struct Inverted {
    /// Term text -> term number, sorted for prefix lookup.
    ids: BTreeMap<Box<str>, u32>,
    /// Term number -> term text.
    names: Vec<Box<str>>,
    /// Term number -> chunks with the term. Empty after the last chunk with it is removed.
    post: Vec<Vec<Posting>>,
    /// Character length -> term numbers of that length, for the edit-distance fallback.
    by_len: BTreeMap<usize, Vec<u32>>,
}

/// Damerau-Levenshtein distance (optimal string alignment variant) if it is at most `max`, else None.
/// Stops as soon as a whole row is above `max`.
pub(super) fn edit_distance_within(a: &[char], b: &[char], max: usize) -> Option<usize> {
    let (n, m) = (a.len(), b.len());
    if n.abs_diff(m) > max {
        return None;
    }
    let mut prev2 = vec![0usize; m + 1];
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut cur = vec![0usize; m + 1];
    for i in 1..=n {
        cur[0] = i;
        let mut row_min = i;
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(prev2[j - 2] + 1);
            }
            cur[j] = v;
            row_min = row_min.min(v);
        }
        if row_min > max {
            return None;
        }
        std::mem::swap(&mut prev2, &mut prev);
        std::mem::swap(&mut prev, &mut cur);
    }
    let d = prev[m];
    (d <= max).then_some(d)
}

/// Edits allowed for a query word of `len` characters (OCR §4.3): none below 5, one up to 8, two from 9.
pub(super) fn max_edits(len: usize) -> usize {
    match len {
        0..=4 => 0,
        5..=8 => 1,
        _ => 2,
    }
}

/// BM25 weight of a term with `tf` occurrences in a chunk of `dl` tokens; `n` chunks, `avg` tokens per chunk.
pub(super) fn bm25(df: usize, tf: u32, dl: u32, n: f32, avg: f32) -> f32 {
    if n == 0.0 || tf == 0 {
        return 0.0;
    }
    let df = df as f32;
    let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
    let tf = tf as f32;
    idf * tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * dl as f32 / avg))
}

impl Inverted {
    pub fn term_id(&self, term: &str) -> Option<u32> {
        self.ids.get(term).copied()
    }

    /// The number of `term`, created when new.
    pub fn intern(&mut self, term: &str) -> u32 {
        if let Some(id) = self.term_id(term) {
            return id;
        }
        let id = u32::try_from(self.names.len()).unwrap_or(u32::MAX);
        self.ids.insert(term.into(), id);
        self.names.push(term.into());
        self.post.push(Vec::new());
        self.by_len.entry(term.chars().count()).or_default().push(id);
        id
    }

    /// Appends a posting. Chunks come in increasing order, so lists stay sorted.
    pub fn push(&mut self, term: u32, p: Posting) {
        self.post[term as usize].push(p);
    }

    pub fn remove(&mut self, term: u32, chunk: u32) {
        let list = &mut self.post[term as usize];
        if let Ok(i) = list.binary_search_by_key(&chunk, |p| p.chunk) {
            list.remove(i);
        }
    }

    pub fn postings(&self, term: u32) -> &[Posting] {
        &self.post[term as usize]
    }

    pub fn contains(&self, term: u32, chunk: u32) -> bool {
        self.post[term as usize].binary_search_by_key(&chunk, |p| p.chunk).is_ok()
    }

    /// Terms with at least one chunk that start with `prefix`.
    pub fn prefix_terms(&self, prefix: &str) -> Vec<u32> {
        self.ids
            .range::<str, _>((Bound::Included(prefix), Bound::Unbounded))
            .take_while(|(t, _)| t.starts_with(prefix))
            .map(|(_, id)| *id)
            .filter(|id| !self.post[*id as usize].is_empty())
            .collect()
    }

    /// Terms of at least 4 characters whose trigram Jaccard similarity to `word` is at least 0.5, with that
    /// similarity (OCR §4.3 fallback). The word itself is left out.
    pub fn similar_terms(&self, word: &str) -> Vec<(u32, f32)> {
        let wg = trigrams(word);
        if wg.is_empty() {
            return vec![];
        }
        let mut out = Vec::new();
        for (t, id) in &self.ids {
            if **t == *word || t.chars().count() < 4 || self.post[*id as usize].is_empty() {
                continue;
            }
            let sim = trigram_similarity(&wg, &trigrams(t));
            if sim >= 0.5 {
                out.push((*id, sim));
            }
        }
        out
    }

    /// Terms within `max_edits` of `word` (not the word itself), with their distance. Only terms whose length
    /// differs by at most the allowed edits are compared.
    pub fn edit_terms(&self, word: &str) -> Vec<(u32, usize)> {
        let wc: Vec<char> = word.chars().collect();
        let max = max_edits(wc.len());
        if max == 0 {
            return vec![];
        }
        let mut out = Vec::new();
        for len in wc.len().saturating_sub(max)..=wc.len() + max {
            let Some(bucket) = self.by_len.get(&len) else { continue };
            for &id in bucket {
                let t = &self.names[id as usize];
                if **t == *word || self.post[id as usize].is_empty() {
                    continue;
                }
                let tc: Vec<char> = t.chars().collect();
                if let Some(d) = edit_distance_within(&wc, &tc, max) {
                    out.push((id, d));
                }
            }
        }
        out
    }

    /// Number of postings in all lists.
    #[cfg(test)]
    pub fn post_len(&self) -> usize {
        self.post.iter().map(Vec::len).sum()
    }

    /// Heap bytes of the term tables and postings (capacities, plus the usual map node overhead).
    #[cfg(test)]
    pub fn heap_bytes(&self) -> usize {
        let ids: usize = self.ids.keys().map(|k| k.len() + 16 + 4 + 24).sum();
        let names: usize = self.names.iter().map(|n| n.len() + 16).sum::<usize>() + self.names.capacity() * 16;
        let post: usize = self.post.capacity() * 24 + self.post.iter().map(|v| v.capacity() * 8).sum::<usize>();
        let by_len: usize = self.by_len.values().map(|v| v.capacity() * 4 + 32).sum();
        ids + names + post + by_len
    }
}

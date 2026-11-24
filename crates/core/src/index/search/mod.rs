//! Search over note chunks and file text layers (OCR §4.2–4.3, PLAN §4.6): normalization, chunking, BM25 with a
//! trigram fallback, query operators. Pure code, no I/O, compiles for wasm32. Notes and files are separate
//! documents; a chunk belongs to one of them and is found through its id (`n:<noteId>#k`, `f:<fileId>#s<page>`).

mod bm25;
mod chunks;
mod graph;
mod mentions;
mod query;
mod text;

pub use graph::{
    Edge, EdgeKind, FileInfo, FilePage, Hub, MapOverview, Neighbors, Node, NodeKind, Scope, normalize_name};
use graph::{FileMeta, embedded_files, people_in_props};
use mentions::MentionCache;

#[cfg(test)]
mod tests_chunks;
#[cfg(test)]
mod tests_eval;
#[cfg(test)]
mod tests_graph;
#[cfg(test)]
mod tests_scope;
#[cfg(test)]
mod tests_perf;
#[cfg(test)]
mod tests_query;
#[cfg(test)]
mod tests_search;
#[cfg(test)]
mod tests_text;

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use crate::index::parse_note;
use bm25::{Inverted, Posting};
use chunks::{note_sections, parse_layer, split_pieces, strip_front_matter};

/// Texts are indexed up to this many bytes.
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// `read` without a limit returns this many characters.
const READ_DEFAULT: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Note,
    File,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub chunk_id: String,
    pub kind: Kind,
    /// The note id or the file id, as given to `upsert_*`.
    pub doc_id: String,
    /// Note path or file name.
    pub title: String,
    /// Heading path ("Koszty > Serwer") or page ("s.2", "obraz").
    pub place: String,
    pub snippet: String,
    pub score: f32,
    pub tokens_approx: u32,
    pub doc_tokens_approx: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchPage {
    pub hits: Vec<Hit>,
    pub total: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutlineItem {
    pub chunk_id: String,
    pub place: String,
    pub tokens_approx: u32,
    /// First non-blank line of a file page.
    pub first_line: Option<String>,
    /// File pages marked `· niska jakość` in the text layer.
    pub low_quality: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadResult {
    /// The id asked for.
    pub id: String,
    pub title: String,
    pub place: String,
    pub text: String,
    /// Length of the whole text, in characters.
    pub total_chars: usize,
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SearchError {
    /// The text layer does not follow OCR §3.1. The reason never contains the file's text.
    #[error("text layer: {0}")]
    Layer(&'static str),
}

/// Index over notes and file text layers. Keep it next to `SpaceIndex`, not inside it.
///
/// Each chunk is stored once, under a number (`u32`) that is never reused. Postings and the term table refer to
/// chunks and terms by number. Notes and files keep only their chunk numbers.
#[derive(Default)]
pub struct SearchIndex {
    notes: BTreeMap<String, NoteDoc>,
    files: BTreeMap<String, FileDoc>,
    /// Chunk number -> chunk. `None` once removed (numbers are not reused).
    chunks: Vec<Option<Chunk>>,
    /// Chunk id -> chunk number.
    chunk_ids: BTreeMap<Box<str>, u32>,
    /// Chunks in the index, and the sum of their token counts (for BM25's average length).
    live: usize,
    total_len: u64,
    inv: Inverted,
    /// Outgoing links of each note, as the caller resolved them (`set_links`).
    links: BTreeMap<String, Vec<String>>,
    /// Names set with `set_people`, normalized.
    people: BTreeSet<String>,
    /// Name, type and state of each file (`set_file`, and every text layer).
    file_meta: BTreeMap<String, FileMeta>,
    /// Mentions, built on first use and cleared by every change (see `mentions.rs`).
    mentions: RefCell<Option<MentionCache>>,
    /// Light Polish suffix stripping on both sides (chosen by the evaluation in `tests_eval`).
    stem: bool,
}

struct Chunk {
    id: Box<str>,
    kind: Kind,
    /// The note id or the file id.
    doc: Box<str>,
    place: Box<str>,
    text: Box<str>,
    /// Tokens (BM25 length), and characters (for `tokens_approx`).
    tokens: u32,
    chars: u32,
}

struct NoteDoc {
    path: String,
    path_key: String,
    /// The folder of the note (the path without the file name); "" at the top.
    folder: String,
    tags: Vec<String>,
    /// Normalized names of the people in tasks and `osoby:` / `prowadzacy:`.
    assignees: Vec<String>,
    /// File ids from `![[plik:…]]`.
    embeds: Vec<String>,
    tokens: u32,
    chunks: Vec<u32>,
}

struct FileDoc {
    name: String,
    name_key: String,
    mime: String,
    tokens: u32,
    pages: Vec<Page>,
}

struct Page {
    /// Section number; 0 for the image section.
    num: u32,
    obraz: bool,
    low: bool,
    chunks: Vec<u32>,
}

impl Page {
    fn label(&self) -> String {
        if self.obraz { "obraz".to_string() } else { format!("s.{}", self.num) }
    }

    /// `s2` or `obraz`, the part of the chunk ids.
    fn anchor(&self) -> String {
        if self.obraz { "obraz".to_string() } else { format!("s{}", self.num) }
    }
}

/// `ceil(chars / 3)`, the rough token count of Polish text (OCR §4.2).
fn approx_tokens(chars: usize) -> u32 {
    u32::try_from(chars.div_ceil(3)).unwrap_or(u32::MAX)
}

/// The longest prefix of at most `MAX_TEXT_BYTES` bytes that ends on a character boundary.
fn cap(text: &str) -> &str {
    if text.len() <= MAX_TEXT_BYTES {
        return text;
    }
    let mut end = MAX_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

impl SearchIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// The stemming variant, for the evaluation in `tests_eval`.
    #[cfg(test)]
    fn with_stemming(stem: bool) -> Self {
        SearchIndex { stem, ..Self::default() }
    }

    /// Replaces the note. `text` is the whole `.md` file, front matter included.
    pub fn upsert_note(&mut self, id: &str, path: &str, text: &str) {
        self.remove_note(id);
        let text = cap(text);
        let (_, body) = strip_front_matter(text);
        let parsed = parse_note(text);
        let tags = parsed.tags.iter().map(|t| text::normalize(t)).collect();
        let mut assignees: Vec<String> = parsed
            .tasks
            .iter()
            .flat_map(|t| t.assignees.iter().map(|a| text::normalize(a)))
            .chain(people_in_props(&parsed.props))
            .collect();
        assignees.sort();
        assignees.dedup();
        let folder = path.rsplit_once('/').map_or("", |(dir, _)| dir).to_string();
        let mut ids = Vec::new();
        for sec in note_sections(body) {
            for piece in split_pieces(&sec.text) {
                let chunk_id = format!("n:{id}#{}", ids.len() + 1);
                ids.push(self.add_chunk(chunk_id, Kind::Note, id, &sec.place, &piece));
            }
        }
        let doc = NoteDoc {
            path: path.to_string(),
            path_key: text::normalize(path),
            folder,
            tags,
            assignees,
            embeds: embedded_files(text),
            tokens: approx_tokens(body.chars().count()),
            chunks: ids,
        };
        self.notes.insert(id.to_string(), doc);
        self.invalidate();
    }

    pub fn remove_note(&mut self, id: &str) {
        if let Some(doc) = self.notes.remove(id) {
            self.drop_chunks(&doc.chunks);
            self.invalidate();
        }
    }

    /// Replaces the text layer of a file. A layer that does not parse is an error and changes nothing.
    pub fn upsert_file_text(&mut self, file_id: &str, name: &str, mime: &str, markdown: &str) -> Result<(), SearchError> {
        let md = cap(markdown);
        let layer = parse_layer(md)?;
        self.remove_file(file_id);
        let (_, body) = strip_front_matter(md);
        let mut pages = Vec::new();
        for p in layer {
            let page = Page { num: p.num, obraz: p.obraz, low: p.low, chunks: Vec::new() };
            let anchor = page.anchor();
            let label = page.label();
            let pieces = split_pieces(&p.text);
            let n = pieces.len();
            let mut chunks = Vec::new();
            for (j, piece) in pieces.iter().enumerate() {
                let chunk_id = if n == 1 {
                    format!("f:{file_id}#{anchor}")
                } else {
                    format!("f:{file_id}#{anchor}.{}", j + 1)
                };
                chunks.push(self.add_chunk(chunk_id, Kind::File, file_id, &label, piece));
            }
            pages.push(Page { chunks, ..page });
        }
        let doc = FileDoc {
            name: name.to_string(),
            name_key: text::normalize(name),
            mime: mime.to_lowercase(),
            tokens: approx_tokens(body.chars().count()),
            pages,
        };
        let meta = FileMeta { name: name.to_string(), mime: mime.to_lowercase(), state: "text".to_string() };
        self.file_meta.insert(file_id.to_string(), meta);
        self.files.insert(file_id.to_string(), doc);
        self.invalidate();
        Ok(())
    }

    pub fn remove_file(&mut self, file_id: &str) {
        self.file_meta.remove(file_id);
        if let Some(doc) = self.files.remove(file_id) {
            let ids: Vec<u32> = doc.pages.into_iter().flat_map(|p| p.chunks).collect();
            self.drop_chunks(&ids);
        }
        self.invalidate();
    }

    /// Chunks of a note (headings with tokens) or pages of a file. `None` for an unknown id.
    pub fn outline(&self, doc_id: &str, scope: Option<&Scope>) -> Option<Vec<OutlineItem>> {
        let (kind, key) = self.resolve(doc_id, scope)?;
        if !graph::visible(scope, kind, key) {
            return None;
        }
        match kind {
            Kind::Note => {
                let doc = self.notes.get(key)?;
                Some(
                    doc.chunks
                        .iter()
                        .filter_map(|&c| {
                            let ch = self.chunk(c)?;
                            Some(OutlineItem {
                                chunk_id: ch.id.to_string(),
                                place: ch.place.to_string(),
                                tokens_approx: approx_tokens(ch.chars as usize),
                                first_line: None,
                                low_quality: false,
                            })
                        })
                        .collect(),
                )
            }
            Kind::File => {
                let doc = self.files.get(key)?;
                Some(
                    doc.pages
                        .iter()
                        .map(|p| {
                            let first = p.chunks.first().and_then(|&c| self.chunk(c));
                            let chars: usize = p.chunks.iter().filter_map(|&c| self.chunk(c)).map(|c| c.chars as usize).sum();
                            OutlineItem {
                                chunk_id: first.map_or_else(|| format!("f:{key}#{}", p.anchor()), |c| c.id.to_string()),
                                place: p.label(),
                                tokens_approx: approx_tokens(chars),
                                first_line: first.and_then(|c| c.text.lines().find(|l| !l.trim().is_empty()).map(str::to_string)),
                                low_quality: p.low,
                            }
                        })
                        .collect(),
                )
            }
        }
    }

    /// The text of a chunk, of a whole note, of a file's whole layer, or of a page range of a file (`pages`,
    /// inclusive). Whole notes and files are their chunks joined, so separators between chunks are approximate.
    /// `limit` 0 means `READ_DEFAULT` characters from `offset`. `None` for an unknown id.
    pub fn read(
        &self,
        id: &str,
        pages: Option<(u32, u32)>,
        offset: usize,
        limit: usize,
        scope: Option<&Scope>,
    ) -> Option<ReadResult> {
        let limit = if limit == 0 { READ_DEFAULT } else { limit.min(READ_DEFAULT) };
        if let Some(&cid) = self.chunk_ids.get(id) {
            let ch = self.chunk(cid)?;
            if !graph::visible(scope, ch.kind, &ch.doc) {
                return None;
            }
            let title = match ch.kind {
                Kind::Note => self.notes.get(&*ch.doc)?.path.clone(),
                Kind::File => self.files.get(&*ch.doc)?.name.clone(),
            };
            return Some(slice(id, title, ch.place.to_string(), &ch.text, offset, limit));
        }
        let (kind, key) = self.resolve(id, scope)?;
        if !graph::visible(scope, kind, key) {
            return None;
        }
        match (kind, pages) {
            (Kind::Note, Some(_)) => None,
            (Kind::Note, None) => {
                let d = self.notes.get(key)?;
                let text = self.join(&d.chunks, "\n");
                Some(slice(id, d.path.clone(), String::new(), &text, offset, limit))
            }
            (Kind::File, pages) => {
                let f = self.files.get(key)?;
                let parts: Vec<String> = f
                    .pages
                    .iter()
                    .filter(|p| match pages {
                        None => true,
                        Some((from, to)) => !p.obraz && (from..=to).contains(&p.num),
                    })
                    .map(|p| {
                        let head = if p.obraz {
                            "## Obraz".to_string()
                        } else {
                            format!("## Strona {}{}", p.num, if p.low { " · niska jakość" } else { "" })
                        };
                        format!("{head}\n{}", self.join(&p.chunks, "\n\n"))
                    })
                    .collect();
                if pages.is_some() && parts.is_empty() {
                    return None;
                }
                Some(slice(id, f.name.clone(), String::new(), &parts.join("\n\n"), offset, limit))
            }
        }
    }

    fn chunk(&self, cid: u32) -> Option<&Chunk> {
        self.chunks.get(cid as usize)?.as_ref()
    }

    fn join(&self, cids: &[u32], sep: &str) -> String {
        cids.iter().filter_map(|&c| self.chunk(c)).map(|c| &*c.text).collect::<Vec<_>>().join(sep)
    }

    /// Stores a chunk and its postings. Returns its number.
    fn add_chunk(&mut self, id: String, kind: Kind, doc: &str, place: &str, text: &str) -> u32 {
        let mut toks = text::tokens(text, self.stem);
        let tokens = u32::try_from(toks.len()).unwrap_or(u32::MAX);
        let chars = u32::try_from(text.chars().count()).unwrap_or(u32::MAX);
        let cid = u32::try_from(self.chunks.len()).unwrap_or(u32::MAX);
        toks.sort_unstable();
        let mut i = 0;
        while i < toks.len() {
            let mut j = i;
            while j < toks.len() && toks[j] == toks[i] {
                j += 1;
            }
            let term = self.inv.intern(&toks[i]);
            self.inv.push(term, Posting { chunk: cid, tf: u32::try_from(j - i).unwrap_or(u32::MAX) });
            i = j;
        }
        self.chunk_ids.insert(id.as_str().into(), cid);
        self.chunks.push(Some(Chunk {
            id: id.into(),
            kind,
            doc: doc.into(),
            place: place.into(),
            text: text.into(),
            tokens,
            chars,
        }));
        self.live += 1;
        self.total_len += u64::from(tokens);
        cid
    }

    fn drop_chunks(&mut self, cids: &[u32]) {
        for &cid in cids {
            let Some(ch) = self.chunks.get_mut(cid as usize).and_then(Option::take) else { continue };
            let mut toks = text::tokens(&ch.text, self.stem);
            toks.sort_unstable();
            toks.dedup();
            for t in &toks {
                if let Some(term) = self.inv.term_id(t) {
                    self.inv.remove(term, cid);
                }
            }
            self.chunk_ids.remove(&ch.id);
            self.live -= 1;
            self.total_len -= u64::from(ch.tokens);
        }
    }

    /// The document of an id: `n:`/`f:` prefixed, or a bare id found among notes, then files.
    /// A document by `n:<id>`, `f:<id>` or a bare id, only among those `scope` shows: a bare id that is a hidden note
    /// and a visible file is the file (resolving the note first would tell the note exists).
    fn resolve(&self, id: &str, scope: Option<&Scope>) -> Option<(Kind, &str)> {
        let note = |raw: &str| self.notes.get_key_value(raw).map(|(k, _)| (Kind::Note, k.as_str()));
        let file = |raw: &str| self.files.get_key_value(raw).map(|(k, _)| (Kind::File, k.as_str()));
        let candidates = if let Some(raw) = id.strip_prefix("n:") {
            [note(raw), None]
        } else if let Some(raw) = id.strip_prefix("f:") {
            [file(raw), None]
        } else {
            [note(id), file(id)]
        };
        candidates.into_iter().flatten().find(|(kind, key)| graph::visible(scope, *kind, key))
    }

    /// (chunks in the index, average tokens per chunk) for BM25.
    fn stats(&self) -> (f32, f32) {
        let n = self.live as f32;
        (n, (self.total_len as f32 / n.max(1.0)).max(1.0))
    }

    /// `stats` over the chunks `scope` shows (all of them with `None`).
    pub(super) fn stats_in(&self, scope: Option<&Scope>) -> (f32, f32) {
        if scope.is_none() {
            return self.stats();
        }
        let (mut n, mut len) = (0u64, 0u64);
        for c in self.chunks.iter().flatten().filter(|c| graph::visible(scope, c.kind, &c.doc)) {
            n += 1;
            len += c.tokens as u64;
        }
        let n = n as f32;
        (n, (len as f32 / n.max(1.0)).max(1.0))
    }

    /// Heap bytes of the index: capacities of its vectors and strings, plus the map entries (node overhead is an
    /// estimate). Used by `tests_perf` only.
    #[cfg(test)]
    pub fn heap_bytes(&self) -> usize {
        let docs_notes: usize = self
            .notes
            .iter()
            .map(|(k, d)| {
                k.len() + d.path.capacity() + d.path_key.capacity() + d.tags.iter().map(|t| t.capacity() + 24).sum::<usize>()
                    + d.chunks.capacity() * 4 + 80
            })
            .sum();
        let docs_files: usize = self
            .files
            .iter()
            .map(|(k, d)| {
                let pages: usize = d.pages.iter().map(|p| p.chunks.capacity() * 4 + 16).sum();
                k.len() + d.name.capacity() + d.name_key.capacity() + d.mime.capacity() + pages + d.pages.capacity() * 16 + 80
            })
            .sum();
        let chunks_vec = self.chunks.capacity() * std::mem::size_of::<Option<Chunk>>();
        let chunk_heap: usize = self
            .chunks
            .iter()
            .flatten()
            .map(|c| c.id.len() + c.doc.len() + c.place.len() + c.text.len())
            .sum();
        let ids: usize = self.chunk_ids.keys().map(|k| k.len() + 16 + 4 + 24).sum();
        let mentions: usize = self
            .mentions
            .borrow()
            .as_ref()
            .map_or(0, |c| {
                let targets: usize = c.targets.iter().map(|t| t.len() + 24).sum::<usize>() + c.lens.capacity() * 4;
                let sources: usize = c.by_source.iter().map(|(k, v)| k.len() + 24 + 24 + v.capacity() * 8).sum();
                targets + sources
            });
        chunks_vec + chunk_heap + ids + docs_notes + docs_files + self.inv.heap_bytes() + mentions
    }
}

fn slice(id: &str, title: String, place: String, text: &str, offset: usize, limit: usize) -> ReadResult {
    let total_chars = text.chars().count();
    let taken: String = text.chars().skip(offset).take(limit).collect();
    let more = offset.saturating_add(limit) < total_chars;
    ReadResult { id: id.to_string(), title, place, text: taken, total_chars, more }
}


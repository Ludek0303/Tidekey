//! Mentions (OCR §4.1): a note or file text that names another note (by its file name) or a person, without a
//! link. Computed once for the whole index and cached; every change clears the cache. Scope is applied later, in
//! `build_graph`, so that a mention leading out of scope is dropped and not counted.

use std::cell::Ref;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use super::text;
use super::SearchIndex;

/// Titles and names shorter than this (after normalization, in characters) are not mentioned.
const MIN_TITLE_CHARS: usize = 4;
/// Longest title, in tokens, that is looked for.
const MAX_TITLE_TOKENS: usize = 8;

/// One mentioned node, by its number in `MentionCache::targets`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Mention {
    pub target: u32,
    pub count: u32,
}

/// Mentions of every source, strongest first. Not capped and not scoped. Targets are stored once and referred to by
/// number, which keeps a mention to 8 bytes.
#[derive(Debug, Default)]
pub(super) struct MentionCache {
    /// Node ids (`n:<id>`, `p:<name>`).
    pub targets: Vec<String>,
    /// Title length in characters per target, for ranking ties.
    pub lens: Vec<u32>,
    /// Source node (`n:<id>`, `f:<id>`) -> its mentions.
    pub by_source: BTreeMap<String, Vec<Mention>>,
}

impl SearchIndex {
    /// The cached mention map, built on first use.
    pub(super) fn mentions(&self) -> Ref<'_, MentionCache> {
        if self.mentions.borrow().is_none() {
            let built = self.build_mentions();
            *self.mentions.borrow_mut() = Some(built);
        }
        Ref::map(self.mentions.borrow(), |m| m.as_ref().unwrap_or_else(|| unreachable_empty()))
    }

    /// Drops the cached mentions. Called by every change that can alter them.
    pub(super) fn invalidate(&self) {
        *self.mentions.borrow_mut() = None;
    }

    /// Title or name as searched: normalized tokens joined by one space.
    fn title_key(&self, s: &str) -> String {
        text::tokens(s, self.stem).join(" ")
    }

    /// Every person known: named in a task or a front matter list of a note, or set with `set_people`.
    pub(super) fn known_people(&self) -> BTreeSet<String> {
        let mut out: BTreeSet<String> = self.people.clone();
        for doc in self.notes.values() {
            out.extend(doc.assignees.iter().cloned());
        }
        out
    }

    fn build_mentions(&self) -> MentionCache {
        let mut cache = MentionCache::default();
        let mut numbers: HashMap<String, u32> = HashMap::new();
        // title key -> (key length in characters, target numbers)
        let mut titles: BTreeMap<String, (usize, Vec<u32>)> = BTreeMap::new();
        let mut add = |key: String, target: String| {
            let len = key.chars().count();
            if len >= MIN_TITLE_CHARS {
                let n = *numbers.entry(target.clone()).or_insert_with(|| {
                    cache.targets.push(target);
                    cache.lens.push(len as u32);
                    u32::try_from(cache.targets.len() - 1).unwrap_or(u32::MAX)
                });
                titles.entry(key).or_insert_with(|| (len, Vec::new())).1.push(n);
            }
        };
        for (id, doc) in &self.notes {
            let file = doc.path.rsplit('/').next().unwrap_or(&doc.path);
            let stem = file.strip_suffix(".md").unwrap_or(file);
            add(self.title_key(stem), format!("n:{id}"));
        }
        for p in self.known_people() {
            add(self.title_key(&p), format!("p:{p}"));
        }
        let first: HashSet<String> = titles.keys().filter_map(|k| k.split(' ').next().map(str::to_string)).collect();
        let max = titles.keys().map(|k| k.split(' ').count()).max().unwrap_or(0).min(MAX_TITLE_TOKENS);

        let sources = self
            .notes
            .iter()
            .map(|(id, d)| (format!("n:{id}"), Some(id.as_str()), d.chunks.clone()))
            .chain(self.files.iter().map(|(id, d)| (format!("f:{id}"), None, d.pages.iter().flat_map(|p| p.chunks.clone()).collect())));
        for (source, note_id, chunks) in sources {
            let tokens: Vec<String> = chunks.iter().filter_map(|&c| self.chunk(c)).flat_map(|c| text::tokens(&c.text, self.stem)).collect();
            let linked: HashSet<&str> = note_id
                .and_then(|id| self.links.get(id))
                .map(|ts| ts.iter().map(String::as_str).collect())
                .unwrap_or_default();
            let mut found: BTreeMap<u32, u32> = BTreeMap::new();
            for i in 0..tokens.len() {
                if !first.contains(&tokens[i]) {
                    continue;
                }
                let mut key = String::new();
                for k in 1..=max {
                    if i + k > tokens.len() {
                        break;
                    }
                    if k > 1 {
                        key.push(' ');
                    }
                    key.push_str(&tokens[i + k - 1]);
                    let Some((_, targets)) = titles.get(&key) else { continue };
                    for &t in targets {
                        let name = cache.targets[t as usize].as_str();
                        let self_mention = name == source;
                        let linked_note = name.strip_prefix("n:").is_some_and(|x| linked.contains(x));
                        if self_mention || linked_note {
                            continue;
                        }
                        *found.entry(t).or_insert(0) += 1;
                    }
                }
            }
            let mut list: Vec<Mention> = found.into_iter().map(|(target, count)| Mention { target, count }).collect();
            list.sort_by(|a, b| {
                b.count
                    .cmp(&a.count)
                    .then_with(|| cache.lens[b.target as usize].cmp(&cache.lens[a.target as usize]))
                    .then_with(|| cache.targets[a.target as usize].cmp(&cache.targets[b.target as usize]))
            });
            if !list.is_empty() {
                cache.by_source.insert(source, list);
            }
        }
        cache
    }
}

/// `mentions()` always fills the cache first, so this is never reached; it avoids a panic path.
fn unreachable_empty() -> &'static MentionCache {
    static EMPTY: std::sync::OnceLock<MentionCache> = std::sync::OnceLock::new();
    EMPTY.get_or_init(MentionCache::default)
}


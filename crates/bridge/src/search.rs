//! Full-text search over the notes: an FTS5 table in space.db, updated in the background after each save
//! (ARCHITEKTURA §4.15). The table is local and never synced.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, params};

use notes_core::Space;

use crate::error::Result;

/// Notes indexed per `tick`.
const BATCH: usize = 50;
/// Snippet markers: control characters, so that the UI can escape the text and only then mark the hits.
pub const MARK_START: char = '\u{2}';
pub const MARK_END: char = '\u{3}';

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SearchHit {
    pub id: String,
    pub path: String,
    pub snippet: String,
}

pub(crate) struct Index {
    db: Connection,
    dirty: BTreeSet<String>,
}

impl Index {
    /// Opens the index in `root`'s space.db. Returns whether the table was just created (then every note needs
    /// indexing).
    pub(crate) fn open(root: &Path) -> Result<(Index, bool)> {
        let db = Connection::open(root.join(".notes-sync").join("space.db"))?;
        db.busy_timeout(Duration::from_secs(5))?;
        let existed: i64 = db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'fts'",
            [],
            |r| r.get(0),
        )?;
        db.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(note_id UNINDEXED, title, body, \
             tokenize = 'unicode61 remove_diacritics 2');",
        )?;
        Ok((
            Index {
                db,
                dirty: BTreeSet::new(),
            },
            existed == 0,
        ))
    }

    /// Queues a note for indexing at the next `tick`.
    pub(crate) fn mark(&mut self, id: &str) {
        self.dirty.insert(id.to_string());
    }

    /// Takes a note out of the index at once, when it is deleted.
    pub(crate) fn remove(&mut self, id: &str) -> Result<()> {
        self.dirty.remove(id);
        self.db
            .execute("DELETE FROM fts WHERE note_id = ?1", params![id])?;
        Ok(())
    }

    /// Indexes up to `BATCH` queued notes. `paths` maps every live note to its path; a note no longer in it is
    /// removed from the index.
    pub(crate) fn index_batch(
        &mut self,
        space: &mut Space,
        paths: &HashMap<String, String>,
    ) -> Result<()> {
        let ids: Vec<String> = self.dirty.iter().take(BATCH).cloned().collect();
        // one commit per batch: each autocommitted statement would be a separate fsync
        let tx = self.db.transaction()?;
        for id in ids {
            self.dirty.remove(&id);
            tx.execute("DELETE FROM fts WHERE note_id = ?1", params![id])?;
            let Some(path) = paths.get(&id) else {
                continue;
            };
            let body = space.text(&id)?;
            let title = path
                .rsplit('/')
                .next()
                .unwrap_or(path)
                .trim_end_matches(".md");
            tx.execute(
                "INSERT INTO fts (note_id, title, body) VALUES (?1, ?2, ?3)",
                params![id, title, body],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The note ids and snippets matching `query`, best match first.
    pub(crate) fn query(&self, query: &str, limit: usize) -> Result<Vec<(String, String)>> {
        let Some(expr) = match_expr(query) else {
            return Ok(Vec::new());
        };
        let mut stmt = self.db.prepare(
            "SELECT note_id, snippet(fts, 2, ?2, ?3, '…', 12) FROM fts \
             WHERE fts MATCH ?1 ORDER BY bm25(fts) LIMIT ?4",
        )?;
        let start = MARK_START.to_string();
        let end = MARK_END.to_string();
        let rows = stmt.query_map(params![expr, start, end, limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

/// The user's words as an FTS5 query: each word is a set of quoted prefix terms (its spellings, see `spellings`),
/// so FTS operators (`OR`, `NEAR`, `*`, `:`, quotes) are plain text, and the words are joined with AND. Words without any
/// letter or digit are dropped.
pub fn match_expr(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .filter(|t| t.chars().any(char::is_alphanumeric))
        .map(|t| {
            let alternatives: Vec<String> = spellings(t)
                .iter()
                .map(|s| format!("\"{}\"*", s.replace('"', "\"\"")))
                .collect();
            format!("({})", alternatives.join(" OR "))
        })
        .collect();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

/// The spellings of a word the index can match. The tokenizer folds Polish diacritics but keeps `ł` apart from
/// `l`, so each `l` of the word may also be written `ł`. Up to `MAX_L` letters are expanded; a longer word is
/// matched as typed.
fn spellings(word: &str) -> Vec<String> {
    const MAX_L: usize = 6;
    let slots: Vec<usize> = word
        .char_indices()
        .filter(|(_, c)| *c == 'l' || *c == 'L')
        .map(|(i, _)| i)
        .collect();
    if slots.len() > MAX_L {
        return vec![word.to_string()];
    }
    let mut out: Vec<String> = Vec::new();
    for mask in 0..(1usize << slots.len()) {
        let mut spelled = String::with_capacity(word.len());
        let mut next = 0;
        for (i, c) in word.char_indices() {
            if slots.get(next) == Some(&i) {
                let swap = mask & (1 << next) != 0;
                spelled.push(match (c, swap) {
                    ('l', true) => 'ł',
                    ('L', true) => 'Ł',
                    _ => c,
                });
                next += 1;
            } else {
                spelled.push(c);
            }
        }
        if !out.contains(&spelled) {
            out.push(spelled);
        }
    }
    out
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;

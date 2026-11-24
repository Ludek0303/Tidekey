//! Note index: links, embeds, tags, headings, block ids and tasks of each note, plus the
//! space-wide lookups built on them (backlinks, graph, tag pane, "my tasks"). Pure code, no I/O.
//! Lines are 1-based.

mod parse;
mod rename;
mod search;
mod space;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_space;
#[cfg(test)]
mod tests_prop;
#[cfg(test)]
mod tests_rename;

pub use parse::{LineTask, TaskToken, TokenKind, line_task, parse_note};
pub use rename::rename_links;
pub use search::{
    Edge, EdgeKind, FileInfo, FilePage, Hit, Hub, Kind, MapOverview, Neighbors, Node, NodeKind, OutlineItem, ReadResult,
    Scope, SearchError, SearchIndex, SearchPage, normalize_name,
};
pub use space::{ResolvedLink, SpaceIndex, TaskQuery};

/// `[[target#heading|alias]]`, `[[target#^block]]`, `![[…]]` (embed) or `[text](Folder/Note.md)`.
/// `target` is as written; `heading` and `block` are without `#` and `^`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub target: String,
    pub heading: Option<String>,
    pub block: Option<String>,
    pub alias: Option<String>,
    pub embed: bool,
    /// `[text](x.md)`: a path relative to the note's folder, not a basename.
    pub md: bool,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub line: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    High,
    Medium,
    Low,
}

/// From `!przypomnij:<before>[/<every>][x<count>]` (ORGANIZACJA §2): minutes before the due moment, the gap between
/// the repeats, and how many reminders in all (1 without `x`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Reminder {
    pub before_min: u32,
    pub every_min: Option<u32>,
    pub count: u8,
}

/// A list item with `[ ]`, `[x]` or `[X]` (ORGANIZACJA §2). Days are since 1970-01-01.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub line: u32,
    /// List nesting level, 0 for top-level items.
    pub depth: u8,
    pub done: bool,
    /// Text without the metadata tokens.
    pub text: String,
    /// Handles without `@`.
    pub assignees: Vec<String>,
    /// Stable organization group ids, from `!grupa:id`.
    pub groups: Vec<String>,
    /// Handle of the supervisor without `@`, from `!nadzor:@handle`.
    pub supervisor: Option<String>,
    /// From `!trudnosc:N`, 0 to 10. None when unrated, which is not the same as 0.
    pub difficulty: Option<u8>,
    pub due: Option<i32>,
    pub done_on: Option<i32>,
    pub priority: Option<Priority>,
    /// Block id without `^`.
    pub id: Option<String>,
    /// From `!przypomnij:`, None when the task has no reminder.
    pub reminder: Option<Reminder>,
    /// From `!etap:`, the board column with `_` read as spaces (`!etap:W_toku` is `W toku`); None without one.
    pub stage: Option<String>,
}

/// A token the parser could not use. The line is still indexed, without that token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Warning {
    pub line: u32,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteIndex {
    pub links: Vec<Link>,
    /// Lowercase, without `#`, deduplicated.
    pub tags: Vec<String>,
    pub headings: Vec<Heading>,
    /// Block ids without `^`, each with its line.
    pub blocks: Vec<(String, u32)>,
    pub tasks: Vec<Task>,
    pub warnings: Vec<Warning>,
    /// Simple `key: value` pairs of the front matter, such as `typ` and `status`. Keys are lowercase.
    pub props: Vec<(String, String)>,
}

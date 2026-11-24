pub mod access;
mod atomic;
pub mod calendar;
pub mod formula;
pub mod github;
#[cfg(test)]
mod github_tests;
pub mod github_plan;
#[cfg(test)]
mod github_plan_tests;
pub mod index;
mod legacy;
mod message;
pub mod records;
pub mod render;
#[cfg(test)]
mod render_tests;
mod space;
mod space_meta;
mod textdiff;

pub use access::{Access, Header, Key, message_hash};
pub use atomic::write_atomic;
pub use legacy::LegacySecrets;
pub use records::Records;
pub use space::{ExternalOutcome, KIND_NOTES, KIND_ORGANIZATION, NoteId, Received, Space, TRASH_DAYS, VersionInfo, text_hash, trash_cutoff};
pub use space_meta::is_valid_path;
pub use space::{TaskEvent, TaskSnapshot};
pub use textdiff::{TextEdit, text_edits};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("crdt error: {0}")]
    Crdt(String),
    #[error("bad signature on message seq {seq}")]
    BadSignature { seq: u64 },
    #[error("rejected message seq {seq}: {reason}")]
    BadMessage { seq: u64, reason: &'static str },
    #[error("unknown note: {0}")]
    UnknownNote(String),
    #[error("path already used by another note: {0}")]
    PathTaken(String),
    #[error("invalid note path: {0}")]
    InvalidPath(String),
    #[error("space already exists")]
    AlreadyExists,
    #[error("no key for epoch {} of message seq {}", .0.epoch, .0.seq)]
    NoEpochKey(Header),
    #[error("message seq {seq} denied: {reason}")]
    Denied { seq: u64, reason: String },
    #[error("no current space key")]
    NoCurrentKey,
    #[error("unknown version: {0}")]
    UnknownVersion(i64),
    #[error("note is not in conflict: {0}")]
    NotInConflict(String),
    #[error("the other side's text of the conflict changed: {0}")]
    ConflictChanged(String),
    #[error("unknown space type: {0}")]
    UnknownKind(String),
    #[error("a space cannot go back from organizacja to notatki")]
    KindDowngrade,
    #[error("unsupported space layout: {0}")]
    Layout(&'static str),
    /// The note's file is a link, a folder or not UTF-8 text now: it was neither read nor overwritten.
    #[error("the note's file is not plain text now, so it was not read or overwritten: {0}")]
    NotPlainFile(String),
}

pub type Result<T> = std::result::Result<T, Error>;

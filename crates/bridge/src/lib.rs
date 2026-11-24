//! The desktop backend: the commands the UI bridge calls (`ui/src/bridge.ts`), over one open space.
//! It has no window and no IPC, so the Tauri app is only a set of thin wrappers around it.

mod attach;
mod backend;
mod changes;
mod error;
mod folders;
mod organization;
mod organization_records;
mod search;
mod watch;

pub use backend::{Backend, ConflictTexts, TrashItem, TreeItem, TreeListing, VersionItem};
pub use changes::Change;
pub use error::{BridgeError, Result};
pub use notes_sync::keystore::MemoryKeyStore;
#[cfg(feature = "os-keyring")]
pub use notes_sync::keystore::OsKeyStore;
pub use search::SearchHit;

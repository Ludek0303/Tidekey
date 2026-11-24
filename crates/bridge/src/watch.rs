//! Watches the space folder for changes made by other programs. Events only queue paths here; the backend reads
//! and applies them in `tick` (changes.rs), on the thread that owns the space.

use std::path::Path;
use std::sync::mpsc::{self, Receiver};

use notify::event::{EventKind, ModifyKind};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use crate::folders;

pub struct Watch {
    // dropping the watcher stops its own thread
    _watcher: RecommendedWatcher,
    events: Receiver<notify::Result<Event>>,
}

impl Watch {
    pub fn start(root: &Path) -> notify::Result<Watch> {
        let (tx, events) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            // a send after the backend is gone fails harmlessly
            let _ = tx.send(event);
        })?;
        watcher.watch(root, RecursiveMode::Recursive)?;
        Ok(Watch {
            _watcher: watcher,
            events,
        })
    }

    /// The paths touched since the last call, relative to the root, with whether the event created or renamed
    /// them (a folder created or renamed is walked). Hidden names (`.notes-sync`, the temp files of `write_atomic`)
    /// are left out.
    // shortcut: an error the watcher reports (overflow, a lost folder) is dropped without a rescan; upgrade with the full stat pass of §4.4 step 3
    pub fn touched(&self, root: &Path) -> Vec<(String, bool)> {
        self.events
            .try_iter()
            .filter_map(Result::ok)
            // reads and metadata changes are not edits: our own reads would queue the file again, in a loop
            .filter(|e| {
                matches!(
                    e.kind,
                    EventKind::Create(_)
                        | EventKind::Remove(_)
                        | EventKind::Modify(
                            ModifyKind::Data(_) | ModifyKind::Name(_) | ModifyKind::Any
                        )
                )
            })
            .flat_map(|e| {
                let created = matches!(
                    e.kind,
                    EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))
                );
                e.paths.into_iter().map(move |p| (p, created))
            })
            .filter_map(|(p, created)| Some((folders::rel_of(root, &p)?, created)))
            .filter(|(rel, _)| !rel.is_empty() && !rel.split('/').any(|s| s.starts_with('.')))
            .collect()
    }
}

//! One open space and the commands the UI calls on it (ARCHITEKTURA §4.3, §4.9, §4.17).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use notes_sync::identity::{RecoveryPhrase, UserKeys};
use notes_sync::keystore::{KeyStore, Slot};
use notes_sync::space::{Opened, create_space, open_space};
use notes_sync::space_recover::recover_existing;
use zeroize::Zeroizing;

use crate::attach;
use crate::changes::Change;
use crate::error::{BridgeError, Result};
use crate::folders;
use crate::search::{Index, SearchHit};
use crate::watch::Watch;

/// Notes loaded per `tick`, so that the UI stays responsive while cold notes are read in.
const TICK_BATCH: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TreeItem {
    pub id: String,
    pub path: String,
}

/// Notes plus every folder, empty ones included, as `list_tree` returns them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TreeListing {
    pub notes: Vec<TreeItem>,
    pub folders: Vec<String>,
}

/// One saved version of a note, newest first.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct VersionItem {
    pub id: i64,
    pub time_ms: i64,
    pub reason: String,
}

/// A deleted note in the trash, newest deletion first.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TrashItem {
    pub id: String,
    pub path: String,
    pub deleted_at: i64,
}

/// The two texts of a conflict: the note's (`ours`) and the file's (`theirs`). `theirs_hash` is the hash the
/// resolution must quote, so a file that changed again after this view is refused.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ConflictTexts {
    pub ours: String,
    pub theirs: String,
    pub theirs_hash: String,
}

pub struct Backend {
    pub(crate) opened: Opened,
    pub(crate) root: PathBuf,
    pub(crate) search: Index,
    pub(crate) watch: Watch,
    /// Changed files waiting for their debounce, by path, with the time of the last change.
    pub(crate) changed: HashMap<String, u64>,
    /// Vanished files waiting for their deletion, by path, with the time the deletion becomes final.
    pub(crate) gone: HashMap<String, u64>,
    /// Notes whose file vanished, by hash of their text (`notes_core::text_hash`): a new file with that text is the
    /// same note, moved. Entries are (note id, path).
    pub(crate) vanished: HashMap<String, Vec<(String, String)>>,
    pub(crate) changes: Vec<Change>,
    /// Notes edited since the last autosaved version.
    pub(crate) edited: BTreeSet<String>,
    pub(crate) last_edit: Option<u64>,
}

impl Backend {
    /// Creates a new space in `root` with a new identity. Returns the 24 recovery words, which the caller
    /// shows once: they are not stored anywhere, and they are wiped when dropped. Existing `.md` files in `root`
    /// become notes.
    pub fn create(root: &Path, ks: &mut dyn KeyStore) -> Result<(Backend, Zeroizing<Vec<String>>)> {
        let phrase = RecoveryPhrase::generate()?;
        let owner = UserKeys::from_phrase(&phrase)?;
        let words = Zeroizing::new(phrase.as_str().split(' ').map(str::to_string).collect());
        drop(phrase);
        let opened = create_space(root, owner, ks, now_ms() / 1000)?;
        Ok((Self::start(opened, root)?, words))
    }

    /// Opens the space in `root`. Fails with `needs_phrase` when this device has no keys for it, or has keys but
    /// not the current epoch key: then `recover` takes the phrase.
    pub fn open(root: &Path, ks: &mut dyn KeyStore) -> Result<Backend> {
        // a half key (one slot only) counts as none: recovery makes it again
        if ks.get(Slot::DeviceSign)?.is_none() || ks.get(Slot::DeviceBox)?.is_none() {
            return Err(BridgeError::new(
                "needs_phrase",
                "Ta przestrzeń wymaga frazy odzyskiwania na tym komputerze.",
            ));
        }
        let opened = open_space(root, ks)?;
        Self::start(opened, root)
    }

    /// Opens the space in `root` for a device whose key store is empty, from the recovery phrase (SZYFROWANIE
    /// §8b). Nothing is written to the key store unless the phrase belongs to a member and holds the current key.
    pub fn recover(root: &Path, ks: &mut dyn KeyStore, words: &str) -> Result<Backend> {
        let user = UserKeys::from_phrase(&RecoveryPhrase::parse(words)?)?;
        let opened = recover_existing(root, user, ks, now_ms() / 1000)?;
        Self::start(opened, root)
    }

    /// Everything a space needs once it is open: the search index, the folder watcher, and the files that
    /// no note holds yet.
    fn start(opened: Opened, root: &Path) -> Result<Backend> {
        let (search, fresh) = Index::open(root)?;
        let watch = Watch::start(root)
            .map_err(|e| BridgeError::new("watch", format!("Nie można obserwować folderu: {e}")))?;
        let mut backend = Backend {
            opened,
            root: root.to_path_buf(),
            search,
            watch,
            changed: HashMap::new(),
            gone: HashMap::new(),
            vanished: HashMap::new(),
            changes: Vec::new(),
            edited: BTreeSet::new(),
            last_edit: None,
        };
        if fresh {
            // a new index starts with every note queued, so the first search after an upgrade finds them all
            for (id, _) in backend.opened.space.notes() {
                backend.search.mark(&id);
            }
        }
        // notes deleted long ago leave the trash for good; a failure must not keep the space from opening
        let cutoff = notes_core::trash_cutoff(now_ms() as i64);
        if let Err(e) = backend.opened.space.purge_trash(cutoff) {
            eprintln!("notes: could not empty the old trash: {e}");
        }
        backend.adopt_files()?;
        // files other programs changed while the app was closed: the first tick reads them, like any other change
        let now = now_ms();
        for rel in backend.opened.space.files_changed_on_disk()? {
            backend.changed.insert(rel, now);
        }
        Ok(backend)
    }

    /// The space type, `notatki` or `organizacja`.
    pub fn space_kind(&self) -> &'static str {
        self.opened.space.kind()
    }

    pub fn set_space_kind(&mut self, kind: &str) -> Result<()> {
        Ok(self.opened.space.set_kind(kind)?)
    }

    /// The folder's name is the space's name.
    pub fn space_name(&self) -> String {
        self.root.file_name().map_or_else(
            || "Przestrzeń".to_string(),
            |n| n.to_string_lossy().into_owned(),
        )
    }

    /// Reads the folders on disk, so this costs a walk of the space; fine for a few thousand notes.
    // shortcut: list_tree walks the whole folder on every call, upgrade to a cached folder list kept up to date by the watcher when spaces reach ~10 000 files
    pub fn list_tree(&self) -> Result<TreeListing> {
        let notes: Vec<TreeItem> = self
            .opened
            .space
            .notes()
            .into_iter()
            .map(|(id, path)| TreeItem { id, path })
            .collect();
        let mut folders: HashSet<String> = folders::scan(&self.root)?.dirs.into_iter().collect();
        for note in &notes {
            let segs: Vec<&str> = note.path.split('/').collect();
            for i in 1..segs.len() {
                folders.insert(segs[..i].join("/"));
            }
        }
        let mut folders: Vec<String> = folders.into_iter().collect();
        folders.sort();
        Ok(TreeListing { notes, folders })
    }

    pub fn create_note(&mut self, path: &str) -> Result<String> {
        let id = self.opened.space.create_note(path)?;
        self.search.mark(&id);
        Ok(id)
    }

    pub fn create_folder(&mut self, path: &str) -> Result<()> {
        if !folders::valid(path) {
            return Err(BridgeError::new(
                "invalid_path",
                format!("Nieprawidłowa ścieżka: {path}"),
            ));
        }
        if !folders::no_symlinks(&self.root, path) {
            return Err(BridgeError::new(
                "invalid_path",
                format!("Nieprawidłowa ścieżka: {path}"),
            ));
        }
        if self.root.join(path).exists() {
            return Err(BridgeError::new(
                "path_taken",
                format!("Ścieżka jest zajęta: {path}"),
            ));
        }
        fs::create_dir_all(self.root.join(path))?;
        Ok(())
    }

    pub fn rename(&mut self, id: &str, path: &str) -> Result<()> {
        self.opened.space.rename_note(id, path)?;
        self.search.mark(id);
        Ok(())
    }

    /// Moves every note under `from` to `to`, then removes the folders left empty. A folder with no notes
    /// is moved as a whole.
    pub fn rename_folder(&mut self, from: &str, to: &str) -> Result<()> {
        // `from` is joined onto the root and may be moved as a whole, so it must be a plain folder too
        for path in [from, to] {
            if !folders::valid(path) {
                return Err(BridgeError::new(
                    "invalid_path",
                    format!("Nieprawidłowa ścieżka: {path}"),
                ));
            }
        }
        if to == from {
            return Ok(());
        }
        if to.starts_with(&format!("{from}/")) {
            return Err(BridgeError::new(
                "invalid_path",
                "Folder nie może być przeniesiony do siebie samego",
            ));
        }
        // a case-only change is the same folder on a case-insensitive disk
        if to.to_lowercase() != from.to_lowercase() && self.root.join(to).exists() {
            return Err(BridgeError::new(
                "path_taken",
                format!("Ścieżka jest zajęta: {to}"),
            ));
        }
        let prefix = format!("{from}/");
        let moved: Vec<(String, String)> = self
            .opened
            .space
            .notes()
            .into_iter()
            .filter_map(|(id, path)| {
                let rest = path.strip_prefix(&prefix)?.to_string();
                Some((id, format!("{to}/{rest}")))
            })
            .collect();
        let old = self.root.join(from);
        if moved.is_empty() {
            if !old.is_dir() {
                return Err(BridgeError::new(
                    "not_found",
                    format!("Nie ma folderu: {from}"),
                ));
            }
            fs::create_dir_all(self.root.join(to).parent().unwrap_or(&self.root))?;
            fs::rename(&old, self.root.join(to))?;
            return Ok(());
        }
        for (id, path) in moved {
            self.opened.space.rename_note(&id, &path)?;
            self.search.mark(&id);
        }
        folders::remove_empty_dirs(&old);
        Ok(())
    }

    pub fn delete(&mut self, id: &str) -> Result<()> {
        self.opened.space.delete_note(id, now_ms() as i64)?;
        self.search.remove(id)
    }

    /// Deletes a folder, every tracked note below it and any remaining files in that folder.
    /// The path is validated and checked for symlinks before it is joined to the space root.
    pub fn delete_folder(&mut self, path: &str) -> Result<()> {
        if !folders::valid(path) || !folders::no_symlinks(&self.root, path) {
            return Err(BridgeError::new(
                "invalid_path",
                format!("Nieprawidłowa ścieżka: {path}"),
            ));
        }
        let folder = self.root.join(path);
        if !folder.is_dir() {
            return Err(BridgeError::new(
                "not_found",
                format!("Nie ma folderu: {path}"),
            ));
        }
        let prefix = format!("{path}/");
        let notes: Vec<String> = self
            .opened
            .space
            .notes()
            .into_iter()
            .filter_map(|(id, note_path)| note_path.starts_with(&prefix).then_some(id))
            .collect();
        for id in notes {
            self.opened.space.delete_note(&id, now_ms() as i64)?;
            self.search.remove(&id)?;
        }
        // delete_note removes Markdown projections. Remove empty directories and other files that
        // belonged to the folder (for example attachments) after the encrypted log is updated.
        if folder.exists() {
            fs::remove_dir_all(folder)?;
        }
        Ok(())
    }

    pub fn list_trash(&self) -> Result<Vec<TrashItem>> {
        Ok(self
            .opened
            .space
            .trash()
            .into_iter()
            .map(|(id, path, deleted_at)| TrashItem {
                id,
                path,
                deleted_at,
            })
            .collect())
    }

    /// Brings a trashed note back; returns the path it has now (it may differ when the old one is taken).
    pub fn restore_note(&mut self, id: &str) -> Result<String> {
        let path = self.opened.space.restore_note(id)?;
        self.search.mark(id);
        Ok(path)
    }

    pub fn purge_note(&mut self, id: &str) -> Result<()> {
        Ok(self.opened.space.purge_note(id)?)
    }

    /// The note's full Yjs state. Loads the note if it was cold, and records that it was used.
    pub fn open_note(&mut self, id: &str) -> Result<Vec<u8>> {
        self.opened.space.touch(id, now_ms())?;
        Ok(self.opened.space.state(id)?)
    }

    pub fn note_text(&mut self, id: &str) -> Result<String> {
        Ok(self.opened.space.text(id)?)
    }

    /// Commits a Yjs update as one message, then writes the note's `.md` file. The update is committed
    /// even if the file write fails; the next update writes the file again.
    pub fn apply_update(&mut self, id: &str, update: &[u8]) -> Result<()> {
        if self.space_kind() == notes_core::KIND_ORGANIZATION {
            let people = self.organization_handles()?;
            self.opened.space.apply_task_update(id, update, &people)?;
        } else {
            self.opened.space.apply_local_update(id, update)?;
        }
        // a change from outside taken in by the write is sent to the editor, which merges it into its text
        if let Some(outcome) = self.opened.space.write_file(id)? {
            self.report(Some(id.to_string()), outcome)?;
        }
        self.search.mark(id);
        self.edited.insert(id.to_string());
        self.last_edit = Some(now_ms());
        Ok(())
    }

    /// Runs the background work once, at the current time: file changes, autosaved versions, the search index,
    /// and a batch of cold notes. Returns how many cold notes are still waiting.
    pub fn tick(&mut self) -> Result<usize> {
        self.tick_at(now_ms())
    }

    /// `tick` with the time given, so that the debounce and the autosave can be tested.
    pub fn tick_at(&mut self, now: u64) -> Result<usize> {
        self.apply_watch(now)?;
        let paths: HashMap<String, String> = self.opened.space.notes().into_iter().collect();
        self.search.index_batch(&mut self.opened.space, &paths)?;
        self.opened.space.load_pending(TICK_BATCH)?;
        Ok(self.opened.space.pending_count())
    }

    /// Finds notes by their text, best match first (see `search::match_expr` for the query rules).
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let paths: HashMap<String, String> = self.opened.space.notes().into_iter().collect();
        let mut hits = Vec::new();
        for (id, snippet) in self.search.query(query, limit)? {
            if let Some(path) = paths.get(&id) {
                hits.push(SearchHit {
                    id,
                    path: path.clone(),
                    snippet,
                });
            }
        }
        Ok(hits)
    }

    /// The saved versions of a note, newest first.
    pub fn list_versions(&self, id: &str) -> Result<Vec<VersionItem>> {
        Ok(self
            .opened
            .space
            .versions(id)?
            .into_iter()
            .map(|v| VersionItem {
                id: v.id,
                time_ms: v.time_ms,
                reason: v.reason,
            })
            .collect())
    }

    pub fn version_text(&self, vid: i64) -> Result<String> {
        Ok(self.opened.space.version_text(vid)?)
    }

    /// Restores a version as new edits; the editor gets the restored state.
    pub fn restore_version(&mut self, id: &str, vid: i64) -> Result<()> {
        if let Some(outcome) = self.opened.space.restore_version(id, vid)? {
            self.report(Some(id.to_string()), outcome)?;
        }
        self.write_back(id)
    }

    pub fn list_conflicts(&self) -> Result<Vec<String>> {
        Ok(self.opened.space.conflicts()?)
    }

    pub fn conflict_texts(&mut self, id: &str) -> Result<ConflictTexts> {
        let (ours, theirs) = self.opened.space.conflict_texts(id)?;
        let theirs_hash = notes_core::text_hash(&theirs);
        Ok(ConflictTexts {
            ours,
            theirs,
            theirs_hash,
        })
    }

    /// Resolves a conflict with the text the user chose (the note's, the file's, or a mix). `seen_theirs` is the
    /// `theirs_hash` of the view the choice was made in.
    pub fn resolve_conflict(&mut self, id: &str, text: &str, seen_theirs: &str) -> Result<()> {
        self.opened.space.resolve_conflict(id, text, seen_theirs)?;
        self.write_back(id)
    }

    /// After a change the editor did not make: index the note and queue its state for the UI.
    fn write_back(&mut self, id: &str) -> Result<()> {
        self.search.mark(id);
        self.note_update(id)
    }

    /// Saves a pasted or dropped file under `assets/`. Returns its relative path, for `![[...]]` links.
    pub fn save_attachment(&mut self, name: &str, bytes: &[u8]) -> Result<String> {
        attach::save(&self.root, name, bytes)
    }

    pub fn read_attachment(&self, rel: &str) -> Result<Vec<u8>> {
        attach::read(&self.root, rel)
    }

    /// Makes a note of every `.md` file in the folder that no note holds yet (PLAN etap 2 pkt 5). The file
    /// keeps its bytes; files already known to the space are skipped.
    fn adopt_files(&mut self) -> Result<()> {
        let known: HashSet<String> = self
            .opened
            .space
            .notes()
            .into_iter()
            .map(|(_, path)| path.to_lowercase())
            .collect();
        for rel in folders::scan(&self.root)?.files {
            if known.contains(&rel.to_lowercase()) {
                continue;
            }
            let Ok(text) = fs::read_to_string(self.root.join(&rel)) else {
                eprintln!("notes: {rel} is not UTF-8 text, it was not imported");
                continue;
            };
            match self.opened.space.import_note(&rel, &text) {
                Ok(id) => self.search.mark(&id),
                Err(notes_core::Error::PathTaken(_) | notes_core::Error::InvalidPath(_)) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
#[path = "backend_tests.rs"]
mod tests;

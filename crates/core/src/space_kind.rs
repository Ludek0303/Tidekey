//! The space type, `notatki` or `organizacja`. Each device that switched the space writes a flag under its own key
//! in the meta document, and the type is `organizacja` while any flag exists. Under a different key, a message
//! cannot downgrade the space. The legacy key `kind` (spaces made before the flags) counts too.

use yrs::{Any, Map, Out, Transact};

use super::{META_DOC, Space};
use crate::{Error, Result};

pub const KIND_NOTES: &str = "notatki";
pub const KIND_ORGANIZATION: &str = "organizacja";

const SETTINGS: &str = "settings";
const FLAG_PREFIX: &str = "org:";

impl Space {
    /// The space type: `organizacja` when the legacy key says so or any device's flag exists, whatever its value.
    // shortcut: until stage B, a writer can still delete a flag or the legacy key; the owner-only roles of stage B are what stop that
    pub fn kind(&self) -> &'static str {
        let settings = self.meta.get_or_insert_map(SETTINGS);
        let txn = self.meta.transact();
        let legacy = matches!(settings.get(&txn, "kind"), Some(Out::Any(Any::String(k))) if &*k == KIND_ORGANIZATION);
        let flagged = settings.iter(&txn).any(|(key, _)| key.starts_with(FLAG_PREFIX));
        if legacy || flagged { KIND_ORGANIZATION } else { KIND_NOTES }
    }

    /// Switches the space to `kind`. Only `organizacja` can be set; the change is a message like any other.
    // shortcut: any member who can write the meta document can set the flag, and the switch is not limited to the owner until stage B's roles; the owner check goes in with them
    pub fn set_kind(&mut self, kind: &str) -> Result<()> {
        if kind != KIND_NOTES && kind != KIND_ORGANIZATION {
            return Err(Error::UnknownKind(kind.to_string()));
        }
        if kind == KIND_NOTES {
            // a space never goes back, so `notatki` is accepted only as "already notes"
            return if self.kind() == KIND_NOTES { Ok(()) } else { Err(Error::KindDowngrade) };
        }
        if self.kind() == KIND_ORGANIZATION {
            return Ok(());
        }
        self.check_writable()?;
        let flag = format!("{FLAG_PREFIX}{}", hex::encode(self.device.verifying_key().to_bytes()));
        let update = {
            let settings = self.meta.get_or_insert_map(SETTINGS);
            let mut txn = self.meta.transact_mut();
            settings.insert(&mut txn, flag.as_str(), true);
            txn.encode_update_v1()
        };
        self.append(META_DOC, &update)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{create_test, open_test};
    use super::*;
    use yrs::updates::decoder::Decode;

    #[test]
    fn a_new_space_is_notes_and_the_type_can_only_go_up() {
        let dir = tempfile::tempdir().unwrap();
        let mut sp = create_test(dir.path()).unwrap();
        assert_eq!(sp.kind(), KIND_NOTES);
        sp.set_kind(KIND_NOTES).unwrap();
        assert!(matches!(sp.set_kind("ogród"), Err(Error::UnknownKind(_))));
        assert_eq!(sp.kind(), KIND_NOTES);

        sp.set_kind(KIND_ORGANIZATION).unwrap();
        sp.set_kind(KIND_ORGANIZATION).unwrap();
        assert!(matches!(sp.set_kind(KIND_NOTES), Err(Error::KindDowngrade)));
        assert_eq!(sp.kind(), KIND_ORGANIZATION);
    }

    #[test]
    fn the_type_survives_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        create_test(dir.path()).unwrap().set_kind(KIND_ORGANIZATION).unwrap();
        assert_eq!(open_test(dir.path()).unwrap().kind(), KIND_ORGANIZATION);
    }

    #[test]
    fn a_type_change_is_logged_as_a_message() {
        let dir = tempfile::tempdir().unwrap();
        let mut sp = create_test(dir.path()).unwrap();
        let before = sp.messages().unwrap().len();
        sp.set_kind(KIND_ORGANIZATION).unwrap();
        assert_eq!(sp.messages().unwrap().len(), before + 1);
    }

    /// Writes meta settings directly, as a message from another device would.
    fn write_settings(sp: &mut Space, write: impl FnOnce(&yrs::MapRef, &mut yrs::TransactionMut)) {
        let settings = sp.meta.get_or_insert_map(SETTINGS);
        let mut txn = sp.meta.transact_mut();
        write(&settings, &mut txn);
        drop(txn);
    }

    #[test]
    fn a_false_flag_still_means_organization() {
        let dir = tempfile::tempdir().unwrap();
        let mut sp = create_test(dir.path()).unwrap();
        write_settings(&mut sp, |m, t| {
            m.insert(t, "org:someone", false);
        });
        assert_eq!(sp.kind(), KIND_ORGANIZATION);
    }

    #[test]
    fn the_legacy_key_means_organization() {
        let dir = tempfile::tempdir().unwrap();
        let mut sp = create_test(dir.path()).unwrap();
        write_settings(&mut sp, |m, t| {
            m.insert(t, "kind", KIND_ORGANIZATION);
        });
        assert_eq!(sp.kind(), KIND_ORGANIZATION);
    }

    #[test]
    fn a_legacy_key_of_notes_alone_means_notes() {
        let dir = tempfile::tempdir().unwrap();
        let mut sp = create_test(dir.path()).unwrap();
        write_settings(&mut sp, |m, t| {
            m.insert(t, "kind", KIND_NOTES);
        });
        assert_eq!(sp.kind(), KIND_NOTES);
    }

    #[test]
    fn a_deleted_flag_keeps_the_type_only_with_the_legacy_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut sp = create_test(dir.path()).unwrap();
        sp.set_kind(KIND_ORGANIZATION).unwrap();
        let flag = format!("org:{}", hex::encode(sp.device.verifying_key().to_bytes()));
        write_settings(&mut sp, |m, t| {
            m.remove(t, &flag);
        });
        // the shortcut: with no flag and no legacy key, a writer who deleted the flag has downgraded the space
        assert_eq!(sp.kind(), KIND_NOTES);
        write_settings(&mut sp, |m, t| {
            m.insert(t, "kind", KIND_ORGANIZATION);
        });
        assert_eq!(sp.kind(), KIND_ORGANIZATION);
    }

    #[test]
    fn a_write_of_notes_under_another_key_does_not_downgrade() {
        let dir = tempfile::tempdir().unwrap();
        let mut sp = create_test(dir.path()).unwrap();
        sp.set_kind(KIND_ORGANIZATION).unwrap();
        // what a message from another device could write: the old single key, set to notes
        let update = {
            let settings = sp.meta.get_or_insert_map(SETTINGS);
            let mut txn = sp.meta.transact_mut();
            settings.insert(&mut txn, "kind", "notatki");
            settings.insert(&mut txn, "org:someone-else", false);
            txn.encode_update_v1()
        };
        sp.meta.transact_mut().apply_update(yrs::Update::decode_v1(&update).unwrap()).unwrap();
        assert_eq!(sp.kind(), KIND_ORGANIZATION);
    }
}

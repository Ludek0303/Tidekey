//! Secret storage for device keys and epoch keys (SZYFROWANIE §8b). The recovery phrase is never
//! stored, so there is no slot for it.

use std::collections::BTreeMap;

use zeroize::Zeroizing;

use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Slot {
    /// Device Ed25519 seed (32 B).
    DeviceSign,
    /// Device X25519 secret (32 B).
    DeviceBox,
    /// Space key of one epoch (32 B).
    EpochKey { space: [u8; 16], epoch: u32 },
    /// Highest participants-log head this device has seen for a space: index (u64 LE) and hash (32 B).
    /// Kept apart from space.db, so restoring an old folder cannot roll the log back.
    AclHead { space: [u8; 16] },
}

pub trait KeyStore {
    fn get(&self, slot: Slot) -> Result<Option<Zeroizing<Vec<u8>>>>;
    fn set(&mut self, slot: Slot, value: &[u8]) -> Result<()>;
    fn delete(&mut self, slot: Slot) -> Result<()>;
}

/// In-memory store for tests and for sessions that keep nothing on disk.
#[derive(Debug, Default)]
pub struct MemoryKeyStore(BTreeMap<Slot, Zeroizing<Vec<u8>>>);

impl KeyStore for MemoryKeyStore {
    fn get(&self, slot: Slot) -> Result<Option<Zeroizing<Vec<u8>>>> {
        Ok(self.0.get(&slot).cloned())
    }

    fn set(&mut self, slot: Slot, value: &[u8]) -> Result<()> {
        self.0.insert(slot, Zeroizing::new(value.to_vec()));
        Ok(())
    }

    fn delete(&mut self, slot: Slot) -> Result<()> {
        self.0.remove(&slot);
        Ok(())
    }
}

#[cfg(feature = "os-keyring")]
pub use os::OsKeyStore;

#[cfg(feature = "os-keyring")]
mod os {
    use super::{KeyStore, Slot};
    use crate::{Error, Result};
    use data_encoding::HEXLOWER;
    use keyring::Entry;
    use zeroize::Zeroizing;

    const SERVICE: &str = "notes-organizations";

    /// OS credential store (Secret Service / Keychain / Credential Manager) under service `notes`.
    // shortcut: no app uses it yet, the Tauri app wires it up in stage 3
    #[derive(Debug, Default)]
    pub struct OsKeyStore;

    impl OsKeyStore {
        fn entry(slot: Slot) -> Result<Entry> {
            Entry::new(SERVICE, &account(slot)).map_err(|e| Error::Store(e.to_string()))
        }
    }

    fn account(slot: Slot) -> String {
        match slot {
            Slot::DeviceSign => "device-sign".to_string(),
            Slot::DeviceBox => "device-box".to_string(),
            Slot::EpochKey { space, epoch } => format!("epoch-{}-{epoch}", HEXLOWER.encode(&space)),
            Slot::AclHead { space } => format!("acl-head-{}", HEXLOWER.encode(&space)),
        }
    }

    impl KeyStore for OsKeyStore {
        fn get(&self, slot: Slot) -> Result<Option<Zeroizing<Vec<u8>>>> {
            match Self::entry(slot)?.get_secret() {
                Ok(secret) => Ok(Some(Zeroizing::new(secret))),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(Error::Store(e.to_string())),
            }
        }

        fn set(&mut self, slot: Slot, value: &[u8]) -> Result<()> {
            Self::entry(slot)?
                .set_secret(value)
                .map_err(|e| Error::Store(e.to_string()))
        }

        fn delete(&mut self, slot: Slot) -> Result<()> {
            match Self::entry(slot)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(Error::Store(e.to_string())),
            }
        }
    }
}

#[cfg(test)]
#[path = "keystore_tests.rs"]
mod tests;

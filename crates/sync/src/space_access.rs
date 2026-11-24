//! What this device may do in a space, derived from the replayed participants log (SZYFROWANIE §3, §8a):
//! the acceptance rules and the epoch keys, plugged into `notes_core::Access`.

use std::collections::BTreeMap;

use notes_core::access::{Access, Header, Key};
use zeroize::Zeroizing;

use crate::acl_state::AclState;
use crate::cert::CertStore;
use crate::device::DeviceKeys;
use crate::keystore::{KeyStore, Slot};
use crate::policy::{self, MessageHeader};
use crate::{Error, Result};

pub struct SpaceAccess {
    state: AclState,
    certs: CertStore,
    keys: BTreeMap<u32, Key>,
}

impl SpaceAccess {
    pub fn new(state: AclState, certs: CertStore, keys: BTreeMap<u32, Key>) -> Self {
        Self { state, certs, keys }
    }
}

impl Access for SpaceAccess {
    fn accept_document(&self, h: &Header, doc: &str) -> std::result::Result<(), String> {
        if !doc.starts_with('@') || doc == "@org/data" { return Ok(()); }
        if doc != "@org/admin" { return Err("unknown reserved document".into()); }
        let cert = self.certs.get(&h.device).ok_or("unknown device")?;
        if cert.user != self.state.owner { return Err("organization settings require the owner".into()); }
        Ok(())
    }
    fn current(&self) -> Option<(u32, Key)> {
        let key = self.keys.get(&self.state.epoch)?;
        Some((self.state.epoch, key.clone()))
    }

    fn key(&self, epoch: u32) -> Option<Key> {
        self.keys.get(&epoch).cloned()
    }

    fn accept(&self, h: &Header, msg_hash: &[u8; 32]) -> std::result::Result<(), String> {
        let header = MessageHeader {
            space: h.space,
            device: h.device,
            seq: h.seq,
            epoch: h.epoch,
        };
        policy::accept(&self.state, &self.certs, &header, msg_hash).map_err(|e| e.to_string())
    }
}

/// Space keys of every epoch up to the current one. The key store comes first; a key that only a device
/// envelope opens is cached there. Epochs with no key are left out (the caller decides if that matters).
pub fn load_keys(
    state: &AclState,
    device: &DeviceKeys,
    ks: &mut dyn KeyStore,
) -> Result<BTreeMap<u32, Key>> {
    let from_envelopes = state.epoch_keys_for_device(device);
    let mut out = BTreeMap::new();
    for epoch in 0..=state.epoch {
        let slot = Slot::EpochKey {
            space: state.space,
            epoch,
        };
        let key = match ks.get(slot)? {
            Some(stored) => Zeroizing::new(secret32(&stored)?),
            None => match from_envelopes.keys.get(&epoch) {
                Some(key) => {
                    ks.set(slot, &key[..])?;
                    Zeroizing::new(**key)
                }
                None => continue,
            },
        };
        out.insert(epoch, key);
    }
    Ok(out)
}

pub(crate) fn secret32(bytes: &[u8]) -> Result<[u8; 32]> {
    bytes
        .try_into()
        .map_err(|_| Error::Store("stored key has the wrong length".to_string()))
}

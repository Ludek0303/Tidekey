//! `SyncStore` of a device: the space opened on this machine, with its key store. Messages go through
//! `Space::receive`, which checks the access rules and stores the exact bytes.

use notes_core::Error as CoreError;
use notes_core::Received;

use crate::acl::AclEntry;
use crate::acl_state::{AclHead, AclState};
use crate::cert::{CertStore, DeviceCert};
use crate::keystore::KeyStore;
use crate::proto::VersionVector;
use crate::session::{AclBytes, Put, SyncStore};
use crate::space::{self, Opened, read_acl};
use crate::{Error, Result};

pub struct DeviceStore {
    pub opened: Opened,
    pub ks: Box<dyn KeyStore + Send>,
}

impl SyncStore for DeviceStore {
    fn space(&self) -> [u8; 16] {
        self.opened.acl.space
    }

    fn acl_head(&self) -> Option<AclHead> {
        Some(self.opened.acl.head())
    }

    fn acl(&self) -> Result<AclBytes> {
        let (entries, certs) = read_acl(&self.opened.root)?;
        Ok((
            entries.iter().map(AclEntry::to_bytes).collect(),
            certs.iter().map(|c| c.to_bytes().to_vec()).collect(),
        ))
    }

    fn import_acl(&mut self, entries: &[Vec<u8>], certs: &[Vec<u8>]) -> Result<bool> {
        let entries = entries
            .iter()
            .map(|b| AclEntry::from_bytes(b))
            .collect::<Result<Vec<_>>>()?;
        let certs = certs
            .iter()
            .map(|b| DeviceCert::from_bytes(b))
            .collect::<Result<Vec<_>>>()?;
        space::import_acl(&mut self.opened, &mut *self.ks, entries, certs)
    }

    fn acl_state(&self) -> Option<&AclState> {
        Some(&self.opened.acl)
    }

    fn certs(&self) -> &CertStore {
        &self.opened.certs
    }

    fn version_vector(&self) -> Result<VersionVector> {
        Ok(self.opened.space.version_vector()?)
    }

    fn after(&self, vv: &VersionVector, max_bytes: usize) -> Result<Vec<Vec<u8>>> {
        Ok(self.opened.space.messages_after(vv, max_bytes)?)
    }

    fn recover(&mut self) {
        if let Err(e) = self.opened.space.reload() {
            eprintln!("notes: could not rebuild the space after a panic: {e}");
        }
    }

    fn put(&mut self, msg: &[u8]) -> Result<Put> {
        outcome(self.opened.space.receive(msg))
    }

    fn put_batch(&mut self, msgs: &[Vec<u8>]) -> Result<Vec<Put>> {
        self.opened
            .space
            .receive_batch(msgs)?
            .into_iter()
            .map(outcome)
            .collect()
    }
}

/// What a stored-or-refused message means to the session. Refusals are the peer's fault and are counted;
/// a storage failure stops the session.
fn outcome(r: notes_core::Result<Received>) -> Result<Put> {
    Ok(match r {
        Ok(Received::Applied) => Put::New,
        Ok(Received::Known) => Put::Known,
        Err(CoreError::Denied { reason, .. }) => Put::Rejected(reason),
        Err(CoreError::BadSignature { .. }) => Put::Rejected("bad signature".to_string()),
        Err(CoreError::BadMessage { reason, .. }) => Put::Rejected(reason.to_string()),
        Err(CoreError::NoEpochKey(h)) => Put::Rejected(format!("no key for epoch {}", h.epoch)),
        Err(CoreError::Crdt(_)) => Put::Rejected("malformed update".to_string()),
        Err(e) => return Err(Error::from(e)),
    })
}

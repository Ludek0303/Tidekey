//! Owner operations on the participants log (SZYFROWANIE §8a, §8b, §8c). Each one appends signed entries,
//! stores them with the new head and certificates, and switches this device to the new access rules.
//! Cutoffs come from the messages this device stores: the last seq of each device and its BLAKE3.

use notes_core::Records;

use crate::acl::{Cutoff, Role};
use crate::acl_log::AclLog;
use crate::cert::{CertStore, DeviceCert};
use crate::invite::{JoinReveal, PendingInvites};
use crate::keystore::KeyStore;
use crate::space::{Opened, cert_rows, head_of, log_rows, refresh, remember_head};
use crate::{Error, Result};

/// Approves a joiner whose typed code matches. The joiner is added with `role` and its certificate stored.
pub fn approve_join(
    opened: &mut Opened,
    ks: &mut dyn KeyStore,
    invites: &mut PendingInvites,
    reveal: &JoinReveal,
    role: Role,
    now: u64,
    typed_code: &str,
) -> Result<()> {
    let user = invites.approve(reveal, now, typed_code)?;
    opened.certs.insert(reveal.cert)?;
    let cert = reveal.cert;
    commit(opened, ks, &[cert], |log, certs| log.add(user, role, certs))
}

/// Removes a member; the new epoch goes to everyone else, and every known device of theirs is cut.
pub fn remove_member(opened: &mut Opened, ks: &mut dyn KeyStore, user: [u8; 32]) -> Result<()> {
    let cuts = user_cutoffs(opened, &user)?;
    commit(opened, ks, &[], |log, certs| log.remove(user, cuts, certs))
}

/// Changes a member's role. Lowering it starts a new epoch and cuts every known device of the member.
pub fn change_role(
    opened: &mut Opened,
    ks: &mut dyn KeyStore,
    user: [u8; 32],
    role: Role,
) -> Result<()> {
    let cuts = user_cutoffs(opened, &user)?;
    commit(opened, ks, &[], |log, certs| {
        log.change_role(user, role, cuts, certs)
    })
}

/// Revokes one device of a member at its last known message; the new epoch skips that device.
pub fn revoke_device(opened: &mut Opened, ks: &mut dyn KeyStore, device: [u8; 32]) -> Result<()> {
    let (seq, hash) = opened.space.cutoff(&device)?;
    commit(opened, ks, &[], |log, certs| {
        log.revoke_device((device, seq, hash), certs)
    })
}

fn user_cutoffs(opened: &Opened, user: &[u8; 32]) -> Result<Vec<Cutoff>> {
    opened
        .certs
        .certs_of(user)
        .iter()
        .map(|cert| -> Result<Cutoff> {
            let (seq, hash) = opened.space.cutoff(&cert.device)?;
            Ok((cert.device, seq, hash))
        })
        .collect()
}

/// Runs one owner operation on the log, then persists what it added and refreshes the access rules.
fn commit(
    opened: &mut Opened,
    ks: &mut dyn KeyStore,
    new_certs: &[DeviceCert],
    op: impl FnOnce(&mut AclLog, &CertStore) -> Result<()>,
) -> Result<()> {
    let log = opened
        .owner
        .as_mut()
        .ok_or(Error::Space("this device is not an owner device"))?;
    let before = log.entries().len();
    op(log, &opened.certs)?;
    let added = log_rows(&log.entries()[before..]);
    let head = head_of(log.entries());
    let state = log.state().clone();
    Records::open(&opened.root)?.put_acl(&added, &cert_rows(new_certs), head)?;
    remember_head(ks, &opened.acl.space, head)?;
    opened.acl = state;
    refresh(opened, ks)
}

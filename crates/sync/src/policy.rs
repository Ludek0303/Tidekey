//! Message acceptance rules (SZYFROWANIE §3 and §8a), used by participants and the storage node.
//! The Ed25519 signature over header + ciphertext is checked by `notes-core` (`message::open`);
//! the caller must check it as well, before or after `accept`. This module never decrypts.

use ed25519_dalek::{Signature, VerifyingKey};
use notes_core::access::message_hash;
use thiserror::Error;

use crate::acl_state::AclState;
use crate::cert::CertStore;

pub const HEADER_LEN: usize = 85;
const SIG_LEN: usize = 64;
const VERSION: u8 = 1;

/// Plain header of a message (`version ‖ space ‖ device ‖ seq ‖ epoch ‖ nonce`, layout from core).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageHeader {
    pub space: [u8; 16],
    pub device: [u8; 32],
    pub seq: u64,
    pub epoch: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum Reject {
    #[error("message from another space")]
    OtherSpace,
    #[error("epoch newer than the current one")]
    FutureEpoch,
    #[error("device has no valid certificate")]
    NoCert,
    #[error("device is revoked")]
    Revoked,
    #[error("message sent after the author lost access")]
    AfterDeparture,
    #[error("message at the cut seq has different content than the one the owner accepted")]
    CutMismatch,
    #[error("author cannot write in this epoch")]
    NotWriter,
    #[error("bad signature")]
    BadSignature,
    #[error("malformed message")]
    Malformed,
}

pub fn parse_header(bytes: &[u8]) -> Option<MessageHeader> {
    if bytes.len() < HEADER_LEN || bytes[0] != VERSION {
        return None;
    }
    Some(MessageHeader {
        space: bytes[1..17].try_into().ok()?,
        device: bytes[17..49].try_into().ok()?,
        seq: u64::from_le_bytes(bytes[49..57].try_into().ok()?),
        epoch: u32::from_le_bytes(bytes[57..61].try_into().ok()?),
    })
}

/// Checks the §8a rules in order. Any failure rejects the message.
// shortcut: messages below the cut seq can still be equivocated by a stolen device, until messages chain per device (prev hash in the core header)
pub fn accept(
    state: &AclState,
    certs: &CertStore,
    h: &MessageHeader,
    msg_hash: &[u8; 32],
) -> Result<(), Reject> {
    if h.space != state.space {
        return Err(Reject::OtherSpace);
    }
    if h.epoch > state.epoch {
        return Err(Reject::FutureEpoch);
    }
    let cert = certs.get(&h.device).ok_or(Reject::NoCert)?;
    cert.verify().map_err(|_| Reject::NoCert)?;

    if let Some((cut_seq, cut_hash)) = state.revoked.get(&h.device) {
        if h.seq > *cut_seq {
            return Err(Reject::Revoked);
        }
        if h.seq == *cut_seq && msg_hash != cut_hash {
            return Err(Reject::CutMismatch);
        }
    }
    // A device of a user who lost rights may only send what was known before the change.
    // Devices missing from the cutoff list get nothing, including devices certified later.
    for (change_epoch, cuts) in state.departures.get(&cert.user).into_iter().flatten() {
        if h.epoch >= *change_epoch {
            continue;
        }
        match cuts.get(&h.device) {
            None => return Err(Reject::AfterDeparture),
            Some((cut_seq, _)) if h.seq > *cut_seq => return Err(Reject::AfterDeparture),
            Some((cut_seq, cut_hash)) if h.seq == *cut_seq && msg_hash != cut_hash => {
                return Err(Reject::CutMismatch);
            }
            Some(_) => {}
        }
    }
    let writer = state
        .writers
        .get(&h.epoch)
        .is_some_and(|set| set.contains(&cert.user));
    if !writer {
        return Err(Reject::NotWriter);
    }
    Ok(())
}

/// Full check of a message the caller cannot decrypt (a storage node): the Ed25519 signature over
/// everything before it, then the acceptance rules. Returns the header on success.
pub fn check_message(
    state: &AclState,
    certs: &CertStore,
    bytes: &[u8],
) -> Result<MessageHeader, Reject> {
    if bytes.len() < HEADER_LEN + SIG_LEN {
        return Err(Reject::Malformed);
    }
    let h = parse_header(bytes).ok_or(Reject::Malformed)?;
    let (signed, sig) = bytes.split_at(bytes.len() - SIG_LEN);
    let key = VerifyingKey::from_bytes(&h.device).map_err(|_| Reject::BadSignature)?;
    let sig = Signature::from_slice(sig).map_err(|_| Reject::BadSignature)?;
    key.verify_strict(signed, &sig)
        .map_err(|_| Reject::BadSignature)?;
    accept(state, certs, &h, &message_hash(bytes))?;
    Ok(h)
}

/// Whether a device may take part in sync: certified, not revoked, and of a member (readers included).
pub fn peer_allowed(state: &AclState, certs: &CertStore, device: &[u8; 32]) -> bool {
    certs.get(device).is_some_and(|cert| {
        cert.verify().is_ok()
            && !state.revoked.contains_key(device)
            && state.members.contains_key(&cert.user)
    })
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;

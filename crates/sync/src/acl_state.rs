//! Result of replaying the participants log: who may write in which epoch, which epoch keys
//! each user and device can open, and which devices were cut off (SZYFROWANIE §7, §8a, §8b).

use std::collections::{BTreeMap, BTreeSet};

use zeroize::Zeroizing;

use crate::Result;
use crate::acl::Role;
use crate::device::DeviceKeys;
use crate::envelope::Envelope;
use crate::identity::UserKeys;

/// Epochs whose envelopes opened, and the ones that did not (kept apart, not an error).
#[derive(Debug, Default)]
pub struct EpochKeys {
    /// Epoch number -> space key.
    pub keys: BTreeMap<u32, Zeroizing<[u8; 32]>>,
    pub unopened: Vec<u32>,
}

/// Position and hash of the last entry of a log. The caller persists the highest head it has seen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AclHead {
    pub index: u64,
    pub hash: [u8; 32],
}

/// `(last seq accepted, BLAKE3 of that message)`.
pub type Cut = (u64, [u8; 32]);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Member {
    pub role: Role,
    pub boxk: [u8; 32],
}

/// `(epoch that started with the change, device -> cut)`.
pub type Departure = (u32, BTreeMap<[u8; 32], Cut>);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AclState {
    pub space: [u8; 16],
    pub owner: [u8; 32],
    pub epoch: u32,
    pub members: BTreeMap<[u8; 32], Member>,
    /// Users who could write while the epoch was current (only grows within an epoch).
    pub writers: BTreeMap<u32, BTreeSet<[u8; 32]>>,
    /// Per user who lost write rights: for every epoch that started with the change,
    /// the last seq known for each of the user's devices. Messages of older epochs stay valid up to it.
    pub departures: BTreeMap<[u8; 32], Vec<Departure>>,
    /// Revoked device -> cut (any epoch).
    pub revoked: BTreeMap<[u8; 32], Cut>,
    /// User sign key -> user-level envelopes addressed to that user, with their epoch.
    pub envelopes: BTreeMap<[u8; 32], Vec<(u32, Envelope)>>,
    /// Device sign key -> device-level envelopes addressed to that device, with their epoch.
    pub device_envelopes: BTreeMap<[u8; 32], Vec<(u32, Envelope)>>,
    /// Last entry of the replayed log.
    pub head: AclHead,
}

impl AclState {
    /// Whether a certificate from a peer is worth keeping: its user is a member, left the space (its devices
    /// are still cut by the log), or the device was revoked. Anything else is junk. A device already in
    /// `certs` is kept; a new one only while its user has fewer than `MAX_ACTIVE_DEVICES_PER_USER` active ones.
    pub fn keeps_cert(
        &self,
        certs: &crate::cert::CertStore,
        cert: &crate::cert::DeviceCert,
    ) -> bool {
        let relevant = self.members.contains_key(&cert.user)
            || self.departures.contains_key(&cert.user)
            || self.revoked.contains_key(&cert.device);
        if !relevant {
            return false;
        }
        if certs.get(&cert.device).is_some() {
            return true;
        }
        let active = certs
            .certs_of(&cert.user)
            .iter()
            .filter(|c| !self.revoked.contains_key(&c.device))
            .count();
        active < crate::cert::MAX_ACTIVE_DEVICES_PER_USER
    }

    /// Last entry of the replayed log; persist the highest one seen (see `AclLog::verify_extension`).
    pub fn head(&self) -> AclHead {
        self.head
    }

    pub fn writers_in_epoch(&self, epoch: u32) -> BTreeSet<[u8; 32]> {
        self.writers.get(&epoch).cloned().unwrap_or_default()
    }

    /// Opens every user-level envelope (setup and recovery from the phrase, §8b).
    /// Envelopes that do not open are listed in `unopened`, not treated as an error.
    pub fn epoch_keys(&self, user: &UserKeys) -> EpochKeys {
        let envelopes = self.envelopes.get(&user.public().sign);
        open_all(envelopes, |env, epoch| env.open(user, &self.space, epoch))
    }

    /// Opens the device-level envelopes of one device. A revoked or removed device gets
    /// nothing for the epochs after its cut.
    pub fn epoch_keys_for_device(&self, device: &DeviceKeys) -> EpochKeys {
        let envelopes = self.device_envelopes.get(&device.public().sign);
        open_all(envelopes, |env, epoch| {
            env.open_device(device, &self.space, epoch)
        })
    }
}

fn open_all(
    envelopes: Option<&Vec<(u32, Envelope)>>,
    open: impl Fn(&Envelope, u32) -> Result<Zeroizing<[u8; 32]>>,
) -> EpochKeys {
    let mut out = EpochKeys::default();
    for (epoch, env) in envelopes.into_iter().flatten() {
        match open(env, *epoch) {
            Ok(key) => {
                out.keys.insert(*epoch, key);
            }
            Err(_) => out.unopened.push(*epoch),
        }
    }
    out
}

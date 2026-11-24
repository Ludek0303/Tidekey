//! Participants log: strict replay (`AclLog::verify`) and the owner's builder (SZYFROWANIE §8a, §8b).
//! Every change that removes or lowers access starts a new epoch with a fresh random key.

use std::collections::BTreeMap;

use ed25519_dalek::SigningKey;
use zeroize::Zeroizing;

use crate::acl::{AclEntry, Body, Cutoff, DeviceEnvelopes, Role, Rotation, Signer};
use crate::acl_replay::{apply, genesis_state};
use crate::acl_state::{AclHead, AclState, Cut};
use crate::cert::{CertStore, DeviceCert};
use crate::device::DeviceKeys;
use crate::envelope::Envelope;
use crate::identity::{UserKeys, UserPublic};
use crate::{Error, Result};

/// Keys the owner signs its entries with: the user key (setup) or one of its devices (normal use).
// One owner session at a time; the size difference does not matter.
#[allow(clippy::large_enum_variant)]
pub enum Signing {
    User(UserKeys),
    Device { keys: DeviceKeys, cert: DeviceCert },
}

impl Signing {
    fn parts(&self) -> (Signer, &SigningKey) {
        match self {
            Signing::User(keys) => (Signer::OwnerUser, keys.sign_key()),
            Signing::Device { keys, cert } => (Signer::OwnerDevice(*cert), keys.sign_key()),
        }
    }
}

/// Owner-side log: appends signed entries and keeps the current epoch key.
pub struct AclLog {
    signing: Signing,
    entries: Vec<AclEntry>,
    state: AclState,
    key: Zeroizing<[u8; 32]>,
}

impl AclLog {
    /// Replays the whole log. Any broken link, signature, order or epoch rule fails the replay.
    pub fn verify(entries: &[AclEntry]) -> Result<AclState> {
        let first = entries.first().ok_or(Error::Acl("empty log"))?;
        let space = first.space;
        let mut st = AclState::default();
        let mut prev = [0u8; 32];
        for (i, entry) in entries.iter().enumerate() {
            if entry.index != i as u64 {
                return Err(Error::Acl("index out of order"));
            }
            if i > 0 && entry.space != space {
                return Err(Error::Acl("entry from another space"));
            }
            if entry.prev != prev {
                return Err(Error::Acl("broken hash chain"));
            }
            if i == 0 {
                st = genesis_state(entry)?;
            } else {
                let key = st.signer_key(&entry.signer)?;
                entry.verify_sig(&key)?;
                apply(&mut st, &entry.body)?;
            }
            prev = entry.hash();
        }
        st.head = AclHead {
            index: entries.len() as u64 - 1,
            hash: prev,
        };
        Ok(st)
    }

    /// Whether `entries` is a longer log than `known` and so worth importing. A shorter or equal log that
    /// agrees with `known` brings nothing new (false); one that forks at the known index is refused.
    pub fn is_extension(known: Option<AclHead>, entries: &[AclEntry]) -> Result<bool> {
        let (Some(head), Some(last)) = (known, entries.last()) else {
            return Ok(known.is_none() && !entries.is_empty());
        };
        if last.index < head.index {
            return Ok(false);
        }
        if last.index == head.index {
            if last.hash() == head.hash {
                return Ok(false);
            }
            return Err(Error::Acl("log does not contain the known head (fork)"));
        }
        Ok(true)
    }

    /// Like `verify`, but also rejects a log that does not extend `known`: a shorter log (rollback)
    /// or one with another entry at the known index (fork). The caller must persist the highest head it has seen.
    pub fn verify_extension(known: Option<AclHead>, entries: &[AclEntry]) -> Result<AclState> {
        let st = Self::verify(entries)?;
        if let Some(head) = known {
            if st.head.index < head.index {
                return Err(Error::Acl("log shorter than the known head (rollback)"));
            }
            if entries[head.index as usize].hash() != head.hash {
                return Err(Error::Acl("log does not contain the known head (fork)"));
            }
        }
        Ok(st)
    }

    /// New log with the owner as the only member and a fresh epoch 0 key.
    /// `certs` holds the owner's device certificates; they receive device envelopes.
    pub fn genesis(owner: UserKeys, space: [u8; 16], certs: &CertStore) -> Result<Self> {
        Self::genesis_with_key(owner, space, certs, crate::random::<32>()?)
    }

    /// Like `genesis`, but with a given epoch-0 key. Only for migrating a space made before the log existed.
    pub fn genesis_with_key(
        owner: UserKeys,
        space: [u8; 16],
        certs: &CertStore,
        key: [u8; 32],
    ) -> Result<Self> {
        let key = Zeroizing::new(key);
        let me = owner.public();
        let envelope = Envelope::seal(&me.boxk, &space, 0, &key)?;
        let device_envelopes =
            seal_devices(&space, 0, &key, certs, &[me.sign], &BTreeMap::new(), None)?;
        let body = Body::Genesis {
            owner: me,
            envelope,
            device_envelopes,
        };
        let entry = AclEntry::sign(owner.sign_key(), Signer::OwnerUser, space, 0, [0; 32], body);
        let entries = vec![entry];
        let state = Self::verify(&entries)?;
        Ok(Self {
            signing: Signing::User(owner),
            entries,
            state,
            key,
        })
    }

    /// Continues an existing log after a restart. Recovers the current epoch key from the
    /// envelopes addressed to the signing key; fails if that key has none for the current epoch.
    pub fn load(entries: Vec<AclEntry>, signing: Signing) -> Result<Self> {
        let state = Self::verify(&entries)?;
        let keys = match &signing {
            Signing::User(keys) => {
                if keys.public().sign != state.owner {
                    return Err(Error::Acl("not the owner"));
                }
                state.epoch_keys(keys)
            }
            Signing::Device { keys, cert } => {
                cert.verify()?;
                if cert.user != state.owner
                    || cert.device != keys.public().sign
                    || state.revoked.contains_key(&cert.device)
                {
                    return Err(Error::Acl("not an active owner device"));
                }
                state.epoch_keys_for_device(keys)
            }
        };
        let (epoch, key) = keys
            .keys
            .last_key_value()
            .ok_or(Error::Acl("no key for the current epoch"))?;
        if *epoch != state.epoch {
            return Err(Error::Acl("no key for the current epoch"));
        }
        let key = Zeroizing::new(**key);
        Ok(Self {
            signing,
            entries,
            state,
            key,
        })
    }

    pub fn entries(&self) -> &[AclEntry] {
        &self.entries
    }

    pub fn state(&self) -> &AclState {
        &self.state
    }

    /// Adds a member; the current epoch key goes to the user and to every known device of theirs.
    pub fn add(&mut self, user: UserPublic, role: Role, certs: &CertStore) -> Result<()> {
        let (space, epoch) = (self.state.space, self.state.epoch);
        let envelope = Envelope::seal(&user.boxk, &space, epoch, &self.key)?;
        let device_envelopes = seal_devices(
            &space,
            epoch,
            &self.key,
            certs,
            &[user.sign],
            &self.state.revoked,
            None,
        )?;
        self.commit(
            Body::Add {
                user,
                role,
                envelope,
                device_envelopes,
            },
            None,
        )
    }

    /// Raising a role needs no new epoch. Lowering one starts an epoch; `cutoffs` lists
    /// `(device, last seq, hash)` for the user's devices.
    pub fn change_role(
        &mut self,
        user: [u8; 32],
        role: Role,
        cutoffs: Vec<Cutoff>,
        certs: &CertStore,
    ) -> Result<()> {
        let current = self
            .state
            .members
            .get(&user)
            .ok_or(Error::Acl("unknown member"))?
            .role;
        if role.rank() < current.rank() {
            require_all_devices_cut(user, &cutoffs, certs)?;
            let (rotation, key) = self.rotate(None, None, cutoffs, certs)?;
            self.commit(
                Body::ChangeRole {
                    user,
                    role,
                    rotation: Some(rotation),
                },
                Some(key),
            )
        } else {
            self.commit(
                Body::ChangeRole {
                    user,
                    role,
                    rotation: None,
                },
                None,
            )
        }
    }

    pub fn remove(
        &mut self,
        user: [u8; 32],
        cutoffs: Vec<Cutoff>,
        certs: &CertStore,
    ) -> Result<()> {
        require_all_devices_cut(user, &cutoffs, certs)?;
        let (rotation, key) = self.rotate(Some(user), None, cutoffs, certs)?;
        self.commit(Body::Remove { user, rotation }, Some(key))
    }

    /// Cuts one device at `seq`. The new epoch goes to the other devices only, never to this one.
    pub fn revoke_device(&mut self, cut: Cutoff, certs: &CertStore) -> Result<()> {
        let device = cut.0;
        let (rotation, key) = self.rotate(None, Some(device), vec![cut], certs)?;
        self.commit(Body::RevokeDevice { device, rotation }, Some(key))
    }

    /// Builds the next epoch: a fresh key for every member except `removed`, and for each
    /// known device of those members that is not revoked (`revoked_now` is the device cut in this entry).
    fn rotate(
        &self,
        removed: Option<[u8; 32]>,
        revoked_now: Option<[u8; 32]>,
        cutoffs: Vec<Cutoff>,
        certs: &CertStore,
    ) -> Result<(Rotation, Zeroizing<[u8; 32]>)> {
        let (space, new_epoch) = (self.state.space, self.state.epoch + 1);
        let key = Zeroizing::new(crate::random::<32>()?);
        let remaining: Vec<[u8; 32]> = self
            .state
            .members
            .keys()
            .copied()
            .filter(|u| Some(*u) != removed)
            .collect();
        let mut envelopes = Vec::new();
        for user in &remaining {
            let member = &self.state.members[user];
            envelopes.push((
                *user,
                Envelope::seal(&member.boxk, &space, new_epoch, &key)?,
            ));
        }
        let device_envelopes = seal_devices(
            &space,
            new_epoch,
            &key,
            certs,
            &remaining,
            &self.state.revoked,
            revoked_now,
        )?;
        Ok((
            Rotation {
                new_epoch,
                envelopes,
                device_envelopes,
                cutoffs,
            },
            key,
        ))
    }

    /// Appends the entry if the extended log still verifies; the new key is kept only then.
    fn commit(&mut self, body: Body, new_key: Option<Zeroizing<[u8; 32]>>) -> Result<()> {
        let index = self.entries.len() as u64;
        let prev = self.entries.last().map_or([0; 32], AclEntry::hash);
        let (signer, key) = self.signing.parts();
        let entry = AclEntry::sign(key, signer, self.state.space, index, prev, body);
        let mut all = self.entries.clone();
        all.push(entry);
        let state = Self::verify(&all)?;
        self.entries = all;
        self.state = state;
        if let Some(key) = new_key {
            self.key = key;
        }
        Ok(())
    }
}

/// The owner must cut every known device of a departing user, or the omitted ones would keep
/// writing with the old epoch key.
fn require_all_devices_cut(user: [u8; 32], cutoffs: &[Cutoff], certs: &CertStore) -> Result<()> {
    for cert in certs.certs_of(&user) {
        if !cutoffs.iter().any(|(device, _, _)| *device == cert.device) {
            return Err(Error::Acl("cutoffs miss a known device of the user"));
        }
    }
    Ok(())
}

/// Device envelopes for every non-revoked device of `users`, except `exclude`.
fn seal_devices(
    space: &[u8; 16],
    epoch: u32,
    key: &[u8; 32],
    certs: &CertStore,
    users: &[[u8; 32]],
    revoked: &BTreeMap<[u8; 32], Cut>,
    exclude: Option<[u8; 32]>,
) -> Result<DeviceEnvelopes> {
    let mut out = Vec::new();
    for user in users {
        for cert in certs.certs_of(user) {
            if revoked.contains_key(&cert.device) || exclude == Some(cert.device) {
                continue;
            }
            let env = Envelope::seal(&cert.device_box, space, epoch, key)?;
            out.push((cert, env));
        }
    }
    Ok(out)
}

#[cfg(test)]
#[path = "acl_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "acl_device_tests.rs"]
mod device_tests;

//! Replay rules of the participants log: what each entry does to the state (SZYFROWANIE §8a, §8b).

use std::collections::{BTreeMap, BTreeSet};

use ed25519_dalek::VerifyingKey;

use crate::acl::{AclEntry, Body, DeviceEnvelopes, Role, Rotation, Signer};
use crate::acl_state::{AclState, Member};
use crate::{Error, Result};

pub(crate) fn genesis_state(entry: &AclEntry) -> Result<AclState> {
    let Body::Genesis {
        owner,
        envelope,
        device_envelopes,
    } = &entry.body
    else {
        return Err(Error::Acl("first entry must be genesis"));
    };
    let owner_key =
        VerifyingKey::from_bytes(&owner.sign).map_err(|_| Error::Acl("bad owner key"))?;
    entry.verify_sig(&owner_key)?;
    let mut st = AclState {
        space: entry.space,
        owner: owner.sign,
        ..Default::default()
    };
    st.members.insert(
        owner.sign,
        Member {
            role: Role::Owner,
            boxk: owner.boxk,
        },
    );
    st.writers.insert(0, BTreeSet::from([owner.sign]));
    st.envelopes.insert(owner.sign, vec![(0, *envelope)]);
    st.check_devices(device_envelopes, None)?;
    st.record_devices(device_envelopes, 0);
    Ok(st)
}

pub(crate) fn apply(st: &mut AclState, body: &Body) -> Result<()> {
    let epoch = st.epoch;
    match body {
        Body::Genesis { .. } => Err(Error::Acl("genesis only at index 0")),
        Body::Add {
            user,
            role,
            envelope,
            device_envelopes,
        } => {
            if *role == Role::Owner || st.members.contains_key(&user.sign) {
                return Err(Error::Acl("cannot add this member"));
            }
            st.members.insert(
                user.sign,
                Member {
                    role: *role,
                    boxk: user.boxk,
                },
            );
            if role.is_writer() {
                st.writers.entry(epoch).or_default().insert(user.sign);
            }
            st.envelopes
                .entry(user.sign)
                .or_default()
                .push((epoch, *envelope));
            st.check_devices(device_envelopes, None)?;
            st.record_devices(device_envelopes, epoch);
            Ok(())
        }
        Body::ChangeRole {
            user,
            role,
            rotation,
        } => {
            let current = st.member(user)?.role;
            if current == Role::Owner || *role == Role::Owner || *role == current {
                return Err(Error::Acl("invalid role change"));
            }
            st.members.get_mut(user).expect("member checked above").role = *role;
            if role.rank() < current.rank() {
                let rot = rotation
                    .as_ref()
                    .ok_or(Error::Acl("demotion needs a rotation"))?;
                st.rotate(rot, Some(*user), None)
            } else {
                if rotation.is_some() {
                    return Err(Error::Acl("promotion takes no rotation"));
                }
                if role.is_writer() {
                    st.writers.entry(epoch).or_default().insert(*user);
                }
                Ok(())
            }
        }
        Body::Remove { user, rotation } => {
            if st.member(user)?.role == Role::Owner {
                return Err(Error::Acl("owner cannot be removed"));
            }
            st.members.remove(user);
            st.rotate(rotation, Some(*user), None)
        }
        Body::RevokeDevice { device, rotation } => {
            let [(cut, seq, hash)] = rotation.cutoffs.as_slice() else {
                return Err(Error::Acl("revoke must name exactly one device"));
            };
            if cut != device {
                return Err(Error::Acl("revoke cutoff names another device"));
            }
            st.rotate(rotation, None, Some(*device))?;
            st.revoked.insert(*device, (*seq, *hash));
            Ok(())
        }
    }
}

impl AclState {
    pub(crate) fn member(&self, user: &[u8; 32]) -> Result<&Member> {
        self.members.get(user).ok_or(Error::Acl("unknown member"))
    }

    /// Key that must have signed an entry at this point of the log.
    pub(crate) fn signer_key(&self, signer: &Signer) -> Result<VerifyingKey> {
        match signer {
            Signer::OwnerUser => {
                VerifyingKey::from_bytes(&self.owner).map_err(|_| Error::Acl("bad owner key"))
            }
            Signer::OwnerDevice(cert) => {
                if cert.user != self.owner {
                    return Err(Error::Acl("signer device of another user"));
                }
                cert.verify()?;
                if self.revoked.contains_key(&cert.device) {
                    return Err(Error::Acl("signer device revoked earlier"));
                }
                VerifyingKey::from_bytes(&cert.device).map_err(|_| Error::Acl("bad device key"))
            }
        }
    }

    /// Starts the epoch of `rot`. `departed` is the user who lost write rights, if any;
    /// `revoked_now` is the device cut in this entry, which must not get the new key.
    fn rotate(
        &mut self,
        rot: &Rotation,
        departed: Option<[u8; 32]>,
        revoked_now: Option<[u8; 32]>,
    ) -> Result<()> {
        if self.epoch.checked_add(1) != Some(rot.new_epoch) {
            return Err(Error::Acl("epoch must grow by one"));
        }
        let want: BTreeSet<[u8; 32]> = self.members.keys().copied().collect();
        let got: BTreeSet<[u8; 32]> = rot.envelopes.iter().map(|(u, _)| *u).collect();
        if got.len() != rot.envelopes.len() || got != want {
            return Err(Error::Acl(
                "envelopes must cover exactly the remaining members",
            ));
        }
        let devices: BTreeSet<[u8; 32]> = rot.cutoffs.iter().map(|(d, _, _)| *d).collect();
        if devices.len() != rot.cutoffs.len() {
            return Err(Error::Acl("duplicate cutoff"));
        }

        self.epoch = rot.new_epoch;
        let writers = self
            .members
            .iter()
            .filter(|(_, m)| m.role.is_writer())
            .map(|(u, _)| *u)
            .collect();
        self.writers.insert(self.epoch, writers);
        for (user, env) in &rot.envelopes {
            self.envelopes
                .entry(*user)
                .or_default()
                .push((self.epoch, *env));
        }
        self.check_devices(&rot.device_envelopes, revoked_now)?;
        self.record_devices(&rot.device_envelopes, self.epoch);
        if let Some(user) = departed {
            let cuts: BTreeMap<[u8; 32], (u64, [u8; 32])> = rot
                .cutoffs
                .iter()
                .map(|(d, seq, hash)| (*d, (*seq, *hash)))
                .collect();
            self.departures
                .entry(user)
                .or_default()
                .push((self.epoch, cuts));
        }
        Ok(())
    }

    /// Device envelopes must go to certified devices of current members that are not revoked.
    fn check_devices(
        &self,
        devices: &DeviceEnvelopes,
        revoked_now: Option<[u8; 32]>,
    ) -> Result<()> {
        let mut seen = BTreeSet::new();
        for (cert, _) in devices {
            cert.verify()?;
            if !self.members.contains_key(&cert.user) {
                return Err(Error::Acl("device envelope for a non-member"));
            }
            if self.revoked.contains_key(&cert.device) || revoked_now == Some(cert.device) {
                return Err(Error::Acl("device envelope for a revoked device"));
            }
            if !seen.insert(cert.device) {
                return Err(Error::Acl("duplicate device envelope"));
            }
        }
        Ok(())
    }

    pub(crate) fn record_devices(&mut self, devices: &DeviceEnvelopes, epoch: u32) {
        for (cert, env) in devices {
            self.device_envelopes
                .entry(cert.device)
                .or_default()
                .push((epoch, *env));
        }
    }
}

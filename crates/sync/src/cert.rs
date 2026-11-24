//! Device certificates (SZYFROWANIE §8a, §8b, §8c): the user signs the device's Ed25519 and X25519
//! keys, and the device signs its own proof of possession (PoP), so nobody can certify a key they do not hold.

use std::collections::BTreeMap;

use ed25519_dalek::{Signature, Signer, VerifyingKey};

use crate::device::{DeviceKeys, DevicePublic};
use crate::identity::UserKeys;
use crate::{Error, Result};

const CERT_CONTEXT: &[u8] = b"notes device-cert v3";
const POP_CONTEXT: &[u8] = b"notes device-pop v1";
pub const CERT_LEN: usize = 32 + 32 + 32 + 8 + 64 + 64;
/// Devices one user may have in a space that are not revoked. Limits what a peer's Acl can add; revoked
/// devices do not count, because their certificates must stay for the cut.
pub const MAX_ACTIVE_DEVICES_PER_USER: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceCert {
    pub user: [u8; 32],
    /// Device Ed25519 key (signs messages and entries).
    pub device: [u8; 32],
    /// Device X25519 key (opens device envelopes).
    pub device_box: [u8; 32],
    /// Unix seconds.
    pub created: u64,
    /// User signature over the certificate fields.
    pub sig: [u8; 64],
    /// Device signature over the same fields: proof that the certifier got the device key from its holder.
    pub pop: [u8; 64],
}

impl DeviceCert {
    pub fn issue(user: &UserKeys, device: &DeviceKeys, created: u64) -> Self {
        let user_pub = user.public().sign;
        let public = device.public();
        let pop = device
            .sign_key()
            .sign(&signed_bytes(POP_CONTEXT, &user_pub, &public, created))
            .to_bytes();
        let sig = user
            .sign_key()
            .sign(&signed_bytes(CERT_CONTEXT, &user_pub, &public, created))
            .to_bytes();
        Self {
            user: user_pub,
            device: public.sign,
            device_box: public.boxk,
            created,
            sig,
            pop,
        }
    }

    /// Both signatures: the user's, and the device's proof of possession.
    pub fn verify(&self) -> Result<()> {
        let user = VerifyingKey::from_bytes(&self.user).map_err(|_| Error::Signature)?;
        let device = VerifyingKey::from_bytes(&self.device).map_err(|_| Error::Signature)?;
        let public = self.public();
        let cert_msg = signed_bytes(CERT_CONTEXT, &self.user, &public, self.created);
        user.verify_strict(&cert_msg, &Signature::from_bytes(&self.sig))
            .map_err(|_| Error::Signature)?;
        let pop_msg = signed_bytes(POP_CONTEXT, &self.user, &public, self.created);
        device
            .verify_strict(&pop_msg, &Signature::from_bytes(&self.pop))
            .map_err(|_| Error::Signature)
    }

    pub fn public(&self) -> DevicePublic {
        DevicePublic {
            sign: self.device,
            boxk: self.device_box,
        }
    }

    pub fn to_bytes(&self) -> [u8; CERT_LEN] {
        let mut out = [0u8; CERT_LEN];
        out[..32].copy_from_slice(&self.user);
        out[32..64].copy_from_slice(&self.device);
        out[64..96].copy_from_slice(&self.device_box);
        out[96..104].copy_from_slice(&self.created.to_le_bytes());
        out[104..168].copy_from_slice(&self.sig);
        out[168..].copy_from_slice(&self.pop);
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let b: &[u8; CERT_LEN] = bytes
            .try_into()
            .map_err(|_| Error::Malformed("device cert length"))?;
        Ok(Self {
            user: b[..32].try_into().unwrap(),
            device: b[32..64].try_into().unwrap(),
            device_box: b[64..96].try_into().unwrap(),
            created: u64::from_le_bytes(b[96..104].try_into().unwrap()),
            sig: b[104..168].try_into().unwrap(),
            pop: b[168..].try_into().unwrap(),
        })
    }
}

fn signed_bytes(context: &[u8], user: &[u8; 32], device: &DevicePublic, created: u64) -> Vec<u8> {
    let mut msg = Vec::with_capacity(context.len() + 32 * 3 + 8);
    msg.extend_from_slice(context);
    msg.extend_from_slice(user);
    msg.extend_from_slice(&device.sign);
    msg.extend_from_slice(&device.boxk);
    msg.extend_from_slice(&created.to_le_bytes());
    msg
}

/// Verified device certificates, keyed by device key. One device belongs to one user only.
/// The first valid certificate for a device key fixes its owner; with the proof of possession
/// only the holder of the device key can create one, so nobody else can take that slot.
#[derive(Debug, Default, Clone)]
pub struct CertStore(BTreeMap<[u8; 32], DeviceCert>);

impl CertStore {
    pub fn insert(&mut self, cert: DeviceCert) -> Result<()> {
        cert.verify()?;
        if self
            .0
            .get(&cert.device)
            .is_some_and(|old| old.user != cert.user)
        {
            return Err(Error::Acl("device already certified for another user"));
        }
        self.0.insert(cert.device, cert);
        Ok(())
    }

    pub fn get(&self, device: &[u8; 32]) -> Option<&DeviceCert> {
        self.0.get(device)
    }

    pub fn certs_of(&self, user: &[u8; 32]) -> Vec<DeviceCert> {
        self.0
            .values()
            .filter(|c| &c.user == user)
            .copied()
            .collect()
    }
}

#[cfg(test)]
#[path = "cert_tests.rs"]
mod tests;

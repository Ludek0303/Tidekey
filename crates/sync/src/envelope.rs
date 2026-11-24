//! Key envelope: the space key of one epoch, sealed to one participant (SZYFROWANIE §2, §8a).
//! A libsodium-style sealed box (`crypto_box::PublicKey::seal`); the plaintext is
//! `space ‖ epoch LE ‖ key`, so an envelope cannot be replayed into another space or epoch.

use crypto_box::aead::rand_core::{CryptoRng, RngCore};
use zeroize::Zeroizing;

use crate::device::DeviceKeys;
use crate::identity::UserKeys;
use crate::{Error, Result};

const PLAIN_LEN: usize = 16 + 4 + 32;
/// Sealed box = ephemeral public key (32) + ciphertext + tag (16).
pub const ENVELOPE_LEN: usize = 32 + PLAIN_LEN + 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Envelope(pub [u8; ENVELOPE_LEN]);

impl Envelope {
    pub fn seal(
        recipient_boxk: &[u8; 32],
        space: &[u8; 16],
        epoch: u32,
        key: &[u8; 32],
    ) -> Result<Self> {
        let mut plain = Zeroizing::new([0u8; PLAIN_LEN]);
        plain[..16].copy_from_slice(space);
        plain[16..20].copy_from_slice(&epoch.to_le_bytes());
        plain[20..].copy_from_slice(key);
        let pk = crypto_box::PublicKey::from(*recipient_boxk);
        let mut rng = OsRng { failed: false };
        let sealed = pk.seal(&mut rng, &*plain).map_err(|_| Error::Envelope)?;
        if rng.failed {
            return Err(Error::Random);
        }
        let bytes: [u8; ENVELOPE_LEN] = sealed.try_into().map_err(|_| Error::Envelope)?;
        Ok(Self(bytes))
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let b: [u8; ENVELOPE_LEN] = bytes
            .try_into()
            .map_err(|_| Error::Malformed("envelope length"))?;
        Ok(Self(b))
    }

    /// Opens a user-level envelope; checks that it is for this space and epoch.
    pub fn open(
        &self,
        user: &UserKeys,
        space: &[u8; 16],
        epoch: u32,
    ) -> Result<Zeroizing<[u8; 32]>> {
        self.open_with(user.box_key(), space, epoch)
    }

    /// Opens a device-level envelope with the device's X25519 key.
    pub fn open_device(
        &self,
        device: &DeviceKeys,
        space: &[u8; 16],
        epoch: u32,
    ) -> Result<Zeroizing<[u8; 32]>> {
        self.open_with(device.box_key(), space, epoch)
    }

    fn open_with(
        &self,
        secret: &crypto_box::SecretKey,
        space: &[u8; 16],
        epoch: u32,
    ) -> Result<Zeroizing<[u8; 32]>> {
        let plain = Zeroizing::new(secret.unseal(&self.0).map_err(|_| Error::Envelope)?);
        if plain.len() != PLAIN_LEN
            || plain[..16] != space[..]
            || plain[16..20] != epoch.to_le_bytes()
        {
            return Err(Error::Envelope);
        }
        let key: [u8; 32] = plain[20..].try_into().map_err(|_| Error::Envelope)?;
        Ok(Zeroizing::new(key))
    }
}

/// OS randomness for `seal`. A failed read fills zeros and sets `failed`, so `seal` returns
/// `Error::Random` instead of panicking; the sealed output is then discarded.
struct OsRng {
    failed: bool,
}

impl RngCore for OsRng {
    fn next_u32(&mut self) -> u32 {
        let mut b = [0u8; 4];
        self.fill_bytes(&mut b);
        u32::from_le_bytes(b)
    }

    fn next_u64(&mut self) -> u64 {
        let mut b = [0u8; 8];
        self.fill_bytes(&mut b);
        u64::from_le_bytes(b)
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        if getrandom::fill(dest).is_err() {
            self.failed = true;
            dest.fill(0);
        }
    }

    fn try_fill_bytes(
        &mut self,
        dest: &mut [u8],
    ) -> std::result::Result<(), crypto_box::aead::rand_core::Error> {
        self.fill_bytes(dest);
        Ok(())
    }
}

impl CryptoRng for OsRng {}

#[cfg(test)]
#[path = "envelope_tests.rs"]
mod tests;

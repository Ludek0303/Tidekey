//! Device keys (SZYFROWANIE §8b): a random Ed25519 key that signs messages and a random X25519
//! key that opens device envelopes. Neither is derived from the recovery phrase.

use crypto_box::{PublicKey, SecretKey as BoxSecret};
use ed25519_dalek::SigningKey;
use zeroize::Zeroizing;

use crate::Result;

/// Public half of the device keys, as certified by the user in a `DeviceCert`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DevicePublic {
    pub sign: [u8; 32],
    pub boxk: [u8; 32],
}

/// Secret device keys. Both halves zeroize on drop.
pub struct DeviceKeys {
    sign: SigningKey,
    boxk: BoxSecret,
}

impl DeviceKeys {
    pub fn generate() -> Result<Self> {
        let sign = Zeroizing::new(crate::random::<32>()?);
        let boxk = Zeroizing::new(crate::random::<32>()?);
        Ok(Self::from_seeds(&sign, &boxk))
    }

    pub fn from_seeds(sign: &[u8; 32], boxk: &[u8; 32]) -> Self {
        Self {
            sign: SigningKey::from_bytes(sign),
            boxk: BoxSecret::from_bytes(*boxk),
        }
    }

    /// Raw secrets for the key store; the caller must not keep them longer than needed.
    pub fn to_seeds(&self) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>) {
        (
            Zeroizing::new(self.sign.to_bytes()),
            Zeroizing::new(self.boxk.to_bytes()),
        )
    }

    pub fn public(&self) -> DevicePublic {
        DevicePublic {
            sign: self.sign.verifying_key().to_bytes(),
            boxk: PublicKey::from(&self.boxk).to_bytes(),
        }
    }

    pub(crate) fn sign_key(&self) -> &SigningKey {
        &self.sign
    }

    pub(crate) fn box_key(&self) -> &BoxSecret {
        &self.boxk
    }
}

impl std::fmt::Debug for DeviceKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DeviceKeys(<secret>)")
    }
}

//! Recovery phrase and user keys (SZYFROWANIE §2, §8a).

use bip39::{Language, Mnemonic};
use crypto_box::{PublicKey, SecretKey as BoxSecret};
use ed25519_dalek::SigningKey;
use zeroize::Zeroizing;

use crate::{Error, Result};

const SIGN_CONTEXT: &str = "notes user-sign v1";
const BOX_CONTEXT: &str = "notes user-box v1";

/// 24-word BIP39 phrase (English list), stored normalised: lowercase, single spaces.
pub struct RecoveryPhrase(Zeroizing<String>);

impl RecoveryPhrase {
    pub fn generate() -> Result<Self> {
        let entropy = Zeroizing::new(crate::random::<32>()?);
        let mnemonic = Mnemonic::from_entropy(&*entropy).map_err(|_| Error::Phrase)?;
        let words: Vec<&str> = mnemonic.words().collect();
        Ok(Self(Zeroizing::new(words.join(" "))))
    }

    /// Accepts any whitespace and letter case; checks the word count and the BIP39 checksum.
    pub fn parse(text: &str) -> Result<Self> {
        // Lowercasing and joining happen in zeroized buffers: the words are secret too.
        let lower = Zeroizing::new(text.to_lowercase());
        let normalised = Zeroizing::new(lower.split_whitespace().collect::<Vec<_>>().join(" "));
        let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalised)
            .map_err(|_| Error::Phrase)?;
        if mnemonic.word_count() != 24 {
            return Err(Error::Phrase);
        }
        Ok(Self(normalised))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Public halves of the user keys: what other participants and the storage node may see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct UserPublic {
    pub sign: [u8; 32],
    pub boxk: [u8; 32],
}

/// Secret user keys. Both halves zeroize on drop (`SigningKey` and `crypto_box::SecretKey` do it).
pub struct UserKeys {
    sign: SigningKey,
    boxk: BoxSecret,
}

impl UserKeys {
    pub fn from_phrase(phrase: &RecoveryPhrase) -> Result<Self> {
        let mnemonic = Mnemonic::parse_in_normalized(Language::English, phrase.as_str())
            .map_err(|_| Error::Phrase)?;
        let seed = Zeroizing::new(mnemonic.to_seed(""));
        let sign_seed = Zeroizing::new(blake3::derive_key(SIGN_CONTEXT, &seed[..]));
        let box_seed = Zeroizing::new(blake3::derive_key(BOX_CONTEXT, &seed[..]));
        Ok(Self {
            sign: SigningKey::from_bytes(&sign_seed),
            boxk: BoxSecret::from_bytes(*box_seed),
        })
    }

    pub fn public(&self) -> UserPublic {
        UserPublic {
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

impl std::fmt::Debug for UserKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "UserKeys(<secret>)")
    }
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;

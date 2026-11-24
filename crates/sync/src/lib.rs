//! Identity, device certificates, participants log, key envelopes and message policy
//! (SZYFROWANIE §2, §3, §7, §8a). Pure logic: no networking, no storage.

pub mod acl;
pub mod acl_log;
mod acl_replay;
pub mod acl_state;
pub mod cert;
mod codec;
pub mod device;
pub mod envelope;
pub mod identity;
pub mod invite;
pub mod keystore;
#[cfg(feature = "net")]
pub mod net;
pub mod policy;
pub mod proto;
pub mod session;
pub mod space;
pub mod space_access;
pub mod space_owner;
pub mod space_recover;
pub mod space_store;
#[cfg(test)]
mod test_util;
pub mod ticket;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("invalid recovery phrase")]
    Phrase,
    #[error("OS randomness unavailable")]
    Random,
    #[error("bad signature")]
    Signature,
    #[error("malformed encoding: {0}")]
    Malformed(&'static str),
    #[error("participants log rejected: {0}")]
    Acl(&'static str),
    #[error("cannot open envelope")]
    Envelope,
    #[error("invite rejected: {0}")]
    Invite(&'static str),
    #[error("key store: {0}")]
    Store(String),
    #[error("no key for the current epoch on this device: enter the recovery phrase")]
    NeedsPhrase,
    #[error("space: {0}")]
    Space(&'static str),
    #[error("the recovery phrase belongs to no member of this space")]
    NotMember,
    #[error("this device has no certificate in this space: enter the recovery phrase")]
    NoCertificate,
    #[error("this device's key is revoked in this space or certified for another member")]
    DeviceUnusable,
    #[error("message store: {0}")]
    Core(String),
    #[error("transport: {0}")]
    Transport(String),
}

impl From<notes_core::Error> for Error {
    fn from(e: notes_core::Error) -> Self {
        Error::Core(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Fills a fixed-size buffer from the OS randomness source.
pub fn random<const N: usize>() -> Result<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|_| Error::Random)?;
    Ok(buf)
}

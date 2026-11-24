//! Hook through which the sync layer decides which messages the core may replay, store and write
//! (SZYFROWANIE §3, §8a). The core keeps no participants or keys of its own.

use zeroize::Zeroizing;

/// A space key; zeroized when dropped.
pub type Key = Zeroizing<[u8; 32]>;

/// Plain header of a message (`version ‖ space ‖ device ‖ seq ‖ epoch ‖ nonce`, layout in `message.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub space: [u8; 16],
    pub device: [u8; 32],
    pub seq: u64,
    pub epoch: u32,
}

pub trait Access {
    /// Epoch and key for new local messages; `None` when this device holds no current key.
    fn current(&self) -> Option<(u32, Key)>;
    /// Space key of one epoch, if this device holds it.
    fn key(&self, epoch: u32) -> Option<Key>;
    /// Acceptance rules. `Err` carries the reason; `msg_hash` is `message_hash` of the full bytes.
    fn accept(&self, header: &Header, msg_hash: &[u8; 32]) -> std::result::Result<(), String>;
    /// Reserved documents require an explicit policy, on local writes as well as receive/replay.
    fn accept_document(&self, _header: &Header, doc: &str) -> std::result::Result<(), String> {
        if doc.starts_with('@') { Err("reserved document requires an explicit access policy".into()) } else { Ok(()) }
    }
}

/// BLAKE3 of the whole message (header, ciphertext and signature).
pub fn message_hash(bytes: &[u8]) -> [u8; 32] {
    blake3::hash(bytes).into()
}

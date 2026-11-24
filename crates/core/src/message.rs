//! Wire format of one log message (SZYFROWANIE §3): `header ‖ ciphertext ‖ signature`.
//! The same bytes live in the local log, go over the network and sit on the storage node.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

use crate::access::{Header, Key};
use crate::{Error, Result};

const VERSION: u8 = 1;
pub(crate) const HEADER_LEN: usize = 1 + 16 + 32 + 8 + 4 + 24;
const SIG_LEN: usize = 64;
const TAG_LEN: usize = 16;
// Hides the length of single edits from anyone holding only ciphertext.
const PAD: usize = 256;

pub(crate) struct SpaceKey {
    pub id: [u8; 16],
    pub epoch: u32,
    pub key: [u8; 32],
}

pub(crate) struct Opened {
    pub header: Header,
    pub doc: String,
    pub payload: Vec<u8>,
    /// Authoring time in ms since the Unix epoch; 0 for messages that carry none.
    pub time_ms: u64,
    /// Optional task audit payload, authenticated by the same signature as the update.
    pub audit: Vec<u8>,
}

/// Encrypts `{doc, payload, time_ms}` with the space key and signs header + ciphertext with the device key.
/// `time_ms` is the authoring time, inside the ciphertext only. Messages from before it existed carry zero
/// bytes there (the old padding), so they read back as time 0, "unknown".
pub(crate) fn seal(
    device: &SigningKey,
    space: &SpaceKey,
    seq: u64,
    nonce: [u8; 24],
    doc: &str,
    payload: &[u8],
    time_ms: u64,
) -> Result<Vec<u8>> {
    seal_audited(device, space, seq, nonce, doc, payload, time_ms, &[])
}

#[allow(clippy::too_many_arguments)] // mirrors the header fields one to one
pub(crate) fn seal_audited(
    device: &SigningKey, space: &SpaceKey, seq: u64, nonce: [u8; 24],
    doc: &str, payload: &[u8], time_ms: u64, audit: &[u8],
) -> Result<Vec<u8>> {
    let mut msg = Vec::with_capacity(HEADER_LEN + PAD + TAG_LEN + SIG_LEN);
    msg.push(VERSION);
    msg.extend_from_slice(&space.id);
    msg.extend_from_slice(&device.verifying_key().to_bytes());
    msg.extend_from_slice(&seq.to_le_bytes());
    msg.extend_from_slice(&space.epoch.to_le_bytes());
    msg.extend_from_slice(&nonce);

    let mut plain = Vec::with_capacity(16 + doc.len() + payload.len());
    plain.extend_from_slice(&(doc.len() as u32).to_le_bytes());
    plain.extend_from_slice(doc.as_bytes());
    plain.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    plain.extend_from_slice(payload);
    plain.extend_from_slice(&time_ms.to_le_bytes());
    plain.extend_from_slice(&(audit.len() as u32).to_le_bytes());
    plain.extend_from_slice(audit);
    plain.resize(plain.len().div_ceil(PAD) * PAD, 0);

    let ct = cipher(&space.key)
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &plain,
                aad: &msg,
            },
        )
        .map_err(|_| Error::BadMessage {
            seq,
            reason: "encryption failed",
        })?;
    msg.extend_from_slice(&ct);
    let sig = device.sign(&msg).to_bytes();
    msg.extend_from_slice(&sig);
    Ok(msg)
}

/// Checks format, space, signature, then decrypts. `key_for` maps an epoch to its space key.
/// A valid message whose epoch key is unknown fails with `NoEpochKey`, which is not tampering.
/// Device and seq from the header, verifying nothing. Only for a lookup: the caller verifies before it trusts them.
pub(crate) fn peek(bytes: &[u8]) -> Option<([u8; 32], u64)> {
    if bytes.len() < HEADER_LEN + TAG_LEN + SIG_LEN {
        return None;
    }
    let device = bytes[17..49].try_into().ok()?;
    let seq = u64::from_le_bytes(bytes[49..57].try_into().ok()?);
    Some((device, seq))
}

pub(crate) fn open(
    bytes: &[u8],
    space_id: &[u8; 16],
    key_for: impl Fn(u32) -> Option<Key>,
) -> Result<Opened> {
    let bad = |seq, reason| Error::BadMessage { seq, reason };
    if bytes.len() < HEADER_LEN + TAG_LEN + SIG_LEN {
        return Err(bad(0, "too short"));
    }
    let (signed, sig) = bytes.split_at(bytes.len() - SIG_LEN);
    let (header, ct) = signed.split_at(HEADER_LEN);
    let device: [u8; 32] = header[17..49].try_into().unwrap();
    let seq = u64::from_le_bytes(header[49..57].try_into().unwrap());
    let epoch = u32::from_le_bytes(header[57..61].try_into().unwrap());
    let nonce: [u8; 24] = header[61..85].try_into().unwrap();

    if header[0] != VERSION {
        return Err(bad(seq, "unknown format version"));
    }
    if header[1..17] != space_id[..] {
        return Err(bad(seq, "message from another space"));
    }
    let sig = Signature::from_slice(sig).map_err(|_| Error::BadSignature { seq })?;
    let key = VerifyingKey::from_bytes(&device).map_err(|_| Error::BadSignature { seq })?;
    key.verify_strict(signed, &sig)
        .map_err(|_| Error::BadSignature { seq })?;

    let hdr = Header {
        space: *space_id,
        device,
        seq,
        epoch,
    };
    let space_key = key_for(epoch).ok_or(Error::NoEpochKey(hdr))?;
    let plain = cipher(&space_key)
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: ct,
                aad: header,
            },
        )
        .map_err(|_| bad(seq, "cannot decrypt"))?;

    let (doc, payload, time_ms) = split_plain(&plain).ok_or(bad(seq, "malformed plaintext"))?;
    let audit_offset = 4 + doc.len() + 4 + payload.len() + 8;
    let audit = match plain.get(audit_offset..) {
        Some(rest) if rest.len() >= 4 => take_prefixed(rest).ok_or(bad(seq, "malformed audit"))?.0.to_vec(),
        _ => Vec::new(),
    };
    let doc = String::from_utf8(doc.to_vec()).map_err(|_| bad(seq, "malformed plaintext"))?;
    Ok(Opened {
        header: hdr,
        doc,
        payload: payload.to_vec(),
        time_ms,
        audit,
    })
}

fn cipher(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(&(*key).into())
}

/// `(doc, payload, time_ms)`; a missing or zero time (old messages) reads as 0.
fn split_plain(plain: &[u8]) -> Option<(&[u8], &[u8], u64)> {
    let (doc, rest) = take_prefixed(plain)?;
    let (payload, rest) = take_prefixed(rest)?;
    let time = rest
        .get(..8)
        .map_or(0, |t| u64::from_le_bytes(t.try_into().expect("8 bytes")));
    Some((doc, payload, time))
}

fn take_prefixed(buf: &[u8]) -> Option<(&[u8], &[u8])> {
    let len = u32::from_le_bytes(buf.get(..4)?.try_into().ok()?) as usize;
    let rest = &buf[4..];
    (len <= rest.len()).then(|| rest.split_at(len))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeroize::Zeroizing;

    const SPACE: [u8; 16] = [7; 16];
    const KEY: [u8; 32] = [9; 32];

    fn sealed(doc: &str, payload: &[u8]) -> Vec<u8> {
        let dev = SigningKey::from_bytes(&[1; 32]);
        let space = SpaceKey {
            id: SPACE,
            epoch: 0,
            key: KEY,
        };
        seal(&dev, &space, 5, [3; 24], doc, payload, 0).unwrap()
    }

    fn key0(e: u32) -> Option<Key> {
        (e == 0).then(|| Zeroizing::new(KEY))
    }

    #[test]
    fn round_trip() {
        let m = open(&sealed("note-1", b"update"), &SPACE, key0).unwrap();
        assert_eq!(
            (m.header.seq, m.doc.as_str(), &m.payload[..]),
            (5, "note-1", &b"update"[..])
        );
    }

    #[test]
    fn authoring_time_round_trips_and_old_messages_read_as_zero() {
        let dev = SigningKey::from_bytes(&[1; 32]);
        let space = SpaceKey {
            id: SPACE,
            epoch: 0,
            key: KEY,
        };
        let timed = seal(
            &dev,
            &space,
            5,
            [3; 24],
            "note-1",
            b"update",
            1_700_000_000_123,
        )
        .unwrap();
        assert_eq!(
            open(&timed, &SPACE, key0).unwrap().time_ms,
            1_700_000_000_123
        );
        // a message from before the field existed has zero bytes where it now sits
        let old = seal(&dev, &space, 5, [3; 24], "note-1", b"update", 0).unwrap();
        assert_eq!(open(&old, &SPACE, key0).unwrap().time_ms, 0);
        // the padding works as before: lengths stay multiples of the pad size plus the fixed overhead
        assert_eq!((timed.len() - HEADER_LEN - TAG_LEN - SIG_LEN) % PAD, 0);
    }

    #[test]
    fn no_plaintext_and_padded_to_same_size() {
        let a = sealed("secret-note-id", b"secret text");
        let b = sealed("x", b"y");
        assert_eq!(a.len(), b.len());
        for needle in [&b"secret"[..], b"note-id"] {
            assert!(!a.windows(needle.len()).any(|w| w == needle));
        }
    }

    #[test]
    fn any_flipped_byte_is_rejected() {
        let good = sealed("n", b"payload");
        for i in 0..good.len() {
            let mut m = good.clone();
            m[i] ^= 1;
            assert!(open(&m, &SPACE, key0).is_err(), "byte {i} accepted");
        }
    }

    #[test]
    fn wrong_space_or_key_is_rejected() {
        let m = sealed("n", b"p");
        assert!(matches!(
            open(&m, &[8; 16], key0),
            Err(Error::BadMessage {
                reason: "message from another space",
                ..
            })
        ));
        assert!(matches!(
            open(&m, &SPACE, |_| Some(Zeroizing::new([0; 32]))),
            Err(Error::BadMessage {
                reason: "cannot decrypt",
                ..
            })
        ));
    }
}

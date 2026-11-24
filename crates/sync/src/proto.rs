//! `notes-sync/1` frames (ARCHITEKTURA §4.7, SIEC.md). Pure encoding: no sockets, no clocks, so it
//! also builds for the browser.

use ed25519_dalek::{Signature, Signer, VerifyingKey};

use crate::acl_state::AclHead;
use crate::cert::{CERT_LEN, DeviceCert};
use crate::codec::{Reader, Writer};
use crate::device::DeviceKeys;
use crate::{Error, Result};

pub const PROTOCOL: u16 = 1;
pub const ALPN: &[u8] = b"notes-sync/1";
pub const MAX_FRAME: usize = 16 * 1024 * 1024;
/// `(device, last contiguous seq)` for every device the sender holds messages of.
pub type VersionVector = Vec<([u8; 32], u64)>;

const BIND_CONTEXT: &[u8] = b"notes-sync bind v1";
// Bounds the element count of a vector before its loop starts; the frame size bounds the rest.
const MAX_ITEMS: u32 = 1 << 20;

// Hello is sent once per connection; boxing the certificate would only add an allocation.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerProof {
    /// A device of the space: its certificate and a signature by the device key over
    /// `BIND_CONTEXT ‖ space ‖ endpoint` (endpoint = the sender's transport key).
    Device { cert: DeviceCert, bind: [u8; 64] },
    /// A storage node: authenticated only by its transport key, which the device knows from the ticket.
    Node,
}

// Frames are short-lived; the Hello variant is the only large one and is sent once.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Hello {
        protocol: u16,
        space: [u8; 16],
        proof: PeerProof,
        acl_head: Option<AclHead>,
        token: Option<[u8; 32]>,
    },
    /// Encoded participants-log entries and device certificates.
    Acl {
        entries: Vec<Vec<u8>>,
        certs: Vec<Vec<u8>>,
    },
    Have(VersionVector),
    Msgs(Vec<Vec<u8>>),
    Synced(VersionVector),
    Live(Vec<u8>),
    Reject(String),
}

impl Frame {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut w = Writer::default();
        match self {
            Frame::Hello {
                protocol,
                space,
                proof,
                acl_head,
                token,
            } => {
                w.u8(1);
                w.bytes(&protocol.to_le_bytes());
                w.bytes(space);
                match proof {
                    PeerProof::Device { cert, bind } => {
                        w.u8(0);
                        w.bytes(&cert.to_bytes());
                        w.bytes(bind);
                    }
                    PeerProof::Node => w.u8(1),
                }
                match acl_head {
                    Some(h) => {
                        w.u8(1);
                        w.u64(h.index);
                        w.bytes(&h.hash);
                    }
                    None => w.u8(0),
                }
                match token {
                    Some(t) => {
                        w.u8(1);
                        w.bytes(t);
                    }
                    None => w.u8(0),
                }
            }
            Frame::Acl { entries, certs } => {
                w.u8(2);
                put_blobs(&mut w, entries);
                put_blobs(&mut w, certs);
            }
            Frame::Have(vv) => {
                w.u8(3);
                put_vv(&mut w, vv);
            }
            Frame::Msgs(msgs) => {
                w.u8(4);
                put_blobs(&mut w, msgs);
            }
            Frame::Synced(vv) => {
                w.u8(5);
                put_vv(&mut w, vv);
            }
            Frame::Live(msg) => {
                w.u8(6);
                put_blob(&mut w, msg);
            }
            Frame::Reject(reason) => {
                w.u8(7);
                put_blob(&mut w, reason.as_bytes());
            }
        }
        w.0
    }

    pub fn from_bytes(b: &[u8]) -> Result<Frame> {
        if b.len() > MAX_FRAME {
            return Err(Error::Malformed("frame too large"));
        }
        let mut r = Reader::new(b);
        let frame = match r.u8()? {
            1 => {
                let protocol = u16::from_le_bytes(r.array()?);
                let space = r.array()?;
                let proof = match r.u8()? {
                    0 => {
                        let cert = DeviceCert::from_bytes(r.take(CERT_LEN)?)?;
                        PeerProof::Device {
                            cert,
                            bind: r.array()?,
                        }
                    }
                    1 => PeerProof::Node,
                    _ => return Err(Error::Malformed("peer proof tag")),
                };
                let acl_head = match r.u8()? {
                    0 => None,
                    1 => Some(AclHead {
                        index: r.u64()?,
                        hash: r.array()?,
                    }),
                    _ => return Err(Error::Malformed("acl head flag")),
                };
                let token = match r.u8()? {
                    0 => None,
                    1 => Some(r.array()?),
                    _ => return Err(Error::Malformed("token flag")),
                };
                Frame::Hello {
                    protocol,
                    space,
                    proof,
                    acl_head,
                    token,
                }
            }
            2 => Frame::Acl {
                entries: get_blobs(&mut r)?,
                certs: get_blobs(&mut r)?,
            },
            3 => Frame::Have(get_vv(&mut r)?),
            4 => Frame::Msgs(get_blobs(&mut r)?),
            5 => Frame::Synced(get_vv(&mut r)?),
            6 => Frame::Live(get_blob(&mut r)?),
            7 => Frame::Reject(
                String::from_utf8(get_blob(&mut r)?)
                    .map_err(|_| Error::Malformed("reject text"))?,
            ),
            _ => return Err(Error::Malformed("frame tag")),
        };
        r.finish()?;
        Ok(frame)
    }
}

/// Signs the transport key of this endpoint with the device key, binding the device to the connection.
pub fn bind_sig(device: &DeviceKeys, space: [u8; 16], endpoint: [u8; 32]) -> [u8; 64] {
    device
        .sign_key()
        .sign(&bind_msg(space, endpoint))
        .to_bytes()
}

pub fn verify_bind(cert: &DeviceCert, space: [u8; 16], endpoint: [u8; 32], sig: &[u8; 64]) -> bool {
    VerifyingKey::from_bytes(&cert.device).is_ok_and(|key| {
        key.verify_strict(&bind_msg(space, endpoint), &Signature::from_bytes(sig))
            .is_ok()
    })
}

fn bind_msg(space: [u8; 16], endpoint: [u8; 32]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(BIND_CONTEXT.len() + 48);
    msg.extend_from_slice(BIND_CONTEXT);
    msg.extend_from_slice(&space);
    msg.extend_from_slice(&endpoint);
    msg
}

fn put_blob(w: &mut Writer, b: &[u8]) {
    w.u32(u32::try_from(b.len()).expect("blob shorter than 4 GiB"));
    w.bytes(b);
}

fn put_blobs(w: &mut Writer, items: &[Vec<u8>]) {
    w.u32(u32::try_from(items.len()).expect("fewer than 4 G items"));
    for item in items {
        put_blob(w, item);
    }
}

fn put_vv(w: &mut Writer, vv: &VersionVector) {
    w.u32(u32::try_from(vv.len()).expect("fewer than 4 G devices"));
    for (device, seq) in vv {
        w.bytes(device);
        w.u64(*seq);
    }
}

fn get_blob(r: &mut Reader) -> Result<Vec<u8>> {
    let n = r.u32()? as usize;
    if n > MAX_FRAME {
        return Err(Error::Malformed("blob too large"));
    }
    Ok(r.take(n)?.to_vec())
}

fn get_blobs(r: &mut Reader) -> Result<Vec<Vec<u8>>> {
    let n = r.count(MAX_ITEMS)?;
    let mut out = Vec::new();
    for _ in 0..n {
        out.push(get_blob(r)?);
    }
    Ok(out)
}

fn get_vv(r: &mut Reader) -> Result<VersionVector> {
    let n = r.count(MAX_ITEMS)?;
    let mut out = Vec::new();
    for _ in 0..n {
        out.push((r.array()?, r.u64()?));
    }
    Ok(out)
}

#[cfg(test)]
#[path = "proto_tests.rs"]
mod tests;

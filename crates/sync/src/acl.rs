//! Participants log entries (SZYFROWANIE §8a, §8b): types, signed bytes and strict binary encoding.
//! Entry = `version ‖ space ‖ index ‖ prev ‖ body ‖ signer ‖ sig`; `signer` is absent for Genesis.
//! `sig` = Ed25519 by the signer over `DOMAIN ‖ version … signer`.

use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};

use crate::cert::{CERT_LEN, DeviceCert};
use crate::codec::{Reader, Writer};
use crate::envelope::{ENVELOPE_LEN, Envelope};
use crate::identity::UserPublic;
use crate::{Error, Result};

pub const DOMAIN: &[u8] = b"notes acl v1";
const VERSION: u8 = 1;
pub const MAX_MEMBERS: u32 = 10_000;
pub const MAX_CUTOFFS: u32 = 10_000;
pub const MAX_DEVICES: u32 = 50_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Owner,
    Editor,
    Reader,
}

impl Role {
    /// Owners and editors may write; readers may only read.
    pub fn is_writer(self) -> bool {
        matches!(self, Role::Owner | Role::Editor)
    }

    pub(crate) fn rank(self) -> u8 {
        match self {
            Role::Reader => 0,
            Role::Editor => 1,
            Role::Owner => 2,
        }
    }

    fn tag(self) -> u8 {
        match self {
            Role::Owner => 1,
            Role::Editor => 2,
            Role::Reader => 3,
        }
    }

    fn from_tag(tag: u8) -> Result<Self> {
        match tag {
            1 => Ok(Role::Owner),
            2 => Ok(Role::Editor),
            3 => Ok(Role::Reader),
            _ => Err(Error::Malformed("unknown role")),
        }
    }
}

/// Who signed an entry. Only the owner writes; the owner signs with the user key or with one of its devices.
#[derive(Debug, Clone, PartialEq, Eq)]
// The certificate is 232 bytes; boxing it would only complicate matching here.
#[allow(clippy::large_enum_variant)]
pub enum Signer {
    OwnerUser,
    /// Certificate issued by the owner's user key; the signature is by that device key.
    OwnerDevice(DeviceCert),
}

/// Device-level envelopes: `(certificate of the device, key sealed to its X25519 key)`.
pub type DeviceEnvelopes = Vec<(DeviceCert, Envelope)>;

/// `(device, last seq known to the owner, BLAKE3 of the message bytes at that seq)`.
pub type Cutoff = ([u8; 32], u64, [u8; 32]);

/// New epoch key for everyone who keeps access, plus the last seq of each cut device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rotation {
    pub new_epoch: u32,
    /// `(user sign key, envelope)` for every remaining member (recovery with the phrase).
    pub envelopes: Vec<([u8; 32], Envelope)>,
    /// Envelopes for the known, non-revoked devices of the remaining members.
    pub device_envelopes: DeviceEnvelopes,
    /// Devices that lose access, each with the last message the owner accepted from it.
    pub cutoffs: Vec<Cutoff>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    Genesis {
        owner: UserPublic,
        envelope: Envelope,
        device_envelopes: DeviceEnvelopes,
    },
    Add {
        user: UserPublic,
        role: Role,
        envelope: Envelope,
        device_envelopes: DeviceEnvelopes,
    },
    ChangeRole {
        user: [u8; 32],
        role: Role,
        rotation: Option<Rotation>,
    },
    Remove {
        user: [u8; 32],
        rotation: Rotation,
    },
    RevokeDevice {
        device: [u8; 32],
        rotation: Rotation,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AclEntry {
    pub space: [u8; 16],
    pub index: u64,
    /// BLAKE3 of the previous entry's full bytes; zeros for index 0.
    pub prev: [u8; 32],
    pub body: Body,
    /// Always `OwnerUser` for Genesis (not encoded there).
    pub signer: Signer,
    pub sig: [u8; 64],
}

impl AclEntry {
    /// `key` must be the signer's key: the user key for `OwnerUser`, the device key for `OwnerDevice`.
    pub fn sign(
        key: &SigningKey,
        signer: Signer,
        space: [u8; 16],
        index: u64,
        prev: [u8; 32],
        body: Body,
    ) -> Self {
        let mut entry = Self {
            space,
            index,
            prev,
            body,
            signer,
            sig: [0; 64],
        };
        entry.sig = key.sign(&entry.signed_msg()).to_bytes();
        entry
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut w = Writer(self.signed_part());
        w.bytes(&self.sig);
        w.0
    }

    pub fn from_bytes(buf: &[u8]) -> Result<Self> {
        if buf.len() < 1 + 16 + 8 + 32 + 1 + 64 {
            return Err(Error::Malformed("entry too short"));
        }
        let (body_part, sig) = buf.split_at(buf.len() - 64);
        let mut r = Reader::new(body_part);
        if r.u8()? != VERSION {
            return Err(Error::Malformed("unknown entry version"));
        }
        let space = r.array()?;
        let index = r.u64()?;
        let prev = r.array()?;
        let body = read_body(&mut r)?;
        let signer = if matches!(body, Body::Genesis { .. }) {
            Signer::OwnerUser
        } else {
            read_signer(&mut r)?
        };
        r.finish()?;
        Ok(Self {
            space,
            index,
            prev,
            body,
            signer,
            sig: sig.try_into().expect("split leaves 64 bytes"),
        })
    }

    pub fn hash(&self) -> [u8; 32] {
        blake3::hash(&self.to_bytes()).into()
    }

    pub(crate) fn verify_sig(&self, key: &VerifyingKey) -> Result<()> {
        let sig = Signature::from_bytes(&self.sig);
        key.verify_strict(&self.signed_msg(), &sig)
            .map_err(|_| Error::Acl("bad signature"))
    }

    fn signed_part(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.u8(VERSION);
        w.bytes(&self.space);
        w.u64(self.index);
        w.bytes(&self.prev);
        write_body(&mut w, &self.body);
        if !matches!(self.body, Body::Genesis { .. }) {
            write_signer(&mut w, &self.signer);
        }
        w.0
    }

    fn signed_msg(&self) -> Vec<u8> {
        let mut msg = DOMAIN.to_vec();
        msg.extend_from_slice(&self.signed_part());
        msg
    }
}

fn write_body(w: &mut Writer, body: &Body) {
    match body {
        Body::Genesis {
            owner,
            envelope,
            device_envelopes,
        } => {
            w.u8(1);
            write_user(w, owner);
            w.bytes(&envelope.0);
            write_devices(w, device_envelopes);
        }
        Body::Add {
            user,
            role,
            envelope,
            device_envelopes,
        } => {
            w.u8(2);
            write_user(w, user);
            w.u8(role.tag());
            w.bytes(&envelope.0);
            write_devices(w, device_envelopes);
        }
        Body::ChangeRole {
            user,
            role,
            rotation,
        } => {
            w.u8(3);
            w.bytes(user);
            w.u8(role.tag());
            match rotation {
                None => w.u8(0),
                Some(rot) => {
                    w.u8(1);
                    write_rotation(w, rot);
                }
            }
        }
        Body::Remove { user, rotation } => {
            w.u8(4);
            w.bytes(user);
            write_rotation(w, rotation);
        }
        Body::RevokeDevice { device, rotation } => {
            w.u8(5);
            w.bytes(device);
            write_rotation(w, rotation);
        }
    }
}

fn write_signer(w: &mut Writer, signer: &Signer) {
    match signer {
        Signer::OwnerUser => w.u8(1),
        Signer::OwnerDevice(cert) => {
            w.u8(2);
            w.bytes(&cert.to_bytes());
        }
    }
}

fn write_user(w: &mut Writer, user: &UserPublic) {
    w.bytes(&user.sign);
    w.bytes(&user.boxk);
}

fn write_devices(w: &mut Writer, devices: &DeviceEnvelopes) {
    w.u32(devices.len() as u32);
    for (cert, env) in devices {
        w.bytes(&cert.to_bytes());
        w.bytes(&env.0);
    }
}

fn write_rotation(w: &mut Writer, rot: &Rotation) {
    w.u32(rot.new_epoch);
    w.u32(rot.envelopes.len() as u32);
    for (user, env) in &rot.envelopes {
        w.bytes(user);
        w.bytes(&env.0);
    }
    write_devices(w, &rot.device_envelopes);
    w.u32(rot.cutoffs.len() as u32);
    for (device, seq, hash) in &rot.cutoffs {
        w.bytes(device);
        w.u64(*seq);
        w.bytes(hash);
    }
}

fn read_body(r: &mut Reader) -> Result<Body> {
    Ok(match r.u8()? {
        1 => Body::Genesis {
            owner: read_user(r)?,
            envelope: read_envelope(r)?,
            device_envelopes: read_devices(r)?,
        },
        2 => Body::Add {
            user: read_user(r)?,
            role: Role::from_tag(r.u8()?)?,
            envelope: read_envelope(r)?,
            device_envelopes: read_devices(r)?,
        },
        3 => {
            let user = r.array()?;
            let role = Role::from_tag(r.u8()?)?;
            let rotation = match r.u8()? {
                0 => None,
                1 => Some(read_rotation(r)?),
                _ => return Err(Error::Malformed("bad option flag")),
            };
            Body::ChangeRole {
                user,
                role,
                rotation,
            }
        }
        4 => Body::Remove {
            user: r.array()?,
            rotation: read_rotation(r)?,
        },
        5 => Body::RevokeDevice {
            device: r.array()?,
            rotation: read_rotation(r)?,
        },
        _ => return Err(Error::Malformed("unknown entry type")),
    })
}

fn read_signer(r: &mut Reader) -> Result<Signer> {
    Ok(match r.u8()? {
        1 => Signer::OwnerUser,
        2 => Signer::OwnerDevice(DeviceCert::from_bytes(&r.array::<CERT_LEN>()?)?),
        _ => return Err(Error::Malformed("unknown signer")),
    })
}

fn read_user(r: &mut Reader) -> Result<UserPublic> {
    Ok(UserPublic {
        sign: r.array()?,
        boxk: r.array()?,
    })
}

fn read_envelope(r: &mut Reader) -> Result<Envelope> {
    Ok(Envelope(r.array::<ENVELOPE_LEN>()?))
}

fn read_devices(r: &mut Reader) -> Result<DeviceEnvelopes> {
    let n = r.count(MAX_DEVICES)?;
    let mut out = Vec::new();
    for _ in 0..n {
        let cert = DeviceCert::from_bytes(&r.array::<CERT_LEN>()?)?;
        out.push((cert, read_envelope(r)?));
    }
    Ok(out)
}

fn read_rotation(r: &mut Reader) -> Result<Rotation> {
    let new_epoch = r.u32()?;
    let n = r.count(MAX_MEMBERS)?;
    let mut envelopes = Vec::new();
    for _ in 0..n {
        envelopes.push((r.array()?, read_envelope(r)?));
    }
    let device_envelopes = read_devices(r)?;
    let n = r.count(MAX_CUTOFFS)?;
    let mut cutoffs = Vec::new();
    for _ in 0..n {
        cutoffs.push((r.array()?, r.u64()?, r.array()?));
    }
    Ok(Rotation {
        new_epoch,
        envelopes,
        device_envelopes,
        cutoffs,
    })
}

//! Invites (SZYFROWANIE §8a, §8c): one-time ticket, commit-reveal join, and the 6-digit security code.
//! Order is enforced by types: the joiner commits to its keys before the owner's challenge exists,
//! and reveals only after receiving it. Code = BLAKE3 over both keys, the secret, `nonce_w` and `nonce_z`.

use data_encoding::BASE32_NOPAD;
use zeroize::Zeroizing;

use crate::cert::{CERT_LEN, DeviceCert};
use crate::identity::UserPublic;
use crate::{Error, Result};

const PREFIX: &str = "notes1:";
const TICKET_LEN: usize = 16 + 32 + 16 + 8;
pub const COMMIT_LEN: usize = 32 + 32;
pub const REVEAL_LEN: usize = 32 + 32 + CERT_LEN + 32;

/// Bearer ticket handed over out of band. `secret` is one-time and zeroized on drop.
#[derive(Clone, PartialEq, Eq)]
pub struct Ticket {
    pub space: [u8; 16],
    pub owner: [u8; 32],
    pub secret: Zeroizing<[u8; 16]>,
    /// Unix seconds; the ticket is valid up to and including this moment.
    pub expires: u64,
}

impl std::fmt::Debug for Ticket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Ticket {{ expires: {}, secret: <secret> }}",
            self.expires
        )
    }
}

impl Ticket {
    pub fn new(space: [u8; 16], owner: [u8; 32], expires: u64) -> Result<Self> {
        Ok(Self {
            space,
            owner,
            secret: Zeroizing::new(crate::random()?),
            expires,
        })
    }

    pub fn encode(&self) -> String {
        let mut bytes = Zeroizing::new(Vec::with_capacity(TICKET_LEN));
        bytes.extend_from_slice(&self.space);
        bytes.extend_from_slice(&self.owner);
        bytes.extend_from_slice(&*self.secret);
        bytes.extend_from_slice(&self.expires.to_le_bytes());
        format!("{PREFIX}{}", BASE32_NOPAD.encode(&bytes))
    }

    pub fn decode(text: &str) -> Result<Self> {
        let body = text
            .strip_prefix(PREFIX)
            .ok_or(Error::Invite("bad ticket prefix"))?;
        let bytes = Zeroizing::new(
            BASE32_NOPAD
                .decode(body.as_bytes())
                .map_err(|_| Error::Invite("bad ticket encoding"))?,
        );
        if bytes.len() != TICKET_LEN {
            return Err(Error::Invite("bad ticket length"));
        }
        Ok(Self {
            space: bytes[..16].try_into().expect("length checked"),
            owner: bytes[16..48].try_into().expect("length checked"),
            secret: Zeroizing::new(bytes[48..64].try_into().expect("length checked")),
            expires: u64::from_le_bytes(bytes[64..].try_into().expect("length checked")),
        })
    }
}

/// First joiner message: binds the joiner's keys to the ticket without revealing them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JoinCommit {
    pub commit: [u8; 32],
    pub mac: [u8; 32],
}

/// Owner's answer to a commit. Random, so the joiner cannot choose its keys after seeing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OwnerChallenge {
    pub nonce_w: [u8; 32],
}

/// Second joiner message: the keys the commit covers, and the commit's nonce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JoinReveal {
    pub user: UserPublic,
    pub cert: DeviceCert,
    pub nonce_z: [u8; 32],
}

/// Joiner state between commit and reveal. Holds the nonce; consumed by `reveal`.
pub struct JoinSecretState {
    ticket: Ticket,
    user: UserPublic,
    cert: DeviceCert,
    nonce_z: Zeroizing<[u8; 32]>,
}

impl JoinCommit {
    /// Returns the commit to send and the state to keep until the owner's challenge arrives.
    pub fn create(
        ticket: &Ticket,
        user: &UserPublic,
        cert: &DeviceCert,
    ) -> Result<(Self, JoinSecretState)> {
        if cert.user != user.sign {
            return Err(Error::Invite("certificate of another user"));
        }
        cert.verify()?;
        let nonce_z = Zeroizing::new(crate::random::<32>()?);
        let commit = commit_hash(user, cert, &nonce_z);
        let mac = commit_mac(ticket, &commit).into();
        let state = JoinSecretState {
            ticket: ticket.clone(),
            user: *user,
            cert: *cert,
            nonce_z,
        };
        Ok((Self { commit, mac }, state))
    }

    pub fn to_bytes(&self) -> [u8; COMMIT_LEN] {
        let mut out = [0u8; COMMIT_LEN];
        out[..32].copy_from_slice(&self.commit);
        out[32..64].copy_from_slice(&self.mac);
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let b: &[u8; COMMIT_LEN] = bytes
            .try_into()
            .map_err(|_| Error::Malformed("join commit length"))?;
        Ok(Self {
            commit: b[..32].try_into().unwrap(),
            mac: b[32..].try_into().unwrap(),
        })
    }
}

impl JoinSecretState {
    /// Consumes the state and produces the reveal and the security code shown on this side.
    pub fn reveal(self, challenge: &OwnerChallenge) -> (JoinReveal, String) {
        let code = security_code(
            &self.ticket.owner,
            &self.user,
            &self.ticket.secret,
            &challenge.nonce_w,
            &self.nonce_z,
        );
        let reveal = JoinReveal {
            user: self.user,
            cert: self.cert,
            nonce_z: *self.nonce_z,
        };
        (reveal, code)
    }
}

impl JoinReveal {
    pub fn to_bytes(&self) -> [u8; REVEAL_LEN] {
        let mut out = [0u8; REVEAL_LEN];
        out[..32].copy_from_slice(&self.user.sign);
        out[32..64].copy_from_slice(&self.user.boxk);
        out[64..64 + CERT_LEN].copy_from_slice(&self.cert.to_bytes());
        out[64 + CERT_LEN..].copy_from_slice(&self.nonce_z);
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let b: &[u8; REVEAL_LEN] = bytes
            .try_into()
            .map_err(|_| Error::Malformed("join reveal length"))?;
        Ok(Self {
            user: UserPublic {
                sign: b[..32].try_into().unwrap(),
                boxk: b[32..64].try_into().unwrap(),
            },
            cert: DeviceCert::from_bytes(&b[64..64 + CERT_LEN])?,
            nonce_z: b[64 + CERT_LEN..].try_into().unwrap(),
        })
    }
}

fn commit_hash(user: &UserPublic, cert: &DeviceCert, nonce_z: &[u8; 32]) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(b"notes join commit v1");
    h.update(&user.sign);
    h.update(&user.boxk);
    h.update(&cert.to_bytes());
    h.update(nonce_z);
    h.finalize().into()
}

fn commit_mac(ticket: &Ticket, commit: &[u8; 32]) -> blake3::Hash {
    // The ticket secret is 16 bytes; BLAKE3 keys are 32, so the MAC key is derived from it.
    let key = Zeroizing::new(blake3::derive_key("notes join key v1", &ticket.secret[..]));
    let mut h = blake3::Hasher::new_keyed(&key);
    h.update(b"notes join mac v1");
    h.update(&ticket.space);
    h.update(commit);
    h.finalize()
}

/// 6 decimal digits both sides show for comparison.
pub fn security_code(
    owner: &[u8; 32],
    joiner: &UserPublic,
    secret: &[u8; 16],
    nonce_w: &[u8; 32],
    nonce_z: &[u8; 32],
) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"notes join code v1");
    h.update(owner);
    h.update(&joiner.sign);
    h.update(&joiner.boxk);
    h.update(secret);
    h.update(nonce_w);
    h.update(nonce_z);
    let digest = h.finalize();
    let n = u64::from_le_bytes(digest.as_bytes()[..8].try_into().expect("32-byte digest"));
    format!("{:06}", n % 1_000_000)
}

struct Pending {
    ticket: Ticket,
    /// `(commit, nonce_w)` once the joiner committed; one commit per ticket.
    committed: Option<([u8; 32], [u8; 32])>,
    /// Set after a wrong code: the ticket stays unusable until cancelled, so typing codes cannot be brute-forced.
    blocked: bool,
}

/// What the owner's UI can say about a ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketStatus {
    /// Issued, nobody committed yet.
    Open,
    /// Someone committed; waiting for the reveal and the typed code.
    Committed,
    Expired,
    /// Not pending any more: approved, cancelled, or never issued here.
    /// Typically means the ticket was used by someone else; issue a new one over another channel.
    Unknown,
}

/// Owner-side open tickets. A ticket is consumed by the first approval.
#[derive(Default)]
pub struct PendingInvites(Vec<Pending>);

impl PendingInvites {
    pub fn issue(&mut self, ticket: Ticket, now: u64) {
        self.prune(now);
        self.0.push(Pending {
            ticket,
            committed: None,
            blocked: false,
        });
    }

    /// Withdraws a ticket (the owner gave up on it, or it leaked). Unknown tickets are ignored.
    pub fn cancel(&mut self, ticket: &Ticket) {
        self.0.retain(|p| p.ticket != *ticket);
    }

    pub fn status(&self, ticket: &Ticket, now: u64) -> TicketStatus {
        match self.0.iter().find(|p| p.ticket == *ticket) {
            None => TicketStatus::Unknown,
            Some(p) if now > p.ticket.expires => TicketStatus::Expired,
            Some(p) if p.committed.is_some() => TicketStatus::Committed,
            Some(_) => TicketStatus::Open,
        }
    }

    /// Finds the ticket the commit authenticates against, then issues the challenge.
    pub fn receive_commit(&mut self, commit: &JoinCommit, now: u64) -> Result<OwnerChallenge> {
        self.prune(now);
        let pos = self
            .0
            .iter()
            .position(|p| commit_mac(&p.ticket, &commit.commit) == blake3::Hash::from(commit.mac))
            .ok_or(Error::Invite("no matching open ticket"))?;
        let pending = &mut self.0[pos];
        if pending.committed.is_some() {
            return Err(Error::Invite("ticket already committed"));
        }
        let nonce_w = crate::random::<32>()?;
        pending.committed = Some((commit.commit, nonce_w));
        Ok(OwnerChallenge { nonce_w })
    }

    /// Verifies the reveal against the stored commit, the certificate and the expiry; returns the code.
    pub fn check_reveal(&self, reveal: &JoinReveal, now: u64) -> Result<String> {
        self.locate(reveal, now).map(|(_, code)| code)
    }

    /// Approves only if `typed_code` (what the owner read from the joiner's screen) equals the code.
    /// A wrong code blocks the ticket (not consumed; `cancel` it and issue a new one).
    /// Success consumes the ticket so the same secret cannot approve twice.
    pub fn approve(
        &mut self,
        reveal: &JoinReveal,
        now: u64,
        typed_code: &str,
    ) -> Result<UserPublic> {
        let (pos, code) = self.locate(reveal, now)?;
        if self.0[pos].blocked {
            return Err(Error::Invite("ticket blocked after a wrong code"));
        }
        if blake3::hash(code.as_bytes()) != blake3::hash(typed_code.as_bytes()) {
            self.0[pos].blocked = true;
            return Err(Error::Invite("code does not match"));
        }
        self.0.remove(pos);
        Ok(reveal.user)
    }

    fn prune(&mut self, now: u64) {
        self.0.retain(|p| now <= p.ticket.expires);
    }

    fn locate(&self, reveal: &JoinReveal, now: u64) -> Result<(usize, String)> {
        reveal.cert.verify()?;
        if reveal.cert.user != reveal.user.sign {
            return Err(Error::Invite("certificate of another user"));
        }
        let hash = commit_hash(&reveal.user, &reveal.cert, &reveal.nonce_z);
        let (pos, pending) = self
            .0
            .iter()
            .enumerate()
            .find(|(_, p)| p.committed.is_some_and(|(c, _)| c == hash))
            .ok_or(Error::Invite("reveal does not match the commit"))?;
        if now > pending.ticket.expires {
            return Err(Error::Invite("ticket expired"));
        }
        let (_, nonce_w) = pending.committed.expect("matched a commit");
        let code = security_code(
            &pending.ticket.owner,
            &reveal.user,
            &pending.ticket.secret,
            &nonce_w,
            &reveal.nonce_z,
        );
        Ok((pos, code))
    }
}

#[cfg(test)]
#[path = "invite_tests.rs"]
mod tests;

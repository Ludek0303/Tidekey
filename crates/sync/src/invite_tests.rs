use super::*;
use crate::acl::Role;
use crate::acl_log::AclLog;
use crate::cert::{CertStore, DeviceCert};
use crate::device::DeviceKeys;
use crate::identity::{RecoveryPhrase, UserKeys};
use crate::policy::{MessageHeader, accept};

const SPACE: [u8; 16] = [5; 16];
const NOW: u64 = 1_700_000_000;

fn user() -> (RecoveryPhrase, UserKeys) {
    let p = RecoveryPhrase::generate().unwrap();
    let k = UserKeys::from_phrase(&p).unwrap();
    (p, k)
}

/// A device of `keys` with its certificate.
fn joiner_device(keys: &UserKeys) -> (DeviceKeys, DeviceCert) {
    let d = DeviceKeys::generate().unwrap();
    let cert = DeviceCert::issue(keys, &d, NOW);
    (d, cert)
}

/// Joiner side up to the commit; the owner has the ticket in `pending`.
struct Join {
    ticket: Ticket,
    commit: JoinCommit,
    state: JoinSecretState,
    joiner: UserKeys,
    device: DeviceKeys,
    cert: DeviceCert,
}

fn start_join(pending: &mut PendingInvites, owner_pub: [u8; 32]) -> Join {
    let ticket = Ticket::new(SPACE, owner_pub, NOW + 600).unwrap();
    pending.issue(ticket.clone(), NOW);
    let (_, joiner) = user();
    let (device, cert) = joiner_device(&joiner);
    let (commit, state) = JoinCommit::create(&ticket, &joiner.public(), &cert).unwrap();
    Join {
        ticket,
        commit,
        state,
        joiner,
        device,
        cert,
    }
}

#[test]
fn ticket_round_trip_and_strict_decode() {
    let t = Ticket::new(SPACE, [2; 32], NOW + 60).unwrap();
    let text = t.encode();
    assert!(text.starts_with("notes1:"));
    assert_eq!(Ticket::decode(&text).unwrap(), t);
    assert!(Ticket::decode(&text[..text.len() - 1]).is_err());
    assert!(Ticket::decode(&text.replace("notes1:", "notes2:")).is_err());
    assert!(Ticket::decode("notes1:AAAA").is_err());
}

#[test]
fn ticket_debug_hides_secret() {
    let t = Ticket::new(SPACE, [2; 32], NOW).unwrap();
    let shown = format!("{t:?}");
    assert!(shown.contains("<secret>") && !shown.contains('['));
}

#[test]
fn full_commit_reveal_join() {
    let (_, owner) = user();
    let owner_pub = owner.public().sign;
    let mut log = AclLog::genesis(owner, SPACE, &CertStore::default()).unwrap();
    let mut pending = PendingInvites::default();
    let j = start_join(&mut pending, owner_pub);

    // Commit first; the owner answers with the challenge; then the joiner reveals.
    let challenge = pending.receive_commit(&j.commit, NOW).unwrap();
    let (reveal, joiner_code) = j.state.reveal(&challenge);
    let owner_code = pending.check_reveal(&reveal, NOW).unwrap();
    assert_eq!(owner_code, joiner_code);
    assert_eq!(owner_code.len(), 6);

    let code = pending.check_reveal(&reveal, NOW + 1).unwrap();
    let user = pending.approve(&reveal, NOW + 1, &code).unwrap();
    assert_eq!(user, j.joiner.public());
    let mut certs = CertStore::default();
    certs.insert(reveal.cert).unwrap();
    log.add(user, Role::Editor, &certs).unwrap();

    // The joiner checks the log against the owner key from the ticket and opens its keys.
    let st = AclLog::verify(log.entries()).unwrap();
    assert_eq!(st.owner, j.ticket.owner);
    assert!(st.epoch_keys(&j.joiner).keys.contains_key(&0));
    // The joiner's device gets the key directly, through its device envelope.
    assert!(st.epoch_keys_for_device(&j.device).keys.contains_key(&0));

    let h = MessageHeader {
        space: SPACE,
        device: j.cert.device,
        seq: 1,
        epoch: 0,
    };
    assert_eq!(accept(&st, &certs, &h, &[0; 32]), Ok(()));
}

#[test]
fn reveal_with_other_keys_fails_the_commit_check() {
    let (_, owner) = user();
    let mut pending = PendingInvites::default();
    let j = start_join(&mut pending, owner.public().sign);
    let challenge = pending.receive_commit(&j.commit, NOW).unwrap();

    // The attacker saw the challenge only after committing, so switching keys must fail.
    let (_, attacker) = user();
    let (_, attacker_cert) = joiner_device(&attacker);
    let forged = JoinReveal {
        user: attacker.public(),
        cert: attacker_cert,
        nonce_z: [0; 32],
    };
    assert_eq!(
        pending.check_reveal(&forged, NOW),
        Err(Error::Invite("reveal does not match the commit"))
    );

    // Same keys, wrong nonce_z: also rejected.
    let (reveal, _) = j.state.reveal(&challenge);
    let mut wrong_nonce = reveal;
    wrong_nonce.nonce_z[0] ^= 1;
    assert!(pending.check_reveal(&wrong_nonce, NOW).is_err());
    assert!(pending.check_reveal(&reveal, NOW).is_ok());
}

#[test]
fn second_commit_for_the_same_ticket_is_rejected() {
    let (_, owner) = user();
    let mut pending = PendingInvites::default();
    let j = start_join(&mut pending, owner.public().sign);
    pending.receive_commit(&j.commit, NOW).unwrap();

    let (_, other) = user();
    let (_, other_cert) = joiner_device(&other);
    let (second, _) = JoinCommit::create(&j.ticket, &other.public(), &other_cert).unwrap();
    assert_eq!(
        pending.receive_commit(&second, NOW),
        Err(Error::Invite("ticket already committed"))
    );
}

#[test]
fn reveal_before_any_commit_is_rejected() {
    let (_, owner) = user();
    let mut pending = PendingInvites::default();
    let j = start_join(&mut pending, owner.public().sign);
    let (reveal, _) = j.state.reveal(&OwnerChallenge { nonce_w: [9; 32] });
    assert_eq!(
        pending.check_reveal(&reveal, NOW),
        Err(Error::Invite("reveal does not match the commit"))
    );
}

#[test]
fn commit_checks_mac_and_expiry() {
    let (_, owner) = user();
    let (_, joiner) = user();
    let ticket = Ticket::new(SPACE, owner.public().sign, NOW).unwrap();
    let (_, cert) = joiner_device(&joiner);
    let mut pending = PendingInvites::default();
    pending.issue(ticket.clone(), NOW);

    let (mut commit, _) = JoinCommit::create(&ticket, &joiner.public(), &cert).unwrap();
    commit.mac[0] ^= 1;
    assert!(
        pending.receive_commit(&commit, NOW).is_err(),
        "tampered MAC"
    );

    let (commit, _) = JoinCommit::create(&ticket, &joiner.public(), &cert).unwrap();
    assert_eq!(
        pending.receive_commit(&commit, NOW + 1),
        Err(Error::Invite("no matching open ticket"))
    );
}

#[test]
fn commit_from_another_ticket_is_rejected() {
    let (_, owner) = user();
    let (_, joiner) = user();
    let t1 = Ticket::new(SPACE, owner.public().sign, NOW + 60).unwrap();
    let t2 = Ticket::new(SPACE, owner.public().sign, NOW + 60).unwrap();
    let (_, cert) = joiner_device(&joiner);
    let (commit, _) = JoinCommit::create(&t1, &joiner.public(), &cert).unwrap();
    let mut pending = PendingInvites::default();
    pending.issue(t2, NOW);
    assert!(pending.receive_commit(&commit, NOW).is_err());
}

#[test]
fn reused_secret_rejected() {
    let (_, owner) = user();
    let mut pending = PendingInvites::default();
    let j = start_join(&mut pending, owner.public().sign);
    let challenge = pending.receive_commit(&j.commit, NOW).unwrap();
    let (reveal, _) = j.state.reveal(&challenge);
    let code = pending.check_reveal(&reveal, NOW).unwrap();
    pending.approve(&reveal, NOW, &code).unwrap();
    assert_eq!(
        pending.approve(&reveal, NOW, &code),
        Err(Error::Invite("reveal does not match the commit"))
    );
}

#[test]
fn certificate_of_another_user_rejected() {
    let (_, joiner) = user();
    let (_, other) = user();
    let ticket = Ticket::new(SPACE, [1; 32], NOW + 60).unwrap();
    let (_, cert) = joiner_device(&other);
    assert_eq!(
        JoinCommit::create(&ticket, &joiner.public(), &cert).err(),
        Some(Error::Invite("certificate of another user"))
    );
}

#[test]
fn security_code_changes_with_any_input() {
    let (_, a) = user();
    let (_, b) = user();
    let secret = [1u8; 16];
    let (w, z) = ([3u8; 32], [4u8; 32]);
    let base = security_code(&a.public().sign, &b.public(), &secret, &w, &z);
    assert_ne!(
        base,
        security_code(&b.public().sign, &b.public(), &secret, &w, &z)
    );
    assert_ne!(
        base,
        security_code(&a.public().sign, &a.public(), &secret, &w, &z)
    );
    assert_ne!(
        base,
        security_code(&a.public().sign, &b.public(), &[2; 16], &w, &z)
    );
    assert_ne!(
        base,
        security_code(&a.public().sign, &b.public(), &secret, &[5; 32], &z)
    );
    assert_ne!(
        base,
        security_code(&a.public().sign, &b.public(), &secret, &w, &[5; 32])
    );
}

#[test]
fn encodings_round_trip_and_reject_wrong_length() {
    let (_, owner) = user();
    let mut pending = PendingInvites::default();
    let j = start_join(&mut pending, owner.public().sign);
    assert_eq!(
        JoinCommit::from_bytes(&j.commit.to_bytes()).unwrap(),
        j.commit
    );
    assert!(JoinCommit::from_bytes(&[0; COMMIT_LEN - 1]).is_err());
    let challenge = pending.receive_commit(&j.commit, NOW).unwrap();
    let (reveal, _) = j.state.reveal(&challenge);
    assert_eq!(JoinReveal::from_bytes(&reveal.to_bytes()).unwrap(), reveal);
    assert!(JoinReveal::from_bytes(&[0; REVEAL_LEN + 1]).is_err());
}

#[test]
fn approve_requires_the_typed_code() {
    let (_, owner) = user();
    let mut pending = PendingInvites::default();
    let j = start_join(&mut pending, owner.public().sign);
    let challenge = pending.receive_commit(&j.commit, NOW).unwrap();
    let (reveal, joiner_code) = j.state.reveal(&challenge);
    let code = pending.check_reveal(&reveal, NOW).unwrap();

    // Empty and wrong codes fail, and the first wrong one blocks the ticket.
    assert_eq!(
        pending.approve(&reveal, NOW, ""),
        Err(Error::Invite("code does not match"))
    );
    assert_eq!(
        pending.approve(&reveal, NOW, "000000"),
        Err(Error::Invite("ticket blocked after a wrong code"))
    );
    // Even the right code is refused now: no further guessing, the ticket was not consumed.
    assert_eq!(
        pending.approve(&reveal, NOW, &code),
        Err(Error::Invite("ticket blocked after a wrong code"))
    );
    assert_eq!(pending.status(&j.ticket, NOW), TicketStatus::Committed);
    assert_eq!(joiner_code, code);
}

#[test]
fn right_code_approves_once() {
    let (_, owner) = user();
    let mut pending = PendingInvites::default();
    let j = start_join(&mut pending, owner.public().sign);
    let challenge = pending.receive_commit(&j.commit, NOW).unwrap();
    let (reveal, _) = j.state.reveal(&challenge);
    let code = pending.check_reveal(&reveal, NOW).unwrap();
    assert_eq!(pending.approve(&reveal, NOW, &code), Ok(j.joiner.public()));
    assert_eq!(pending.status(&j.ticket, NOW), TicketStatus::Unknown);
}

#[test]
fn cancel_withdraws_an_open_or_committed_ticket() {
    let (_, owner) = user();
    let mut pending = PendingInvites::default();
    let j = start_join(&mut pending, owner.public().sign);
    assert_eq!(pending.status(&j.ticket, NOW), TicketStatus::Open);
    let challenge = pending.receive_commit(&j.commit, NOW).unwrap();
    assert_eq!(pending.status(&j.ticket, NOW), TicketStatus::Committed);

    pending.cancel(&j.ticket);
    assert_eq!(pending.status(&j.ticket, NOW), TicketStatus::Unknown);
    let (reveal, _) = j.state.reveal(&challenge);
    assert!(pending.check_reveal(&reveal, NOW).is_err());
    // Cancelling again is harmless.
    pending.cancel(&j.ticket);
}

#[test]
fn status_reports_expiry_and_expired_tickets_are_dropped() {
    let (_, owner) = user();
    let mut pending = PendingInvites::default();
    let j = start_join(&mut pending, owner.public().sign);
    let later = j.ticket.expires + 1;
    assert_eq!(pending.status(&j.ticket, later), TicketStatus::Expired);

    // Issuing another ticket later prunes the expired one.
    let fresh = Ticket::new(SPACE, owner.public().sign, later + 60).unwrap();
    pending.issue(fresh.clone(), later);
    assert_eq!(pending.status(&j.ticket, later), TicketStatus::Unknown);
    assert_eq!(pending.status(&fresh, later), TicketStatus::Open);
}

#[test]
fn expired_commit_is_pruned_on_receive() {
    let (_, owner) = user();
    let mut pending = PendingInvites::default();
    let j = start_join(&mut pending, owner.public().sign);
    let later = j.ticket.expires + 1;
    assert_eq!(
        pending.receive_commit(&j.commit, later),
        Err(Error::Invite("no matching open ticket"))
    );
}

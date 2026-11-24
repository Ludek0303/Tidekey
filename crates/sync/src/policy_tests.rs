use super::*;

/// Message hash the tests use for every message, matching the cutoffs they set.
const MSG: [u8; 32] = [7; 32];

fn accept(state: &AclState, certs: &CertStore, h: &MessageHeader) -> Result<(), Reject> {
    super::accept(state, certs, h, &MSG)
}
use crate::acl::Role;
use crate::acl_log::AclLog;
use crate::cert::DeviceCert;
use crate::device::DeviceKeys;
use crate::identity::{RecoveryPhrase, UserKeys};
use crate::keystore::Slot;
use crate::space_access::secret32;
use crate::space_owner::revoke_device;
use crate::test_util::{Permissive, account, owner_space, team};

const SPACE: [u8; 16] = [4; 16];

fn user() -> (RecoveryPhrase, UserKeys) {
    let p = RecoveryPhrase::generate().unwrap();
    let k = UserKeys::from_phrase(&p).unwrap();
    (p, k)
}

fn again(p: &RecoveryPhrase) -> UserKeys {
    UserKeys::from_phrase(p).unwrap()
}

/// Issues a new device certificate for `user` and returns the device key.
fn device(user: &UserKeys, certs: &mut CertStore) -> [u8; 32] {
    let d = DeviceKeys::generate().unwrap();
    certs.insert(DeviceCert::issue(user, &d, 1)).unwrap();
    d.public().sign
}

fn hdr(device: [u8; 32], seq: u64, epoch: u32) -> MessageHeader {
    MessageHeader {
        space: SPACE,
        device,
        seq,
        epoch,
    }
}

#[test]
fn reader_message_is_rejected() {
    let (_, owner) = user();
    let (_, reader) = user();
    let mut certs = CertStore::default();
    let o_dev = device(&owner, &mut certs);
    let r_dev = device(&reader, &mut certs);
    let mut log = AclLog::genesis(owner, SPACE, &certs).unwrap();
    log.add(reader.public(), Role::Reader, &certs).unwrap();
    let st = log.state().clone();

    assert_eq!(
        accept(&st, &certs, &hdr(r_dev, 1, 0)),
        Err(Reject::NotWriter)
    );
    assert_eq!(accept(&st, &certs, &hdr(o_dev, 1, 0)), Ok(()));
}

#[test]
fn removed_user_old_messages_pass_and_newer_ones_fail() {
    let (_, owner) = user();
    let (bp, b) = user();
    let mut certs = CertStore::default();
    let o_dev = device(&owner, &mut certs);
    let b_dev = device(&b, &mut certs);
    let mut log = AclLog::genesis(owner, SPACE, &certs).unwrap();
    log.add(b.public(), Role::Editor, &certs).unwrap();
    log.remove(again(&bp).public().sign, vec![(b_dev, 5, [7; 32])], &certs)
        .unwrap();
    let st = AclLog::verify(log.entries()).unwrap();

    assert_eq!(
        accept(&st, &certs, &hdr(b_dev, 5, 0)),
        Ok(()),
        "known before removal"
    );
    assert_eq!(
        accept(&st, &certs, &hdr(b_dev, 6, 0)),
        Err(Reject::AfterDeparture)
    );
    assert_eq!(
        accept(&st, &certs, &hdr(b_dev, 1, 1)),
        Err(Reject::NotWriter)
    );
    assert_eq!(accept(&st, &certs, &hdr(o_dev, 1, 1)), Ok(()));
    assert_eq!(
        accept(&st, &certs, &hdr(o_dev, 1, 2)),
        Err(Reject::FutureEpoch)
    );
}

#[test]
fn new_device_of_removed_user_is_rejected() {
    let (_, owner) = user();
    let (bp, b) = user();
    let mut certs = CertStore::default();
    let b_dev = device(&b, &mut certs);
    let mut log = AclLog::genesis(owner, SPACE, &certs).unwrap();
    log.add(b.public(), Role::Editor, &certs).unwrap();
    log.remove(b.public().sign, vec![(b_dev, 5, [7; 32])], &certs)
        .unwrap();
    let st = AclLog::verify(log.entries()).unwrap();

    let b2_dev = device(&again(&bp), &mut certs);
    assert_eq!(
        accept(&st, &certs, &hdr(b2_dev, 1, 0)),
        Err(Reject::AfterDeparture)
    );
    assert_eq!(
        accept(&st, &certs, &hdr(b2_dev, 1, 1)),
        Err(Reject::NotWriter)
    );
}

#[test]
fn new_device_of_member_is_accepted_and_gets_epoch_keys() {
    let (_, owner) = user();
    let (bp, b) = user();
    let mut certs = CertStore::default();
    let _ = device(&owner, &mut certs);
    let b1 = device(&b, &mut certs);
    let mut log = AclLog::genesis(owner, SPACE, &certs).unwrap();
    log.add(b.public(), Role::Editor, &certs).unwrap();
    let st = log.state().clone();

    let b2 = device(&again(&bp), &mut certs);
    assert_eq!(accept(&st, &certs, &hdr(b1, 1, 0)), Ok(()));
    assert_eq!(accept(&st, &certs, &hdr(b2, 1, 0)), Ok(()));
    let keys = st.epoch_keys(&again(&bp));
    assert!(keys.keys.contains_key(&0));
}

#[test]
fn revoked_device_is_cut_at_its_seq() {
    let (_, owner) = user();
    let (_, b) = user();
    let mut certs = CertStore::default();
    let _ = device(&owner, &mut certs);
    let b1 = device(&b, &mut certs);
    let mut log = AclLog::genesis(owner, SPACE, &certs).unwrap();
    log.add(b.public(), Role::Editor, &certs).unwrap();
    log.revoke_device((b1, 4, [7; 32]), &certs).unwrap();
    let st = log.state().clone();

    assert_eq!(accept(&st, &certs, &hdr(b1, 4, 0)), Ok(()));
    assert_eq!(accept(&st, &certs, &hdr(b1, 5, 0)), Err(Reject::Revoked));
    assert_eq!(accept(&st, &certs, &hdr(b1, 5, 1)), Err(Reject::Revoked));
    assert_eq!(accept(&st, &certs, &hdr(b1, 4, 1)), Ok(()));
}

#[test]
fn demoted_user_regains_rights_without_reopening_old_cut() {
    let (_, owner) = user();
    let (_, b) = user();
    let mut certs = CertStore::default();
    let _ = device(&owner, &mut certs);
    let b1 = device(&b, &mut certs);
    let mut log = AclLog::genesis(owner, SPACE, &certs).unwrap();
    log.add(b.public(), Role::Editor, &certs).unwrap();
    log.change_role(
        b.public().sign,
        Role::Reader,
        vec![(b1, 3, [7; 32])],
        &certs,
    )
    .unwrap();
    assert_eq!(accept(&log.state().clone(), &certs, &hdr(b1, 3, 0)), Ok(()));
    assert_eq!(
        accept(&log.state().clone(), &certs, &hdr(b1, 4, 0)),
        Err(Reject::AfterDeparture)
    );

    log.change_role(b.public().sign, Role::Editor, vec![], &certs)
        .unwrap();
    let st = log.state().clone();
    assert_eq!(
        accept(&st, &certs, &hdr(b1, 10, 1)),
        Ok(()),
        "writes again in the new epoch"
    );
    assert_eq!(
        accept(&st, &certs, &hdr(b1, 4, 0)),
        Err(Reject::AfterDeparture)
    );
}

#[test]
fn unknown_device_and_other_space_are_rejected() {
    let (_, owner) = user();
    let mut certs = CertStore::default();
    let o_dev = device(&owner, &mut certs);
    let log = AclLog::genesis(owner, SPACE, &certs).unwrap();
    let st = log.state().clone();

    assert_eq!(
        accept(&st, &certs, &hdr([9; 32], 1, 0)),
        Err(Reject::NoCert)
    );
    let other = MessageHeader {
        space: [1; 16],
        ..hdr(o_dev, 1, 0)
    };
    assert_eq!(accept(&st, &certs, &other), Err(Reject::OtherSpace));
}

#[test]
fn parse_header_reads_core_layout() {
    let mut bytes = vec![1u8];
    bytes.extend_from_slice(&SPACE);
    bytes.extend_from_slice(&[7; 32]);
    bytes.extend_from_slice(&42u64.to_le_bytes());
    bytes.extend_from_slice(&3u32.to_le_bytes());
    bytes.extend_from_slice(&[0; 24]);
    assert_eq!(bytes.len(), HEADER_LEN);
    let h = parse_header(&bytes).unwrap();
    assert_eq!((h.space, h.device, h.seq, h.epoch), (SPACE, [7; 32], 42, 3));

    assert!(parse_header(&bytes[..HEADER_LEN - 1]).is_none());
    bytes[0] = 2;
    assert!(parse_header(&bytes).is_none());
}

#[test]
fn cut_seq_with_different_content_is_rejected() {
    let (_, owner) = user();
    let (bp, b) = user();
    let mut certs = CertStore::default();
    let _ = device(&owner, &mut certs);
    let b1 = device(&b, &mut certs);
    let mut log = AclLog::genesis(owner, SPACE, &certs).unwrap();
    log.add(b.public(), Role::Editor, &certs).unwrap();
    log.remove(again(&bp).public().sign, vec![(b1, 5, [7; 32])], &certs)
        .unwrap();
    let st = AclLog::verify(log.entries()).unwrap();

    // The same message the owner saw at seq 5 is accepted; a different one at that seq is not.
    assert_eq!(super::accept(&st, &certs, &hdr(b1, 5, 0), &[7; 32]), Ok(()));
    assert_eq!(
        super::accept(&st, &certs, &hdr(b1, 5, 0), &[8; 32]),
        Err(Reject::CutMismatch)
    );
    assert_eq!(
        super::accept(&st, &certs, &hdr(b1, 6, 0), &[7; 32]),
        Err(Reject::AfterDeparture)
    );
}

#[test]
fn revoked_cut_checks_content_too() {
    let (_, owner) = user();
    let (_, b) = user();
    let mut certs = CertStore::default();
    let _ = device(&owner, &mut certs);
    let b1 = device(&b, &mut certs);
    let mut log = AclLog::genesis(owner, SPACE, &certs).unwrap();
    log.add(b.public(), Role::Editor, &certs).unwrap();
    log.revoke_device((b1, 4, [7; 32]), &certs).unwrap();
    let st = log.state().clone();
    assert_eq!(super::accept(&st, &certs, &hdr(b1, 4, 1), &[7; 32]), Ok(()));
    assert_eq!(
        super::accept(&st, &certs, &hdr(b1, 4, 1), &[9; 32]),
        Err(Reject::CutMismatch)
    );
}

#[test]
fn check_message_accepts_a_signed_message_and_rejects_tampering() {
    let dir = tempfile::tempdir().unwrap();
    let (mut owner, _) = owner_space(dir.path());
    let id = owner.space.create_note("n.md").unwrap();
    owner.space.insert_text(&id, 0, "tekst").unwrap();
    let msg = owner.space.messages().unwrap().remove(0);

    let h = check_message(&owner.acl, &owner.certs, &msg).unwrap();
    assert_eq!(h.device, owner.cert.device);

    // a flipped byte in the ciphertext and one in the signature both fail the signature check
    let mut body = msg.clone();
    body[HEADER_LEN + 3] ^= 1;
    assert_eq!(
        check_message(&owner.acl, &owner.certs, &body),
        Err(Reject::BadSignature)
    );
    let mut sig = msg.clone();
    let last = sig.len() - 1;
    sig[last] ^= 1;
    assert_eq!(
        check_message(&owner.acl, &owner.certs, &sig),
        Err(Reject::BadSignature)
    );
    assert_eq!(
        check_message(&owner.acl, &owner.certs, &msg[..HEADER_LEN]),
        Err(Reject::Malformed)
    );
}

#[test]
fn check_message_refuses_a_reader_even_with_a_valid_signature() {
    let dirs: Vec<_> = (0..2).map(|_| tempfile::tempdir().unwrap()).collect();
    let roots: Vec<&std::path::Path> = dirs.iter().map(|d| d.path()).collect();
    let mut stores = team(&roots, &[Role::Reader]);
    let space = stores[0].opened.acl.space;
    let epoch0 = secret32(
        &stores[0]
            .ks
            .get(Slot::EpochKey { space, epoch: 0 })
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let reader = &mut stores[1].opened;
    // a device that ignores the rules: it holds the epoch-0 key and writes anyway
    reader.space.set_access(Box::new(Permissive(epoch0)));
    let id = reader.space.create_note("x.md").unwrap();
    reader.space.insert_text(&id, 0, "czytelnik").unwrap();
    let msg = reader.space.messages().unwrap().remove(0);
    let owner = &stores[0].opened;
    assert_eq!(
        check_message(&owner.acl, &owner.certs, &msg),
        Err(Reject::NotWriter)
    );
}

#[test]
fn peer_allowed_covers_members_readers_and_revoked_devices() {
    let dirs: Vec<_> = (0..2).map(|_| tempfile::tempdir().unwrap()).collect();
    let roots: Vec<&std::path::Path> = dirs.iter().map(|d| d.path()).collect();
    let mut stores = team(&roots, &[Role::Reader]);
    let reader = stores[1].opened.cert.device;
    let owner = stores[0].opened.cert.device;
    let (_, stranger_user) = account();
    let stranger_keys = crate::device::DeviceKeys::generate().unwrap();
    let stranger = stranger_keys.public().sign;
    let mut certs = stores[0].opened.certs.clone();
    certs
        .insert(crate::cert::DeviceCert::issue(
            &stranger_user,
            &stranger_keys,
            1,
        ))
        .unwrap();
    let acl = stores[0].opened.acl.clone();

    assert!(peer_allowed(&acl, &certs, &owner));
    assert!(peer_allowed(&acl, &certs, &reader));
    assert!(!peer_allowed(&acl, &certs, &stranger));
    assert!(!peer_allowed(&acl, &certs, &[0; 32]));

    let owner_store = &mut stores[0];
    revoke_device(&mut owner_store.opened, &mut *owner_store.ks, reader).unwrap();
    let acl = owner_store.opened.acl.clone();
    assert!(!peer_allowed(&acl, &owner_store.opened.certs, &reader));
}

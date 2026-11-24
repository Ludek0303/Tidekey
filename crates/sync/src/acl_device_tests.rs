//! Device-level envelopes, owner device signers and restart (SZYFROWANIE §8b).

use crate::acl::{AclEntry, Body, Role, Signer};
use crate::acl_log::{AclLog, Signing};
use crate::acl_state::AclHead;
use crate::cert::{CertStore, DeviceCert};
use crate::device::DeviceKeys;
use crate::envelope::Envelope;
use crate::identity::{RecoveryPhrase, UserKeys, UserPublic};
use crate::{Error, Result};
use proptest::prelude::*;
use std::sync::OnceLock;

const SPACE: [u8; 16] = [9; 16];

fn phrase() -> RecoveryPhrase {
    RecoveryPhrase::generate().unwrap()
}

fn keys(p: &RecoveryPhrase) -> UserKeys {
    UserKeys::from_phrase(p).unwrap()
}

/// Generates a device of `user` and certifies it.
fn enroll(user: &UserKeys, certs: &mut CertStore) -> (DeviceKeys, DeviceCert) {
    let d = DeviceKeys::generate().unwrap();
    let cert = DeviceCert::issue(user, &d, 1);
    certs.insert(cert).unwrap();
    (d, cert)
}

fn copy(d: &DeviceKeys) -> DeviceKeys {
    let (s, b) = d.to_seeds();
    DeviceKeys::from_seeds(&s, &b)
}

/// Entry signed by the owner's user key.
fn forge_user(owner: &UserKeys, entries: &[AclEntry], body: Body) -> AclEntry {
    let prev = entries.last().map_or([0; 32], AclEntry::hash);
    AclEntry::sign(
        owner.sign_key(),
        Signer::OwnerUser,
        SPACE,
        entries.len() as u64,
        prev,
        body,
    )
}

/// Entry signed by a device key, with the certificate that proves it.
fn forge_device(
    signer: &DeviceKeys,
    cert: DeviceCert,
    entries: &[AclEntry],
    body: Body,
) -> AclEntry {
    let prev = entries.last().map_or([0; 32], AclEntry::hash);
    AclEntry::sign(
        signer.sign_key(),
        Signer::OwnerDevice(cert),
        SPACE,
        entries.len() as u64,
        prev,
        body,
    )
}

/// An `Add` of a fresh member whose only device envelope is `(cert, env)`.
fn add_with_device(owner: &UserKeys, entries: &[AclEntry], cert: DeviceCert) -> Vec<AclEntry> {
    let member = keys(&phrase()).public();
    let epoch = 0;
    let body = Body::Add {
        user: member,
        role: Role::Reader,
        envelope: Envelope::seal(&member.boxk, &SPACE, epoch, &[1; 32]).unwrap(),
        device_envelopes: vec![(
            cert,
            Envelope::seal(&cert.device_box, &SPACE, epoch, &[2; 32]).unwrap(),
        )],
    };
    let mut bad = entries.to_vec();
    bad.push(forge_user(owner, entries, body));
    bad
}

#[test]
fn lost_device_gets_no_new_epoch() {
    let op = phrase();
    let up = phrase();
    let mut certs = CertStore::default();
    let (d1, _) = enroll(&keys(&up), &mut certs);
    let (d2, _) = enroll(&keys(&up), &mut certs);
    let mut log = AclLog::genesis(keys(&op), SPACE, &CertStore::default()).unwrap();
    log.add(keys(&up).public(), Role::Editor, &certs).unwrap();
    log.revoke_device((d1.public().sign, 5, [7; 32]), &certs)
        .unwrap();
    let st = AclLog::verify(log.entries()).unwrap();
    assert_eq!(st.epoch, 1);

    let k1 = st.epoch_keys_for_device(&d1);
    let k2 = st.epoch_keys_for_device(&d2);
    assert_eq!(
        k1.keys.keys().copied().collect::<Vec<_>>(),
        vec![0],
        "lost device keeps old epochs only"
    );
    assert_eq!(k2.keys.keys().copied().collect::<Vec<_>>(), vec![0, 1]);

    // The user-level envelope of epoch 1 is for the user, not for the lost device.
    let user_env = st.envelopes[&keys(&up).public().sign]
        .iter()
        .find(|(e, _)| *e == 1)
        .unwrap()
        .1;
    assert!(user_env.open_device(&d1, &SPACE, 1).is_err());
    assert_eq!(*user_env.open(&keys(&up), &SPACE, 1).unwrap(), *k2.keys[&1]);
}

#[test]
fn new_device_recovers_all_epochs_from_phrase() {
    let op = phrase();
    let up = phrase();
    let mut certs = CertStore::default();
    let (_, _) = enroll(&keys(&up), &mut certs);
    let mut log = AclLog::genesis(keys(&op), SPACE, &CertStore::default()).unwrap();
    log.add(keys(&up).public(), Role::Editor, &certs).unwrap();
    log.revoke_device(
        (enroll(&keys(&up), &mut certs).0.public().sign, 1, [7; 32]),
        &certs,
    )
    .unwrap();
    let st = AclLog::verify(log.entries()).unwrap();

    // A brand new device: it only has the phrase, no certificate was issued before the rotation.
    let _new_device = enroll(&keys(&up), &mut certs);
    let epochs: Vec<u32> = st.epoch_keys(&keys(&up)).keys.keys().copied().collect();
    assert_eq!(epochs, vec![0, 1]);
}

#[test]
fn revoked_remaining_or_stranger_device_envelope_is_rejected() {
    let op = phrase();
    let owner = keys(&op);
    let up = phrase();
    let mut certs = CertStore::default();
    let (d1, c1) = enroll(&keys(&up), &mut certs);
    let (_d2, c2) = enroll(&keys(&up), &mut certs);
    let mut log = AclLog::genesis(keys(&op), SPACE, &CertStore::default()).unwrap();
    log.add(keys(&up).public(), Role::Editor, &certs).unwrap();
    let before_revoke = log.entries().to_vec();

    // Revoked device d1: it must not get a device envelope any more.
    log.revoke_device((d1.public().sign, 3, [7; 32]), &certs)
        .unwrap();
    let revoked_entries = log.entries().to_vec();
    assert!(AclLog::verify(&add_with_device(&owner, &revoked_entries, c1)).is_err());

    // Certificate of a user who is not a member.
    let stranger = keys(&phrase());
    let stranger_cert = DeviceCert::issue(&stranger, &DeviceKeys::generate().unwrap(), 1);
    assert!(AclLog::verify(&add_with_device(&owner, &before_revoke, stranger_cert)).is_err());

    // Certified device of a member, still valid: accepted (control case).
    assert!(AclLog::verify(&add_with_device(&owner, &before_revoke, c2)).is_ok());
}

#[test]
fn device_envelope_of_removed_user_is_rejected() {
    let op = phrase();
    let owner = keys(&op);
    let up = phrase();
    let mut certs = CertStore::default();
    let (_, c1) = enroll(&keys(&up), &mut certs);
    let mut log = AclLog::genesis(keys(&op), SPACE, &CertStore::default()).unwrap();
    log.add(keys(&up).public(), Role::Editor, &certs).unwrap();
    log.remove(
        keys(&up).public().sign,
        vec![(c1.device, 2, [7; 32])],
        &certs,
    )
    .unwrap();
    let entries = log.entries().to_vec();
    assert!(AclLog::verify(&add_with_device(&owner, &entries, c1)).is_err());
}

#[test]
fn owner_device_signs_entries() {
    let op = phrase();
    let owner = keys(&op);
    let mut certs = CertStore::default();
    let (od, od_cert) = enroll(&owner, &mut certs);
    let log = AclLog::genesis(keys(&op), SPACE, &certs).unwrap();
    let mut log = AclLog::load(
        log.entries().to_vec(),
        Signing::Device {
            keys: copy(&od),
            cert: od_cert,
        },
    )
    .unwrap();

    let member = keys(&phrase()).public();
    log.add(member, Role::Reader, &certs).unwrap();
    let st = AclLog::verify(log.entries()).unwrap();
    assert_eq!(st.members.len(), 2);
    assert_eq!(
        log.entries().last().unwrap().signer,
        Signer::OwnerDevice(od_cert)
    );
    assert!(st.epoch_keys_for_device(&od).keys.contains_key(&0));
}

#[test]
fn entry_signed_by_revoked_owner_device_is_rejected() {
    let op = phrase();
    let owner = keys(&op);
    let mut certs = CertStore::default();
    let (od1, c1) = enroll(&owner, &mut certs);
    let (_od2, _c2) = enroll(&owner, &mut certs);
    let mut log = AclLog::genesis(keys(&op), SPACE, &certs).unwrap();
    log.revoke_device((od1.public().sign, 0, [7; 32]), &certs)
        .unwrap();
    let entries = log.entries().to_vec();

    let member = keys(&phrase()).public();
    let body = Body::Add {
        user: member,
        role: Role::Reader,
        envelope: Envelope::seal(&member.boxk, &SPACE, 1, &[3; 32]).unwrap(),
        device_envelopes: vec![],
    };
    let mut bad = entries.clone();
    bad.push(forge_device(&od1, c1, &entries, body));
    assert_eq!(
        AclLog::verify(&bad).err(),
        Some(Error::Acl("signer device revoked earlier"))
    );
}

#[test]
fn entry_signed_by_non_owner_device_is_rejected() {
    let op = phrase();
    let log = AclLog::genesis(keys(&op), SPACE, &CertStore::default()).unwrap();
    let entries = log.entries().to_vec();

    let other = keys(&phrase());
    let mut certs = CertStore::default();
    let (dx, cx) = enroll(&other, &mut certs);
    let member = keys(&phrase()).public();
    let body = Body::Add {
        user: member,
        role: Role::Reader,
        envelope: Envelope::seal(&member.boxk, &SPACE, 0, &[3; 32]).unwrap(),
        device_envelopes: vec![],
    };
    let mut bad = entries.clone();
    bad.push(forge_device(&dx, cx, &entries, body));
    assert_eq!(
        AclLog::verify(&bad).err(),
        Some(Error::Acl("signer device of another user"))
    );
}

#[test]
fn load_continues_log_with_user_key() {
    let op = phrase();
    let mut log = AclLog::genesis(keys(&op), SPACE, &CertStore::default()).unwrap();
    let none = CertStore::default();
    let member = keys(&phrase()).public();
    log.add(member, Role::Editor, &none).unwrap();
    log.remove(member.sign, vec![], &none).unwrap();
    let before = *log.key;
    let entries = log.entries().to_vec();
    drop(log);

    let mut log = AclLog::load(entries, Signing::User(keys(&op))).unwrap();
    assert_eq!(*log.key, before, "epoch key recovered after restart");
    log.add(keys(&phrase()).public(), Role::Reader, &none)
        .unwrap();
    assert_eq!(log.state().epoch, 1);
}

#[test]
fn load_continues_log_with_owner_device() {
    let op = phrase();
    let owner = keys(&op);
    let mut certs = CertStore::default();
    let (od, od_cert) = enroll(&owner, &mut certs);
    let log = AclLog::genesis(keys(&op), SPACE, &certs).unwrap();
    let mut log = AclLog::load(
        log.entries().to_vec(),
        Signing::Device {
            keys: copy(&od),
            cert: od_cert,
        },
    )
    .unwrap();
    let member = keys(&phrase());
    log.add(member.public(), Role::Editor, &certs).unwrap();
    log.remove(member.public().sign, vec![], &certs).unwrap();
    let before = *log.key;
    let entries = log.entries().to_vec();
    drop(log);

    let mut log = AclLog::load(
        entries.clone(),
        Signing::Device {
            keys: copy(&od),
            cert: od_cert,
        },
    )
    .unwrap();
    assert_eq!(*log.key, before);
    log.add(keys(&phrase()).public(), Role::Reader, &certs)
        .unwrap();
    assert!(AclLog::verify(log.entries()).is_ok());

    // A device that was not known at the last rotation has no key for the current epoch.
    let mut newer = CertStore::default();
    let (late, late_cert) = enroll(&owner, &mut newer);
    assert!(
        AclLog::load(
            entries,
            Signing::Device {
                keys: late,
                cert: late_cert
            }
        )
        .is_err()
    );
}

#[test]
fn load_rejects_wrong_signer() {
    let op = phrase();
    let log = AclLog::genesis(keys(&op), SPACE, &CertStore::default()).unwrap();
    let entries = log.entries().to_vec();
    assert!(AclLog::load(entries.clone(), Signing::User(keys(&phrase()))).is_err());
    let other = keys(&phrase());
    let mut certs = CertStore::default();
    let (d, c) = enroll(&other, &mut certs);
    assert!(AclLog::load(entries, Signing::Device { keys: d, cert: c }).is_err());
}

#[test]
fn rollback_and_fork_are_rejected_and_extension_accepted() {
    let op = phrase();
    let mut log = AclLog::genesis(keys(&op), SPACE, &CertStore::default()).unwrap();
    let none = CertStore::default();
    log.add(keys(&phrase()).public(), Role::Reader, &none)
        .unwrap();
    let prefix = log.entries().to_vec();
    let known: AclHead = AclLog::verify(&prefix).unwrap().head();
    log.add(keys(&phrase()).public(), Role::Reader, &none)
        .unwrap();
    let full = log.entries().to_vec();

    // Extension: the known head is inside the longer log.
    assert!(AclLog::verify_extension(Some(known), &full).is_ok());
    // Rollback: the node serves the shorter, older log.
    assert_eq!(
        AclLog::verify_extension(Some(AclLog::verify(&full).unwrap().head()), &prefix).err(),
        Some(Error::Acl("log shorter than the known head (rollback)"))
    );
    // Fork: another entry at the known index, same length or longer.
    let mut fork = AclLog::load(prefix[..1].to_vec(), Signing::User(keys(&op))).unwrap();
    fork.add(keys(&phrase()).public(), Role::Reader, &none)
        .unwrap();
    fork.add(keys(&phrase()).public(), Role::Reader, &none)
        .unwrap();
    assert_eq!(
        AclLog::verify_extension(Some(known), fork.entries()).err(),
        Some(Error::Acl("log does not contain the known head (fork)"))
    );
    assert!(AclLog::verify_extension(None, &full).is_ok());
}

#[test]
fn envelopes_that_do_not_open_are_reported_separately() {
    let op = phrase();
    let up = phrase();
    let mut log = AclLog::genesis(keys(&op), SPACE, &CertStore::default()).unwrap();
    log.add(keys(&up).public(), Role::Reader, &CertStore::default())
        .unwrap();
    let mut st = AclLog::verify(log.entries()).unwrap();
    let stray = Envelope::seal(&keys(&phrase()).public().boxk, &SPACE, 0, &[1; 32]).unwrap();
    st.envelopes
        .entry(keys(&up).public().sign)
        .or_default()
        .push((0, stray));
    let got = st.epoch_keys(&keys(&up));
    assert!(got.keys.contains_key(&0), "the real envelope still opens");
    assert_eq!(got.unopened, vec![0]);
}

#[test]
fn remove_and_demotion_must_cut_every_known_device() {
    let op = phrase();
    let up = keys(&phrase());
    let mut certs = CertStore::default();
    let (d1, _) = enroll(&up, &mut certs);
    let (d2, _) = enroll(&up, &mut certs);
    let mut log = AclLog::genesis(keys(&op), SPACE, &CertStore::default()).unwrap();
    log.add(up.public(), Role::Editor, &certs).unwrap();
    let h = [7u8; 32];
    assert!(
        log.remove(up.public().sign, vec![(d1.public().sign, 1, h)], &certs)
            .is_err()
    );
    assert!(
        log.change_role(
            up.public().sign,
            Role::Reader,
            vec![(d1.public().sign, 1, h)],
            &certs
        )
        .is_err()
    );
    assert_eq!(log.entries().len(), 2, "rejected operations append nothing");
    log.change_role(
        up.public().sign,
        Role::Reader,
        vec![(d1.public().sign, 1, h), (d2.public().sign, 1, h)],
        &certs,
    )
    .unwrap();
}

/// A log of ~20 KB: several members with devices, a demotion, a removal and device revocations.
fn big_log() -> &'static Vec<Vec<u8>> {
    static LOG: OnceLock<Vec<Vec<u8>>> = OnceLock::new();
    LOG.get_or_init(|| {
        let op = phrase();
        let mut certs = CertStore::default();
        let members: Vec<RecoveryPhrase> = (0..4).map(|_| phrase()).collect();
        let mut devices = Vec::new();
        for p in &members {
            let u = keys(p);
            devices.push(enroll(&u, &mut certs).0);
            devices.push(enroll(&u, &mut certs).0);
        }
        let h = [7u8; 32];
        let mut log = AclLog::genesis(keys(&op), SPACE, &certs).unwrap();
        for p in &members {
            log.add(keys(p).public(), Role::Editor, &certs).unwrap();
        }
        let cuts_of = |u: &UserPublic, certs: &CertStore| -> Vec<([u8; 32], u64, [u8; 32])> {
            certs
                .certs_of(&u.sign)
                .iter()
                .map(|c| (c.device, 1, h))
                .collect()
        };
        log.revoke_device((devices[7].public().sign, 2, h), &certs)
            .unwrap();
        let u0 = keys(&members[0]).public();
        log.change_role(u0.sign, Role::Reader, cuts_of(&u0, &certs), &certs)
            .unwrap();
        let u1 = keys(&members[1]).public();
        log.remove(u1.sign, cuts_of(&u1, &certs), &certs).unwrap();
        log.revoke_device((devices[2].public().sign, 2, h), &certs)
            .unwrap();
        log.entries().iter().map(AclEntry::to_bytes).collect()
    })
}

proptest! {
    #[test]
    fn mutated_big_log_never_verifies(entry in any::<usize>(), pos in any::<usize>(), bit in 0u8..8) {
        let encoded = big_log();
        prop_assert!(encoded.iter().map(|b| b.len()).sum::<usize>() > 10_000);
        let mut bad = encoded.clone();
        let i = entry % bad.len();
        let j = pos % bad[i].len();
        bad[i][j] ^= 1 << bit;
        let entries: Result<Vec<AclEntry>> = bad.iter().map(|b| AclEntry::from_bytes(b)).collect();
        match entries {
            Err(_) => {}
            Ok(entries) => prop_assert!(AclLog::verify(&entries).is_err()),
        }
    }

    #[test]
    fn truncated_big_log_never_panics(cut in any::<usize>(), extra in proptest::collection::vec(any::<u8>(), 0..64)) {
        let encoded = big_log();
        let i = cut % encoded.len();
        let mut bytes = encoded[i].clone();
        bytes.truncate(cut % (bytes.len() + 1));
        bytes.extend_from_slice(&extra);
        let _ = AclEntry::from_bytes(&bytes);
    }
}

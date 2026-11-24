use std::collections::BTreeSet;

use proptest::prelude::*;

use crate::acl::{AclEntry, Body, Cutoff, Role, Rotation, Signer};
use crate::acl_log::AclLog;
use crate::acl_state::AclState;
use crate::cert::CertStore;
use crate::device::DeviceKeys;
use crate::envelope::Envelope;
use crate::identity::{RecoveryPhrase, UserKeys, UserPublic};
use crate::{Error, Result};

const SPACE: [u8; 16] = [3; 16];

fn phrase() -> RecoveryPhrase {
    RecoveryPhrase::generate().unwrap()
}

fn keys(p: &RecoveryPhrase) -> UserKeys {
    UserKeys::from_phrase(p).unwrap()
}

fn public(p: &RecoveryPhrase) -> UserPublic {
    keys(p).public()
}

/// Device sign key only (no certificate, so it gets no device envelopes).
fn device() -> [u8; 32] {
    DeviceKeys::generate().unwrap().public().sign
}

fn owner_log() -> (RecoveryPhrase, AclLog) {
    let p = phrase();
    let log = AclLog::genesis(keys(&p), SPACE, &CertStore::default()).unwrap();
    (p, log)
}

fn replay(encoded: &[Vec<u8>]) -> Result<AclState> {
    let entries = encoded
        .iter()
        .map(|b| AclEntry::from_bytes(b))
        .collect::<Result<Vec<_>>>()?;
    AclLog::verify(&entries)
}

/// Owner-signed entry built outside `AclLog`, to test the verifier against bad logs.
fn forge(signer: &UserKeys, entries: &[AclEntry], body: Body) -> AclEntry {
    let prev = entries.last().map_or([0; 32], AclEntry::hash);
    AclEntry::sign(
        signer.sign_key(),
        Signer::OwnerUser,
        SPACE,
        entries.len() as u64,
        prev,
        body,
    )
}

fn rotation(
    new_epoch: u32,
    envelopes: Vec<([u8; 32], Envelope)>,
    cutoffs: Vec<Cutoff>,
) -> Rotation {
    Rotation {
        new_epoch,
        envelopes,
        device_envelopes: vec![],
        cutoffs,
    }
}

fn sample_log() -> Vec<Vec<u8>> {
    let (_, mut log) = owner_log();
    let b = public(&phrase());
    log.add(b, Role::Editor, &CertStore::default()).unwrap();
    log.revoke_device((device(), 2, [7; 32]), &CertStore::default())
        .unwrap();
    log.entries().iter().map(AclEntry::to_bytes).collect()
}

#[test]
fn valid_flow_verifies_and_tracks_state() {
    let (owner_p, mut log) = owner_log();
    let none = CertStore::default();
    let owner = public(&owner_p).sign;
    let (bp, cp) = (phrase(), phrase());
    let (bu, cu) = (public(&bp), public(&cp));
    let (bd, cd) = (device(), device());

    log.add(bu, Role::Editor, &none).unwrap();
    log.add(cu, Role::Reader, &none).unwrap();
    log.change_role(cu.sign, Role::Editor, vec![], &none)
        .unwrap();
    assert_eq!(log.state().epoch, 0, "promotion starts no epoch");
    log.change_role(bu.sign, Role::Reader, vec![(bd, 7, [7; 32])], &none)
        .unwrap();
    log.remove(cu.sign, vec![(cd, 3, [7; 32])], &none).unwrap();

    let st = AclLog::verify(log.entries()).unwrap();
    assert_eq!(st.epoch, 2);
    assert_eq!(st.owner, owner);
    assert_eq!(st.members.len(), 2);
    assert_eq!(st.members[&bu.sign].role, Role::Reader);
    assert!(!st.members.contains_key(&cu.sign));
    assert_eq!(
        st.writers_in_epoch(0),
        BTreeSet::from([owner, bu.sign, cu.sign])
    );
    assert_eq!(st.writers_in_epoch(1), BTreeSet::from([owner, cu.sign]));
    assert_eq!(st.writers_in_epoch(2), BTreeSet::from([owner]));
    assert_eq!(st.departures[&bu.sign][0], (1, [(bd, (7, [7; 32]))].into()));
    assert_eq!(st.departures[&cu.sign][0], (2, [(cd, (3, [7; 32]))].into()));
}

#[test]
fn users_open_only_epochs_they_belong_to() {
    let (owner_p, mut log) = owner_log();
    let none = CertStore::default();
    let (bp, cp) = (phrase(), phrase());
    log.add(public(&bp), Role::Editor, &none).unwrap();
    log.add(public(&cp), Role::Reader, &none).unwrap();
    log.remove(public(&cp).sign, vec![], &none).unwrap();
    log.revoke_device((device(), 1, [7; 32]), &none).unwrap();
    let st = AclLog::verify(log.entries()).unwrap();

    let owner_keys = st.epoch_keys(&keys(&owner_p));
    let b_keys = st.epoch_keys(&keys(&bp));
    let c_keys = st.epoch_keys(&keys(&cp));
    assert_eq!(
        owner_keys.keys.keys().copied().collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_eq!(
        b_keys.keys.keys().copied().collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_eq!(
        *b_keys.keys[&2], *owner_keys.keys[&2],
        "same epoch key for everyone who keeps access"
    );
    assert_eq!(
        c_keys.keys.keys().copied().collect::<Vec<_>>(),
        vec![0],
        "removed user keeps only history"
    );

    let owner_env_epoch_1 = st.envelopes[&public(&owner_p).sign]
        .iter()
        .find(|(e, _)| *e == 1)
        .unwrap()
        .1;
    assert!(owner_env_epoch_1.open(&keys(&cp), &SPACE, 1).is_err());
}

#[test]
fn any_tampered_byte_is_rejected() {
    let encoded = sample_log();
    assert!(replay(&encoded).is_ok());
    for i in 0..encoded.len() {
        for j in 0..encoded[i].len() {
            let mut bad = encoded.clone();
            bad[i][j] ^= 0x01;
            assert!(replay(&bad).is_err(), "entry {i}, byte {j}");
        }
    }
}

#[test]
fn reordered_missing_duplicated_or_empty_logs_are_rejected() {
    let (_, mut log) = owner_log();
    let none = CertStore::default();
    log.add(public(&phrase()), Role::Reader, &none).unwrap();
    log.add(public(&phrase()), Role::Reader, &none).unwrap();
    let e = log.entries().to_vec();
    assert!(AclLog::verify(&e).is_ok());

    let mut swapped = e.clone();
    swapped.swap(1, 2);
    assert!(AclLog::verify(&swapped).is_err());

    let mut missing = e.clone();
    missing.remove(1);
    assert!(AclLog::verify(&missing).is_err());

    let mut dup = e.clone();
    dup.push(e[2].clone());
    assert!(AclLog::verify(&dup).is_err());

    let mut no_genesis = e.clone();
    no_genesis.remove(0);
    assert!(AclLog::verify(&no_genesis).is_err());
    assert!(AclLog::verify(&[]).is_err());
}

#[test]
fn entry_signed_by_non_owner_is_rejected() {
    let (_, mut log) = owner_log();
    log.add(public(&phrase()), Role::Reader, &CertStore::default())
        .unwrap();
    let intruder = keys(&phrase());
    let mut entries = log.entries().to_vec();
    let body = Body::Add {
        user: public(&phrase()),
        role: Role::Editor,
        envelope: Envelope::seal(&intruder.public().boxk, &SPACE, 0, &[1; 32]).unwrap(),
        device_envelopes: vec![],
    };
    entries.push(forge(&intruder, &entries, body));
    assert_eq!(
        AclLog::verify(&entries).err(),
        Some(Error::Acl("bad signature"))
    );
}

#[test]
fn genesis_only_at_index_zero_and_owner_cannot_be_changed() {
    let (owner_p, mut log) = owner_log();
    let none = CertStore::default();
    let owner = keys(&owner_p);
    let mut entries = log.entries().to_vec();
    let body = Body::Genesis {
        owner: owner.public(),
        envelope: Envelope::seal(&owner.public().boxk, &SPACE, 0, &[1; 32]).unwrap(),
        device_envelopes: vec![],
    };
    entries.push(forge(&owner, &entries, body));
    assert!(AclLog::verify(&entries).is_err());

    assert!(
        log.change_role(owner.public().sign, Role::Reader, vec![], &none)
            .is_err()
    );
    assert!(log.remove(owner.public().sign, vec![], &none).is_err());
    assert!(
        log.add(owner.public(), Role::Reader, &none).is_err(),
        "owner is already a member"
    );
    assert_eq!(log.entries().len(), 1, "failed operations append nothing");
}

#[test]
fn add_rules() {
    let (_, mut log) = owner_log();
    let none = CertStore::default();
    let b = public(&phrase());
    assert!(log.add(b, Role::Owner, &none).is_err(), "no second owner");
    log.add(b, Role::Reader, &none).unwrap();
    assert!(
        log.add(b, Role::Editor, &none).is_err(),
        "adding an existing member"
    );
    assert!(log.change_role(b.sign, Role::Owner, vec![], &none).is_err());
    assert!(
        log.change_role(public(&phrase()).sign, Role::Editor, vec![], &none)
            .is_err(),
        "unknown member"
    );
}

#[test]
fn demotion_without_rotation_and_promotion_with_rotation_are_rejected() {
    let (owner_p, mut log) = owner_log();
    let owner = keys(&owner_p);
    let b = public(&phrase());
    log.add(b, Role::Editor, &CertStore::default()).unwrap();
    let entries = log.entries().to_vec();

    let no_rot = forge(
        &owner,
        &entries,
        Body::ChangeRole {
            user: b.sign,
            role: Role::Reader,
            rotation: None,
        },
    );
    let mut bad = entries.clone();
    bad.push(no_rot);
    assert!(AclLog::verify(&bad).is_err());

    let key = [5u8; 32];
    let envs = |epoch: u32| {
        vec![
            (
                owner.public().sign,
                Envelope::seal(&owner.public().boxk, &SPACE, epoch, &key).unwrap(),
            ),
            (
                b.sign,
                Envelope::seal(&b.boxk, &SPACE, epoch, &key).unwrap(),
            ),
        ]
    };
    let promote_with_rot = forge(
        &owner,
        &entries,
        Body::ChangeRole {
            user: b.sign,
            role: Role::Owner,
            rotation: Some(rotation(1, envs(1), vec![])),
        },
    );
    let mut bad = entries.clone();
    bad.push(promote_with_rot);
    assert!(AclLog::verify(&bad).is_err());
}

#[test]
fn remove_needs_exactly_the_remaining_members() {
    let (owner_p, mut log) = owner_log();
    let owner = keys(&owner_p);
    let b = public(&phrase());
    log.add(b, Role::Editor, &CertStore::default()).unwrap();
    let entries = log.entries().to_vec();
    let key = [6u8; 32];
    let own = Envelope::seal(&owner.public().boxk, &SPACE, 1, &key).unwrap();
    let with = |envelopes: Vec<([u8; 32], Envelope)>, new_epoch: u32| {
        let mut bad = entries.clone();
        bad.push(forge(
            &owner,
            &entries,
            Body::Remove {
                user: b.sign,
                rotation: rotation(new_epoch, envelopes, vec![]),
            },
        ));
        AclLog::verify(&bad)
    };
    assert!(with(vec![], 1).is_err(), "owner envelope missing");
    let b_env = Envelope::seal(&b.boxk, &SPACE, 1, &key).unwrap();
    assert!(
        with(vec![(owner.public().sign, own), (b.sign, b_env)], 1).is_err(),
        "removed user gets an envelope"
    );
    assert!(with(vec![(owner.public().sign, own)], 1).is_ok());
    assert!(
        with(vec![(owner.public().sign, own)], 2).is_err(),
        "epoch must grow by one"
    );
}

#[test]
fn revoke_names_exactly_its_device() {
    let (owner_p, log) = owner_log();
    let owner = keys(&owner_p);
    let entries = log.entries().to_vec();
    let (d1, d2) = (device(), device());
    let key = [7u8; 32];
    let rot = |cutoffs| {
        rotation(
            1,
            vec![(
                owner.public().sign,
                Envelope::seal(&owner.public().boxk, &SPACE, 1, &key).unwrap(),
            )],
            cutoffs,
        )
    };
    let try_with = |body_rot: Rotation, device: [u8; 32]| {
        let mut bad = entries.clone();
        bad.push(forge(
            &owner,
            &entries,
            Body::RevokeDevice {
                device,
                rotation: body_rot,
            },
        ));
        AclLog::verify(&bad)
    };
    assert!(try_with(rot(vec![(d1, 4, [7; 32])]), d1).is_ok());
    assert!(try_with(rot(vec![(d1, 4, [7; 32]), (d2, 4, [7; 32])]), d1).is_err());
    assert!(try_with(rot(vec![(d2, 4, [7; 32])]), d1).is_err());
    assert!(try_with(rot(vec![]), d1).is_err());
}

#[test]
fn revoked_device_is_recorded_with_cutoff() {
    let (_, mut log) = owner_log();
    let d = device();
    log.revoke_device((d, 9, [7; 32]), &CertStore::default())
        .unwrap();
    assert_eq!(log.state().revoked.get(&d), Some(&(9, [7; 32])));
    assert_eq!(log.state().epoch, 1);
}

#[test]
fn bytes_are_strict() {
    let (_, log) = owner_log();
    let bytes = log.entries()[0].to_bytes();
    assert_eq!(AclEntry::from_bytes(&bytes).unwrap(), log.entries()[0]);

    let mut trailing = bytes.clone();
    trailing.insert(trailing.len() - 64, 0);
    assert!(AclEntry::from_bytes(&trailing).is_err());

    let mut unknown_tag = bytes.clone();
    unknown_tag[1 + 16 + 8 + 32] = 9;
    assert!(AclEntry::from_bytes(&unknown_tag).is_err());

    let mut bad_version = bytes;
    bad_version[0] = 2;
    assert!(AclEntry::from_bytes(&bad_version).is_err());
}

proptest! {
    #[test]
    fn random_bit_flip_never_verifies(entry in 0usize..8, pos in any::<usize>(), bit in 0u8..8) {
        let encoded = sample_log();
        let i = entry % encoded.len();
        let j = pos % encoded[i].len();
        let mut bad = encoded.clone();
        bad[i][j] ^= 1 << bit;
        prop_assert!(replay(&bad).is_err());
    }

    #[test]
    fn random_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..600)) {
        let _ = AclEntry::from_bytes(&bytes);
        let _ = crate::policy::parse_header(&bytes);
        let _ = crate::cert::DeviceCert::from_bytes(&bytes);
        let _ = Envelope::from_bytes(&bytes);
        let _ = crate::invite::Ticket::decode(&String::from_utf8_lossy(&bytes));
        let _ = crate::invite::JoinCommit::from_bytes(&bytes);
        let _ = crate::invite::JoinReveal::from_bytes(&bytes);
    }
}

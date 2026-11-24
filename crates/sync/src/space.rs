//! Creating, opening and joining a space: key store, participants log, certificates and the core
//! `Space` wired together (SZYFROWANIE §2, §8a, §8b). Secrets go to the key store; space.db keeps
//! only public records and encrypted messages.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ed25519_dalek::SigningKey;
use notes_core::access::Key;
use notes_core::{Records, Space};

use crate::acl::AclEntry;
use crate::acl_log::{AclLog, Signing};
use crate::acl_state::{AclHead, AclState};
use crate::cert::{CertStore, DeviceCert};
use crate::device::DeviceKeys;
use crate::identity::UserKeys;
use crate::invite::Ticket;
use crate::keystore::{KeyStore, Slot};
use crate::space_access::{SpaceAccess, load_keys, secret32};
use crate::{Error, Result, random};

/// A space open on this device.
pub struct Opened {
    pub space: Space,
    /// Participants log as this device replayed it.
    pub acl: AclState,
    pub certs: CertStore,
    /// This device's certificate.
    pub cert: DeviceCert,
    /// Owner devices only: builds and signs new log entries.
    pub(crate) owner: Option<AclLog>,
    pub(crate) root: PathBuf,
}

/// Creates a space with `owner` as its only member and this device as its owner device. The user keys
/// are used once, to sign the genesis entry, and are dropped here; the phrase is never stored.
pub fn create_space(
    root: &Path,
    owner: UserKeys,
    ks: &mut dyn KeyStore,
    now: u64,
) -> Result<Opened> {
    let cert = device_cert(ks, &owner, now)?;
    let device = device_keys(ks)?;
    let mut certs = CertStore::default();
    certs.insert(cert)?;
    let space_id: [u8; 16] = random()?;
    let log = AclLog::genesis(owner, space_id, &certs)?;
    let entries = log.entries().to_vec();
    drop(log);
    let state = AclLog::verify(&entries)?;
    let keys = current_keys(&state, &device, ks)?;
    let space = Space::create(
        root,
        space_id,
        signing_key(&device),
        Box::new(access_for(state.clone(), certs.clone(), keys)),
    )?;
    Records::open(root)?.put_acl(&log_rows(&entries), &cert_rows(&[cert]), head_of(&entries))?;
    remember_head(ks, &space_id, head_of(&entries))?;
    let owner = owner_session(&state, entries, device_keys(ks)?, cert);
    Ok(Opened {
        space,
        acl: state,
        certs,
        cert,
        owner,
        root: root.to_path_buf(),
    })
}

/// Opens the space at `root` with this device's keys. Fails with `NeedsPhrase` when the device has no
/// key for the current epoch (SZYFROWANIE §8b). A log shorter or forked against the stored head is refused.
/// Refusal for a space.db older than the log this device has seen. The way out is in the message.
const STALE_COPY: &str = "kopia przestrzeni jest starsza niż znany dziennik uczestników; połącz się z innym urządzeniem albo przywróć nowszą kopię";

pub fn open_space(root: &Path, ks: &mut dyn KeyStore) -> Result<Opened> {
    let mut records = Records::open(root)?;
    let entries = read_log(&records)?;
    let known = known_head(&records, ks, &records.space_id()?)?;
    // shortcut: no waiting-for-newer-log mode yet (open with the old rules, accept only a longer Acl); until then the copy is refused and the message says what to do
    if let Some(k) = known
        && records
            .acl_head()?
            .is_none_or(|(stored, _)| stored < k.index)
    {
        return Err(Error::Space(STALE_COPY));
    }
    let state = AclLog::verify_extension(known, &entries)?;
    let certs = store_of(&decode_certs(&records)?)?;
    let device = device_keys(ks)?;
    let cert = *certs
        .get(&device.public().sign)
        .ok_or(Error::NoCertificate)?;
    let keys = current_keys(&state, &device, ks)?;
    if known.map(|k| k.index) != Some(state.head.index) {
        records.put_acl(&[], &[], (state.head.index, state.head.hash))?;
    }
    remember_head(ks, &state.space, (state.head.index, state.head.hash))?;
    drop(records);
    let space = Space::open(
        root,
        signing_key(&device),
        Box::new(access_for(state.clone(), certs.clone(), keys)),
    )?;
    let owner = owner_session(&state, entries, device_keys(ks)?, cert);
    Ok(Opened {
        space,
        acl: state,
        certs,
        cert,
        owner,
        root: root.to_path_buf(),
    })
}

/// Sets up this device in a space it was invited to. `entries` and `certs` come from the owner; the ticket
/// must name the same space and owner. The device keys must already be in the key store (`device_cert`).
pub fn join_space(
    root: &Path,
    ks: &mut dyn KeyStore,
    ticket: &Ticket,
    entries: Vec<AclEntry>,
    certs: Vec<DeviceCert>,
) -> Result<Opened> {
    let state = AclLog::verify_extension(None, &entries)?;
    if state.space != ticket.space || state.owner != ticket.owner {
        return Err(Error::Space("the log is not the one the invite names"));
    }
    let device = device_keys(ks)?;
    let store = store_of(&certs)?;
    let cert = *store
        .get(&device.public().sign)
        .ok_or(Error::Space("this device is not in the log yet"))?;
    let keys = current_keys(&state, &device, ks)?;
    let space = Space::create(
        root,
        state.space,
        signing_key(&device),
        Box::new(access_for(state.clone(), store.clone(), keys)),
    )?;
    Records::open(root)?.put_acl(&log_rows(&entries), &cert_rows(&certs), head_of(&entries))?;
    remember_head(ks, &state.space, head_of(&entries))?;
    let owner = owner_session(&state, entries, device_keys(ks)?, cert);
    Ok(Opened {
        space,
        acl: state,
        certs: store,
        cert,
        owner,
        root: root.to_path_buf(),
    })
}

/// Adds a new device of an existing member from the recovery phrase (SZYFROWANIE §8b). The epoch keys
/// come from the user-level envelopes; `user` is dropped at the end, so the phrase's keys are not kept.
pub fn recover_device(
    root: &Path,
    user: UserKeys,
    entries: Vec<AclEntry>,
    certs: Vec<DeviceCert>,
    ks: &mut dyn KeyStore,
    now: u64,
) -> Result<Opened> {
    let state = AclLog::verify_extension(None, &entries)?;
    if !state.members.contains_key(&user.public().sign) {
        return Err(Error::Space("not a member of this space"));
    }
    for (epoch, key) in state.epoch_keys(&user).keys {
        ks.set(
            Slot::EpochKey {
                space: state.space,
                epoch,
            },
            &key[..],
        )?;
    }
    let cert = device_cert(ks, &user, now)?;
    drop(user);
    let mut all = certs;
    all.push(cert);
    let store = store_of(&all)?;
    let device = device_keys(ks)?;
    let keys = current_keys(&state, &device, ks)?;
    let space = Space::create(
        root,
        state.space,
        signing_key(&device),
        Box::new(access_for(state.clone(), store.clone(), keys)),
    )?;
    Records::open(root)?.put_acl(&log_rows(&entries), &cert_rows(&all), head_of(&entries))?;
    remember_head(ks, &state.space, head_of(&entries))?;
    let owner = owner_session(&state, entries, device_keys(ks)?, cert);
    Ok(Opened {
        space,
        acl: state,
        certs: store,
        cert,
        owner,
        root: root.to_path_buf(),
    })
}

/// Moves a space made before the identity stage into the new layout. The old device secret becomes this
/// device's signing key (old messages stay valid), the old epoch-0 key becomes epoch 0 of the new log, and
/// the old secrets are deleted from space.db. Note text does not change.
pub fn migrate_legacy(
    root: &Path,
    owner: UserKeys,
    ks: &mut dyn KeyStore,
    now: u64,
) -> Result<Opened> {
    let legacy =
        Space::take_legacy_secrets(root)?.ok_or(Error::Space("no old-layout space to migrate"))?;
    let mut records = Records::open(root)?;
    // a crash after the genesis is stored skips straight to deleting the secrets
    if records.acl_entries()?.is_empty() {
        let device = DeviceKeys::from_seeds(&legacy.device_secret, &random::<32>()?);
        // the key store has one device key slot: a different key already there belongs to another space
        let existing = ks.get(Slot::DeviceSign)?;
        if existing.is_some_and(|key| key[..] != legacy.device_secret[..]) {
            return Err(Error::Space(
                "this device already has a key for another space; the old space cannot be migrated here",
            ));
        }
        let (sign, boxk) = device.to_seeds();
        ks.set(Slot::DeviceSign, &sign[..])?;
        ks.set(Slot::DeviceBox, &boxk[..])?;
        let cert = DeviceCert::issue(&owner, &device, now);
        let mut certs = CertStore::default();
        certs.insert(cert)?;
        let log = AclLog::genesis_with_key(owner, legacy.space_id, &certs, *legacy.epoch0_key)?;
        let entries = log.entries().to_vec();
        records.put_acl(&log_rows(&entries), &cert_rows(&[cert]), head_of(&entries))?;
    }
    drop(records);
    Space::finish_legacy_migration(root)?;
    open_space(root, ks)
}

/// Stores a newer participants log and certificates received from another device of this space. The log
/// must extend the head already stored: a shorter or forked log is refused. Keys and rules are rebuilt.
pub fn import_acl(
    opened: &mut Opened,
    ks: &mut dyn KeyStore,
    entries: Vec<AclEntry>,
    certs: Vec<DeviceCert>,
) -> Result<bool> {
    let mut records = Records::open(&opened.root)?;
    let known = known_head(&records, ks, &opened.acl.space)?;
    // a log that brings nothing new is ignored; one that forks at the known head is refused
    if !AclLog::is_extension(known, &entries)? {
        return Ok(false);
    }
    let state = AclLog::verify_extension(known, &entries)?;
    if state.space != opened.acl.space {
        return Err(Error::Space("the log names another space"));
    }
    // the keys and rules for the new log are worked out before anything is stored or replaced
    let device = device_keys(ks)?;
    let keys = load_keys(&state, &device, ks)?;
    let missing_current = !keys.contains_key(&state.epoch);
    let mut store = opened.certs.clone();
    let mut added = Vec::new();
    for cert in certs {
        if state.keeps_cert(&store, &cert) && store.insert(cert).is_ok() {
            added.push(cert);
        }
    }
    let stored = known.map_or(0, |h| h.index as usize + 1);
    let head = head_of(&entries);
    records.put_acl(&log_rows(&entries[stored..]), &cert_rows(&added), head)?;
    remember_head(ks, &state.space, head)?;
    drop(records);
    opened.acl = state;
    opened.certs = store;
    // the rules follow the stored log even when the current key is missing: then the space is read-only
    opened.space.set_access(Box::new(access_for(
        opened.acl.clone(),
        opened.certs.clone(),
        keys,
    )));
    opened.owner = owner_session(&opened.acl, entries, device_keys(ks)?, opened.cert);
    if missing_current {
        return Err(Error::NeedsPhrase);
    }
    Ok(true)
}

/// Log entries and certificates of a space, as another device needs them to join or to catch up.
pub fn read_acl(root: &Path) -> Result<(Vec<AclEntry>, Vec<DeviceCert>)> {
    let records = Records::open(root)?;
    Ok((read_log(&records)?, decode_certs(&records)?))
}

/// Creates or loads this device's keys and returns its certificate for `user`. Keys already in the key store
/// are reused; new ones are stored there and never leave it.
// shortcut: the key store has one device key slot, not one per space; upgrade when one app holds several spaces
pub fn device_cert(ks: &mut dyn KeyStore, user: &UserKeys, now: u64) -> Result<DeviceCert> {
    if stored_device(ks)?.is_none() {
        let keys = DeviceKeys::generate()?;
        let (sign, boxk) = keys.to_seeds();
        ks.set(Slot::DeviceSign, &sign[..])?;
        ks.set(Slot::DeviceBox, &boxk[..])?;
    }
    Ok(DeviceCert::issue(user, &device_keys(ks)?, now))
}

/// Re-derives the access rules and keys from `opened.acl` after the log changed.
pub(crate) fn refresh(opened: &mut Opened, ks: &mut dyn KeyStore) -> Result<()> {
    let device = device_keys(ks)?;
    let keys = load_keys(&opened.acl, &device, ks)?;
    let missing_current = !keys.contains_key(&opened.acl.epoch);
    opened.space.set_access(Box::new(access_for(
        opened.acl.clone(),
        opened.certs.clone(),
        keys,
    )));
    if missing_current {
        return Err(Error::NeedsPhrase);
    }
    Ok(())
}

/// The highest head this device knows for the space: the one in space.db or the one in the key store,
/// whichever is longer. A stored log shorter than either is refused by `verify_extension`.
fn known_head(records: &Records, ks: &dyn KeyStore, space: &[u8; 16]) -> Result<Option<AclHead>> {
    let stored = records
        .acl_head()?
        .map(|(index, hash)| AclHead { index, hash });
    let remembered = match ks.get(Slot::AclHead { space: *space })? {
        Some(bytes) => Some(parse_head(&bytes)?),
        None => None,
    };
    match (stored, remembered) {
        (Some(a), Some(b)) if a.index == b.index && a.hash != b.hash => {
            Err(Error::Acl("the stored log forks from the remembered head"))
        }
        (Some(a), Some(b)) => Ok(Some(if a.index >= b.index { a } else { b })),
        (a, b) => Ok(a.or(b)),
    }
}

/// Stores the head of the log in the key store, so that an older space.db cannot take it back.
pub(crate) fn remember_head(
    ks: &mut dyn KeyStore,
    space: &[u8; 16],
    (index, hash): (u64, [u8; 32]),
) -> Result<()> {
    let mut bytes = [0u8; 40];
    bytes[..8].copy_from_slice(&index.to_le_bytes());
    bytes[8..].copy_from_slice(&hash);
    ks.set(Slot::AclHead { space: *space }, &bytes)
}

fn parse_head(bytes: &[u8]) -> Result<AclHead> {
    let bytes: [u8; 40] = bytes
        .try_into()
        .map_err(|_| Error::Store("the remembered log head has the wrong length".to_string()))?;
    Ok(AclHead {
        index: u64::from_le_bytes(bytes[..8].try_into().expect("8 bytes")),
        hash: bytes[8..].try_into().expect("32 bytes"),
    })
}

/// This device's keys when both halves are in the key store. A half key (a store failure between the two writes)
/// counts as none: it cannot open envelopes, so it is made again rather than leaving the device stuck.
pub(crate) fn stored_device(ks: &dyn KeyStore) -> Result<Option<DeviceKeys>> {
    if ks.get(Slot::DeviceSign)?.is_none() || ks.get(Slot::DeviceBox)?.is_none() {
        return Ok(None);
    }
    device_keys(ks).map(Some)
}

pub(crate) fn device_keys(ks: &dyn KeyStore) -> Result<DeviceKeys> {
    let sign = ks
        .get(Slot::DeviceSign)?
        .ok_or(Error::Space("this device has no keys"))?;
    let boxk = ks
        .get(Slot::DeviceBox)?
        .ok_or(Error::Space("this device has no keys"))?;
    Ok(DeviceKeys::from_seeds(&secret32(&sign)?, &secret32(&boxk)?))
}

pub(crate) fn signing_key(device: &DeviceKeys) -> SigningKey {
    SigningKey::from_bytes(&device.to_seeds().0)
}

/// Epoch keys for the current state; `NeedsPhrase` when the current one is missing.
pub(crate) fn current_keys(
    state: &AclState,
    device: &DeviceKeys,
    ks: &mut dyn KeyStore,
) -> Result<BTreeMap<u32, Key>> {
    let keys = load_keys(state, device, ks)?;
    if !keys.contains_key(&state.epoch) {
        return Err(Error::NeedsPhrase);
    }
    Ok(keys)
}

pub(crate) fn access_for(
    state: AclState,
    certs: CertStore,
    keys: BTreeMap<u32, Key>,
) -> SpaceAccess {
    SpaceAccess::new(state, certs, keys)
}

/// The log builder, if this device is an owner device of the space (it needs the current epoch key).
// shortcut: an owner device without a device envelope for the current epoch gets no builder (owner ops then fail), upgrade when recovery also rebuilds it
pub(crate) fn owner_session(
    state: &AclState,
    entries: Vec<AclEntry>,
    device: DeviceKeys,
    cert: DeviceCert,
) -> Option<AclLog> {
    if cert.user != state.owner {
        return None;
    }
    AclLog::load(entries, Signing::Device { keys: device, cert }).ok()
}

pub(crate) fn head_of(entries: &[AclEntry]) -> (u64, [u8; 32]) {
    let last = entries.last().expect("a verified log has an entry");
    (last.index, last.hash())
}

pub(crate) fn log_rows(entries: &[AclEntry]) -> Vec<(u64, Vec<u8>)> {
    entries.iter().map(|e| (e.index, e.to_bytes())).collect()
}

pub(crate) fn cert_rows(certs: &[DeviceCert]) -> Vec<([u8; 32], Vec<u8>)> {
    certs
        .iter()
        .map(|c| (c.device, c.to_bytes().to_vec()))
        .collect()
}

pub(crate) fn read_log(records: &Records) -> Result<Vec<AclEntry>> {
    records
        .acl_entries()?
        .iter()
        .map(|bytes| AclEntry::from_bytes(bytes))
        .collect()
}

pub(crate) fn decode_certs(records: &Records) -> Result<Vec<DeviceCert>> {
    records
        .certs()?
        .iter()
        .map(|bytes| DeviceCert::from_bytes(bytes))
        .collect()
}

pub(crate) fn store_of(certs: &[DeviceCert]) -> Result<CertStore> {
    let mut store = CertStore::default();
    for cert in certs {
        store.insert(*cert)?;
    }
    Ok(store)
}

#[cfg(test)]
#[path = "space_tests.rs"]
mod tests;

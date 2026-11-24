//! Recovery into a folder that already holds the space, from the recovery phrase, when this device's key store has
//! no keys for it (SZYFROWANIE §8b). The phrase's keys stay in memory until every check has passed.

use std::path::Path;

use notes_core::{Records, Space};

use crate::acl_log::AclLog;
use crate::cert::DeviceCert;
use crate::device::DeviceKeys;
use crate::identity::UserKeys;
use crate::keystore::{KeyStore, Slot};
use crate::space::{
    Opened, access_for, cert_rows, current_keys, decode_certs, device_keys, head_of, owner_session,
    read_log, remember_head, signing_key, store_of, stored_device,
};
use crate::{Error, Result};

/// Opens the space in `root` with the user's keys from the phrase. Checks run in this order, and nothing is written
/// before the last one passes: the stored log names the user as a member; the user's envelopes give the current
/// epoch key. Then the device key is taken from the key store, or made when the store has none: a key already there
/// serves the device's other spaces too, so it is never replaced. A device key the folder does not certify yet gets
/// a certificate signed by the user. The epoch keys and the head are stored, and the space is opened.
// shortcut: a recovered device's certificate stays local and peers refuse it, upgrade with cert exchange in Hello (SZYFROWANIE §1, §8a) when the app gets networking
pub fn recover_existing(
    root: &Path,
    user: UserKeys,
    ks: &mut dyn KeyStore,
    now: u64,
) -> Result<Opened> {
    let mut records = Records::open(root)?;
    let entries = read_log(&records)?;
    let state = AclLog::verify_extension(None, &entries)?;
    if !state.members.contains_key(&user.public().sign) {
        return Err(Error::NotMember);
    }
    let epoch_keys = state.epoch_keys(&user).keys;
    if !epoch_keys.contains_key(&state.epoch) {
        return Err(Error::NeedsPhrase);
    }
    let existing = stored_device(ks)?;
    let stored = existing.is_some();
    let device = match existing {
        Some(device) => device,
        None => DeviceKeys::generate()?,
    };
    let mut certs = decode_certs(&records)?;
    let certified = certs
        .iter()
        .find(|c| c.device == device.public().sign)
        .copied();
    // the kept key must work for this user here: a revoked key, or one certified for another member, would open
    // a space every write of which is refused (or made under someone else's name)
    // shortcut: a revoked device key cannot be replaced, since one key serves every space; upgrade with per-space device keys
    if state.revoked.contains_key(&device.public().sign)
        || certified.is_some_and(|c| c.user != user.public().sign)
    {
        return Err(Error::DeviceUnusable);
    }
    let cert = certified.unwrap_or_else(|| DeviceCert::issue(&user, &device, now));
    if certified.is_none() {
        certs.push(cert);
    }
    let store = store_of(&certs)?;
    drop(user);

    // every check has passed: from here the key store and the records are written
    if !stored {
        let (sign, boxk) = device.to_seeds();
        ks.set(Slot::DeviceSign, &sign[..])?;
        ks.set(Slot::DeviceBox, &boxk[..])?;
    }
    for (epoch, key) in &epoch_keys {
        ks.set(
            Slot::EpochKey {
                space: state.space,
                epoch: *epoch,
            },
            &key[..],
        )?;
    }
    let keys = current_keys(&state, &device, ks)?;
    if certified.is_none() {
        records.put_acl(&[], &cert_rows(&[cert]), head_of(&entries))?;
    }
    remember_head(ks, &state.space, head_of(&entries))?;
    drop(records);
    let space = Space::open(
        root,
        signing_key(&device),
        Box::new(access_for(state.clone(), store.clone(), keys)),
    )?;
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

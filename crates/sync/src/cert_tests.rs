use super::*;
use crate::device::DeviceKeys;
use crate::identity::RecoveryPhrase;

fn user() -> UserKeys {
    UserKeys::from_phrase(&RecoveryPhrase::generate().unwrap()).unwrap()
}

fn device() -> DeviceKeys {
    DeviceKeys::generate().unwrap()
}

#[test]
fn issued_cert_verifies() {
    let u = user();
    let d = device();
    let cert = DeviceCert::issue(&u, &d, 1_700_000_000);
    assert_eq!(cert.user, u.public().sign);
    assert_eq!(cert.public(), d.public());
    cert.verify().unwrap();
}

#[test]
fn tampering_any_field_is_rejected() {
    let u = user();
    let cert = DeviceCert::issue(&u, &device(), 1_700_000_000);

    let mut c = cert;
    c.user[0] ^= 1;
    assert!(c.verify().is_err(), "user field");

    let mut c = cert;
    c.device[5] ^= 0x80;
    assert!(c.verify().is_err(), "device sign field");

    let mut c = cert;
    c.device_box[7] ^= 0x01;
    assert!(c.verify().is_err(), "device box field");

    let mut c = cert;
    c.created += 1;
    assert!(c.verify().is_err(), "created field");

    let mut c = cert;
    c.sig[63] ^= 1;
    assert!(c.verify().is_err(), "user signature");

    let mut c = cert;
    c.pop[0] ^= 1;
    assert!(c.verify().is_err(), "proof of possession");
}

#[test]
fn cert_from_another_user_is_rejected() {
    let owner = user();
    let other = user();
    let mut cert = DeviceCert::issue(&other, &device(), 5);
    cert.user = owner.public().sign;
    assert!(cert.verify().is_err());
}

#[test]
fn stranger_cannot_certify_someone_elses_device_key() {
    // The stranger has its own device key and tries to certify the victim's public key with it.
    let stranger = user();
    let victim_device = device();
    let own_device = device();
    let mut forged = DeviceCert::issue(&stranger, &own_device, 9);
    forged.device = victim_device.public().sign;
    forged.device_box = victim_device.public().boxk;
    assert!(forged.verify().is_err(), "PoP is not by the victim's key");

    // Same with a valid user signature over the victim's key: still no PoP.
    let mut store = CertStore::default();
    assert!(store.insert(forged).is_err());
    let real = DeviceCert::issue(&user(), &victim_device, 9);
    store.insert(real).unwrap();
    assert_eq!(store.get(&victim_device.public().sign), Some(&real));
}

#[test]
fn real_cert_inserts_regardless_of_order() {
    let u = user();
    let d = device();
    let real = DeviceCert::issue(&u, &d, 3);
    let mut fake = DeviceCert::issue(&user(), &device(), 3);
    fake.device = d.public().sign;
    fake.device_box = d.public().boxk;

    let mut first_fake = CertStore::default();
    assert!(first_fake.insert(fake).is_err());
    first_fake.insert(real).unwrap();

    let mut first_real = CertStore::default();
    first_real.insert(real).unwrap();
    assert!(first_real.insert(fake).is_err());
    assert_eq!(first_fake.get(&real.device), first_real.get(&real.device));
}

#[test]
fn bytes_round_trip_and_wrong_length() {
    let cert = DeviceCert::issue(&user(), &device(), 42);
    let bytes = cert.to_bytes();
    assert_eq!(bytes.len(), CERT_LEN);
    assert_eq!(DeviceCert::from_bytes(&bytes).unwrap(), cert);
    assert!(DeviceCert::from_bytes(&bytes[..CERT_LEN - 1]).is_err());
    let mut long = bytes.to_vec();
    long.push(0);
    assert!(DeviceCert::from_bytes(&long).is_err());
}

#[test]
fn device_seeds_round_trip() {
    let d = device();
    let (s, b) = d.to_seeds();
    let again = DeviceKeys::from_seeds(&s, &b);
    assert_eq!(again.public(), d.public());
}

#[test]
fn store_rejects_unverified_and_conflicting_certs() {
    let u = user();
    let other = user();
    let d = device();
    let good = DeviceCert::issue(&u, &d, 1);
    let mut store = CertStore::default();

    let mut bad = good;
    bad.created = 2;
    assert!(store.insert(bad).is_err());

    store.insert(good).unwrap();
    store.insert(good).unwrap();
    let stolen = DeviceCert::issue(&other, &d, 1);
    assert!(store.insert(stolen).is_err());
    assert_eq!(store.certs_of(&u.public().sign), vec![good]);
    assert!(store.certs_of(&other.public().sign).is_empty());
}

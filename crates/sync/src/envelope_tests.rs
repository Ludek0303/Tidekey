use super::*;
use crate::identity::RecoveryPhrase;

const SPACE: [u8; 16] = [7; 16];
const KEY: [u8; 32] = [9; 32];

fn user() -> UserKeys {
    UserKeys::from_phrase(&RecoveryPhrase::generate().unwrap()).unwrap()
}

#[test]
fn seal_then_open_gives_the_key() {
    let u = user();
    let env = Envelope::seal(&u.public().boxk, &SPACE, 3, &KEY).unwrap();
    assert_eq!(*env.open(&u, &SPACE, 3).unwrap(), KEY);
}

#[test]
fn wrong_recipient_space_or_epoch_fails() {
    let u = user();
    let other = user();
    let env = Envelope::seal(&u.public().boxk, &SPACE, 3, &KEY).unwrap();
    assert!(env.open(&other, &SPACE, 3).is_err());
    assert!(env.open(&u, &[8; 16], 3).is_err());
    assert!(env.open(&u, &SPACE, 4).is_err());
}

#[test]
fn tampered_envelope_fails() {
    let u = user();
    let mut env = Envelope::seal(&u.public().boxk, &SPACE, 0, &KEY).unwrap();
    env.0[40] ^= 1;
    assert!(env.open(&u, &SPACE, 0).is_err());
}

#[test]
fn length_is_fixed() {
    assert_eq!(ENVELOPE_LEN, 100);
    assert!(Envelope::from_bytes(&[0; 99]).is_err());
    assert!(Envelope::from_bytes(&[0; 101]).is_err());
    assert!(Envelope::from_bytes(&[0; ENVELOPE_LEN]).is_ok());
}

#[test]
fn device_envelope_opens_only_with_its_device_key() {
    let d = crate::device::DeviceKeys::generate().unwrap();
    let other = crate::device::DeviceKeys::generate().unwrap();
    let env = Envelope::seal(&d.public().boxk, &SPACE, 4, &KEY).unwrap();
    assert_eq!(*env.open_device(&d, &SPACE, 4).unwrap(), KEY);
    assert!(env.open_device(&other, &SPACE, 4).is_err());
    assert!(env.open_device(&d, &SPACE, 5).is_err());
}

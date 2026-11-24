use super::*;
use data_encoding::HEXLOWER;

const ZERO_PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
    abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
    abandon abandon abandon abandon abandon art";

fn keys_of(text: &str) -> UserKeys {
    UserKeys::from_phrase(&RecoveryPhrase::parse(text).unwrap()).unwrap()
}

#[test]
fn phrase_round_trip() {
    let phrase = RecoveryPhrase::generate().unwrap();
    assert_eq!(phrase.as_str().split(' ').count(), 24);
    let again = RecoveryPhrase::parse(phrase.as_str()).unwrap();
    assert_eq!(again.as_str(), phrase.as_str());
}

#[test]
fn parse_normalises_case_and_whitespace() {
    let messy = format!("\n  {}  ", ZERO_PHRASE.to_uppercase().replace(' ', "\t"));
    assert_eq!(RecoveryPhrase::parse(&messy).unwrap().as_str(), ZERO_PHRASE);
}

#[test]
fn wrong_checksum_rejected() {
    let bad = ZERO_PHRASE.replace(" art", " abandon");
    assert_eq!(RecoveryPhrase::parse(&bad).err(), Some(Error::Phrase));
}

#[test]
fn wrong_word_count_and_unknown_word_rejected() {
    let short = ZERO_PHRASE.rsplit_once(' ').unwrap().0;
    assert_eq!(RecoveryPhrase::parse(short).err(), Some(Error::Phrase));
    let unknown = ZERO_PHRASE.replace("art", "notaword");
    assert_eq!(RecoveryPhrase::parse(&unknown).err(), Some(Error::Phrase));
}

#[test]
fn same_phrase_same_keys() {
    let a = keys_of(ZERO_PHRASE).public();
    let b = keys_of(&ZERO_PHRASE.to_uppercase()).public();
    assert_eq!(a, b);
}

#[test]
fn different_phrases_different_keys() {
    let a = RecoveryPhrase::generate().unwrap();
    let b = RecoveryPhrase::generate().unwrap();
    let ka = UserKeys::from_phrase(&a).unwrap().public();
    let kb = UserKeys::from_phrase(&b).unwrap().public();
    assert_ne!(ka, kb);
}

#[test]
fn bip39_seed_matches_published_vector() {
    // BIP-39 test vector: all-zero entropy, empty passphrase.
    let m = Mnemonic::parse_in_normalized(Language::English, ZERO_PHRASE).unwrap();
    assert_eq!(
        HEXLOWER.encode(&m.to_seed("")),
        "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840"
    );
}

#[test]
fn known_answer_user_public_keys() {
    let p = keys_of(ZERO_PHRASE).public();
    assert_eq!(
        HEXLOWER.encode(&p.sign),
        "a11b5545e42179ad45d05cbd26eb0fca338a806d9f087cfdfc59664a784a29d4"
    );
    assert_eq!(
        HEXLOWER.encode(&p.boxk),
        "6c12926b9d89def3d819afc79c66942258e7b034bfdf4e293d546bba8a68d630"
    );
    assert_ne!(p.sign, p.boxk);
}

#[test]
fn debug_hides_secrets() {
    let keys = keys_of(ZERO_PHRASE);
    assert_eq!(format!("{keys:?}"), "UserKeys(<secret>)");
}

use super::*;

use crate::identity::{RecoveryPhrase, UserKeys};

const SPACE: [u8; 16] = [5; 16];
const ENDPOINT: [u8; 32] = [6; 32];

fn device_cert() -> (DeviceCert, DeviceKeys) {
    let user = UserKeys::from_phrase(&RecoveryPhrase::generate().unwrap()).unwrap();
    let device = DeviceKeys::generate().unwrap();
    (DeviceCert::issue(&user, &device, 1), device)
}

fn every_variant() -> Vec<Frame> {
    let (cert, keys) = device_cert();
    let bind = bind_sig(&keys, SPACE, ENDPOINT);
    vec![
        Frame::Hello {
            protocol: PROTOCOL,
            space: SPACE,
            proof: PeerProof::Device { cert, bind },
            acl_head: Some(AclHead {
                index: 3,
                hash: [1; 32],
            }),
            token: Some([2; 32]),
        },
        Frame::Hello {
            protocol: PROTOCOL,
            space: SPACE,
            proof: PeerProof::Node,
            acl_head: None,
            token: None,
        },
        Frame::Acl {
            entries: vec![vec![1, 2, 3], vec![]],
            certs: vec![cert.to_bytes().to_vec()],
        },
        Frame::Have(vec![([7; 32], 4), ([8; 32], 0)]),
        Frame::Msgs(vec![vec![9; 300], vec![]]),
        Frame::Synced(vec![]),
        Frame::Live(vec![5; 10]),
        Frame::Reject("zaktualizuj aplikację".to_string()),
    ]
}

#[test]
fn every_variant_round_trips() {
    for frame in every_variant() {
        assert_eq!(Frame::from_bytes(&frame.to_bytes()).unwrap(), frame);
    }
}

#[test]
fn truncated_or_padded_frames_are_rejected() {
    for frame in every_variant() {
        let bytes = frame.to_bytes();
        for n in 0..bytes.len() {
            assert!(Frame::from_bytes(&bytes[..n]).is_err(), "prefix {n}");
        }
        let mut padded = bytes.clone();
        padded.push(0);
        assert!(Frame::from_bytes(&padded).is_err());
    }
}

#[test]
fn oversized_counts_and_frames_are_rejected_before_allocation() {
    // Have with a count of u32::MAX devices, and no data behind it
    assert!(Frame::from_bytes(&[3, 0xff, 0xff, 0xff, 0xff]).is_err());
    // Msgs with a count above the item limit
    assert!(Frame::from_bytes(&[4, 0x00, 0x00, 0x10, 0x00]).is_err());
    // a blob that claims more bytes than the frame holds
    assert!(Frame::from_bytes(&[6, 0x10, 0x00, 0x00, 0x00, 1]).is_err());
    assert!(Frame::from_bytes(&vec![7; MAX_FRAME + 1]).is_err());
    assert!(Frame::from_bytes(&[99]).is_err());
}

#[test]
fn bind_signature_covers_space_and_endpoint() {
    let (cert, keys) = device_cert();
    let sig = bind_sig(&keys, SPACE, ENDPOINT);
    assert!(verify_bind(&cert, SPACE, ENDPOINT, &sig));
    assert!(!verify_bind(&cert, [0; 16], ENDPOINT, &sig));
    assert!(!verify_bind(&cert, SPACE, [0; 32], &sig));
    let mut bad = sig;
    bad[0] ^= 1;
    assert!(!verify_bind(&cert, SPACE, ENDPOINT, &bad));
}

proptest::proptest! {
    #[test]
    fn random_bytes_never_panic(bytes in proptest::collection::vec(proptest::arbitrary::any::<u8>(), 0..512)) {
        let _ = Frame::from_bytes(&bytes);
    }

    #[test]
    fn mutated_frames_never_panic(index in 0usize..4096, value in proptest::arbitrary::any::<u8>()) {
        for frame in every_variant() {
            let mut bytes = frame.to_bytes();
            let i = index % bytes.len();
            bytes[i] = value;
            let _ = Frame::from_bytes(&bytes);
        }
    }
}

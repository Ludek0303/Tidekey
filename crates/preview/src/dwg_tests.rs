use super::*;

const RYSUNEK: &[u8] = include_bytes!("../../../fixtures/preview/rysunek.dwg");
const LOSOWE: &[u8] = include_bytes!("../../../fixtures/preview/losowe.dwg");

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
}

#[test]
fn the_fixture_becomes_dxf_with_its_entities_and_layers() {
    let dxf = dwg_to_dxf(RYSUNEK).expect("rysunek.dwg converts");
    // acadrust writes CRLF line ends.
    assert!(dxf.starts_with(b"  0\r\nSECTION\r\n"));
    for entity in ["LINE", "CIRCLE", "ARC", "LWPOLYLINE", "TEXT"] {
        assert!(contains(&dxf, &format!("\r\n{entity}\r\n")), "missing {entity}");
    }
    for layer in ["Ściany", "Okna i drzwi", "Opisy"] {
        assert!(contains(&dxf, layer), "missing layer {layer}");
    }
    assert!(contains(&dxf, "Rzut parteru"));
    assert!(contains(&dxf, "zażółć gęślą jaźń"));
}

#[test]
fn random_bytes_with_a_dwg_signature_are_corrupt() {
    assert_eq!(dwg_to_dxf(LOSOWE), Err(PreviewError::Corrupt));
}

#[test]
fn every_truncation_is_an_error_and_never_a_panic() {
    for cut in (0..RYSUNEK.len()).step_by(997) {
        assert!(dwg_to_dxf(&RYSUNEK[..cut]).is_err(), "truncated at {cut} B");
    }
}

#[test]
fn changed_bytes_are_an_error_or_a_result_but_never_a_panic() {
    let mut bytes = RYSUNEK.to_vec();
    for i in (0..bytes.len()).step_by(101) {
        if let Some(b) = bytes.get_mut(i) {
            *b ^= 0x5a;
        }
    }
    let _ = dwg_to_dxf(&bytes);
}

#[test]
fn an_input_over_the_limit_is_too_large_before_parsing() {
    let mut bytes = b"AC1032".to_vec();
    bytes.resize(MAX_DWG + 1, 0);
    assert_eq!(dwg_to_dxf(&bytes), Err(PreviewError::TooLarge));
}

#[test]
fn bytes_without_the_signature_are_unsupported() {
    assert_eq!(dwg_to_dxf(b""), Err(PreviewError::Unsupported));
    assert_eq!(dwg_to_dxf(b"AC10"), Err(PreviewError::Unsupported));
    assert_eq!(dwg_to_dxf(b"AC1X32 nie DWG"), Err(PreviewError::Unsupported));
    assert_eq!(dwg_to_dxf(b"  0\nSECTION\n"), Err(PreviewError::Unsupported));
}

proptest::proptest! {
    #[test]
    fn any_bytes_never_panic(bytes in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..4096)) {
        let _ = dwg_to_dxf(&bytes);
    }

    #[test]
    fn any_bytes_after_a_dwg_signature_never_panic(tail in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..4096)) {
        let mut bytes = b"AC1032".to_vec();
        bytes.extend_from_slice(&tail);
        let _ = dwg_to_dxf(&bytes);
    }
}

// Found by cargo-fuzz (2026-11-18): acadrust 0.6.8 panics on it ("attempt to shift left with overflow" in
// handle_reader.rs:101). The panic is the library's; dwg_to_dxf must turn it into an error, not a crash.
#[test]
fn a_panic_inside_acadrust_is_an_error() {
    let bytes = include_bytes!("testdata/dwg-acadrust-shift-overflow.dwg");
    assert!(dwg_to_dxf(bytes).is_err());
}

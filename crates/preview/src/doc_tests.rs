use super::*;
use crate::{MAX_DEPTH, cfbx};
use proptest::prelude::*;

const DOC: &[u8] = include_bytes!("../../../fixtures/preview/dokument.doc");
const LOSOWE: &[u8] = include_bytes!("../../../fixtures/preview/losowe.doc");
const PPT: &[u8] = include_bytes!("../../../fixtures/preview/prezentacja.ppt");
const DOCX: &[u8] = include_bytes!("../../../fixtures/preview/dokument.docx");
const CFB_SIGNATURE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/// Text of the reference document, the same as `dokument.docx` (word/document.xml), empty paragraphs left out.
const EXPECTED_TEXT: [&str; 22] = [
    "Dokument testowy podglądu",
    "Ten dokument ma nagłówki, akapity, tabelę i obraz. Zażółć gęślą jaźń: polskie znaki w akapicie, pogrubienie i kursywa w jednym zdaniu.",
    "1. Wstęp",
    "Strona pierwsza: nagłówek, dwa akapity i obraz wstawiony w tekst. Podgląd ma pokazać układ strony, a nie edytować treść.",
    "Drugi akapit zawiera więcej tekstu, żeby sprawdzić zawijanie wierszy przy szerokości strony A4 z marginesami 2,5 cm po obu stronach.",
    "2. Tabela",
    "Lp",
    "Pozycja",
    "Kwota (zł)",
    "1",
    "Ziemia ogrodowa",
    "4 500,00",
    "2",
    "Ławki do altany",
    "1 890,50",
    "3",
    "Nasiona i sadzonki",
    "320,75",
    "3. Podsumowanie",
    "Pierwszy punkt listy z polskim tekstem: łąka, źródło, świerszcz.",
    "Drugi punkt listy.",
    "Koniec dokumentu testowego.",
];

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// Runs the paragraph pass over plain text.
fn para(s: &str) -> Result<DocModel> {
    paragraphs(&utf16(s), &mut Budget::new(1 << 20))
}

/// The paragraphs of `s` as (kind, text) pairs, for readable assertions.
fn shape(s: &str) -> Vec<(ParagraphKind, String)> {
    para(s).map(|m| m.paragraphs.into_iter().map(|p| (p.kind, p.text)).collect()).unwrap_or_default()
}

fn noise(seed: u64, len: usize) -> Vec<u8> {
    let mut s = seed | 1;
    (0..len)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s >> 32) as u8
        })
        .collect()
}

/// A CLX with no Prc entries and one Pcdt: character positions `cps` and one piece per `fcs` entry.
fn clx(cps: &[u32], fcs: &[u32]) -> Vec<u8> {
    let mut plc = Vec::new();
    for cp in cps {
        plc.extend_from_slice(&cp.to_le_bytes());
    }
    for fc in fcs {
        plc.extend_from_slice(&[0, 0]);
        plc.extend_from_slice(&fc.to_le_bytes());
        plc.extend_from_slice(&[0, 0]);
    }
    let mut out = vec![0x02];
    out.extend_from_slice(&u32::try_from(plc.len()).unwrap_or(0).to_le_bytes());
    out.extend_from_slice(&plc);
    out
}

#[test]
fn the_reference_document_gives_its_paragraphs() {
    let model = doc_text(DOC).unwrap_or_default();
    let texts: Vec<&str> = model.paragraphs.iter().map(|p| p.text.as_str()).filter(|t| !t.is_empty()).collect();
    assert_eq!(texts, EXPECTED_TEXT);
}

#[test]
fn table_cells_are_cells_and_the_row_end_is_a_cell_too() {
    let model = doc_text(DOC).unwrap_or_default();
    let kind_of = |text: &str| model.paragraphs.iter().find(|p| p.text == text).map(|p| p.kind);
    assert_eq!(kind_of("Lp"), Some(ParagraphKind::Cell));
    assert_eq!(kind_of("320,75"), Some(ParagraphKind::Cell));
    assert_eq!(kind_of("1. Wstęp"), Some(ParagraphKind::Normal));
    // every row ends with \x07, which gives an empty cell paragraph
    assert_eq!(model.paragraphs.iter().filter(|p| p.kind == ParagraphKind::Cell && p.text.is_empty()).count(), 4);
}

#[test]
fn a_random_file_is_an_error() {
    assert!(doc_text(LOSOWE).is_err());
    assert!(doc_text(b"").is_err());
}

#[test]
fn a_zip_file_is_an_error() {
    assert!(doc_text(DOCX).is_err());
}

#[test]
fn a_compound_file_without_word_text_is_an_error() {
    assert!(doc_text(PPT).is_err());
}

#[test]
fn read_stream_finds_streams_and_enforces_the_limit() {
    assert_eq!(cfbx::read_stream(PPT, "WordDocument", 1 << 20), Ok(None));
    let ppt = cfbx::read_stream(PPT, "PowerPoint Document", 1 << 20);
    assert!(matches!(ppt, Ok(Some(ref v)) if !v.is_empty()));
    assert_eq!(cfbx::read_stream(PPT, "PowerPoint Document", 4), Err(PreviewError::TooLarge));
    assert_eq!(cfbx::read_stream(DOCX, "WordDocument", 1 << 20), Err(PreviewError::Corrupt));
}

#[test]
fn truncated_files_never_panic() {
    for cut in (0..DOC.len()).step_by(997) {
        let _ = doc_text(&DOC[..cut]);
    }
}

#[test]
fn changed_bytes_never_panic() {
    for i in (0..DOC.len()).step_by(101) {
        let mut v = DOC.to_vec();
        if let Some(b) = v.get_mut(i) {
            *b ^= 0x5a;
        }
        let _ = doc_text(&v);
    }
}

#[test]
fn noise_after_a_real_signature_never_panics() {
    for seed in 1..200 {
        let mut v = CFB_SIGNATURE.to_vec();
        v.extend(noise(seed, 4096));
        let _ = doc_text(&v);
    }
}

#[test]
fn an_eight_bit_character_uses_cp1252_with_its_exceptions() {
    assert_eq!(cp1252(b'A'), u16::from(b'A'));
    assert_eq!(cp1252(0xE9), 0xE9);
    assert_eq!(cp1252(0x80), 0x20AC);
    assert_eq!(cp1252(0x82), 0x201A);
    assert_eq!(cp1252(0x9F), 0x0178);
    assert_eq!(cp1252(0x81), 0x0081);
}

#[test]
fn pieces_decode_from_the_word_stream() {
    // "\x80A" in 8-bit at byte 0, then "ż" as UTF-16LE at byte 4
    let word = [0x80, b'A', 0, 0, 0x7C, 0x01];
    let pieces = [
        Piece { len: 2, compressed: true, at: 0 },
        Piece { len: 1, compressed: false, at: 4 },
    ];
    let units = main_text_units(&word, &pieces, 3, &mut Budget::new(1000));
    assert_eq!(units, Ok(vec![0x20AC, u16::from(b'A'), 0x017C]));
}

#[test]
fn the_piece_table_reads_compressed_and_wide_pieces() {
    let table = clx(&[0, 2, 4], &[0x4000_0000 | 20, 0x0000_0100]);
    assert_eq!(
        piece_table(&table),
        Ok(vec![
            Piece { len: 2, compressed: true, at: 10 },
            Piece { len: 2, compressed: false, at: 0x100 },
        ])
    );
}

#[test]
fn a_prc_before_the_piece_table_is_skipped() {
    let mut table = vec![0x01, 2, 0, 0xAA, 0xBB];
    table.extend(clx(&[0, 1], &[0x4000_0000 | 8]));
    assert_eq!(piece_table(&table), Ok(vec![Piece { len: 1, compressed: true, at: 4 }]));
}

#[test]
fn a_piece_table_with_a_backwards_position_is_corrupt() {
    assert_eq!(piece_table(&clx(&[5, 2], &[0x100])), Err(PreviewError::Corrupt));
}

#[test]
fn plain_text_splits_into_paragraphs() {
    assert_eq!(
        shape("ab\rc\x07d\x0Ce"),
        vec![
            (ParagraphKind::Normal, "ab".to_string()),
            (ParagraphKind::Cell, "c".to_string()),
            (ParagraphKind::Normal, "d".to_string()),
            (ParagraphKind::PageBreak, String::new()),
            (ParagraphKind::Normal, "e".to_string()),
        ]
    );
}

#[test]
fn empty_paragraphs_are_kept_but_a_trailing_empty_one_is_not() {
    assert_eq!(
        shape("a\r\rb\r"),
        vec![
            (ParagraphKind::Normal, "a".to_string()),
            (ParagraphKind::Normal, String::new()),
            (ParagraphKind::Normal, "b".to_string()),
        ]
    );
}

#[test]
fn field_codes_are_dropped_and_their_results_kept() {
    assert_eq!(shape("a\x13HYPERLINK x\x14b\x15c"), vec![(ParagraphKind::Normal, "abc".to_string())]);
    assert_eq!(shape("a\x13 HYPERLINK b\x15c"), vec![(ParagraphKind::Normal, "ac".to_string())]);
    assert_eq!(
        shape("x\x13 I\x13 J\x14 K\x15 L\x14 R\x15 y"),
        vec![(ParagraphKind::Normal, "x R y".to_string())]
    );
}

#[test]
fn field_nesting_is_limited() {
    let ok = "\x13".repeat(MAX_DEPTH);
    assert!(para(&ok).is_ok());
    let too_deep = "\x13".repeat(MAX_DEPTH + 1);
    assert_eq!(para(&too_deep).err(), Some(PreviewError::TooLarge));
}

#[test]
fn control_characters_are_mapped_or_dropped() {
    assert_eq!(
        shape("a\x0Bb\x1Ec\x1Fd\x01e\x08f\x05g"),
        vec![(ParagraphKind::Normal, "a\nb-cdefg".to_string())]
    );
    assert_eq!(shape("Ala\tma"), vec![(ParagraphKind::Normal, "Ala\tma".to_string())]);
}

#[test]
fn text_is_decoded_from_utf16_including_polish_letters() {
    assert_eq!(shape("zażółć"), vec![(ParagraphKind::Normal, "zażółć".to_string())]);
}

#[test]
fn the_paragraph_pass_spends_its_budget() {
    assert_eq!(paragraphs(&utf16("abcdef"), &mut Budget::new(3)).err(), Some(PreviewError::TooLarge));
}

#[test]
fn the_json_has_the_documented_shape() {
    let json = doc_text_json(DOC).unwrap_or_default();
    assert!(json.starts_with("{\"paragraphs\":[{"));
    assert!(json.contains("\"kind\":\"cell\""));
    assert!(json.contains("\"kind\":\"normal\""));
    assert!(json.contains("Zażółć gęślą jaźń"));
}

proptest! {
    #[test]
    fn any_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let _ = doc_text(&bytes);
    }

    #[test]
    fn any_bytes_after_a_signature_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let mut v = CFB_SIGNATURE.to_vec();
        v.extend(bytes);
        let _ = doc_text(&v);
    }
}

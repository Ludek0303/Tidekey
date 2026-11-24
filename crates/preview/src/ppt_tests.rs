use super::*;
use crate::u32_le;
use proptest::prelude::*;
use std::io::{Cursor, Read, Write};

const PREZENTACJA: &[u8] = include_bytes!("../../../fixtures/preview/prezentacja.ppt");
const LOSOWE: &[u8] = include_bytes!("../../../fixtures/preview/losowe.ppt");

/// Every root stream of a container, with its path (`/Name`).
fn streams(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut file = cfb::CompoundFile::open(Cursor::new(bytes)).expect("fixture opens");
    let paths: Vec<String> = file.walk().filter(|e| e.is_stream()).map(|e| e.path().display().to_string()).collect();
    paths
        .into_iter()
        .map(|path| {
            let mut data = Vec::new();
            file.open_stream(&path).expect("stream opens").read_to_end(&mut data).expect("stream reads");
            (path, data)
        })
        .collect()
}

/// A new container with exactly these streams.
fn build(streams: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut file = cfb::CompoundFile::create(Cursor::new(Vec::new())).expect("container creates");
    for (path, data) in streams {
        file.create_stream(path).expect("stream creates").write_all(data).expect("stream writes");
    }
    file.flush().expect("container flushes");
    file.into_inner().into_inner()
}

/// The fixture with one root stream changed by `edit`.
fn with_stream(bytes: &[u8], name: &str, mut edit: impl FnMut(&mut Vec<u8>)) -> Vec<u8> {
    let mut all = streams(bytes);
    let path = format!("/{name}");
    for (p, data) in all.iter_mut() {
        if *p == path {
            edit(data);
        }
    }
    build(&all)
}

fn stream(bytes: &[u8], name: &str) -> Vec<u8> {
    let path = format!("/{name}");
    streams(bytes).into_iter().find(|(p, _)| *p == path).map(|(_, d)| d).expect("fixture has the stream")
}

/// Where the UserEditAtom of the current edit starts in the PowerPoint Document stream.
fn current_edit(bytes: &[u8]) -> usize {
    let user = stream(bytes, "Current User");
    // CurrentUserAtom: header 8 bytes, size(4), headerToken(4), offsetToCurrentEdit(4)
    u32_le(&user, 16).expect("CurrentUserAtom has offsetToCurrentEdit") as usize
}

#[test]
fn prezentacja_ma_cztery_slajdy_z_tekstem() {
    let (slides, _) = ppt_slides(PREZENTACJA).expect("fixture parses");
    assert_eq!(slides.len(), 4);
    let all: Vec<&str> = slides.iter().flat_map(|s| s.texts.iter().map(String::as_str)).collect();
    for expected in [
        "Prezentacja testowa",
        "Cele projektu",
        "Zasadzić nowe krzewy",
        "Zażółcić i ozdobić ogrodzenie",
        "Obraz na slajdzie",
        "Podsumowanie",
        "Budżet: 8 000 zł",
        "Kolejne spotkanie w maju",
    ] {
        assert!(all.iter().any(|t| t.contains(expected)), "missing text {expected:?} in {all:?}");
    }
}

#[test]
fn obraz_przypisany_do_trzeciego_slajdu() {
    let (slides, pictures) = ppt_slides(PREZENTACJA).expect("fixture parses");
    assert_eq!(pictures.len(), 1);
    assert_eq!(pictures[0].mime, "image/png");
    assert!(pictures[0].data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]));
    let with_picture: Vec<usize> = slides.iter().enumerate().filter(|(_, s)| !s.pictures.is_empty()).map(|(i, _)| i).collect();
    assert_eq!(with_picture, vec![2]);
    assert_eq!(slides[2].pictures, vec![0]);
}

#[test]
fn losowe_ppt_to_blad() {
    assert!(ppt_slides(LOSOWE).is_err());
}

#[test]
fn obciecia_nie_panikuja() {
    for cut in (0..PREZENTACJA.len()).step_by(997) {
        assert!(ppt_slides(&PREZENTACJA[..cut]).is_err(), "cut at {cut} must not parse");
    }
}

#[test]
fn zmienione_bajty_nie_panikuja() {
    for i in (0..PREZENTACJA.len()).step_by(4099) {
        let mut copy = PREZENTACJA.to_vec();
        copy[i] ^= 0x5a;
        let _ = ppt_slides(&copy);
    }
    for i in (0..stream(PREZENTACJA, "PowerPoint Document").len()).step_by(101) {
        let bytes = with_stream(PREZENTACJA, "PowerPoint Document", |d| d[i] ^= 0x5a);
        let _ = ppt_slides(&bytes);
    }
}

#[test]
fn losowe_bajty_z_sygnatura_cfb_to_blad() {
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    for _ in 0..200 {
        let mut bytes = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        for _ in 0..4096 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            bytes.push(seed as u8);
        }
        assert!(ppt_slides(&bytes).is_err());
    }
}

#[test]
fn lancuch_offsetlastedit_wskazujacy_na_siebie_to_blad() {
    let edit = current_edit(PREZENTACJA);
    // UserEditAtom: header 8 bytes, then lastSlideIdRef(4), version(2), minor(1), major(1), offsetLastEdit(4)
    let bytes = with_stream(PREZENTACJA, "PowerPoint Document", |d| {
        d[edit + 16..edit + 20].copy_from_slice(&(edit as u32).to_le_bytes());
    });
    assert_eq!(ppt_slides(&bytes), Err(PreviewError::Corrupt));
}

#[test]
fn zaszyfrowany_plik_to_nieobslugiwany() {
    let mut all = streams(PREZENTACJA);
    all.push(("/EncryptedSummary".to_string(), vec![0u8; 16]));
    assert_eq!(ppt_slides(&build(&all)), Err(PreviewError::Unsupported));
}

#[test]
fn obraz_bez_powiazania_trafia_na_ostatni_slajd() {
    // the slide's pib property (opid 0x4104, value 1) is zeroed: the picture is in the store but no slide uses it
    let pattern = [0x04u8, 0x41, 0x01, 0x00, 0x00, 0x00];
    let body = stream(PREZENTACJA, "PowerPoint Document");
    let hits: Vec<usize> = body.windows(pattern.len()).enumerate().filter(|(_, w)| *w == pattern).map(|(i, _)| i).collect();
    assert_eq!(hits.len(), 1, "exactly one pib property in the fixture");
    let at = hits[0];
    let bytes = with_stream(PREZENTACJA, "PowerPoint Document", |d| d[at + 2..at + 6].copy_from_slice(&[0, 0, 0, 0]));
    let (slides, pictures) = ppt_slides(&bytes).expect("parses without the binding");
    assert_eq!(pictures.len(), 1);
    assert!(slides[2].pictures.is_empty());
    assert_eq!(slides[3].pictures, vec![0]);
}

#[test]
fn json_dla_ramki_ma_tytul_teksty_i_obrazy() {
    let js = PptJs {
        slides: vec![Slide { title: Some("T".into()), texts: vec!["a".into()], pictures: vec![0, 2] }, Slide { title: None, texts: vec![], pictures: vec![] }],
        pictures: vec![Picture { mime: "image/png", data: vec![1, 2] }],
    };
    let expected: serde_json::Value = serde_json::from_str(
        r#"{"slides":[{"title":"T","texts":["a"],"pictures":[0,2]},{"title":null,"texts":[],"pictures":[]}]}"#,
    )
    .expect("valid json");
    let got: serde_json::Value = serde_json::from_str(&js.slides_json()).expect("slides_json is json");
    assert_eq!(got, expected);
    assert_eq!(js.picture_count(), 1);
    assert_eq!(js.picture_mime(0), "image/png");
    assert_eq!(js.picture(0), vec![1, 2]);
    assert_eq!(js.picture(5), Vec::<u8>::new());
    assert_eq!(js.picture_mime(5), "");
}

proptest! {
    #[test]
    fn dowolne_bajty_nie_panikuja(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let _ = ppt_slides(&bytes);
    }

    #[test]
    fn zmiany_w_prezentacji_nie_panikuja(changes in proptest::collection::vec((0usize..PREZENTACJA.len(), any::<u8>()), 1..16)) {
        let mut copy = PREZENTACJA.to_vec();
        for (at, value) in changes {
            if let Some(b) = copy.get_mut(at) {
                *b = value;
            }
        }
        let _ = ppt_slides(&copy);
    }
}

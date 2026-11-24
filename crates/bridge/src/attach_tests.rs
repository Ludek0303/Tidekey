use super::*;

#[test]
fn saved_attachment_is_read_back_and_a_taken_name_gets_a_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let first = save(dir.path(), "zdjęcie.png", b"png1").unwrap();
    let second = save(dir.path(), "zdjęcie.png", b"png2").unwrap();
    assert_eq!(first, "assets/zdjęcie.png");
    assert_eq!(second, "assets/zdjęcie (2).png");
    assert_eq!(read(dir.path(), &first).unwrap(), b"png1");
    assert_eq!(read(dir.path(), &second).unwrap(), b"png2");
}

#[test]
fn names_that_are_not_plain_file_names_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "",
        ".ukryty.png",
        "a/b.png",
        "..",
        "CON.png",
        "a:b.png",
        "koniec.",
        "x\\y.png",
    ] {
        assert_eq!(
            save(dir.path(), name, b"x").unwrap_err().kind,
            "invalid_path",
            "{name}"
        );
    }
    assert!(!dir.path().join("assets").join(".ukryty.png").exists());
}

#[test]
fn reads_stay_inside_assets_and_outside_hidden_folders() {
    let dir = tempfile::tempdir().unwrap();
    save(dir.path(), "a.png", b"x").unwrap();
    std::fs::write(dir.path().join("sekret.txt"), "tajne").unwrap();
    std::fs::create_dir_all(dir.path().join(".notes-sync")).unwrap();
    std::fs::write(dir.path().join(".notes-sync/space.db"), "db").unwrap();
    for rel in [
        "assets/../sekret.txt",
        "../sekret.txt",
        "sekret.txt",
        ".notes-sync/space.db",
        "assets/.ukryty",
        "/etc/passwd",
        "assets//a.png",
        "assets\\..\\sekret.txt",
    ] {
        assert_eq!(
            read(dir.path(), rel).unwrap_err().kind,
            "invalid_path",
            "{rel}"
        );
    }
}

#[test]
fn a_file_over_the_size_limit_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let big = vec![0u8; MAX_SIZE + 1];
    assert_eq!(
        save(dir.path(), "duzy.bin", &big).unwrap_err().kind,
        "too_large"
    );
}

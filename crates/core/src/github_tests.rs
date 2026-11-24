use crate::github::*;
use proptest::prelude::*;
use sha1::{Digest, Sha1};

/// First 8 hex characters of sha1 of the line, as `guarded_lines` returns them.
fn short(line: &str) -> String {
    Sha1::digest(line.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        .chars()
        .take(8)
        .collect()
}

fn repo(owner: &str, name: &str, git_ref: Option<&str>, path: &str) -> RepoRef {
    RepoRef {
        owner: owner.into(),
        repo: name.into(),
        git_ref: git_ref.map(Into::into),
        path: path.into(),
    }
}

#[test]
fn parses_repo_addresses() {
    let plain = Some(repo("acme", "notes", None, ""));
    assert_eq!(parse_repo_url("https://github.com/acme/notes"), plain);
    assert_eq!(parse_repo_url("http://github.com/acme/notes"), plain);
    assert_eq!(parse_repo_url("www.github.com/acme/notes"), plain);
    assert_eq!(parse_repo_url("github.com/acme/notes"), plain);
    assert_eq!(parse_repo_url("acme/notes"), plain);
    assert_eq!(parse_repo_url("  https://GitHub.com/acme/notes.git/  "), plain);
    assert_eq!(parse_repo_url("https://github.com/acme/notes?tab=x#y"), plain);
    assert_eq!(
        parse_repo_url("https://github.com/acme/notes/tree/main/docs/sub"),
        Some(repo("acme", "notes", Some("main"), "docs/sub"))
    );
    assert_eq!(
        parse_repo_url("https://github.com/acme/notes/tree/dev"),
        Some(repo("acme", "notes", Some("dev"), ""))
    );
    assert_eq!(
        parse_repo_url("https://github.com/acme/notes/blob/main/a/b/plik.md"),
        Some(repo("acme", "notes", Some("main"), "a/b"))
    );
    assert_eq!(
        parse_repo_url("https://github.com/acme/notes/blob/main/plik.md"),
        Some(repo("acme", "notes", Some("main"), ""))
    );
    // a branch with '/' in its name is ambiguous: the first segment is the ref
    assert_eq!(
        parse_repo_url("https://github.com/acme/notes/tree/feature/x/docs"),
        Some(repo("acme", "notes", Some("feature"), "x/docs"))
    );
}

#[test]
fn rejects_bad_addresses() {
    for bad in [
        "",
        "   ",
        "a",
        "a/b/c",
        "https://gitlab.com/a/b",
        "gitlab.com/a/b",
        "ftp://github.com/a/b",
        "https://github.com",
        "https://github.com/",
        "../x",
        "a/..",
        "a/.git",
        ".a/b",
        "a/b c",
        "a//b",
        "a/b/tree",
        "a/b/tree/main/../x",
        "a/b/tree/main/.git/x",
        "a/b/blob/main",
        "https://github.com/a/b/wiki",
    ] {
        assert_eq!(parse_repo_url(bad), None, "{bad:?}");
    }
}

#[test]
fn blob_sha1_matches_git() {
    // expected values from `printf '' | git hash-object --stdin` and the same for the other inputs
    assert_eq!(git_blob_sha1(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    assert_eq!(git_blob_sha1(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
    assert_eq!(git_blob_sha1(b"a\r\nb\r\n"), "c30dea8a3641ea99b125d04d599d843712292759");
}

#[test]
fn normalizes_repo_paths() {
    let cases: [(&str, &str, Option<&str>); 22] = [
        ("docs/a.md", "docs", Some("a.md")),
        ("docs/sub/a.md", "docs", Some("sub/a.md")),
        ("a.md", "", Some("a.md")),
        ("docs/../x", "docs", None),
        ("../x", "", None),
        ("/abs", "", None),
        ("a\\b", "", None),
        ("C:x", "", None),
        ("docs/C:x", "docs", None),
        ("a//b", "", Some("a/b")),
        ("a/./b", "", Some("a/b")),
        ("a\u{7}", "", None),
        ("Zażółć/ę.md", "", Some("Zażółć/ę.md")),
        (".git/config", "", None),
        ("x/.github/a.md", "", None),
        ("a..b.md", "", None),
        ("docs/a.md", "doc", None),
        ("docs", "docs", None),
        ("docs/", "docs", None),
        ("", "", None),
        ("docs/a.md", "docs/", Some("a.md")),
        ("docs/./a.md", "docs", Some("a.md")),
    ];
    for (path, base, want) in cases {
        assert_eq!(
            normalize_repo_path(path, base).as_deref(),
            want,
            "{path:?} under {base:?}"
        );
    }
}

#[test]
fn recognizes_markdown_files() {
    assert!(is_markdown("README"));
    assert!(is_markdown("readme.md"));
    assert!(is_markdown("docs/README"));
    assert!(is_markdown("x.MARKDOWN"));
    assert!(!is_markdown("x.txt"));
    assert!(!is_markdown("docs/readme.txt"));
    assert!(!is_markdown("a.md.txt"));
}

#[test]
fn merges_three_ways() {
    assert_eq!(
        merge3("a\nb\nc\n", "X\nb\nc\n", "a\nb\nc\nd\n"),
        Merge3::Clean("X\nb\nc\nd\n".into())
    );
    assert_eq!(merge3("a\n", "x\n", "y\n"), Merge3::Conflict);
    assert_eq!(merge3("a\nb\n", "a\nb\n", "a\nb\n"), Merge3::Clean("a\nb\n".into()));
    assert_eq!(
        merge3("a\r\nb\r\n", "X\r\nb\r\n", "a\r\nb\r\nc\r\n"),
        Merge3::Clean("X\r\nb\r\nc\r\n".into())
    );
    assert_eq!(
        merge3("\u{feff}a\nb", "\u{feff}a\nB", "\u{feff}a\nb"),
        Merge3::Clean("\u{feff}a\nB".into())
    );
}

#[test]
fn strips_permission_markers() {
    let front = "---\ntyp: kalendarz\nosoby:\n  - Ala\n  - Ola\ntitle: X\n---\nTekst\n";
    assert_eq!(
        strip_permission_markers(front),
        ("---\ntitle: X\n---\nTekst\n".to_string(), 4)
    );
    assert_eq!(
        strip_permission_markers("Tekst !zaznacza: @ala\nInny\n"),
        ("Inny\n".to_string(), 1)
    );
    // without frontmatter at the first line, `typ:` is ordinary text
    assert_eq!(
        strip_permission_markers("typ: x\n"),
        ("typ: x\n".to_string(), 0)
    );
    assert_eq!(
        strip_permission_markers("# Tytuł\n"),
        ("# Tytuł\n".to_string(), 0)
    );
    assert_eq!(
        strip_permission_markers("---\r\ntyp: a\r\ntitle: b\r\n---\r\nZ !zaznacza:\r\nK\r\n"),
        ("---\r\ntitle: b\r\n---\r\nK\r\n".to_string(), 2)
    );
    assert_eq!(
        strip_permission_markers("\u{feff}---\ntyp: a\n---\n"),
        ("\u{feff}---\n---\n".to_string(), 1)
    );
    assert_eq!(
        strip_permission_markers("---\nOsoby: x\nprowadzący: Ala\n---\n"),
        ("---\n---\n".to_string(), 2)
    );
    // no closing `---`: not frontmatter, so nothing in it is removed
    assert_eq!(
        strip_permission_markers("---\ntyp: a\n"),
        ("---\ntyp: a\n".to_string(), 0)
    );
}

#[test]
fn guards_tasks_and_mentions() {
    assert_eq!(guarded_lines("- [ ] zrób @ala\n"), vec![short("- [ ] zrób @ala")]);
    assert_eq!(guarded_lines("Spotkanie z @ala\n"), vec![short("Spotkanie z @ala")]);
    assert_eq!(guarded_lines("* [x] a\n"), vec![short("* [x] a")]);
    assert_eq!(guarded_lines("1. [ ] b\n"), vec![short("1. [ ] b")]);
    assert_eq!(guarded_lines("  - [X] c\n"), vec![short("  - [X] c")]);
    assert_eq!(guarded_lines("(@ala)\n"), vec![short("(@ala)")]);
    // one line counts once, even when it is a task and has a mention
    assert_eq!(guarded_lines("- [ ] @ala\n").len(), 1);
    // e-mail addresses, a bare '@' and plain list items are not guarded
    assert!(guarded_lines("mail: ala@example.test\n").is_empty());
    assert!(guarded_lines("@ tekst @\n").is_empty());
    assert!(guarded_lines("- zwykły punkt\n").is_empty());
    assert!(guarded_lines("[ ] bez listy\n").is_empty());
    // duplicates stay, so the count is kept
    assert_eq!(
        guarded_lines("- [ ] a\n- [ ] a\n"),
        vec![short("- [ ] a"), short("- [ ] a")]
    );
    // CRLF and trailing spaces are not part of the line
    assert_eq!(guarded_lines("- [ ] a\r\n"), vec![short("- [ ] a")]);
    assert_eq!(guarded_lines("- [ ] a   \n"), vec![short("- [ ] a")]);
}

proptest! {
    #[test]
    fn parse_never_panics(input in any::<String>()) {
        if let Some(r) = parse_repo_url(&input) {
            prop_assert!(!r.owner.is_empty() && !r.repo.is_empty());
            prop_assert!(!r.path.contains(".."));
        }
    }

    #[test]
    fn normalized_paths_stay_inside(path in any::<String>(), base in any::<String>()) {
        if let Some(out) = normalize_repo_path(&path, &base) {
            prop_assert!(!out.is_empty());
            prop_assert!(!out.starts_with('/'));
            prop_assert!(!out.contains(".."));
            prop_assert!(!out.contains('\\'));
            prop_assert!(!out.contains(':'));
            prop_assert!(!out.chars().any(char::is_control));
        }
    }
}

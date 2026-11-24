use super::*;
use proptest::prelude::*;

fn tags_of(text: &str) -> Vec<String> {
    parse_note(text).tags
}

#[test]
fn wikilink_forms() {
    let idx = parse_note(
        "[[Plan]] [[Plan#Cele]] [[Plan#^z-1]] [[Plan|Mapa]] ![[Obraz]]\n[[Plan#Cele|x]]",
    );
    let l = &idx.links;
    assert_eq!(l.len(), 6);
    assert_eq!(
        l[0],
        Link {
            target: "Plan".into(),
            heading: None,
            block: None,
            alias: None,
            embed: false,
            md: false,
            line: 1
        }
    );
    assert_eq!(l[1].heading.as_deref(), Some("Cele"));
    assert_eq!(l[2].block.as_deref(), Some("z-1"));
    assert_eq!(l[2].heading, None);
    assert_eq!(l[3].alias.as_deref(), Some("Mapa"));
    assert!(l[4].embed);
    assert_eq!(l[4].target, "Obraz");
    assert_eq!(l[5].line, 2);
    assert_eq!(l[5].alias.as_deref(), Some("x"));
}

#[test]
fn markdown_links_to_notes_only() {
    let idx = parse_note(
        "[x](Projekty/Plan%20A.md) [y](https://example.com/a.md) [z](pic.png) [w](Plan.md#Cele)\n[m](mailto:a@b.md)",
    );
    let targets: Vec<(&str, Option<&str>)> = idx
        .links
        .iter()
        .map(|l| (l.target.as_str(), l.heading.as_deref()))
        .collect();
    assert_eq!(
        targets,
        vec![("Projekty/Plan A.md", None), ("Plan.md", Some("Cele"))]
    );
    assert_eq!(idx.links[0].line, 1);
}

#[test]
fn links_and_tags_in_code_are_ignored() {
    let text = "`[[Nope]] #nope`\n\n```\n[[Nope2]] #nope2 - [ ] ukryte\n```\n\n    [[Nope3]]\n\n[[Yes]] #yes";
    let idx = parse_note(text);
    assert_eq!(idx.links.len(), 1);
    assert_eq!(idx.links[0].target, "Yes");
    assert_eq!(idx.tags, vec!["yes"]);
    assert!(idx.tasks.is_empty());
}

#[test]
fn nested_and_yaml_tags() {
    let text = "---\ntitle: X\ntags: [Projekt, Marketing/Kampania]\n---\n# Tytul\n\nTekst #praca/pilne #Praca #2026 #2026-10 #123 #zażółć\n";
    let idx = parse_note(text);
    assert_eq!(
        idx.tags,
        vec![
            "projekt",
            "marketing/kampania",
            "praca/pilne",
            "praca",
            "2026-10",
            "zażółć"
        ]
    );
    assert_eq!(
        idx.headings,
        vec![Heading {
            level: 1,
            text: "Tytul".into(),
            line: 5
        }]
    );
}

#[test]
fn yaml_tag_list_form() {
    let text = "---\ntags:\n  - \"#a\"\n  - b\nkey: v\n---\nbody";
    assert_eq!(tags_of(text), vec!["a", "b"]);
    assert_eq!(tags_of("---\ntags: c, d\n---\n"), vec!["c", "d"]);
    // Unclosed front matter is not front matter, so its `tags:` line is plain text.
    assert!(tags_of("---\ntags: [x]\n").is_empty());
}

#[test]
fn url_fragment_and_bare_numbers_are_not_tags() {
    let idx = parse_note("https://ex.com/a#frag and [t](ex.md#sec) #123 a#b\n# Naglowek\n#real");
    assert_eq!(idx.tags, vec!["real"]);
    assert_eq!(idx.headings.len(), 1);
}

#[test]
fn headings_and_blocks() {
    let idx = parse_note("# A\n## B *x*\nakapit ^blk-1\n- lista ^z-2\n```\nkod ^nie\n```\n");
    assert_eq!(
        idx.headings[1],
        Heading {
            level: 2,
            text: "B x".into(),
            line: 2
        }
    );
    assert_eq!(
        idx.blocks,
        vec![("blk-1".to_string(), 3), ("z-2".to_string(), 4)]
    );
}

#[test]
fn tasks_with_all_metadata() {
    let text = "## Kampania\n\n- [ ] Przygotować plakat @Ania 📅 2026-10-30 ^z-7f3a\n    - [ ] Zebrać oferty @Cezary ^z-a410\n- [x] Wybrać hasło @Ania ✅ 2026-10-18 ^z-0b77\n- [ ] Zatwierdzić budżet @Bartek 📅 2026-10-25 ⏫ ^z-91c2\n* [X] Gwiazdka 🔽 #tag\n+ [ ] Plus 🔼\n1. [ ] Numer @Łukasz.K\n- [ ] Zwykła lista\n- Bez pudełka\n";
    let idx = parse_note(text);
    let t = &idx.tasks;
    assert_eq!(t.len(), 8);
    let day = |y, m, d| crate::formula::date::parse_iso(&format!("{y:04}-{m:02}-{d:02}")).unwrap();
    assert_eq!(
        t[0],
        Task {
            line: 3,
            depth: 0,
            done: false,
            text: "Przygotować plakat".into(),
            assignees: vec!["Ania".into()],
            groups: vec![],
            supervisor: None,
            difficulty: None,
            due: Some(day(2026, 10, 30)),
            done_on: None,
            priority: None,
            id: Some("z-7f3a".into()),
            reminder: None,
            stage: None,
        }
    );
    assert_eq!(t[1].depth, 1);
    assert_eq!(t[1].text, "Zebrać oferty");
    assert!(t[2].done);
    assert_eq!(t[2].done_on, Some(day(2026, 10, 18)));
    assert_eq!(t[3].priority, Some(Priority::High));
    assert_eq!(t[3].due, Some(day(2026, 10, 25)));
    assert_eq!(t[4].priority, Some(Priority::Low));
    assert!(t[4].done);
    assert_eq!(t[4].text, "Gwiazdka #tag");
    assert_eq!(t[5].priority, Some(Priority::Medium));
    assert_eq!(t[5].line, 8);
    assert_eq!(t[6].assignees, vec!["Łukasz.K"]);
    assert_eq!(idx.blocks.len(), 4);
}

#[test]
fn polish_handles_and_bad_dates() {
    let idx = parse_note("- [ ] Sprawdzić @Łukasz 📅 2026-02-30 @ x");
    let t = &idx.tasks[0];
    assert_eq!(t.assignees, vec!["Łukasz"]);
    assert_eq!(t.due, None);
    assert_eq!(t.text, "Sprawdzić 📅 2026-02-30 @ x");
}

#[test]
fn tasks_in_code_are_ignored() {
    let idx = parse_note("```\n- [ ] nie\n```\n`- [ ] nie`\n> - [ ] w cytacie\n");
    assert_eq!(idx.tasks.len(), 1);
    assert_eq!(idx.tasks[0].text, "w cytacie");
}

#[test]
fn never_panics_on_odd_input() {
    for text in [
        "", "---", "---\n", "[[", "]]", "![[", "#", "^", "- [ ]", "[x](%", "[[|]]", "📅", "@",
    ] {
        let _ = parse_note(text);
    }
}

#[test]
fn table_escape_does_not_leak_into_heading() {
    let l = &parse_note(r"| [[x#H\|al]] |").links;
    assert_eq!(l[0].target, "x");
    assert_eq!(l[0].heading.as_deref(), Some("H"));
    assert_eq!(l[0].alias.as_deref(), Some("al"));
}

#[test]
fn assignee_drops_trailing_punctuation() {
    let t = parse_note("- [ ] A @Ola.\n- [ ] B @jan,\n- [ ] C @Ania.K\n- [ ] D jan@example.test\n").tasks;
    assert_eq!(t[0].assignees, vec!["Ola"]);
    assert_eq!(t[1].assignees, vec!["jan"]);
    assert_eq!(t[2].assignees, vec!["Ania.K"]);
    assert!(t[3].assignees.is_empty());
}

/// shortcut-regression: wikilink scanning used to be quadratic on unclosed `[[`.
#[test]
fn unclosed_wikilink_openers_are_linear() {
    for text in [
        "[[".repeat(200_000),
        "[[".repeat(200_000) + "]]",
        "[[\n".repeat(133_334),
    ] {
        let start = std::time::Instant::now();
        assert!(parse_note(&text).links.is_empty());
        let took = start.elapsed();
        assert!(took.as_millis() < 200, "took {took:?}");
    }
}

#[test]
fn note_is_indexed_only_up_to_512_kib() {
    let text = format!("{}# Koniec\n", "x [[a]] ".repeat(280_000));
    let start = std::time::Instant::now();
    let idx = parse_note(&text);
    let took = start.elapsed();
    assert_eq!(idx.links.len(), 65_536);
    assert!(idx.headings.is_empty());
    assert!(took.as_secs_f64() < 1.0, "took {took:?}");
}

proptest! {
    #[test]
    fn parse_note_never_panics(text in any::<String>()) {
        let _ = parse_note(&text);
    }

    #[test]
    fn parse_note_never_panics_on_markup(text in r"[\[\]\(\)#@^!|`~*\-+ \n\ta-z0-9📅⏫✅/%.:---]{0,200}") {
        let idx = parse_note(&text);
        for t in &idx.tasks {
            prop_assert!(t.line >= 1);
        }
    }
}

#[test]
fn front_matter_properties_are_read_without_empty_values() {
    let idx = parse_note("---\ntyp: projekt\nstatus: \"aktywny\"\nprowadzacy:\ntags: [a]\n---\n# X\n");
    assert!(idx.props.contains(&("typ".into(), "projekt".into())));
    assert!(idx.props.contains(&("status".into(), "aktywny".into())));
    assert!(!idx.props.iter().any(|(k, _)| k == "prowadzacy"));
    assert_eq!(idx.tags, vec!["a"]);
}

#[test]
fn supervisor_and_difficulty_tokens() {
    let t = &parse_note("- [ ] Przygotować schemat elektroniki @Jan 📅 2026-11-05 !nadzor:@Stanisław !trudnosc:8 ^z-7f3a\n").tasks[0];
    assert_eq!(t.text, "Przygotować schemat elektroniki");
    assert_eq!(t.assignees, vec!["Jan"]);
    assert_eq!(t.supervisor.as_deref(), Some("Stanisław"));
    assert_eq!(t.difficulty, Some(8));
    assert_eq!(t.id.as_deref(), Some("z-7f3a"));
    assert_eq!(t.due, crate::formula::date::parse_iso("2026-11-05"));
}

#[test]
fn organization_group_is_task_metadata() {
    let t = &parse_note("- [ ] Wdrożenie !grupa:team-123 ^z-7f3a\n").tasks[0];
    assert_eq!(t.text, "Wdrożenie");
    assert_eq!(t.groups, vec!["team-123"]);
}

#[test]
fn difficulty_zero_is_rated_and_missing_is_unrated() {
    let idx = parse_note("- [ ] Zero !trudnosc:0\n- [ ] Brak\n- [ ] Dziesięć !trudnosc:10\n");
    assert_eq!(idx.tasks[0].difficulty, Some(0));
    assert_eq!(idx.tasks[1].difficulty, None);
    assert_eq!(idx.tasks[2].difficulty, Some(10));
    assert!(idx.warnings.is_empty());
}

#[test]
fn out_of_range_difficulty_is_unrated_with_a_warning() {
    for bad in ["11", "-1", "+5", "1.5", "", "300", "osiem"] {
        let idx = parse_note(&format!("- [ ] Zadanie !trudnosc:{bad}\n"));
        assert_eq!(idx.tasks[0].difficulty, None, "{bad}");
        assert_eq!(idx.tasks[0].text, "Zadanie", "{bad}");
        assert_eq!(idx.warnings.len(), 1, "{bad}");
        assert_eq!(idx.warnings[0].line, 1);
    }
}

#[test]
fn reminder_token_grammar() {
    let rem = |text: &str| parse_note(&format!("- [ ] Zadanie {text}\n")).tasks[0].reminder.clone();
    assert_eq!(rem("!przypomnij:1d"), Some(Reminder { before_min: 1440, every_min: None, count: 1 }));
    assert_eq!(rem("!przypomnij:2h/30mx3"), Some(Reminder { before_min: 120, every_min: Some(30), count: 3 }));
    assert_eq!(rem("!przypomnij:45m/5m"), Some(Reminder { before_min: 45, every_min: Some(5), count: 1 }));
    assert_eq!(rem("!przypomnij:999m x20"), Some(Reminder { before_min: 999, every_min: None, count: 1 }), "a space ends the token");
    assert_eq!(rem("!przypomnij:999mx20"), Some(Reminder { before_min: 999, every_min: None, count: 20 }));
    assert_eq!(rem("!przypomnij:1h/1mx03"), Some(Reminder { before_min: 60, every_min: Some(1), count: 3 }));
}

#[test]
fn invalid_reminder_is_unset_with_a_warning() {
    for bad in ["", "1", "0d", "1000m", "1w", "+1d", "1.5h", "1dx0", "1dx21", "1dx", "1d/", "/1h", "1h/2hx3x", "osiem"] {
        let idx = parse_note(&format!("- [ ] Zadanie !przypomnij:{bad}\n"));
        assert_eq!(idx.tasks[0].reminder, None, "{bad}");
        assert_eq!(idx.tasks[0].text, "Zadanie", "{bad}");
        assert_eq!(idx.warnings.len(), 1, "{bad}");
        assert_eq!(idx.warnings[0].line, 1);
    }
}

#[test]
fn tokens_work_in_any_order() {
    let a = &parse_note("- [ ] Plan !trudnosc:3 !nadzor:@Anna @Jan 📅 2026-11-05 ⏫ ^z-1\n").tasks[0];
    let b = &parse_note("- [ ] Plan ^z-1 ⏫ 📅 2026-11-05 @Jan !nadzor:@Anna !trudnosc:3\n").tasks[0];
    assert_eq!(a.text, "Plan");
    assert_eq!(a, b);
}

#[test]
fn a_bare_supervisor_marker_is_text() {
    let t = &parse_note("- [ ] Ogłoś !nadzor:@ !nadzor:\n").tasks[0];
    assert_eq!(t.supervisor, None);
    assert_eq!(t.text, "Ogłoś !nadzor:@ !nadzor:");
}

#[test]
fn line_tokens_follow_the_note_parser() {
    use super::{TokenKind, line_task};
    let kinds = |line: &str| -> Vec<(TokenKind, String)> {
        let t = line_task(line).expect("a task");
        t.tokens.into_iter().map(|k| (k.kind, line[k.start..k.end].to_string())).collect()
    };
    // a date needs a valid date after the marker: `jutro` stays title text
    assert_eq!(kinds("- [ ] Spotkanie 📅 jutro rano"), vec![]);
    assert_eq!(line_task("- [ ] Spotkanie 📅 jutro rano").unwrap().text, "Spotkanie 📅 jutro rano");
    // `@a/b` is not a handle: title text, as in the note
    assert_eq!(kinds("- [ ] Pisz @a/b"), vec![]);
    // every `@` word is an assignee, in order
    assert_eq!(
        kinds("- [ ] Plan @Jan @Piotr"),
        vec![
            (TokenKind::Assignee("Jan".into()), "@Jan".to_string()),
            (TokenKind::Assignee("Piotr".into()), "@Piotr".to_string()),
        ]
    );
    // a tab before a token is a separator, as in the note
    assert_eq!(kinds("- [ ]\tY\t@Jan"), vec![(TokenKind::Assignee("Jan".into()), "@Jan".to_string())]);
    // leading zeros read as the number, and a trailing dot is not part of the handle
    assert_eq!(kinds("- [ ] x !trudnosc:08"), vec![(TokenKind::Difficulty(Some(8)), "!trudnosc:08".to_string())]);
    assert_eq!(kinds("- [ ] x @Ola."), vec![(TokenKind::Assignee("Ola".into()), "@Ola.".to_string())]);
    // a quoted task is a task
    let quoted = line_task("> - [ ] cytat @Jan").expect("a quoted task");
    assert_eq!(quoted.text, "cytat");
    assert_eq!(quoted.tokens.len(), 1);
    // a line that is not a task
    assert!(line_task("Zwykły tekst @Jan").is_none());
}

#[test]
fn a_star_marks_a_task_important_like_the_high_priority_mark() {
    let tasks = parse_note("- [ ] Ważne ⭐ ^z-1\n- [ ] Pilne ⏫\n- [ ] Zwykłe\n").tasks;
    assert_eq!(tasks.iter().map(|t| t.priority).collect::<Vec<_>>(), [Some(Priority::High), Some(Priority::High), None]);
    assert_eq!(tasks[0].text, "Ważne");
}

#[test]
fn board_stage_token() {
    use super::{TokenKind, line_task};
    let t = &parse_note("- [ ] Szkic @Ola !etap:W_toku ^z-1\n- [ ] Bez etapu\n- [ ] Dziwny !etap:a.b !etap:\n- [ ] Pomysł !etap:Pomysły\n").tasks;
    assert_eq!(t[0].stage.as_deref(), Some("W toku"));
    assert_eq!(t[0].text, "Szkic");
    assert_eq!(t[0].id.as_deref(), Some("z-1"));
    assert_eq!(t[1].stage, None);
    // a token with a dot or no name is an ordinary word
    assert_eq!(t[2].stage, None);
    assert_eq!(t[2].text, "Dziwny !etap:a.b !etap:");
    assert_eq!(t[3].stage.as_deref(), Some("Pomysły"));
    let tokens = line_task("- [ ] x !etap:Gotowe").expect("a task").tokens;
    assert_eq!(tokens[0].kind, TokenKind::Stage("Gotowe".into()));
}

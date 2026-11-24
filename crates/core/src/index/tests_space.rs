use super::*;
use crate::NoteId;

fn id(s: &str) -> NoteId {
    s.to_string()
}

fn targets(idx: &SpaceIndex, from: &str) -> Vec<Option<String>> {
    idx.outgoing(&id(from))
        .into_iter()
        .map(|r| r.target)
        .collect()
}

fn sources(idx: &SpaceIndex, to: &str) -> Vec<String> {
    idx.backlinks(&id(to)).into_iter().map(|(s, _)| s).collect()
}

#[test]
fn resolves_exact_path_then_basename() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("a"), "Projekty/Plan.md", "");
    idx.upsert(id("b"), "Notatki/Plan.md", "");
    idx.upsert(
        id("c"),
        "Zakupy.md",
        "[[Plan]] [[Projekty/Plan]] [[notatki/plan.md]] [[zakupy]] [[Brak]]",
    );
    assert_eq!(
        targets(&idx, "c"),
        vec![
            Some(id("b")),
            Some(id("a")),
            Some(id("b")),
            Some(id("c")),
            None
        ]
    );
}

#[test]
fn duplicate_basenames_pick_shortest_path_deterministically() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("long"), "A/B/Plan.md", "");
    idx.upsert(id("short"), "Z/Plan.md", "");
    idx.upsert(id("root"), "Plan.md", "");
    idx.upsert(id("src"), "src.md", "[[Plan]]");
    assert_eq!(targets(&idx, "src"), vec![Some(id("root"))]);
    idx.remove(&id("root"));
    assert_eq!(targets(&idx, "src"), vec![Some(id("short"))]);
    idx.remove(&id("short"));
    assert_eq!(targets(&idx, "src"), vec![Some(id("long"))]);
}

#[test]
fn same_length_paths_use_lexicographic_order() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("x"), "b/Plan.md", "");
    idx.upsert(id("y"), "a/Plan.md", "");
    idx.upsert(id("src"), "s.md", "[[plan]]");
    assert_eq!(targets(&idx, "src"), vec![Some(id("y"))]);
}

#[test]
fn path_suffix_and_case_insensitive() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("p"), "Marketing/Kampania/Plan.md", "");
    idx.upsert(
        id("src"),
        "s.md",
        "[[KAMPANIA/plan]] [[marketing/plan]] [[Marketing/Kampania/PLAN.md]]",
    );
    assert_eq!(
        targets(&idx, "src"),
        vec![Some(id("p")), None, Some(id("p"))]
    );
}

#[test]
fn incremental_rename_and_remove_keep_backlinks() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("plan"), "Plan.md", "");
    idx.upsert(id("s1"), "s1.md", "[[Plan]]");
    idx.upsert(id("s2"), "s2.md", "[[Plan#Cele]] [[Nowy]]");
    assert_eq!(sources(&idx, "plan"), vec!["s1", "s2"]);

    idx.rename(&id("plan"), "Archiwum/Plan.md");
    assert_eq!(sources(&idx, "plan"), vec!["s1", "s2"]);

    // "Plan" no longer matches, but "[[Nowy]]" in s2 now does.
    idx.rename(&id("plan"), "Nowy.md");
    assert_eq!(sources(&idx, "plan"), vec!["s2"]);
}

#[test]
fn rename_to_link_target_name_resolves_ghosts() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("s"), "s.md", "[[Nowy]]");
    assert_eq!(targets(&idx, "s"), vec![None]);
    idx.upsert(id("n"), "Folder/Nowy.md", "");
    assert_eq!(targets(&idx, "s"), vec![Some(id("n"))]);
    assert_eq!(sources(&idx, "n"), vec!["s"]);
    idx.rename(&id("n"), "Folder/Inny.md");
    assert_eq!(targets(&idx, "s"), vec![None]);
    assert!(sources(&idx, "n").is_empty());
}

#[test]
fn remove_turns_links_into_ghosts_and_drops_outgoing() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("plan"), "Plan.md", "[[s]]");
    idx.upsert(id("s"), "s.md", "[[Plan]]");
    idx.remove(&id("plan"));
    assert_eq!(targets(&idx, "s"), vec![None]);
    assert_eq!(idx.unresolved(), vec![("Plan".to_string(), vec![id("s")])]);
    assert!(idx.outgoing(&id("plan")).is_empty());
    assert!(idx.backlinks(&id("s")).is_empty());
}

#[test]
fn upsert_replaces_links_of_a_note() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("a"), "A.md", "[[B]]");
    idx.upsert(id("b"), "B.md", "");
    assert_eq!(sources(&idx, "b"), vec!["a"]);
    idx.upsert(id("a"), "A.md", "[[C]]");
    assert!(sources(&idx, "b").is_empty());
    assert_eq!(idx.unresolved(), vec![("C".to_string(), vec![id("a")])]);
}

#[test]
fn ghost_link_resolves_when_note_appears() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("s1"), "s1.md", "[[Cel]]");
    idx.upsert(id("s2"), "s2.md", "[[cel]]");
    assert_eq!(
        idx.unresolved(),
        vec![("Cel".to_string(), vec![id("s1"), id("s2")])]
    );
    idx.upsert(id("cel"), "Cel.md", "");
    assert!(idx.unresolved().is_empty());
    assert_eq!(sources(&idx, "cel"), vec!["s1", "s2"]);
}

#[test]
fn graph_is_deduplicated_without_self_loops() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("a"), "a.md", "[[a]] [[b]] [[b#H]] [[B|alias]] [[ghost]]");
    idx.upsert(id("b"), "b.md", "[[a]]");
    let (nodes, edges) = idx.graph();
    assert_eq!(nodes, vec![id("a"), id("b")]);
    assert_eq!(edges, vec![(id("a"), id("b")), (id("b"), id("a"))]);
}

#[test]
fn tags_count_parents_and_match_children() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("a"), "a.md", "#a/b #a/c/d");
    idx.upsert(id("b"), "b.md", "#a");
    assert_eq!(
        idx.tags(),
        vec![
            ("a".to_string(), 2),
            ("a/b".to_string(), 1),
            ("a/c".to_string(), 1),
            ("a/c/d".to_string(), 1)
        ]
    );
    assert_eq!(idx.notes_with_tag("a"), vec![id("a"), id("b")]);
    assert_eq!(idx.notes_with_tag("#A/C"), vec![id("a")]);
    assert!(idx.notes_with_tag("ab").is_empty());
}

#[test]
fn headings_are_per_note() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("a"), "a.md", "# Start\n## Dalej");
    assert_eq!(idx.headings(&id("a")).len(), 2);
    assert!(idx.headings(&id("missing")).is_empty());
}

#[test]
fn task_queries() {
    let mut idx = SpaceIndex::default();
    idx.upsert(
        id("p1"),
        "Marketing/Kampania.md",
        "- [ ] A @Ania 📅 2026-10-30\n- [x] B @Bartek 📅 2026-10-10\n",
    );
    idx.upsert(id("p2"), "Marketing2/X.md", "- [ ] C @ania 📅 2026-10-01\n");
    idx.upsert(
        id("p3"),
        "Marketing/Strona/S.md",
        "- [ ] D @Ania\n- [ ] E @Ania 📅 2026-11-20\n",
    );

    let all =
        |q: TaskQuery| -> Vec<String> { idx.tasks(&q).into_iter().map(|(_, t)| t.text).collect() };
    assert_eq!(all(TaskQuery::default()), vec!["C", "B", "A", "E", "D"]);
    assert_eq!(
        all(TaskQuery {
            assignee: Some("ANIA".into()),
            ..Default::default()
        }),
        vec!["C", "A", "E", "D"]
    );
    assert_eq!(
        all(TaskQuery {
            done: Some(true),
            ..Default::default()
        }),
        vec!["B"]
    );
    assert_eq!(
        all(TaskQuery {
            done: Some(false),
            due_after: Some(0),
            ..Default::default()
        }),
        vec!["C", "A", "E"]
    );
    let day = |s: &str| crate::formula::date::parse_iso(s).unwrap();
    assert_eq!(
        all(TaskQuery {
            due_before: Some(day("2026-10-30")),
            due_after: Some(day("2026-10-05")),
            ..Default::default()
        }),
        vec!["B", "A"]
    );
    assert_eq!(
        all(TaskQuery {
            path_prefix: Some("Marketing".into()),
            ..Default::default()
        }),
        vec!["B", "A", "E", "D"]
    );
    assert_eq!(
        all(TaskQuery {
            path_prefix: Some("Marketing/".into()),
            ..Default::default()
        }),
        vec!["B", "A", "E", "D"]
    );
    let found = idx.tasks(&TaskQuery {
        assignee: Some("bartek".into()),
        ..Default::default()
    });
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0, id("p1"));
    assert_eq!(found[0].1.line, 2);
}

#[test]
fn relative_md_links_resolve_from_the_note_folder() {
    let mut idx = SpaceIndex::default();
    idx.upsert(
        id("a"),
        "Folder/a.md",
        "[u](c.md) [t](../Inne/c.md) [x](../../c.md)",
    );
    idx.upsert(id("root"), "c.md", "");
    idx.upsert(id("inne"), "Inne/c.md", "");
    assert_eq!(
        targets(&idx, "a"),
        vec![Some(id("root")), Some(id("inne")), None]
    );
    idx.upsert(id("fc"), "Folder/c.md", "");
    assert_eq!(targets(&idx, "a")[0], Some(id("fc")));
    idx.rename(&id("fc"), "Other/c.md");
    assert_eq!(targets(&idx, "a")[0], Some(id("root")));
}

#[test]
fn relative_link_follows_renames_of_target_and_source() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("a"), "Folder/a.md", "[u](c.md) [t](../Inne/c.md)");
    assert_eq!(targets(&idx, "a"), vec![None, None]);
    idx.upsert(id("c"), "Folder/Sub/c.md", "");
    assert_eq!(targets(&idx, "a"), vec![Some(id("c")), None]);
    idx.rename(&id("c"), "Inne/c.md");
    assert_eq!(targets(&idx, "a"), vec![Some(id("c")), Some(id("c"))]);
    // Moving the source to the root makes `../` climb above the root: ghost.
    idx.rename(&id("a"), "a.md");
    assert_eq!(targets(&idx, "a"), vec![Some(id("c")), None]);
    idx.remove(&id("c"));
    assert_eq!(targets(&idx, "a"), vec![None, None]);
}

#[test]
fn path_prefix_is_case_insensitive_and_folder_based() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("p"), "Marketing/Plan.md", "- [ ] A\n");
    idx.upsert(id("q"), "market.md", "- [ ] B\n");
    let found = |prefix: &str| -> Vec<String> {
        let q = TaskQuery {
            path_prefix: Some(prefix.into()),
            ..Default::default()
        };
        idx.tasks(&q).into_iter().map(|(_, t)| t.text).collect()
    };
    assert_eq!(found("MARKETING"), vec!["A"]);
    assert!(found("market").is_empty());
}

/// Release only:`cargo test --release -p notes-core index -- --ignored --nocapture`.
#[test]
#[ignore]
fn perf_build_10k_notes_with_10_links() {
    let start = std::time::Instant::now();
    let mut idx = SpaceIndex::default();
    for n in 0..10_000 {
        let text: String = (0..10)
            .map(|k| format!("[[n{}]] ", (n * 7 + k * 13) % 10_000))
            .collect();
        idx.upsert(format!("id{n}"), &format!("dir{}/n{n}.md", n % 50), &text);
    }
    let build = start.elapsed();
    let bl = std::time::Instant::now();
    let mut total = 0;
    for n in 0..10_000 {
        total += idx.backlinks(&format!("id{n}")).len();
    }
    let back = bl.elapsed();
    println!(
        "build 10k notes x 10 links: {build:?}; backlinks for all 10k notes: {back:?}; inbound total {total}"
    );
    assert!(build.as_secs_f64() < 1.0, "build took {build:?}");
    assert_eq!(total, 100_000);
}

#[test]
fn explicit_relative_links_never_jump_to_unrelated_notes() {
    let mut idx = SpaceIndex::default();
    idx.upsert(
        id("a"),
        "Folder/Sub/a.md",
        "[d](../c.md) [e](./c.md) [v](Inne/c.md) [b](c.md) [n](../Nope/c.md)",
    );
    idx.upsert(id("inne"), "Inne/c.md", "");
    // `../` and `./` mean "next to this note": no Folder/c.md or Folder/Sub/c.md, so ghosts.
    // A vault-root path and a bare name still find Inne/c.md, as in Obsidian.
    assert_eq!(
        targets(&idx, "a"),
        vec![None, None, Some(id("inne")), Some(id("inne")), None]
    );
    idx.upsert(id("fc"), "Folder/c.md", "");
    assert_eq!(targets(&idx, "a")[0], Some(id("fc")));
}

#[test]
fn note_returns_path_and_index() {
    let mut idx = SpaceIndex::default();
    idx.upsert(id("a"), "Dir/A.md", "#x/y #z\n# Tytuł");
    let (path, index) = idx.note(&id("a")).expect("indexed note");
    assert_eq!(path, "Dir/A.md");
    assert_eq!(index.tags, vec!["x/y".to_string(), "z".to_string()]);
    assert_eq!(index.headings[0].text, "Tytuł");
    assert!(idx.note(&id("missing")).is_none());
}

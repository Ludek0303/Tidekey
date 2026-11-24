use super::graph::{Edge, EdgeKind, NodeKind};
use super::{Kind, SearchIndex};

const FID: &str = "0123456789abcdef0123456789abcdef";

fn has(g: &super::graph::Graph, from: &str, to: &str, kind: EdgeKind) -> bool {
    g.edges.contains(&Edge { from: from.into(), to: to.into(), kind })
}

fn mentions_of(g: &super::graph::Graph, from: &str) -> Vec<String> {
    g.edges.iter().filter(|e| e.kind == EdgeKind::Mention && e.from == from).map(|e| e.to.clone()).collect()
}

fn corpus() -> SearchIndex {
    let mut idx = SearchIndex::new();
    idx.upsert_note("a", "Projekty/Triton/Triton.md", &format!(
        "---\ntags: [projekt, serwer/dane]\n---\n# Triton\nRozmowa: kawa i ciastka. Plik: ![[plik:{FID}#0a1b2c3d|300]]\n- [ ] Wysłać ofertę @anna\n"));
    idx.upsert_note("b", "Projekty/Kawa.md", "# Kawa\nNotatka o kawie.\n");
    idx.upsert_note("c", "Inne/Ola.md", "Ola to trzy znaki.\n");
    idx.upsert_note("d", "Inne/Żółw.md", "# Zolw\nTekst bez tytułu.\n");
    idx.upsert_note("e", "Inne/Kawalerka.md", "Kawalerka w Krakowie. Kawa w Kawalerce nie wystąpi jako tytuł.\n");
    idx.upsert_note("f", "Osoby/Spotkanie.md", "---\nosoby: [Piotr, @Anna]\n---\nSpotkanie z Piotrem. Anna prowadzi.\n");
    idx.upsert_file_text(FID, "Faktura.pdf", "application/pdf", "---\nschema: notes-filetext-v1\n---\n## Strona 1\nKawa na fakturze.\n").expect("layer");
    idx
}

#[test]
fn tag_folder_person_and_embed_edges() {
    let idx = corpus();
    let g = idx.build_graph(None);
    assert!(has(&g, "n:a", "t:projekt", EdgeKind::Tag));
    assert!(has(&g, "n:a", "t:serwer/dane", EdgeKind::Tag));
    assert!(has(&g, "n:a", "d:Projekty/Triton", EdgeKind::In));
    assert!(has(&g, "n:a", "p:anna", EdgeKind::Assigned));
    assert!(has(&g, "n:f", "p:piotr", EdgeKind::Assigned), "osoby: list");
    assert!(has(&g, "n:f", "p:anna", EdgeKind::Assigned), "osoby: with @");
    assert!(has(&g, "n:a", &format!("f:{FID}"), EdgeKind::Embed));
    assert_eq!(g.nodes[&format!("f:{FID}")].label, "Faktura.pdf");
    assert_eq!(g.nodes["n:a"].label, "Projekty/Triton/Triton.md");
}

#[test]
fn link_edges_come_from_set_links_and_need_both_ends() {
    let mut idx = corpus();
    idx.set_links("a", &["b".to_string(), "nie-ma".to_string()]);
    let g = idx.build_graph(None);
    assert!(has(&g, "n:a", "n:b", EdgeKind::Link));
    assert!(!g.edges.iter().any(|e| e.to == "n:nie-ma"));
}

#[test]
fn mention_of_a_note_title_needs_whole_words_and_folded_diacritics() {
    let idx = corpus();
    let g = idx.build_graph(None);
    // "Kawa" in a, e (as a word), f-file; "Kawalerka" is a word of its own, not Kawa.
    assert!(has(&g, "n:a", "n:b", EdgeKind::Mention));
    assert!(has(&g, &format!("f:{FID}"), "n:b", EdgeKind::Mention));
    assert!(has(&g, "n:e", "n:b", EdgeKind::Mention));
    assert!(!has(&g, "n:b", "n:e", EdgeKind::Mention), "Kawalerka is not a mention of e's title in b");
    // "Żółw" (note d) is named as "Zolw" in its own text only, so no mention from elsewhere; the title is searched folded.
    let idx2 = {
        let mut i = SearchIndex::new();
        i.upsert_note("z", "Zwierzeta/Żółw.md", "# Gady\nZolw w ogrodzie.\n");
        i.upsert_note("y", "Inne/Lista.md", "Gustaw to zółw.\n");
        i
    };
    let g2 = idx2.build_graph(None);
    assert!(has(&g2, "n:y", "n:z", EdgeKind::Mention), "diacritics folded both ways");
}

#[test]
fn short_titles_are_not_mentioned_and_titles_are_not_self_mentions() {
    let idx = corpus();
    let g = idx.build_graph(None);
    assert!(!g.edges.iter().any(|e| e.to == "n:c"), "Ola has 3 characters, below the minimum of 4");
    assert!(!has(&g, "n:b", "n:b", EdgeKind::Mention), "no self mention");
    assert!(!mentions_of(&g, "n:b").contains(&"n:b".to_string()));
}

#[test]
fn linked_notes_are_not_counted_as_mentions() {
    let mut idx = corpus();
    idx.set_links("a", &["b".to_string()]);
    let g = idx.build_graph(None);
    assert!(has(&g, "n:a", "n:b", EdgeKind::Link));
    assert!(!has(&g, "n:a", "n:b", EdgeKind::Mention), "a links to b, so its word Kawa is not a mention");
    assert!(has(&g, &format!("f:{FID}"), "n:b", EdgeKind::Mention), "the file does not link to b");
}

#[test]
fn persons_are_mentioned_once_known_from_tasks_or_set_people() {
    let mut idx = corpus();
    idx.upsert_note("g", "Inne/Notatka.md", "Dzisiaj rozmawiałem z Anna i z Piotr.\n");
    let g = idx.build_graph(None);
    assert!(has(&g, "n:g", "p:anna", EdgeKind::Mention));
    assert!(has(&g, "n:g", "p:piotr", EdgeKind::Mention));
    idx.set_people(&["Marek".to_string()]);
    idx.upsert_note("h", "Inne/Cos.md", "Marek przyjdzie jutro.\n");
    assert!(has(&idx.build_graph(None), "n:h", "p:marek", EdgeKind::Mention));
}

#[test]
fn at_most_twenty_mentions_strongest_first() {
    let mut idx = SearchIndex::new();
    for i in 0..25 {
        idx.upsert_note(&format!("t{i}"), &format!("Tematy/Temat{i:02}.md"), "tekst\n");
    }
    let mut text = String::new();
    for i in 0..25 {
        for _ in 0..(if i == 24 { 5 } else { 1 }) {
            text.push_str(&format!("temat{i:02} "));
        }
    }
    idx.upsert_note("src", "Zrodla/Zrodlo.md", &text);
    let g = idx.build_graph(None);
    let m = mentions_of(&g, "n:src");
    assert_eq!(m.len(), 20);
    assert_eq!(m[0], "n:t24", "five occurrences come first");
}

#[test]
fn files_mention_notes_and_notes_do_not_need_files() {
    let idx = corpus();
    let g = idx.build_graph(None);
    assert_eq!(g.nodes[&format!("f:{FID}")].kind, super::graph::NodeKind::File);
    assert!(idx.search("kawie", 5, 0, None).total >= 1);
    let kinds: Vec<Kind> = idx.search("faktura", 5, 0, None).hits.iter().map(|h| h.kind).collect();
    assert!(kinds.iter().all(|k| *k == Kind::File));
}

#[test]
fn neighbors_filter_by_type_and_depth() {
    let idx = corpus();
    let all = idx.neighbors("n:a", 1, None, 30, None).expect("note a");
    assert!(all.nodes.iter().any(|n| n.id == "t:projekt"));
    let only_tags = idx.neighbors("n:a", 1, Some(&[EdgeKind::Tag]), 30, None).expect("note a");
    assert!(only_tags.edges.iter().all(|e| e.kind == EdgeKind::Tag));
    let two = idx.neighbors("n:a", 2, None, 100, None).expect("note a");
    assert!(two.nodes.iter().any(|n| n.id == "n:e"), "a - b - e through the mention of Kawa");
    assert!(idx.neighbors("n:nie", 1, None, 30, None).is_none());
    let capped = idx.neighbors("n:a", 2, None, 2, None).expect("note a");
    assert!(capped.nodes.len() <= 3 && capped.truncated);
}

#[test]
fn map_overview_counts_and_limits() {
    let idx = corpus();
    let m = idx.map_overview(None);
    assert_eq!(m.files_total, 1);
    assert_eq!(m.files_with_text, 1);
    assert!(m.folders.iter().any(|(p, n)| p == "Projekty/Triton" && *n == 1));
    assert!(m.top_tags.iter().any(|(t, _)| t == "projekt"));
    assert!(m.people.iter().any(|(p, _)| p == "anna"));
    assert!(m.hubs.len() <= 10);
    assert!(m.top_tags.len() <= 20 && m.people.len() <= 20);
}

#[test]
fn edges_of_the_chosen_kinds_with_their_ends() {
    let idx = corpus();
    let e = idx.edges(Some(&[EdgeKind::Embed, EdgeKind::Assigned]), None);
    assert!(e.edges.iter().all(|x| matches!(x.kind, EdgeKind::Embed | EdgeKind::Assigned)));
    assert!(e.edges.contains(&Edge { from: "n:a".into(), to: format!("f:{FID}"), kind: EdgeKind::Embed }));
    let file = e.nodes.iter().find(|n| n.id == format!("f:{FID}")).expect("file end");
    assert_eq!((file.kind, file.label.as_str()), (NodeKind::File, "Faktura.pdf"));
    assert!(e.nodes.iter().any(|n| n.id == "p:anna" && n.kind == NodeKind::Person));
    assert!(e.nodes.iter().all(|n| e.edges.iter().any(|x| x.from == n.id || x.to == n.id)), "every node has an edge");
    assert!(!e.nodes.iter().any(|n| matches!(n.kind, NodeKind::Folder | NodeKind::Tag)));
    assert_eq!(idx.edges(None, None).edges.len(), idx.build_graph(None).edges.len());
}


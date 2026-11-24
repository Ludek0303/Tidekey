use super::*;
use proptest::prelude::*;

// Renames `Projekty/Stary.md` to `Archiwum/Nowy.md` (basename unique) unless a test says otherwise.
fn move_stary(text: &str) -> Option<String> {
    rename_links(text, "Projekty/Stary.md", "Archiwum/Nowy.md", true)
}

#[test]
fn basename_link_gets_the_new_basename() {
    assert_eq!(move_stary("Patrz [[Stary]].").as_deref(), Some("Patrz [[Nowy]]."));
}

#[test]
fn basename_link_gets_the_new_path_when_the_name_is_not_unique() {
    let out = rename_links("[[Stary]]", "Projekty/Stary.md", "Archiwum/Nowy.md", false);
    assert_eq!(out.as_deref(), Some("[[Archiwum/Nowy]]"));
}

#[test]
fn path_link_gets_the_new_path_without_md() {
    let out = rename_links("[[Projekty/Stary]]", "Projekty/Stary.md", "Archiwum/Nowy.md", true);
    assert_eq!(out.as_deref(), Some("[[Archiwum/Nowy]]"));
}

#[test]
fn md_in_the_link_is_kept() {
    assert_eq!(move_stary("[[Stary.md]] [[projekty/stary.MD]]").as_deref(), Some("[[Nowy.md]] [[Archiwum/Nowy.md]]"));
}

#[test]
fn alias_heading_block_and_embed_are_kept() {
    let text = "[[Stary|Mapa]] [[Stary#Cele]] [[Stary#^z-1]] ![[Stary]] ![[Stary#Cele|x]]";
    assert_eq!(
        move_stary(text).as_deref(),
        Some("[[Nowy|Mapa]] [[Nowy#Cele]] [[Nowy#^z-1]] ![[Nowy]] ![[Nowy#Cele|x]]")
    );
}

#[test]
fn match_is_case_insensitive() {
    assert_eq!(move_stary("[[stary]] [[STARY|a]]").as_deref(), Some("[[Nowy]] [[Nowy|a]]"));
}

#[test]
fn unrelated_names_are_untouched() {
    assert_eq!(move_stary("[[Older]] [[Stary 2]] [[Starynka]] [[Inny/Stary]]"), None);
}

#[test]
fn two_links_on_one_line_both_change() {
    assert_eq!(move_stary("[[Stary]] i [[Stary#A]]").as_deref(), Some("[[Nowy]] i [[Nowy#A]]"));
}

#[test]
fn code_fence_and_inline_code_are_untouched() {
    let text = "`[[Stary]]`\n\n```\n[[Stary]]\n```\n\n    [[Stary]]\n\n[[Stary]]";
    assert_eq!(move_stary(text).as_deref(), Some("`[[Stary]]`\n\n```\n[[Stary]]\n```\n\n    [[Stary]]\n\n[[Nowy]]"));
}

#[test]
fn escaped_bracket_is_not_a_link() {
    assert_eq!(move_stary(r"\[[Stary]]"), None);
    assert_eq!(move_stary(r"\\[[Stary]]").as_deref(), Some(r"\\[[Nowy]]"));
}

#[test]
fn polish_characters_in_names() {
    let out = rename_links("[[Łódź Żółw]] [[zażółć]]", "Miasta/Łódź Żółw.md", "Miasta/Zażółć gęślą.md", true);
    assert_eq!(out.as_deref(), Some("[[Zażółć gęślą]] [[zażółć]]"));
    assert_eq!(move_stary("[[Stary]] [[Ąę]]").as_deref(), Some("[[Nowy]] [[Ąę]]"));
}

#[test]
fn unchanged_text_gives_none() {
    assert_eq!(rename_links("[[Stary]]", "Stary.md", "Stary.md", true), None);
}

#[test]
fn self_links_are_rewritten_like_any_other() {
    let out = rename_links("[[Stary]] tu", "Stary.md", "Folder/Nowy.md", true);
    assert_eq!(out.as_deref(), Some("[[Nowy]] tu"));
}

proptest! {
    #[test]
    fn text_without_wikilinks_is_none(text in "[^\\[]*") {
        prop_assert_eq!(move_stary(&text), None);
    }
}

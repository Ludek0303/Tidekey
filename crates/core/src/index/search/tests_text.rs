use super::text::{normalize, stem_word, tokens, trigram_similarity, trigrams};

#[test]
fn polish_letters_fold_to_ascii() {
    assert_eq!(normalize("ąćęłńóśźż"), "acelnoszz");
    assert_eq!(normalize("ĄĆĘŁŃÓŚŹŻ"), "acelnoszz");
    assert_eq!(normalize("Żółw Łódź Gdańsk"), "zolw lodz gdansk");
}

#[test]
fn other_latin_diacritics_fold() {
    assert_eq!(normalize("café naïve Øresund Straße"), "cafe naive oresund strasse");
    assert_eq!(normalize("ő ű ğ ı ş ř ǵ"), "o u g i s r ǵ");
}

#[test]
fn combining_marks_are_dropped_so_decomposed_text_matches() {
    let composed = "żółw";
    let decomposed = "z\u{307}o\u{301}lw";
    assert_eq!(normalize(composed), normalize(decomposed));
    assert_eq!(tokens(decomposed, false), vec!["zolw"]);
}

#[test]
fn tokens_are_letter_and_digit_runs() {
    assert_eq!(tokens("Koszty: 4200 zł, #tag/x-y", false), vec!["koszty", "4200", "zl", "tag", "x", "y"]);
    assert_eq!(tokens("\\# to nie", false), vec!["to", "nie"]);
    assert!(tokens("  -- ?! ", false).is_empty());
}

#[test]
fn stemming_cuts_only_long_enough_stems() {
    assert_eq!(stem_word("budzetu"), "budzet");
    assert_eq!(stem_word("kawa"), "kawa");
    assert_eq!(stem_word("ania"), "ania");
}

#[test]
fn trigram_similarity_is_jaccard() {
    let a = trigrams("serwer");
    assert_eq!(trigram_similarity(&a, &a), 1.0);
    let b = trigrams("serwerr");
    assert!((trigram_similarity(&a, &b) - 0.8).abs() < 1e-6);
    assert_eq!(trigram_similarity(&trigrams("abc"), &trigrams("xyz")), 0.0);
    assert_eq!(trigram_similarity(&[], &[]), 0.0);
}

#[test]
fn edit_distance_counts_substitutions_insertions_and_transpositions() {
    use super::bm25::{edit_distance_within, max_edits};
    let d = |a: &str, b: &str, max: usize| {
        let a: Vec<char> = a.chars().collect();
        let b: Vec<char> = b.chars().collect();
        edit_distance_within(&a, &b, max)
    };
    assert_eq!(d("faktura", "faklura", 1), Some(1));
    assert_eq!(d("onboarding", "onbaording", 1), Some(1));
    assert_eq!(d("serwer", "serwre", 1), Some(1));
    assert_eq!(d("kazimierzu", "kazirnierzu", 2), Some(2));
    assert_eq!(d("faktura", "faktura", 0), Some(0));
    assert_eq!(d("faktura", "kawa", 2), None);
    assert_eq!(d("abc", "abcdef", 2), None);
    assert_eq!((max_edits(4), max_edits(5), max_edits(8), max_edits(9)), (0, 1, 1, 2));
}

//! Edits that turn one text into another, applied to a Yrs text as ranges. Only what changed is touched, so the
//! cursors of other writers stay where they are (ARCHITEKTURA §4.4).

use std::time::Duration;

use similar::{ChangeTag, TextDiff};
use yrs::{GetString, Text, TextRef, TransactionMut};

/// Texts with more chars than this are compared line by line: a char diff of a whole rewritten note is slow.
// shortcut: big texts are diffed by line, so an edit inside one long line replaces the whole line; upgrade with a diff per changed line
const LARGE_CHARS: usize = 4_000;
/// The char diff stops here; the edits it has found still turn the old text into the new one.
const DEADLINE: Duration = Duration::from_millis(100);

/// One range change: at `at` remove `delete` units, then insert `insert` there. Positions are UTF-16 units, as
/// the document counts them, and each `at` counts in the text after the edits before it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEdit {
    pub at: u32,
    pub delete: u32,
    pub insert: String,
}

/// The edits that turn `old` into `new`, in the order they must be applied. Runs of deleted or inserted text are
/// one edit each; equal text is never touched.
pub fn text_edits(old: &str, new: &str) -> Vec<TextEdit> {
    if old.chars().count().max(new.chars().count()) > LARGE_CHARS {
        collect(
            TextDiff::from_lines(old, new)
                .iter_all_changes()
                .map(|c| (c.tag(), c.value())),
        )
    } else {
        let diff = TextDiff::configure()
            .timeout(DEADLINE)
            .diff_chars(old, new);
        collect(diff.iter_all_changes().map(|c| (c.tag(), c.value())))
    }
}

/// Applies the edits that turn the text of `text` into `new`, inside `txn`.
pub(crate) fn apply(text: &TextRef, txn: &mut TransactionMut, new: &str) {
    let old = text.get_string(&*txn);
    for edit in text_edits(&old, new) {
        if edit.delete > 0 {
            text.remove_range(txn, edit.at, edit.delete);
        }
        if !edit.insert.is_empty() {
            text.insert(txn, edit.at, &edit.insert);
        }
    }
}

/// Collects the edits in order. `at` is the position in the text as it is now.
fn collect<'a>(changes: impl Iterator<Item = (ChangeTag, &'a str)>) -> Vec<TextEdit> {
    let mut edits = Vec::new();
    let mut at = 0;
    let mut cut = 0;
    let mut add = String::new();
    for (tag, value) in changes {
        match tag {
            ChangeTag::Equal => {
                push(&mut edits, &mut at, &mut cut, &mut add);
                at += units(value);
            }
            ChangeTag::Delete => cut += units(value),
            ChangeTag::Insert => add.push_str(value),
        }
    }
    push(&mut edits, &mut at, &mut cut, &mut add);
    edits
}

/// Ends the pending run at `at`: removes `cut` units there and inserts `add`, then moves `at` past the insert.
fn push(edits: &mut Vec<TextEdit>, at: &mut u32, cut: &mut u32, add: &mut String) {
    if *cut == 0 && add.is_empty() {
        return;
    }
    let insert = std::mem::take(add);
    let inserted = units(&insert);
    edits.push(TextEdit {
        at: *at,
        delete: std::mem::take(cut),
        insert,
    });
    *at += inserted;
}

fn units(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::new_doc;
    use proptest::prelude::*;
    use yrs::{Doc, Transact};

    /// Starts from `old`, applies the edits to `new`, and reads the result back.
    fn applied(old: &str, new: &str) -> String {
        let doc: Doc = new_doc();
        let text = doc.get_or_insert_text("content");
        text.insert(&mut doc.transact_mut(), 0, old);
        apply(&text, &mut doc.transact_mut(), new);
        let txn = doc.transact();
        text.get_string(&txn)
    }

    #[test]
    fn polish_letters_and_emoji_are_counted_in_utf16_units() {
        assert_eq!(
            applied("Żółw 🐢 w lesie", "zolw 🐢🐢 w lesie"),
            "zolw 🐢🐢 w lesie"
        );
        assert_eq!(applied("", "ąę🐢"), "ąę🐢");
        assert_eq!(applied("ąę🐢", ""), "");
    }

    #[test]
    fn a_whole_text_replacement_of_60_000_chars_is_fast() {
        let old: String = (0..60_000u64)
            .map(|i| char::from(b'a' + ((i * 7919 + 13) % 26) as u8))
            .collect();
        let new: String = (0..60_000u64)
            .map(|i| char::from(b'a' + ((i * 104_729 + 5) % 23) as u8))
            .collect();
        let start = std::time::Instant::now();
        assert_eq!(applied(&old, &new), new);
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "took {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn large_texts_with_lines_are_edited_line_by_line() {
        let old: String = (0..800).map(|i| format!("linia {i} zażółć\n")).collect();
        let new = old
            .replacen("linia 400 ", "linia 400 🐢 ", 1)
            .replace("linia 7 ", "");
        assert_eq!(applied(&old, &new), new);
    }

    /// Applies `edits` to `old` in order, counting UTF-16 units as the document does.
    fn applied_edits(old: &str, edits: &[TextEdit]) -> String {
        let mut units: Vec<u16> = old.encode_utf16().collect();
        for e in edits {
            let at = e.at as usize;
            units.splice(at..at + e.delete as usize, e.insert.encode_utf16());
        }
        String::from_utf16(&units).unwrap()
    }

    fn edit(at: u32, delete: u32, insert: &str) -> TextEdit {
        TextEdit { at, delete, insert: insert.into() }
    }

    #[test]
    fn text_edits_count_utf16_units_and_come_in_order() {
        assert_eq!(text_edits("Żółw 🐢 x", "Żółw 🐢 y"), vec![edit(8, 1, "y")]);
        assert_eq!(text_edits("ąę🐢", ""), vec![edit(0, 4, "")]);
        assert_eq!(text_edits("", "ąę🐢"), vec![edit(0, 0, "ąę🐢")]);
        assert_eq!(text_edits("same", "same"), vec![]);
        assert_eq!(text_edits("", ""), vec![]);
    }

    #[test]
    fn text_edits_cover_insertion_deletion_and_replacement() {
        assert_eq!(text_edits("abc", "ac"), vec![edit(1, 1, "")]);
        assert_eq!(text_edits("ab", "axb"), vec![edit(1, 0, "x")]);
        assert_eq!(text_edits("ab", "xb"), vec![edit(0, 1, "x")]);
        assert_eq!(text_edits("zażółć", "zażółć gęślą"), vec![edit(6, 0, " gęślą")]);
        let (old, new) = ("a1b2c3", "aXb2cY");
        let edits = text_edits(old, new);
        assert_eq!(edits.len(), 2);
        assert_eq!(applied_edits(old, &edits), new);
    }

    proptest! {
        #[test]
        fn text_edits_turn_old_into_new(
            old in "[aąęśźż🐢 \n]{0,40}",
            new in "[aąęśźż🐢 \n]{0,40}",
        ) {
            prop_assert_eq!(applied_edits(&old, &text_edits(&old, &new)), new);
        }

        #[test]
        fn applying_the_edits_gives_exactly_the_new_text(
            old in "[aąęśźż🐢 \n]{0,40}",
            new in "[aąęśźż🐢 \n]{0,40}",
        ) {
            prop_assert_eq!(applied(&old, &new), new);
        }
    }
}

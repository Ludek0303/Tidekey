//! Normalization for search: lowercase, diacritics folded (Polish and other Latin letters), tokens, trigrams.
//! Combining marks are dropped, so `o` + U+0301 and `ó` give the same letters without a Unicode tables crate.

/// Latin Extended-A (U+0100..=U+017F), one ASCII letter per code point; both cases share a letter.
const LATIN_EXT_A: &str = concat!(
    "AaAaAa", "CcCcCcCc", "DdDd", "EeEeEeEeEe", "GgGgGgGg", "HhHh", "IiIiIiIiIi", "Ii", "Jj", "Kkk", "LlLlLlLlLl",
    "NnNnNnnNn", "OoOoOoOo", "RrRrRr", "SsSsSsSs", "TtTtTt", "UuUuUuUuUuUu", "WwYyY", "ZzZzZz", "s",
);

/// Pushes the folded form of one lowercase character.
fn fold_char(c: char, out: &mut String) {
    match c {
        '\u{0300}'..='\u{036F}' => {}
        'a'..='z' | '0'..='9' => out.push(c),
        '\u{100}'..='\u{17F}' => out.push(char::from(LATIN_EXT_A.as_bytes()[c as usize - 0x100])),
        'à'..='å' => out.push('a'),
        'æ' => out.push_str("ae"),
        'ç' => out.push('c'),
        'è'..='ë' => out.push('e'),
        'ì'..='ï' => out.push('i'),
        'ð' => out.push('d'),
        'ñ' => out.push('n'),
        'ò'..='ö' | 'ø' => out.push('o'),
        'ù'..='ü' => out.push('u'),
        'ý' | 'ÿ' => out.push('y'),
        'þ' => out.push_str("th"),
        'ß' => out.push_str("ss"),
        c => out.push(c),
    }
}

/// Lowercase, folded, punctuation kept. Used for tags and paths, which compare as whole strings.
pub(super) fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        for lc in c.to_lowercase() {
            fold_char(lc, &mut out);
        }
    }
    out
}

/// Tokens: runs of letters and digits of the normalized text. With `stem`, light Polish suffixes are cut off.
pub(super) fn tokens(s: &str, stem: bool) -> Vec<String> {
    normalize(s)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| if stem { stem_word(t) } else { t.to_string() })
        .collect()
}

/// Suffixes of folded Polish words; a longer suffix is listed before any suffix that ends it. Cut only when at least 4 characters stay.
const SUFFIXES: &[&str] = &["ami", "ach", "owi", "iem", "ego", "emu", "ow", "om", "ie", "ia", "iu", "ym", "em", "a", "e", "i", "o", "u", "y"];

pub(super) fn stem_word(t: &str) -> String {
    for suf in SUFFIXES {
        if let Some(base) = t.strip_suffix(suf)
            && base.chars().count() >= 4
        {
            return base.to_string();
        }
    }
    t.to_string()
}

/// Sorted, deduplicated character trigrams. A term shorter than 3 characters is its own gram.
pub(super) fn trigrams(term: &str) -> Vec<String> {
    let chars: Vec<char> = term.chars().collect();
    let mut grams: Vec<String> = if chars.len() < 3 {
        if chars.is_empty() { vec![] } else { vec![term.to_string()] }
    } else {
        chars.windows(3).map(|w| w.iter().collect()).collect()
    };
    grams.sort();
    grams.dedup();
    grams
}

/// Jaccard similarity of two sorted, deduplicated gram lists.
pub(super) fn trigram_similarity(a: &[String], b: &[String]) -> f32 {
    let (mut i, mut j, mut inter) = (0, 0, 0usize);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                inter += 1;
                i += 1;
                j += 1;
            }
        }
    }
    let union = a.len() + b.len() - inter;
    if union == 0 { 0.0 } else { inter as f32 / union as f32 }
}

//! Splitting documents into chunks (OCR §4.2) and reading the text layer format (OCR §3.1). Pure string code.

use super::SearchError;

/// Pieces longer than this are split on paragraph boundaries.
pub(super) const PIECE: usize = 1500;
/// A single paragraph longer than this is split on line boundaries instead.
pub(super) const HARD: usize = 3000;

const PLACEHOLDER: &str = "_(brak tekstu)_";

/// A heading section of a note, `place` being its heading path ("Koszty > Serwer").
pub(super) struct Section {
    pub place: String,
    pub text: String,
}

/// One page (or the image section) of a text layer. `num` is 0 for the image section.
pub(super) struct LayerPage {
    pub obraz: bool,
    pub num: u32,
    pub low: bool,
    pub text: String,
}

/// The front matter (between the `---` lines, without them) and the body. Without a closing line the whole text is body.
pub(super) fn strip_front_matter(text: &str) -> (Option<&str>, &str) {
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return (None, text);
    };
    let mut pos = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return (Some(&rest[..pos]), &rest[pos + line.len()..]);
        }
        pos += line.len();
    }
    (None, text)
}

/// Pieces of one section: the whole text when it is short, else packed paragraphs (never cut inside a paragraph of
/// up to `HARD` characters), else packed lines. Blank pieces are dropped.
pub(super) fn split_pieces(text: &str) -> Vec<String> {
    let text = text.trim_matches('\n');
    if text.trim().is_empty() {
        return vec![];
    }
    if text.chars().count() <= PIECE {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0usize;
    for para in text.split("\n\n") {
        let n = para.chars().count();
        if n > HARD {
            flush(&mut out, &mut cur, &mut cur_len);
            pack_lines(para, &mut out);
            continue;
        }
        if cur_len > 0 && cur_len + 2 + n > PIECE {
            flush(&mut out, &mut cur, &mut cur_len);
        }
        if cur_len > 0 {
            cur.push_str("\n\n");
            cur_len += 2;
        }
        cur.push_str(para);
        cur_len += n;
    }
    flush(&mut out, &mut cur, &mut cur_len);
    out
}

fn flush(out: &mut Vec<String>, cur: &mut String, cur_len: &mut usize) {
    let piece = cur.trim_matches('\n');
    if !piece.trim().is_empty() {
        out.push(piece.to_string());
    }
    cur.clear();
    *cur_len = 0;
}

/// Lines of one long paragraph, packed up to `PIECE` characters. A line longer than that is cut by characters.
fn pack_lines(para: &str, out: &mut Vec<String>) {
    let mut cur = String::new();
    let mut cur_len = 0usize;
    for line in para.split('\n') {
        let n = line.chars().count();
        if n > PIECE {
            flush(out, &mut cur, &mut cur_len);
            let chars: Vec<char> = line.chars().collect();
            for part in chars.chunks(PIECE) {
                let s: String = part.iter().collect();
                if !s.trim().is_empty() {
                    out.push(s);
                }
            }
            continue;
        }
        if cur_len > 0 && cur_len + 1 + n > PIECE {
            flush(out, &mut cur, &mut cur_len);
        }
        if cur_len > 0 {
            cur.push('\n');
            cur_len += 1;
        }
        cur.push_str(line);
        cur_len += n;
    }
    flush(out, &mut cur, &mut cur_len);
}

/// `#` heading of level 1 to 3 (`#tag` and deeper headings are text).
fn heading(line: &str) -> Option<(u8, &str)> {
    let line = line.trim_end_matches(['\r', '\n']);
    let level = line.bytes().take_while(|b| *b == b'#').count();
    if !(1..=3).contains(&level) {
        return None;
    }
    let rest = &line[level..];
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }
    Some((level as u8, rest.trim()))
}

/// Note body split at H1–H3 headings (fenced code is skipped). Text before the first heading is its own section.
pub(super) fn note_sections(body: &str) -> Vec<Section> {
    let mut out = Vec::new();
    let mut stack: Vec<(u8, String)> = Vec::new();
    let mut place = String::new();
    let mut text = String::new();
    let mut fence = false;
    for line in body.split_inclusive('\n') {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
        } else if !fence && let Some((level, title)) = heading(line) {
            push_section(&mut out, &place, &mut text);
            while stack.last().is_some_and(|(l, _)| *l >= level) {
                stack.pop();
            }
            stack.push((level, title.to_string()));
            place = stack.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join(" > ");
        }
        text.push_str(line);
    }
    push_section(&mut out, &place, &mut text);
    out
}

fn push_section(out: &mut Vec<Section>, place: &str, text: &mut String) {
    if !text.trim().is_empty() {
        out.push(Section { place: place.to_string(), text: std::mem::take(text) });
    }
    text.clear();
}

/// Reads a text layer (OCR §3.1). Anything that does not match the format is an error, so nothing gets indexed.
pub(super) fn parse_layer(md: &str) -> Result<Vec<LayerPage>, SearchError> {
    let (front, body) = strip_front_matter(md);
    let front = front.ok_or(SearchError::Layer("no front matter"))?;
    if !front.lines().any(|l| l.trim() == "schema: notes-filetext-v1") {
        return Err(SearchError::Layer("unknown schema"));
    }
    let mut pages: Vec<LayerPage> = Vec::new();
    let mut open = false;
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            let page = marker(rest)?;
            if pages.iter().any(|p| p.obraz == page.obraz && (page.obraz || p.num == page.num)) {
                return Err(SearchError::Layer("duplicate section"));
            }
            pages.push(page);
            open = true;
            continue;
        }
        if !open {
            if line.trim().is_empty() {
                continue;
            }
            return Err(SearchError::Layer("text before the first section"));
        }
        let page = pages.last_mut().ok_or(SearchError::Layer("no section"))?;
        // A `#` at the start of a recognized line is escaped as `\#` (OCR §3.1).
        match line.strip_prefix("\\#") {
            Some(rest) => {
                page.text.push('#');
                page.text.push_str(rest);
            }
            None => page.text.push_str(line),
        }
        page.text.push('\n');
    }
    for page in &mut pages {
        let trimmed = page.text.trim_matches('\n');
        page.text = if trimmed.trim() == PLACEHOLDER { String::new() } else { trimmed.to_string() };
    }
    Ok(pages)
}

/// `Strona N` with an optional ` · niska jakość`, or `Obraz`, without the `## `.
fn marker(rest: &str) -> Result<LayerPage, SearchError> {
    if rest == "Obraz" {
        return Ok(LayerPage { obraz: true, num: 0, low: false, text: String::new() });
    }
    let tail = rest.strip_prefix("Strona ").ok_or(SearchError::Layer("unknown section"))?;
    let (num_s, flag) = match tail.split_once(" · ") {
        Some((n, f)) => (n, Some(f)),
        None => (tail, None),
    };
    if num_s.is_empty() || !num_s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(SearchError::Layer("bad page number"));
    }
    let num: u32 = num_s.parse().map_err(|_| SearchError::Layer("bad page number"))?;
    if num == 0 {
        return Err(SearchError::Layer("bad page number"));
    }
    let low = match flag {
        None => false,
        Some("niska jakość") => true,
        Some(_) => return Err(SearchError::Layer("unknown section flag")),
    };
    Ok(LayerPage { obraz: false, num, low, text: String::new() })
}

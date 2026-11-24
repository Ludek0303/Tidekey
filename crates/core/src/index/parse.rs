//! Per-note parsing. Pulldown-cmark gives headings, tasks and Markdown links and tells us which
//! byte ranges are code or link text; wikilinks, tags and block ids are scanned in the rest.

use super::{Heading, Link, NoteIndex, Priority, Reminder, Task, Warning};
use crate::formula::date::parse_iso;
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::collections::HashSet;
use std::ops::Range;

/// Parses one note. Pure and total: any input gives an index, never a panic.
pub fn parse_note(text: &str) -> NoteIndex {
    let s = scan(text);
    let mut found = s.md;
    found.extend(s.wiki.into_iter().map(|w| (w.at, w.link)));
    found.sort_by_key(|(at, _)| *at);
    let mut out = s.out;
    out.links = found.into_iter().map(|(_, link)| link).collect();
    out.blocks = block_ids(s.body, &s.lines, &s.mask);
    out.props = yaml_props(&s.front);
    let mut tags = yaml_tags(&s.front);
    tags.extend(inline_tags(s.body, &s.mask));
    out.tags = dedupe(tags);
    out
}

/// Each wikilink of `text` as `(byte offset of its "[[", byte range of its target)`, found by the same scan as
/// `parse_note`, so code, masked text and over-long notes are skipped the same way.
pub(super) fn wikilink_targets(text: &str) -> Vec<(usize, Range<usize>)> {
    let s = scan(text);
    let start = s.start;
    s.wiki
        .into_iter()
        .map(|w| (start + w.at, start + w.target.start..start + w.target.end))
        .collect()
}

/// What the first pass finds in a note. Offsets in `wiki` are relative to the body.
struct Scan<'a> {
    front: Vec<&'a str>,
    /// Byte offset of the body in the text.
    start: usize,
    body: &'a str,
    lines: Lines,
    mask: Vec<bool>,
    out: NoteIndex,
    /// Markdown links, from `walk`.
    md: Vec<(usize, Link)>,
    wiki: Vec<Wiki>,
}

/// A wikilink: `at` is the offset of its `[[`, `target` the range of its target, both in the body.
struct Wiki {
    at: usize,
    target: Range<usize>,
    link: Link,
}

fn scan(text: &str) -> Scan<'_> {
    // shortcut: only the first 512 KiB is indexed and only the first 128 KiB goes through pulldown-cmark
    // (headings, tasks, Markdown links, code masks), because pulldown is quadratic on some inputs
    // (`*a_` repeated: ~0.5 s at 128 KiB, ~8 s at 512 KiB); tell the user in the UI when a note is cut.
    let mut end = text.len().min(512 * 1024);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let text = &text[..end];
    let (front, start) = front_matter(text);
    let body = &text[start..];
    let lines = Lines {
        starts: line_starts(body),
        base: text[..start].matches('\n').count() as u32,
    };
    let mut out = NoteIndex::default();
    let mut mask = vec![false; body.len()];
    let mut md = Vec::new();
    let mut pd_end = body.len().min(128 * 1024);
    while !body.is_char_boundary(pd_end) {
        pd_end -= 1;
    }
    walk(&body[..pd_end], &lines, &mut out, &mut mask, &mut md);
    let wiki = scan_wikilinks(body, &lines, &mask);
    Scan {
        front,
        start,
        body,
        lines,
        mask,
        out,
        md,
        wiki,
    }
}

struct Lines {
    starts: Vec<usize>,
    /// Lines before the body (front matter).
    base: u32,
}

impl Lines {
    /// 1-based line of a byte offset in the body.
    fn line(&self, at: usize) -> u32 {
        self.base + self.starts.partition_point(|&s| s <= at) as u32
    }
}

fn line_starts(body: &str) -> Vec<usize> {
    let mut starts = vec![0];
    starts.extend(body.match_indices('\n').map(|(i, _)| i + 1));
    starts
}

/// The lines of a YAML front matter, and the byte offset where the body starts.
/// An unclosed block is not front matter.
fn front_matter(text: &str) -> (Vec<&str>, usize) {
    let Some(first_end) = text.find('\n') else {
        return (Vec::new(), 0);
    };
    if text[..first_end].trim_end() != "---" {
        return (Vec::new(), 0);
    }
    let mut lines = Vec::new();
    let mut pos = first_end + 1;
    for line in text[pos..].split_inclusive('\n') {
        let end = pos + line.len();
        if line.trim_end() == "---" {
            return (lines, end);
        }
        lines.push(line.trim_end());
        pos = end;
    }
    (Vec::new(), 0)
}

/// `key: value` lines of the front matter, keys lowercase, values without quotes. Empty values are left out.
fn yaml_props(lines: &[&str]) -> Vec<(String, String)> {
    lines
        .iter()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            let key = key.trim();
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
            let plain_key = !key.is_empty() && !key.starts_with(['-', ' ', '#']);
            (plain_key && !value.is_empty()).then(|| (key.to_lowercase(), value.to_string()))
        })
        .collect()
}

/// Minimal YAML: `tags: [a, b]`, `tags: a, b`, or a `- item` list under `tags:`.
fn yaml_tags(lines: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if let Some(value) = lines[i].strip_prefix("tags:") {
            let value = value.trim();
            if value.is_empty() {
                i += 1;
                while let Some(item) = lines.get(i).and_then(|l| l.trim_start().strip_prefix('-')) {
                    out.extend(yaml_tag(item));
                    i += 1;
                }
                continue;
            }
            let inner = value
                .strip_prefix('[')
                .and_then(|v| v.strip_suffix(']'))
                .unwrap_or(value);
            out.extend(inner.split(',').filter_map(yaml_tag));
        }
        i += 1;
    }
    out
}

fn yaml_tag(s: &str) -> Option<String> {
    let t = s
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .trim_start_matches('#')
        .trim();
    (!t.is_empty()).then(|| t.to_lowercase())
}

fn mask_range(mask: &mut [bool], range: std::ops::Range<usize>) {
    if let Some(s) = mask.get_mut(range) {
        s.fill(true);
    }
}

fn level_number(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// One pulldown pass: headings, tasks, Markdown links, and the masks of code and link text.
fn walk(
    body: &str,
    lines: &Lines,
    out: &mut NoteIndex,
    mask: &mut [bool],
    found: &mut Vec<(usize, Link)>,
) {
    let parser = Parser::new_ext(body, Options::ENABLE_TASKLISTS | Options::ENABLE_TABLES);
    let mut depth = 0u8;
    let mut code_at = 0;
    let mut heading: Option<(u8, usize, String)> = None;
    let mut link: Option<(usize, String)> = None;
    for (event, range) in parser.into_offset_iter() {
        match event {
            Event::Start(Tag::List(_)) => depth = depth.saturating_add(1),
            Event::End(TagEnd::List(_)) => depth = depth.saturating_sub(1),
            Event::Start(Tag::CodeBlock(_)) => code_at = range.start,
            Event::End(TagEnd::CodeBlock) => mask_range(mask, code_at..range.end),
            Event::Code(text) => {
                mask_range(mask, range);
                if let Some((_, _, s)) = heading.as_mut() {
                    s.push_str(&text);
                }
            }
            Event::Text(text) => {
                if let Some((_, _, s)) = heading.as_mut() {
                    s.push_str(&text);
                }
            }
            Event::Start(Tag::Heading { level, .. }) => {
                heading = Some((level_number(level), range.start, String::new()));
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, at, text)) = heading.take() {
                    out.headings.push(Heading {
                        level,
                        text: text.trim().to_string(),
                        line: lines.line(at),
                    });
                }
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                link = Some((range.start, dest_url.into_string()))
            }
            Event::End(TagEnd::Link) => {
                if let Some((start, dest)) = link.take() {
                    mask_range(mask, start..range.end);
                    if let Some(l) = md_link(&dest, lines.line(start)) {
                        found.push((start, l));
                    }
                }
            }
            Event::TaskListMarker(done) => {
                let rest_start = range.end.min(body.len());
                let eol = body[rest_start..]
                    .find('\n')
                    .map_or(body.len(), |i| rest_start + i);
                let task = parse_task(
                    &body[rest_start..eol],
                    done,
                    depth.saturating_sub(1),
                    lines.line(range.start),
                    &mut out.warnings,
                );
                out.tasks.push(task);
            }
            _ => {}
        }
    }
}

/// `Folder/Note.md#Heading` or `#^block`; external URLs and non-`.md` paths are not notes.
fn md_link(dest: &str, line: u32) -> Option<Link> {
    if has_scheme(dest) {
        return None;
    }
    let (path, frag) = match dest.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (dest, None),
    };
    let path = percent_decode(path);
    // `./` is kept: it marks a link relative to this note (SpaceIndex::resolve_from)
    let target = path.trim_start_matches('/');
    let is_md = target.len() > 3
        && target
            .get(target.len() - 3..)
            .is_some_and(|e| e.eq_ignore_ascii_case(".md"));
    if !is_md {
        return None;
    }
    let (heading, block) = split_sub(&percent_decode(frag.unwrap_or("")));
    Some(Link {
        target: target.to_string(),
        heading,
        block,
        alias: None,
        embed: false,
        md: true,
        line,
    })
}

fn has_scheme(dest: &str) -> bool {
    dest.split_once(':').is_some_and(|(s, _)| {
        s.as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphabetic())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+-.".contains(&b))
    })
}

/// Decodes `%XX` escapes; a bad escape stays as written.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let Some(v) = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Splits `Heading` or `^block` (the part after `#`).
fn split_sub(sub: &str) -> (Option<String>, Option<String>) {
    match sub.trim().strip_prefix('^') {
        Some(block) => (None, non_empty(block)),
        None => (non_empty(sub), None),
    }
}

/// `[[target#heading|alias]]`, `[[target#^block]]` and `![[…]]`, outside code and links.
/// Linear: a wikilink never spans lines, so each line is searched for `]]` once.
fn scan_wikilinks(body: &str, lines: &Lines, mask: &[bool]) -> Vec<Wiki> {
    let mut found = Vec::new();
    let mut at = 0;
    let mut line_end = 0;
    while let Some(i) = body[at..].find("[[").map(|i| i + at) {
        let open = i + 2;
        if mask[i] {
            at = open;
            continue;
        }
        if open > line_end {
            line_end = body[open..].find('\n').map_or(body.len(), |n| open + n);
        }
        let Some(close) = body[open..line_end].find("]]").map(|c| c + open) else {
            at = line_end;
            continue;
        };
        let inner = &body[open..close];
        if let Some(last) = inner.rfind("[[") {
            at = open + last;
            continue;
        }
        at = close + 2;
        // A `\` before `|` is a table cell escape, not part of the target.
        let (dest, alias) = match inner.split_once('|') {
            Some((d, a)) => (d.trim_end_matches('\\'), non_empty(a)),
            None => (inner, None),
        };
        let (target, sub) = match dest.split_once('#') {
            Some((t, s)) => (t, Some(s)),
            None => (dest, None),
        };
        let target = target.trim().trim_end_matches('\\').trim();
        if target.is_empty() {
            continue;
        }
        let (heading, block) = sub.map_or((None, None), split_sub);
        // `target` is a slice of `body`, so its offset is the distance between the two starts
        let t = target.as_ptr() as usize - body.as_ptr() as usize;
        found.push(Wiki {
            at: i,
            target: t..t + target.len(),
            link: Link {
                target: target.to_string(),
                heading,
                block,
                alias,
                embed: i > 0 && body.as_bytes()[i - 1] == b'!',
                md: false,
                line: lines.line(i),
            },
        });
    }
    found
}

fn is_block_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `^id` as the last word of a line.
fn block_ids(body: &str, lines: &Lines, mask: &[bool]) -> Vec<(String, u32)> {
    let mut out = Vec::new();
    let mut line_start = 0;
    for line in body.split('\n') {
        let t = line.trim_end();
        let tok_start = match t.rfind(char::is_whitespace) {
            Some(i) => i + t[i..].chars().next().map_or(1, char::len_utf8),
            None => 0,
        };
        if let Some(id) = t[tok_start..].strip_prefix('^')
            && is_block_id(id)
            && !mask[line_start + tok_start]
        {
            out.push((id.to_string(), lines.line(line_start)));
        }
        line_start += line.len() + 1;
    }
    out
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// `#tag` and `#nested/tag` after whitespace or at the start; needs one non-digit character.
fn inline_tags(body: &str, mask: &[bool]) -> Vec<String> {
    let mut tags = Vec::new();
    for (pos, ch) in body.char_indices() {
        if ch != '#'
            || mask[pos]
            || body[..pos]
                .chars()
                .next_back()
                .is_some_and(|c| !c.is_whitespace())
        {
            continue;
        }
        let rest = &body[pos + 1..];
        if !rest
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
        {
            continue;
        }
        let len = rest
            .char_indices()
            .find(|&(i, c)| !is_tag_char(c) || mask[pos + 1 + i])
            .map_or(rest.len(), |(i, _)| i);
        let tag = rest[..len].trim_end_matches('/');
        if tag.chars().any(|c| c != '/' && !c.is_ascii_digit()) {
            tags.push(tag.to_lowercase());
        }
    }
    tags
}

fn dedupe(v: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    v.into_iter().filter(|t| seen.insert(t.clone())).collect()
}

fn is_handle(h: &str) -> bool {
    !h.is_empty()
        && h.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A handle after `@`, without the punctuation that ends a sentence (`@Ola.`).
fn handle(raw: &str) -> Option<String> {
    let h = raw.trim_end_matches(['.', ',', ';', ':', '!', '?', ')']);
    is_handle(h).then(|| h.to_string())
}

/// Digits only and at most 10: `11`, `-1`, `+5`, `1.5` and `` are not difficulties.
fn difficulty(v: &str) -> Option<u8> {
    number(v).filter(|d| *d <= 10).map(|d| d as u8)
}

/// Date after a marker: `📅 2026-10-30` (two words) or `📅2026-10-30`. Returns days and words used.
fn dated(words: &[&str], marker: &str) -> Option<(i32, usize)> {
    let first = *words.first()?;
    if first == marker {
        return Some((parse_iso(words.get(1)?)?, 2));
    }
    Some((parse_iso(first.strip_prefix(marker)?)?, 1))
}

/// Digits only, read as a number.
fn number(v: &str) -> Option<u32> {
    if !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // "" passes the check above but does not parse
    v.parse().ok()
}

/// `30m`, `2h` or `1d` as minutes; the number is 1 to 999 in its unit.
fn minutes(v: &str) -> Option<u32> {
    let unit = match v.chars().last()? {
        'm' => 1,
        'h' => 60,
        'd' => 1440,
        _ => return None,
    };
    let n = number(v.get(..v.len() - 1)?).filter(|n| (1..=999).contains(n))?;
    Some(n * unit)
}

/// `2h/30mx3`: the first reminder 2 h before the due moment, then every 30 min, 3 times in all.
fn reminder(v: &str) -> Option<Reminder> {
    let (head, count) = match v.rsplit_once('x') {
        Some((head, count)) => (head, number(count).filter(|c| (1..=20).contains(c))? as u8),
        None => (v, 1),
    };
    let (before, every) = match head.split_once('/') {
        Some((before, every)) => (minutes(before)?, Some(minutes(every)?)),
        None => (minutes(head)?, None),
    };
    Some(Reminder { before_min: before, every_min: every, count })
}

/// What a metadata token of a task says. `Difficulty(None)` is a `!trudnosc:` the parser could not read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenKind {
    Assignee(String),
    Group(String),
    Supervisor(String),
    Due(i32),
    Done(i32),
    Difficulty(Option<u8>),
    /// `Reminder(None)` is a `!przypomnij:` the parser could not read.
    Reminder(Option<Reminder>),
    Priority(Priority),
    Id(String),
    /// `!etap:W_toku`: the board column, with `_` read as spaces.
    Stage(String),
}

/// A metadata token of a task: its kind and its byte range in the text (the part after the checkbox).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskToken {
    pub start: usize,
    pub end: usize,
    pub kind: TokenKind,
}

/// The one reader of task tokens: `parse_task` and `line_task` (the editor) both use it, so they never disagree.
/// Returns the tokens and the words that stay as the title; an unreadable difficulty is also a warning.
fn scan_tokens<'a>(rest: &'a str, line: u32, warnings: &mut Vec<Warning>) -> (Vec<TaskToken>, Vec<&'a str>) {
    let words: Vec<&str> = rest.split_whitespace().collect();
    let at = |w: &str| w.as_ptr() as usize - rest.as_ptr() as usize;
    let span = |first: usize, used: usize, kind: TokenKind| TaskToken {
        start: at(words[first]),
        end: at(words[first + used - 1]) + words[first + used - 1].len(),
        kind,
    };
    let mut tokens = Vec::new();
    let mut text = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        if let Some((day, used)) = dated(&words[i..], "📅") {
            tokens.push(span(i, used, TokenKind::Due(day)));
            i += used;
            continue;
        }
        if let Some((day, used)) = dated(&words[i..], "✅") {
            tokens.push(span(i, used, TokenKind::Done(day)));
            i += used;
            continue;
        }
        i += 1;
        let kind = match w {
            // ⭐ is the app's "important" star; ⏫ is the same, written by the Obsidian Tasks plugin
            "⏫" | "⭐" => Some(TokenKind::Priority(Priority::High)),
            "🔼" => Some(TokenKind::Priority(Priority::Medium)),
            "🔽" => Some(TokenKind::Priority(Priority::Low)),
            _ => {
                if let Some(v) = w.strip_prefix("!trudnosc:") {
                    let value = difficulty(v);
                    if value.is_none() {
                        warnings.push(Warning { line, message: format!("Trudność musi być liczbą całkowitą 0–10: {v}") });
                    }
                    Some(TokenKind::Difficulty(value))
                } else if let Some(v) = w.strip_prefix("!przypomnij:") {
                    let value = reminder(v);
                    if value.is_none() {
                        warnings.push(Warning { line, message: format!("Przypomnienie: np. !przypomnij:1d albo !przypomnij:2h/30mx3 (m, h, d; 1–999; x 1–20): {v}") });
                    }
                    Some(TokenKind::Reminder(value))
                } else if let Some(group) = w.strip_prefix("!grupa:").filter(|id| {
                    !id.is_empty() && id.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
                }) {
                    Some(TokenKind::Group(group.to_string()))
                } else if let Some(h) = w.strip_prefix("!nadzor:@").and_then(handle) {
                    Some(TokenKind::Supervisor(h))
                } else if let Some(h) = w.strip_prefix('@').and_then(handle) {
                    Some(TokenKind::Assignee(h))
                } else if let Some(stage) = w.strip_prefix("!etap:").filter(|s| !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))) {
                    Some(TokenKind::Stage(stage.replace('_', " ")))
                } else {
                    w.strip_prefix('^').filter(|id| is_block_id(id)).map(|id| TokenKind::Id(id.to_string()))
                }
            }
        };
        match kind {
            Some(kind) => tokens.push(TaskToken { start: at(w), end: at(w) + w.len(), kind }),
            None => text.push(w),
        }
    }
    (tokens, text)
}

/// Metadata tokens (ORGANIZACJA §2) are removed from `text`; the rest stays in order.
fn parse_task(rest: &str, done: bool, depth: u8, line: u32, warnings: &mut Vec<Warning>) -> Task {
    let (tokens, text) = scan_tokens(rest, line, warnings);
    let mut task = Task {
        line,
        depth,
        done,
        text: text.join(" "),
        assignees: Vec::new(),
        groups: Vec::new(),
        supervisor: None,
        difficulty: None,
        due: None,
        done_on: None,
        priority: None,
        id: None,
        reminder: None,
        stage: None,
    };
    for token in tokens {
        match token.kind {
            TokenKind::Assignee(h) => task.assignees.push(h),
            TokenKind::Group(id) => task.groups.push(id),
            TokenKind::Supervisor(h) => task.supervisor = Some(h),
            TokenKind::Due(day) => task.due = Some(day),
            TokenKind::Done(day) => task.done_on = Some(day),
            // an unreadable difficulty keeps the earlier one, as it always did
            TokenKind::Difficulty(Some(d)) => task.difficulty = Some(d),
            TokenKind::Difficulty(None) => {}
            TokenKind::Reminder(Some(r)) => task.reminder = Some(r),
            TokenKind::Reminder(None) => {}
            TokenKind::Priority(p) => task.priority = Some(p),
            TokenKind::Id(id) => task.id = Some(id),
            TokenKind::Stage(stage) => task.stage = Some(stage),
        }
    }
    task
}

/// A task on one line, read by the note parser: its text, its id, and its tokens with byte offsets in the line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineTask {
    pub text: String,
    pub id: Option<String>,
    pub tokens: Vec<TaskToken>,
}

/// The task on `line`, or None when the line is not one in the parser's sense (a list item with a checkbox, also
/// inside a quote). Code fences and front matter depend on the note, so the caller leaves those lines out.
pub fn line_task(line: &str) -> Option<LineTask> {
    let parsed = parse_note(line);
    let [task] = parsed.tasks.as_slice() else {
        return None;
    };
    let rest_start = ["[ ]", "[x]", "[X]"].iter().filter_map(|m| line.find(m)).min()? + 3;
    let mut ignored = Vec::new();
    let (mut tokens, _) = scan_tokens(&line[rest_start..], task.line, &mut ignored);
    for t in &mut tokens {
        t.start += rest_start;
        t.end += rest_start;
    }
    Some(LineTask { text: task.text.clone(), id: task.id.clone(), tokens })
}

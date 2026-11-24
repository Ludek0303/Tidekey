//! Calendar note syntax (ARCHITEKTURA §4.16b): reading a note into events and writing one event
//! back as its canonical lines. Everything here is pure; the layout is documented in the spec.

use super::rrule::{format_rrule, parse_rrule};
use super::{Calendar, Event, MAX_REMINDER_MINUTES};
use crate::formula::date::{civil_from_days, parse_iso};

/// Marker characters. A title, colour or other value never contains them after `sanitize`.
const REPEAT: char = '🔁';
const EXDATE: char = '⛔';
const COLOR: char = '🎨';
const REMINDER: char = '🔔';
const MARKERS: [char; 4] = [REPEAT, EXDATE, COLOR, REMINDER];

/// Default length of a timed event without an end, in minutes.
const DEFAULT_MINUTES: u16 = 60;

#[derive(Clone, Copy)]
enum Marker {
    Repeat,
    Exdate,
    Color,
    Reminder,
}

/// Reads every event of a note. Lines outside the front matter that start with `- ` or `* ` and a
/// valid date are events; indented lines right after one are its description.
pub fn parse_calendar(text: &str) -> Calendar {
    let lines: Vec<&str> = text.lines().collect();
    let body = front_matter_end(&lines);
    let mut events = Vec::new();
    let mut i = body;
    while i < lines.len() {
        let Some(mut event) = parse_event_line(lines[i], i) else {
            i += 1;
            continue;
        };
        let (description, next) = read_description(&lines, i + 1);
        event.description = description.join("\n");
        events.push(event);
        i = next;
    }
    Calendar {
        is_calendar: is_calendar(&lines, body),
        events,
    }
}

/// The canonical lines of one event: the event line, then its description indented by 4 spaces.
/// Title, colour and id are sanitized, so `parse_calendar` reads back an equal event for any event
/// whose strings are already canonical (no newlines, markers or `^word`; a valid date and time).
pub fn format_event(e: &Event) -> String {
    let mut line = format!("- {}", date_str(e.start_day));
    if let Some(m) = e.start_min {
        line.push(' ');
        line += &hhmm(m);
    }
    if default_end(e.start_day, e.start_min) != Some((e.end_day, e.end_min)) {
        line.push('-');
        match e.end_min {
            Some(m) if e.start_min.is_some() && e.end_day == e.start_day => line += &hhmm(m),
            _ => {
                line += &date_str(e.end_day);
                if let Some(m) = e.end_min {
                    line.push(' ');
                    line += &hhmm(m);
                }
            }
        }
    }
    let mut parts = Vec::new();
    let title = escape_time(&sanitize(&e.title));
    if !title.is_empty() {
        parts.push(title);
    }
    if let Some(rule) = &e.rrule {
        parts.push(format!("{REPEAT} {}", format_rrule(rule)));
    }
    if !e.exdates.is_empty() {
        let days: Vec<String> = e.exdates.iter().map(|&d| date_str(d)).collect();
        parts.push(format!("{EXDATE} {}", days.join(",")));
    }
    if let Some(color) = e.color.as_deref().map(sanitize).filter(|c| !c.is_empty()) {
        parts.push(format!("{COLOR} {color}"));
    }
    if let Some(minutes) = e.reminder.filter(|m| (1..=MAX_REMINDER_MINUTES).contains(m)) {
        parts.push(format!("{REMINDER} {minutes}"));
    }
    if is_id(&e.id) {
        parts.push(format!("^{}", e.id));
    }
    for part in parts {
        line.push(' ');
        line += &part;
    }
    for description in e.description.lines() {
        line.push_str("\n    ");
        line.push_str(description);
    }
    line
}

/// Where a timed event ends when the line has no end: one hour later, possibly after midnight.
/// All-day events end on their start day. `None` if the day number would overflow.
pub(super) fn default_end(start_day: i32, start_min: Option<u16>) -> Option<(i32, Option<u16>)> {
    let Some(m) = start_min else {
        return Some((start_day, None));
    };
    let total = i32::from(m) + i32::from(DEFAULT_MINUTES);
    let day = start_day.checked_add(i32::from(total >= 1440))?;
    Some((day, Some((total % 1440) as u16)))
}

/// Removes marker characters and `^word` tokens, and collapses whitespace.
fn sanitize(s: &str) -> String {
    let cleaned: String = s.chars().filter(|c| !MARKERS.contains(c)).collect();
    cleaned
        .split_whitespace()
        .filter(|w| !w.starts_with('^'))
        .collect::<Vec<_>>()
        .join(" ")
}

fn front_matter_end(lines: &[&str]) -> usize {
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return 0;
    }
    lines
        .iter()
        .skip(1)
        .position(|l| l.trim_end() == "---")
        .map_or(0, |p| p + 2)
}

/// `typ: kalendarz` or `type: calendar` in the front matter.
fn is_calendar(lines: &[&str], body: usize) -> bool {
    body > 0
        && lines[1..body - 1].iter().any(|line| {
            line.split_once(':').is_some_and(|(key, value)| {
                matches!(key.trim(), "typ" | "type")
                    && matches!(
                        value.trim().trim_matches(['"', '\'']),
                        "kalendarz" | "calendar"
                    )
            })
        })
}

/// The description lines from `next` on, and the index after the last one. Blank lines count when
/// an indented text line follows them; trailing blank lines do not belong to the event.
fn read_description<'a>(lines: &[&'a str], mut next: usize) -> (Vec<&'a str>, usize) {
    let mut out = Vec::new();
    let mut end = next;
    let mut blanks = 0;
    while let Some(line) = lines.get(next).copied() {
        if line.trim().is_empty() {
            blanks += 1;
        } else if line.starts_with(' ') || line.starts_with('\t') {
            out.extend(std::iter::repeat_n("", blanks));
            blanks = 0;
            out.push(strip_indent(line));
            end = next + 1;
        } else {
            break;
        }
        next += 1;
    }
    (out, end)
}

/// Removes the 4-space (or tab) indent that `format_event` adds.
fn strip_indent(line: &str) -> &str {
    line.strip_prefix("    ")
        .or_else(|| line.strip_prefix('\t'))
        .unwrap_or(line.trim_start())
}

fn parse_event_line(line: &str, index: usize) -> Option<Event> {
    let rest = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))?;
    let (start_day, rest) = take_date(rest)?;
    let (start_min, rest) = match rest.strip_prefix(' ').and_then(take_time) {
        Some((m, after)) if ends_token(after, true) => (Some(m), after),
        _ => (None, rest),
    };
    let (end, rest) = match rest.strip_prefix('-') {
        Some(after) => {
            let (day, min, after) = take_end(after, start_day, start_min.is_some())?;
            (Some((day, min)), after)
        }
        None => (None, rest),
    };
    if !ends_token(rest, false) {
        return None;
    }
    let (mut end_day, mut end_min) = match end {
        Some(end) => end,
        None => default_end(start_day, start_min)?,
    };
    if (end_day, end_min.unwrap_or(0)) < (start_day, start_min.unwrap_or(0)) {
        end_day = start_day;
        end_min = start_min;
    }

    let (head, id) = split_id(rest.trim());
    let (title, values) = split_markers(head);
    let mut rrule = None;
    let mut exdates = Vec::new();
    let mut color = None;
    let mut reminder = None;
    for (kind, value) in values {
        match kind {
            Marker::Repeat => rrule = parse_rrule(value),
            Marker::Exdate => exdates.extend(value.split(',').filter_map(|d| parse_iso(d.trim()))),
            Marker::Color => color = (!value.is_empty()).then(|| value.to_string()),
            Marker::Reminder => reminder = parse_reminder(value),
        }
    }
    Some(Event {
        id: id.map_or_else(|| format!("#L{index}"), str::to_string),
        line: index,
        title: unescape_time(title),
        start_day,
        start_min,
        end_day,
        end_min,
        rrule,
        exdates,
        color,
        reminder,
        description: String::new(),
    })
}

/// The value of `🔔`: a whole number of minutes in `1..=MAX_REMINDER_MINUTES`.
fn parse_reminder(s: &str) -> Option<u16> {
    let digits = !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    s.parse::<u16>()
        .ok()
        .filter(|m| digits && (1..=MAX_REMINDER_MINUTES).contains(m))
}

/// The end after `-`: `HH:MM` (same day, timed events only), or a date with an optional time.
/// A date without a time ends at midnight for timed events and has no time for all-day ones.
fn take_end(s: &str, start_day: i32, timed: bool) -> Option<(i32, Option<u16>, &str)> {
    if timed && let Some((m, after)) = take_time(s).filter(|(_, a)| ends_token(a, false)) {
        return Some((start_day, Some(m), after));
    }
    let (day, after) = take_date(s)?;
    let time = after
        .strip_prefix(' ')
        .and_then(take_time)
        .filter(|(_, a)| ends_token(a, false));
    let (min, after) = match time {
        Some((m, a)) => (Some(m), a),
        None => (None, after),
    };
    Some((day, timed.then(|| min.unwrap_or(0)), after))
}

/// Splits the id `^word` off the end of the text (the last whitespace-separated word).
fn split_id(tail: &str) -> (&str, Option<&str>) {
    let (head, last) = match tail.char_indices().rev().find(|(_, c)| c.is_whitespace()) {
        Some((p, c)) => (&tail[..p], &tail[p + c.len_utf8()..]),
        None => ("", tail),
    };
    match last.strip_prefix('^') {
        Some(id) if is_id(id) => (head.trim_end(), Some(id)),
        _ => (tail, None),
    }
}

/// Escapes a title that starts like a time (`10:00 standup`, `10\:00`) as `10\:00 standup`, so
/// an all-day line cannot be read as timed. Obsidian shows the backslash as `10:00`.
fn escape_time(title: &str) -> String {
    if has_time_prefix(title.as_bytes(), b":\\") {
        format!("{}\\{}", &title[..2], &title[2..])
    } else {
        title.to_string()
    }
}

/// Inverse of `escape_time`: removes the one backslash before the colon of a leading `10\:00`.
fn unescape_time(title: &str) -> String {
    if has_time_prefix(title.as_bytes(), b"\\")
        && matches!(title.as_bytes()[3..].first(), Some(b':' | b'\\'))
    {
        format!("{}{}", &title[..2], &title[3..])
    } else {
        title.to_string()
    }
}

/// `dd` followed by one of `sep` (for `escape_time`) or by `\` (for `unescape_time`).
fn has_time_prefix(b: &[u8], sep: &[u8]) -> bool {
    b.len() >= 3 && b[..2].iter().all(u8::is_ascii_digit) && sep.contains(&b[2])
}

pub(super) fn is_id(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The title is the text before the first marker. Each marker takes the text up to the next one.
fn split_markers(head: &str) -> (&str, Vec<(Marker, &str)>) {
    let mut all: Vec<(usize, Marker, usize)> = Vec::new();
    for (i, c) in head.char_indices() {
        let kind = match c {
            REPEAT => Marker::Repeat,
            EXDATE => Marker::Exdate,
            COLOR => Marker::Color,
            REMINDER => Marker::Reminder,
            _ => continue,
        };
        if i == 0 || head[..i].ends_with(char::is_whitespace) {
            all.push((i, kind, c.len_utf8()));
        }
    }
    // A `🔔` whose value is not a reminder stays in the text (title, colour or other value): its words are kept.
    let found: Vec<(usize, Marker, usize)> = all
        .iter()
        .enumerate()
        .filter(|&(n, &(i, kind, len))| {
            let end = all.get(n + 1).map_or(head.len(), |f| f.0);
            !matches!(kind, Marker::Reminder) || parse_reminder(head[i + len..end].trim()).is_some()
        })
        .map(|(_, &f)| f)
        .collect();
    let title = found.first().map_or(head, |f| &head[..f.0]).trim();
    let values = found
        .iter()
        .enumerate()
        .map(|(n, &(i, kind, len))| {
            let end = found.get(n + 1).map_or(head.len(), |f| f.0);
            (kind, head[i + len..end].trim())
        })
        .collect();
    (title, values)
}

fn ends_token(s: &str, dash: bool) -> bool {
    s.is_empty() || s.starts_with(' ') || (dash && s.starts_with('-'))
}

fn take_date(s: &str) -> Option<(i32, &str)> {
    Some((parse_iso(s.get(..10)?)?, &s[10..]))
}

/// `HH:MM`, returned as minutes since midnight.
fn take_time(s: &str) -> Option<(u16, &str)> {
    if s.as_bytes().get(2) != Some(&b':') {
        return None;
    }
    let h = two_digits(s.get(..2)?)?;
    let m = two_digits(s.get(3..5)?)?;
    (h < 24 && m < 60).then(|| (h * 60 + m, &s[5..]))
}

fn two_digits(s: &str) -> Option<u16> {
    if s.len() == 2 && s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

fn hhmm(minutes: u16) -> String {
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

fn date_str(day: i32) -> String {
    let (y, m, d) = civil_from_days(i64::from(day));
    format!("{y:04}-{m:02}-{d:02}")
}

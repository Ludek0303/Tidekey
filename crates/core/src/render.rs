//! Markdown to HTML for the reading view (ARCHITEKTURA §5). Note text is hostile: raw HTML is
//! shown as escaped text, only safe link targets keep an href, and table formulas show results.

use crate::formula::{self, Value};
use pulldown_cmark::{CowStr, Event, LinkType, Options, Parser, Tag, TagEnd};
use std::ops::Range;

fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_WIKILINKS
}

/// Renders note text as HTML. `today` is days since 1970-01-01 and feeds DZIŚ/TODAY.
pub fn render_html(md: &str, today: i32) -> String {
    let mut filter = Filter::default();
    let mut events = Vec::new();
    let mut parser = Parser::new_ext(md, options()).into_offset_iter();
    while let Some((ev, range)) = parser.next() {
        if !matches!(ev, Event::Start(Tag::Table(_))) {
            filter.map(ev, &mut events);
            continue;
        }
        let values = formula_values(md, range.clone(), today);
        let mut table = vec![(ev, range)];
        for (ev, r) in parser.by_ref() {
            let end = matches!(ev, Event::End(TagEnd::Table));
            table.push((ev, r));
            if end {
                break;
            }
        }
        table_events(&mut filter, md, table, values.as_deref(), &mut events);
    }
    let mut html = String::with_capacity(md.len() * 2);
    pulldown_cmark::html::push_html(&mut html, events.into_iter());
    html
}

#[derive(Clone, Copy)]
enum Open {
    Wiki,
    Keep,
    Drop,
}

/// Rewrites the event stream: note HTML becomes text, unsafe links and images lose their
/// href or src (their text stays), and wikilinks become `<a class="wikilink">` without href.
#[derive(Default)]
struct Filter {
    links: Vec<Open>,
}

impl Filter {
    fn map<'a>(&mut self, ev: Event<'a>, out: &mut Vec<Event<'a>>) {
        match ev {
            Event::Html(s) | Event::InlineHtml(s) => out.push(Event::Text(s)),
            Event::Start(tag) => {
                let open = match &tag {
                    Tag::Link {
                        link_type: LinkType::WikiLink { .. },
                        dest_url,
                        ..
                    }
                    | Tag::Image {
                        link_type: LinkType::WikiLink { .. },
                        dest_url,
                        ..
                    } => {
                        // `![[x]]`: an embed (an attachment, a server file); the UI fills it in by its target
                        let class = if matches!(tag, Tag::Image { .. }) { "wikilink embed" } else { "wikilink" };
                        let target = esc(dest_url);
                        out.push(raw(format!("<a class=\"{class}\" data-target=\"{target}\">")));
                        Open::Wiki
                    }
                    // shortcut: remote http images load at once, leaking read receipts and IP to
                    // the note's author; add an "images from the internet" setting and a CSP before v1.
                    Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }
                        if safe_url(dest_url) =>
                    {
                        Open::Keep
                    }
                    Tag::Link { .. } | Tag::Image { .. } => Open::Drop,
                    _ => {
                        out.push(Event::Start(tag));
                        return;
                    }
                };
                if matches!(open, Open::Keep) {
                    out.push(Event::Start(tag));
                }
                self.links.push(open);
            }
            Event::End(end @ (TagEnd::Link | TagEnd::Image)) => match self.links.pop() {
                Some(Open::Wiki) => out.push(raw("</a>".into())),
                Some(Open::Keep) => out.push(Event::End(end)),
                Some(Open::Drop) | None => {}
            },
            other => out.push(other),
        }
    }
}

/// Emits a table, replacing a formula cell's body with its result. A result is placed only where
/// the cell's own source text equals the formula cell at the same row and column, so a `\|` or a
/// ragged row can never move a value into another cell.
fn table_events<'a>(
    filter: &mut Filter,
    md: &str,
    table: Vec<(Event<'a>, Range<usize>)>,
    values: Option<&[Vec<(String, Value)>]>,
    out: &mut Vec<Event<'a>>,
) {
    // Row 0 is the header; `skip` drops the source text of a replaced cell.
    let (mut row, mut col, mut skip) = (0, 0, false);
    for (ev, range) in table {
        match ev {
            Event::Start(Tag::TableHead) => {
                row = 0;
                out.push(Event::Start(Tag::TableHead));
            }
            Event::Start(Tag::TableRow) => {
                row += 1;
                col = 0;
                out.push(Event::Start(Tag::TableRow));
            }
            Event::Start(Tag::TableCell) => {
                let c = col;
                col += 1;
                out.push(Event::Start(Tag::TableCell));
                let formula = values
                    .and_then(|v| v.get(row)?.get(c))
                    .filter(|(src, _)| src.starts_with('=') && *src == cell_source(md, &range));
                if let Some((src, value)) = formula {
                    out.push(result(src, value));
                    skip = true;
                }
            }
            Event::End(TagEnd::TableCell) => {
                skip = false;
                out.push(Event::End(TagEnd::TableCell));
            }
            _ if skip => {}
            other => filter.map(other, out),
        }
    }
}

/// The cell's source text without its surrounding spaces and pipes, with `\|` unescaped the way
/// `formula::parse_table` does, so the two can be compared.
fn cell_source(md: &str, range: &Range<usize>) -> String {
    let s = md.get(range.clone()).unwrap_or("").trim();
    let s = s.strip_prefix('|').unwrap_or(s);
    s.strip_suffix('|').unwrap_or(s).trim().replace("\\|", "|")
}

/// Evaluated cells of the table at `range`, or `None` if the source is not a GFM table.
fn formula_values(md: &str, range: Range<usize>, today: i32) -> Option<Vec<Vec<(String, Value)>>> {
    let cells = formula::parse_table(md.get(range)?)?;
    let values = formula::evaluate_table(&cells, today);
    Some(
        cells
            .into_iter()
            .zip(values)
            .map(|(src, vals)| src.into_iter().zip(vals).collect())
            .collect(),
    )
}

fn result(src: &str, value: &Value) -> Event<'static> {
    let class = match value {
        Value::Error(_) => "formula-result formula-error",
        Value::Number(_) => "formula-result formula-number",
        _ => "formula-result",
    };
    raw(format!(
        "<span class=\"{class}\" title=\"{}\">{}</span>",
        esc(src),
        esc(&value.to_string())
    ))
}

/// Only for HTML this module built itself; every value inside is already escaped.
fn raw(html: String) -> Event<'static> {
    Event::InlineHtml(CowStr::from(html))
}

/// Browsers ignore whitespace and control characters inside a scheme, so judge the URL without
/// them. Only a URL with no scheme (relative), or http, https and mailto, is kept. Protocol-relative
/// URLs (`//host`, `/\host`, `\host`) leave the app's origin too, so they are refused.
fn safe_url(url: &str) -> bool {
    let clean: String = url
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .collect::<String>()
        .to_ascii_lowercase();
    if clean.starts_with("//") || clean.starts_with("/\\") || clean.starts_with('\\') {
        return false;
    }
    let head = &clean[..clean.find(['/', '?', '#']).unwrap_or(clean.len())];
    match head.find(':') {
        None => true,
        Some(i) => matches!(&head[..i], "http" | "https" | "mailto"),
    }
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

//! Spreadsheet-style formulas for Markdown tables (ARCHITEKTURA §4.16a).
//! Pure functions: no clock, no I/O, so the same code runs in WASM.
//! Every limit turns the affected cell into an error value; nothing panics or grows without bound.

pub(crate) mod date;
mod eval;
mod parse;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_gfm;
#[cfg(test)]
mod tests_limits;

use parse::Addr;
use std::ops::Range;

/// Tables with more cells than this are not evaluated: formulas show #ARG!.
const CELL_LIMIT: usize = 65_536;
/// Formula nodes kept per table; formulas past this are #ARG!.
const NODE_LIMIT: usize = 1 << 20;
/// Cells visited while collecting dependencies, summed over all formulas.
const WORK_LIMIT: usize = 1 << 22;
/// Dependency edges kept per table.
const EDGE_LIMIT: usize = 1 << 21;
/// Bytes of text results kept per table.
const TEXT_LIMIT: usize = 8 << 20;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DateFmt {
    Iso,
    Dotted,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FormulaError {
    Ref,
    Div0,
    Name,
    Value,
    Cycle,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Empty,
    Number(f64),
    Text(String),
    Bool(bool),
    /// Days since 1970-01-01.
    Date(i32, DateFmt),
    Error(FormulaError),
}

impl std::fmt::Display for FormulaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Ref => "#ADR!",
            Self::Div0 => "#DZIEL/0!",
            Self::Name => "#NAZWA?",
            Self::Value => "#ARG!",
            Self::Cycle => "#CYKL!",
        })
    }
}

impl std::fmt::Display for Value {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => Ok(()),
            Self::Number(n) => f.write_str(&fmt_number(*n)),
            Self::Text(s) => f.write_str(s),
            Self::Bool(b) => f.write_str(if *b { "PRAWDA" } else { "FAŁSZ" }),
            Self::Date(d, fmt) => f.write_str(&date::format(*d, *fmt)),
            Self::Error(e) => write!(f, "{e}"),
        }
    }
}

/// GFM table text → trimmed cell strings. The delimiter row is dropped; the header is row 0,
/// and every row is cut to the header's column count.
/// `None` if the text does not start with a header row followed by a delimiter row.
pub fn parse_table(md: &str) -> Option<Vec<Vec<String>>> {
    let mut lines = md.trim().lines();
    let header = lines.next()?;
    let delimiter = lines.next()?;
    if !header.contains('|') || !is_delimiter(delimiter) {
        return None;
    }
    let mut rows = vec![split_row(header)];
    let width = rows[0].len();
    for line in lines {
        if !line.contains('|') {
            break;
        }
        let mut cells = split_row(line);
        cells.truncate(width);
        rows.push(cells);
    }
    Some(rows)
}

/// Evaluates every formula of a table. The result has the same shape as `cells`.
/// `today` is days since 1970-01-01 and feeds DZIŚ/TODAY.
pub fn evaluate_table(cells: &[Vec<String>], today: i32) -> Vec<Vec<Value>> {
    let rows = cells.len();
    let cols = cells.iter().map(Vec::len).max().unwrap_or(0);
    let n = rows.saturating_mul(cols);
    if n > CELL_LIMIT {
        // Too big for a dense grid: literals keep their value, formulas show #ARG!.
        return cells
            .iter()
            .map(|row| {
                row.iter()
                    .map(|s| {
                        if is_formula(s) {
                            Value::Error(FormulaError::Value)
                        } else {
                            literal(s)
                        }
                    })
                    .collect()
            })
            .collect();
    }
    let mut grid = eval::Grid {
        rows,
        cols,
        today,
        cells: vec![Value::Empty; n],
        nodes: Vec::with_capacity(2 * n),
        copy_budget: std::cell::Cell::new(eval::COPY_LIMIT),
    };
    // Formula cells: root node and the arena span of the formula's nodes.
    let mut exprs: Vec<Option<(usize, Range<usize>)>> = vec![None; n];
    // A cell is pending while it is a formula whose value is still to be computed.
    let mut pending = vec![false; n];
    let mut toks = Vec::new();
    for (r, row) in cells.iter().enumerate() {
        for (c, s) in row.iter().enumerate() {
            let i = r * cols + c;
            match s.trim().strip_prefix('=') {
                Some(body) => {
                    let start = grid.nodes.len();
                    if start >= NODE_LIMIT {
                        grid.cells[i] = Value::Error(FormulaError::Value);
                        continue;
                    }
                    match parse::parse(body, &mut grid.nodes, &mut toks) {
                        Some(root) => {
                            exprs[i] = Some((root, start..grid.nodes.len()));
                            pending[i] = true;
                        }
                        None => {
                            grid.nodes.truncate(start);
                            grid.cells[i] = Value::Error(FormulaError::Value);
                        }
                    }
                }
                None => grid.cells[i] = literal(s),
            }
        }
    }

    // Kahn's algorithm: a formula is ready once every pending formula it reads is done.
    // Cells left pending form a cycle or depend on one, and get #CYKL!.
    let (edges, waiting) = dependencies(&grid, &mut exprs, &pending);
    // CSR layout: targets[start[j]..start[j + 1]] are the dependents of cell j.
    let mut start = vec![0usize; n + 1];
    for &(j, _) in &edges {
        start[j + 1] += 1;
    }
    let mut acc = 0;
    for s in &mut start {
        acc += *s;
        *s = acc;
    }
    let mut fill = start.clone();
    let mut targets = vec![0usize; edges.len()];
    for &(j, i) in &edges {
        targets[fill[j]] = i;
        fill[j] += 1;
    }
    let mut waiting = waiting;
    let mut ready: Vec<usize> = (0..n).filter(|&i| pending[i] && waiting[i] == 0).collect();
    let mut text_used = 0usize;
    while let Some(i) = ready.pop() {
        // A formula dropped by a budget has no expression and yields #ARG!.
        let v = match &exprs[i] {
            Some((root, _)) => eval::eval(*root, &grid),
            None => Value::Error(FormulaError::Value),
        };
        grid.cells[i] = keep_text(v, &mut text_used);
        pending[i] = false;
        for &d in &targets[start[i]..start[i + 1]] {
            waiting[d] -= 1;
            if waiting[d] == 0 {
                ready.push(d);
            }
        }
    }
    for (i, p) in pending.iter().enumerate() {
        if *p {
            grid.cells[i] = Value::Error(FormulaError::Cycle);
        }
    }

    cells
        .iter()
        .enumerate()
        .map(|(r, row)| {
            (0..row.len())
                .map(|c| grid.cells[r * cols + c].clone())
                .collect()
        })
        .collect()
}

/// Dependency edges (dependency, dependent) and each formula's count of pending dependencies.
/// A formula that would exceed a budget loses its expression and reads as #ARG!, without edges.
fn dependencies(
    grid: &eval::Grid,
    exprs: &mut [Option<(usize, Range<usize>)>],
    pending: &[bool],
) -> (Vec<(usize, usize)>, Vec<usize>) {
    let n = exprs.len();
    let mut edges = Vec::new();
    let mut waiting = vec![0usize; n];
    let mut seen = vec![usize::MAX; n];
    let mut refs: Vec<(Addr, Addr)> = Vec::new();
    let mut deps: Vec<usize> = Vec::new();
    let mut work = 0usize;
    for i in 0..n {
        if !pending[i] {
            continue;
        }
        let Some((_, span)) = exprs[i].clone() else {
            continue;
        };
        // Work is counted over every reference, before duplicates are removed.
        refs.clear();
        let mut raw = 0usize;
        for (a, b) in parse::refs_in(&grid.nodes[span]) {
            if grid.index(a).is_some() && grid.index(b).is_some() {
                raw = raw.saturating_add(area(a, b));
                refs.push((a, b));
            }
        }
        if work.saturating_add(raw) > WORK_LIMIT {
            exprs[i] = None;
            continue;
        }
        work += raw;
        refs.sort_unstable();
        refs.dedup();
        deps.clear();
        for &(a, b) in &refs {
            for r in a.row.min(b.row)..=a.row.max(b.row) {
                for c in a.col.min(b.col)..=a.col.max(b.col) {
                    if let Some(j) = grid.index(Addr { col: c, row: r }) {
                        // Each dependency is recorded once per formula.
                        if pending[j] && seen[j] != i {
                            seen[j] = i;
                            deps.push(j);
                        }
                    }
                }
            }
        }
        if edges.len() + deps.len() > EDGE_LIMIT {
            exprs[i] = None;
            continue;
        }
        for &j in &deps {
            edges.push((j, i));
        }
        waiting[i] = deps.len();
    }
    (edges, waiting)
}

/// Number of cells in the rectangle spanned by two addresses.
fn area(a: Addr, b: Addr) -> usize {
    let rows = a.row.max(b.row) - a.row.min(b.row) + 1;
    let cols = a.col.max(b.col) - a.col.min(b.col) + 1;
    rows.saturating_mul(cols)
}

/// Total text kept per table is capped; a result over the cap becomes #ARG!.
fn keep_text(v: Value, used: &mut usize) -> Value {
    if let Value::Text(s) = &v {
        *used = used.saturating_add(s.len());
        if *used > TEXT_LIMIT {
            return Value::Error(FormulaError::Value);
        }
    }
    v
}

fn is_formula(s: &str) -> bool {
    s.trim().starts_with('=')
}

fn is_delimiter(line: &str) -> bool {
    let t = line.trim();
    t.contains('-') && t.chars().all(|c| matches!(c, '|' | ':' | '-' | ' ' | '\t'))
}

/// Splits one GFM row on unescaped `|`; `\|` inside a cell is a literal pipe.
fn split_row(line: &str) -> Vec<String> {
    let t = line.trim();
    let t = t.strip_prefix('|').unwrap_or(t);
    let mut cells = Vec::new();
    let mut cur = String::new();
    // False right after a closing pipe, so a trailing pipe does not open an empty cell.
    let mut open = true;
    let mut chars = t.chars();
    while let Some(c) = chars.next() {
        open = true;
        match c {
            // GFM: a backslash escapes the next character, so `\|` is a literal pipe and `\\|` splits.
            '\\' => match chars.next() {
                Some('|') => cur.push('|'),
                Some(n) => {
                    cur.push('\\');
                    cur.push(n);
                }
                None => cur.push('\\'),
            },
            '|' => {
                cells.push(cur.trim().to_string());
                cur.clear();
                open = false;
            }
            _ => cur.push(c),
        }
    }
    if open {
        cells.push(cur.trim().to_string());
    }
    cells
}

/// A cell that is not a formula: number, date or text.
fn literal(s: &str) -> Value {
    let t = s.trim();
    if t.is_empty() {
        return Value::Empty;
    }
    if let Some(n) = parse_number(t) {
        return Value::Number(n);
    }
    if let Some(d) = date::parse_iso(t) {
        return Value::Date(d, DateFmt::Iso);
    }
    if let Some(d) = date::parse_dotted(t) {
        return Value::Date(d, DateFmt::Dotted);
    }
    Value::Text(s.to_string())
}

fn parse_number(t: &str) -> Option<f64> {
    let body = t.strip_prefix('-').unwrap_or(t);
    let seps = body.bytes().filter(|&b| b == b'.' || b == b',').count();
    let digits = body.bytes().filter(u8::is_ascii_digit).count();
    if digits == 0 || seps > 1 || digits + seps != body.len() {
        return None;
    }
    if t.contains(',') {
        t.replace(',', ".").parse().ok()
    } else {
        t.parse().ok()
    }
}

fn fmt_number(x: f64) -> String {
    if x == 0.0 {
        return "0".to_string();
    }
    let mut s = if x.fract() == 0.0 && x.abs() < 1e15 {
        format!("{x:.0}")
    } else {
        format!("{x:.10}")
    };
    if s.contains('.') {
        s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    if s == "-0" {
        s = "0".to_string();
    }
    s.replace('.', ",")
}

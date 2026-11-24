//! Lexer and precedence-climbing parser for formulas (the text after `=`).
//! Nodes live in one arena per table and tokens borrow the cell text, so parsing
//! a formula allocates almost nothing (heap allocation dominates the 1000-cell budget).

use super::{FormulaError, Value};

// shortcut: token count limit keeps the lexer buffer bounded; a formula over 1024 tokens is #ARG!, raise it if real formulas need more
const MAX_TOKENS: usize = 1024;
// shortcut: recursion limit for parentheses, unary minus and function arguments; deeper nesting is #ARG!, raise with MAX_TREE_DEPTH
const MAX_DEPTH: usize = 64;
/// Longest expression tree accepted. The evaluator recurses once per level, so this bounds
/// its stack use. A left-leaning chain such as `1+1+...` counts one level per operator, so
/// about 64 operators is the most a single formula may chain.
pub(super) const MAX_TREE_DEPTH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Addr {
    /// 1-based column (A = 1).
    pub col: usize,
    /// 1-based row (the header row is 1); 0 is never inside a table.
    pub row: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Op {
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    Concat,
    Add,
    Sub,
    Mul,
    Div,
    Pow,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Func {
    Sum,
    Avg,
    Min,
    Max,
    Count,
    Round,
    If,
    Today,
    Date,
    Days,
    Year,
    Month,
    Day,
}

/// AST node. Children are indices into the table's node arena.
#[derive(Debug)]
pub(super) enum Node {
    Lit(Value),
    Ref(Addr),
    Range(Addr, Addr),
    Neg(usize),
    Bin(Op, usize, usize),
    /// `first op1 x1 op2 x2 ...` with operators of one left-to-right chain, folded in order.
    Chain(usize, Vec<(Op, usize)>),
    Call(Func, Vec<usize>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Tok<'a> {
    Num(f64),
    /// Raw text between the quotes; `""` escapes are still doubled.
    Str(&'a str),
    Name(&'a str),
    Bin(Op),
    LParen,
    RParen,
    Semi,
    Colon,
    /// Lexing error: no production accepts it, so the parse fails.
    Bad,
}

/// Parses a formula body (text after `=`) and appends its nodes to `nodes`.
/// Returns the root node index, or `None` on any syntax error or limit (the caller truncates `nodes`).
pub(super) fn parse<'a>(
    src: &'a str,
    nodes: &mut Vec<Node>,
    toks: &mut Vec<Tok<'a>>,
) -> Option<usize> {
    toks.clear();
    lex(src, toks);
    let mut p = Parser {
        toks: toks.as_slice(),
        pos: 0,
        depth: 0,
        nodes,
    };
    let (root, _) = p.expr(1)?;
    (p.pos == p.toks.len()).then_some(root)
}

/// Reference nodes in `nodes` as (from, to) pairs; a single cell gives `from == to`.
pub(super) fn refs_in(nodes: &[Node]) -> impl Iterator<Item = (Addr, Addr)> + '_ {
    nodes.iter().filter_map(|n| match n {
        Node::Ref(a) => Some((*a, *a)),
        Node::Range(a, b) => Some((*a, *b)),
        _ => None,
    })
}

fn lex<'a>(src: &'a str, toks: &mut Vec<Tok<'a>>) {
    let mut i = 0;
    while let Some(c) = src[i..].chars().next() {
        if c.is_whitespace() {
            i += c.len_utf8();
            continue;
        }
        if toks.len() == MAX_TOKENS {
            toks.push(Tok::Bad);
            return;
        }
        let next = src[i + c.len_utf8()..].chars().next();
        match lex_one(src, i, c, next) {
            Some((tok, end)) => {
                toks.push(tok);
                i = end;
            }
            None => {
                toks.push(Tok::Bad);
                return;
            }
        }
    }
}

fn lex_one(src: &str, i: usize, c: char, next: Option<char>) -> Option<(Tok<'_>, usize)> {
    if c.is_ascii_digit() || (matches!(c, '.' | ',') && next.is_some_and(|n| n.is_ascii_digit())) {
        lex_number(src, i)
    } else if c == '"' {
        lex_string(src, i)
    } else if c.is_alphabetic() || c == '$' {
        Some(lex_name(src, i))
    } else {
        let (tok, len) = sym(c, next)?;
        Some((tok, i + len))
    }
}

fn lex_number(src: &str, start: usize) -> Option<(Tok<'_>, usize)> {
    let bytes = src.as_bytes();
    let mut j = start;
    while bytes.get(j).is_some_and(u8::is_ascii_digit) {
        j += 1;
    }
    if matches!(bytes.get(j), Some(b'.' | b',')) {
        j += 1;
        while bytes.get(j).is_some_and(u8::is_ascii_digit) {
            j += 1;
        }
    }
    let text = &src[start..j];
    let n: f64 = if text.contains(',') {
        text.replace(',', ".").parse().ok()?
    } else {
        text.parse().ok()?
    };
    n.is_finite().then_some((Tok::Num(n), j))
}

fn lex_string(src: &str, start: usize) -> Option<(Tok<'_>, usize)> {
    let mut j = start + 1;
    loop {
        let c = src[j..].chars().next()?;
        if c == '"' {
            if src[j + 1..].starts_with('"') {
                j += 2;
                continue;
            }
            return Some((Tok::Str(&src[start + 1..j]), j + 1));
        }
        j += c.len_utf8();
    }
}

fn lex_name(src: &str, start: usize) -> (Tok<'_>, usize) {
    let mut j = start;
    while let Some(c) = src[j..]
        .chars()
        .next()
        .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '$'))
    {
        j += c.len_utf8();
    }
    (Tok::Name(&src[start..j]), j)
}

fn sym(c: char, next: Option<char>) -> Option<(Tok<'static>, usize)> {
    Some(match (c, next) {
        ('<', Some('>')) => (Tok::Bin(Op::Ne), 2),
        ('<', Some('=')) => (Tok::Bin(Op::Le), 2),
        ('>', Some('=')) => (Tok::Bin(Op::Ge), 2),
        ('(', _) => (Tok::LParen, 1),
        (')', _) => (Tok::RParen, 1),
        (';', _) => (Tok::Semi, 1),
        (':', _) => (Tok::Colon, 1),
        ('=', _) => (Tok::Bin(Op::Eq), 1),
        ('<', _) => (Tok::Bin(Op::Lt), 1),
        ('>', _) => (Tok::Bin(Op::Gt), 1),
        ('&', _) => (Tok::Bin(Op::Concat), 1),
        ('+', _) => (Tok::Bin(Op::Add), 1),
        ('-', _) => (Tok::Bin(Op::Sub), 1),
        ('*', _) => (Tok::Bin(Op::Mul), 1),
        ('/', _) => (Tok::Bin(Op::Div), 1),
        ('^', _) => (Tok::Bin(Op::Pow), 1),
        _ => return None,
    })
}

/// `B2` → Addr { col: 2, row: 2 }. Case-insensitive; `None` if the name is not a cell address.
pub(super) fn cell_addr(name: &str) -> Option<Addr> {
    // `$` marks absolute refs in Excel; formulas are never copied here, so it is accepted and ignored
    let name = name.strip_prefix('$').unwrap_or(name);
    let split = name.find(|c: char| c.is_ascii_digit() || c == '$')?;
    let (letters, rest) = name.split_at(split);
    let digits = rest.strip_prefix('$').unwrap_or(rest);
    if letters.is_empty()
        || digits.is_empty()
        || !letters.bytes().all(|b| b.is_ascii_alphabetic())
        || !digits.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let col = letters.bytes().fold(0usize, |acc, b| {
        acc.saturating_mul(26)
            .saturating_add(usize::from(b.to_ascii_uppercase() - b'A' + 1))
    });
    let row = digits.parse().unwrap_or(usize::MAX);
    Some(Addr { col, row })
}

fn func_of(name: &str) -> Option<Func> {
    Some(match name.to_uppercase().as_str() {
        "SUMA" | "SUM" => Func::Sum,
        "ŚREDNIA" | "AVERAGE" => Func::Avg,
        "MIN" => Func::Min,
        "MAX" => Func::Max,
        "ILE.LICZB" | "COUNT" => Func::Count,
        "ZAOKR" | "ROUND" => Func::Round,
        "JEŻELI" | "IF" => Func::If,
        "DZIŚ" | "TODAY" => Func::Today,
        "DATA" | "DATE" => Func::Date,
        "DNI" | "DAYS" => Func::Days,
        "ROK" | "YEAR" => Func::Year,
        "MIESIĄC" | "MONTH" => Func::Month,
        "DZIEŃ" | "DAY" => Func::Day,
        _ => return None,
    })
}

/// Binding strength of a binary operator; higher binds tighter. Unary minus binds tighter than all of them.
fn prec(op: Op) -> u8 {
    match op {
        Op::Eq | Op::Ne | Op::Lt | Op::Gt | Op::Le | Op::Ge => 1,
        Op::Concat => 2,
        Op::Add | Op::Sub => 3,
        Op::Mul | Op::Div => 4,
        Op::Pow => 5,
    }
}

/// Every parse function returns (node index, tree depth of that node).
struct Parser<'t, 'a, 'n> {
    toks: &'t [Tok<'a>],
    pos: usize,
    depth: usize,
    nodes: &'n mut Vec<Node>,
}

impl Parser<'_, '_, '_> {
    fn node(&mut self, n: Node, depth: usize) -> Option<(usize, usize)> {
        if depth > MAX_TREE_DEPTH {
            return None;
        }
        self.nodes.push(n);
        Some((self.nodes.len() - 1, depth))
    }

    fn eat(&mut self, t: &Tok) -> bool {
        if self.toks.get(self.pos) == Some(t) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn nest<T>(&mut self, f: impl FnOnce(&mut Self) -> Option<T>) -> Option<T> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        self.depth += 1;
        let out = f(self);
        self.depth -= 1;
        out
    }

    /// Precedence climbing: `min` is the weakest operator this call may consume.
    fn expr(&mut self, min: u8) -> Option<(usize, usize)> {
        let (first, mut depth) = self.unary()?;
        // `last` is the newest operator; earlier ones move to `rest`, which allocates only for chains.
        let mut last: Option<(Op, usize)> = None;
        let mut rest: Vec<(Op, usize)> = Vec::new();
        loop {
            let op = match self.toks.get(self.pos) {
                Some(Tok::Bin(op)) if prec(*op) >= min => *op,
                _ => break,
            };
            self.pos += 1;
            // Every operator groups to the left, `^` included, as in Excel and LibreOffice.
            let (right, right_depth) = self.nest(|p| p.expr(prec(op) + 1))?;
            depth = depth.max(right_depth);
            if let Some(prev) = last.replace((op, right)) {
                rest.push(prev);
            }
        }
        // Only real nesting adds depth: a chain of operators is one level, however long.
        match last {
            None => Some((first, depth)),
            Some((op, right)) if rest.is_empty() => {
                self.node(Node::Bin(op, first, right), depth + 1)
            }
            Some(item) => {
                rest.push(item);
                self.node(Node::Chain(first, rest), depth + 1)
            }
        }
    }

    fn unary(&mut self) -> Option<(usize, usize)> {
        if self.eat(&Tok::Bin(Op::Sub)) {
            let (inner, d) = self.nest(|p| p.unary())?;
            return self.node(Node::Neg(inner), d + 1);
        }
        self.primary()
    }

    fn primary(&mut self) -> Option<(usize, usize)> {
        let tok = *self.toks.get(self.pos)?;
        self.pos += 1;
        match tok {
            Tok::Num(n) => self.node(Node::Lit(Value::Number(n)), 1),
            Tok::Str(raw) => {
                let text = if raw.contains("\"\"") {
                    raw.replace("\"\"", "\"")
                } else {
                    raw.to_string()
                };
                self.node(Node::Lit(Value::Text(text)), 1)
            }
            Tok::LParen => {
                let (e, d) = self.nest(|p| p.expr(1))?;
                self.eat(&Tok::RParen).then_some((e, d))
            }
            Tok::Name(name) => {
                if self.eat(&Tok::LParen) {
                    let (args, d) = self.nest(|p| p.args())?;
                    return match func_of(name) {
                        Some(f) => self.node(Node::Call(f, args), d + 1),
                        None => self.node(Node::Lit(Value::Error(FormulaError::Name)), 1),
                    };
                }
                let Some(a) = cell_addr(name) else {
                    return self.node(Node::Lit(Value::Error(FormulaError::Name)), 1);
                };
                if self.eat(&Tok::Colon) {
                    let b = match self.toks.get(self.pos) {
                        Some(Tok::Name(b)) => cell_addr(b)?,
                        _ => return None,
                    };
                    self.pos += 1;
                    return self.node(Node::Range(a, b), 1);
                }
                self.node(Node::Ref(a), 1)
            }
            _ => None,
        }
    }

    /// Arguments up to and including `)`, with the deepest argument's depth.
    fn args(&mut self) -> Option<(Vec<usize>, usize)> {
        let mut out = Vec::new();
        let mut depth = 0;
        if self.eat(&Tok::RParen) {
            return Some((out, depth));
        }
        loop {
            let (a, d) = self.expr(1)?;
            out.push(a);
            depth = depth.max(d);
            if self.eat(&Tok::RParen) {
                return Some((out, depth));
            }
            if !self.eat(&Tok::Semi) {
                return None;
            }
        }
    }
}

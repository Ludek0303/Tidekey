//! Evaluates one parsed formula against the grid. Cells are resolved by the caller
//! in dependency order, so evaluation never recurses across cells.

use std::cell::Cell;
use std::cmp::Ordering;

use super::date;
use super::parse::{Addr, Func, Node, Op};
use super::{DateFmt, FormulaError, Value};

/// Longest text result, in characters (Excel's cell limit).
pub(super) const MAX_TEXT_CHARS: usize = 32_767;

/// Bytes of text that a table may copy or lowercase while evaluating, summed over all cells.
/// Every text read and compare draws on it, so one table cannot cost unbounded time.
pub(super) const COPY_LIMIT: usize = 16 << 20;

pub(super) struct Grid {
    pub(super) rows: usize,
    pub(super) cols: usize,
    pub(super) today: i32,
    pub(super) cells: Vec<Value>,
    pub(super) nodes: Vec<Node>,
    /// Text bytes still allowed to be copied or lowercased.
    pub(super) copy_budget: Cell<usize>,
}

impl Grid {
    /// Takes `bytes` from the copy budget; `false` when it is exhausted.
    fn charge(&self, bytes: usize) -> bool {
        let left = self.copy_budget.get();
        if bytes > left {
            return false;
        }
        self.copy_budget.set(left - bytes);
        true
    }

    /// Flat index of a cell inside the table, `None` if the address is outside it.
    pub(super) fn index(&self, a: Addr) -> Option<usize> {
        if a.col == 0 || a.row == 0 || a.col > self.cols || a.row > self.rows {
            return None;
        }
        Some((a.row - 1) * self.cols + (a.col - 1))
    }

    fn get(&self, a: Addr) -> Option<&Value> {
        self.index(a).map(|i| &self.cells[i])
    }

    fn range(&self, a: Addr, b: Addr) -> Option<Vec<&Value>> {
        self.index(a)?;
        self.index(b)?;
        let (c0, c1) = (a.col.min(b.col), a.col.max(b.col));
        let (r0, r1) = (a.row.min(b.row), a.row.max(b.row));
        Some(
            (r0..=r1)
                .flat_map(|r| (c0..=c1).map(move |c| &self.cells[(r - 1) * self.cols + (c - 1)]))
                .collect(),
        )
    }
}

/// Value of the node at `idx`; every cell it reads must already be resolved.
/// Recursion depth is bounded by the parser's tree-depth limit.
pub(super) fn eval(idx: usize, g: &Grid) -> Value {
    match &g.nodes[idx] {
        Node::Lit(v) => match v {
            Value::Text(s) if !g.charge(s.len()) => Value::Error(FormulaError::Value),
            _ => v.clone(),
        },
        Node::Ref(a) => match g.get(*a) {
            // A text longer than one cell may hold is not copied around at all.
            Some(Value::Text(s)) if s.len() > MAX_TEXT_CHARS || !g.charge(s.len()) => {
                Value::Error(FormulaError::Value)
            }
            Some(v) => v.clone(),
            None => Value::Error(FormulaError::Ref),
        },
        Node::Range(..) => Value::Error(FormulaError::Value),
        Node::Neg(x) => match eval(*x, g) {
            Value::Error(e) => Value::Error(e),
            v => num(&v).map_or(Value::Error(FormulaError::Value), |n| finish(-n)),
        },
        Node::Bin(op, a, b) => {
            let (l, r) = (eval(*a, g), eval(*b, g));
            binop(g, *op, &l, &r)
        }
        // Folded left to right, so `^` chains stay left-associative. Stops at the first error.
        Node::Chain(first, rest) => {
            let mut acc = eval(*first, g);
            for (op, idx) in rest {
                if matches!(acc, Value::Error(_)) {
                    break;
                }
                let r = eval(*idx, g);
                acc = binop(g, *op, &acc, &r);
            }
            acc
        }
        Node::Call(f, args) => call(*f, args, g).unwrap_or_else(Value::Error),
    }
}

fn binop(g: &Grid, op: Op, l: &Value, r: &Value) -> Value {
    match (l, r) {
        (Value::Error(e), _) | (_, Value::Error(e)) => Value::Error(*e),
        _ => match op {
            Op::Concat => concat(g, l, r),
            Op::Add | Op::Sub | Op::Mul | Op::Div | Op::Pow => arith(op, l, r),
            _ => compare(g, op, l, r),
        },
    }
}

/// Length check comes first, so an over-long result is never built.
fn concat(g: &Grid, l: &Value, r: &Value) -> Value {
    if chars(l) + chars(r) > MAX_TEXT_CHARS || !g.charge(bytes(l) + bytes(r)) {
        return Value::Error(FormulaError::Value);
    }
    Value::Text(format!("{l}{r}"))
}

fn bytes(v: &Value) -> usize {
    match v {
        Value::Empty => 0,
        Value::Text(s) => s.len(),
        other => other.to_string().len(),
    }
}

fn chars(v: &Value) -> usize {
    match v {
        Value::Empty => 0,
        Value::Text(s) => s.chars().count(),
        other => other.to_string().chars().count(),
    }
}

/// Numeric view of a value in arithmetic: Empty is 0, text and dates are not numbers.
fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Empty => Some(0.0),
        Value::Number(n) => Some(*n),
        _ => None,
    }
}

fn finish(n: f64) -> Value {
    if n.is_finite() {
        Value::Number(n)
    } else {
        Value::Error(FormulaError::Value)
    }
}

fn date_value(x: f64, fmt: DateFmt) -> Value {
    let t = x.trunc();
    if t >= f64::from(i32::MIN) && t <= f64::from(i32::MAX) {
        Value::Date(t as i32, fmt)
    } else {
        Value::Error(FormulaError::Value)
    }
}

fn arith(op: Op, l: &Value, r: &Value) -> Value {
    match (l, r) {
        (Value::Date(a, _), Value::Date(b, _)) if op == Op::Sub => {
            Value::Number(f64::from(*a) - f64::from(*b))
        }
        (Value::Date(a, fmt), _) if op == Op::Add || op == Op::Sub => match num(r) {
            Some(n) => date_value(
                if op == Op::Add {
                    f64::from(*a) + n
                } else {
                    f64::from(*a) - n
                },
                *fmt,
            ),
            None => Value::Error(FormulaError::Value),
        },
        (_, Value::Date(b, fmt)) if op == Op::Add => match num(l) {
            Some(n) => date_value(n + f64::from(*b), *fmt),
            None => Value::Error(FormulaError::Value),
        },
        (Value::Date(..), _) | (_, Value::Date(..)) => Value::Error(FormulaError::Value),
        _ => {
            let (Some(x), Some(y)) = (num(l), num(r)) else {
                return Value::Error(FormulaError::Value);
            };
            match op {
                Op::Add => finish(x + y),
                Op::Sub => finish(x - y),
                Op::Mul => finish(x * y),
                Op::Div if y == 0.0 => Value::Error(FormulaError::Div0),
                Op::Div => finish(x / y),
                Op::Pow => finish(x.powf(y)),
                _ => Value::Error(FormulaError::Value),
            }
        }
    }
}

fn compare(g: &Grid, op: Op, l: &Value, r: &Value) -> Value {
    // Empty compares as the other side's zero: 0 for numbers, "" for text.
    let zero = Value::Number(0.0);
    let blank = Value::Text(String::new());
    let (l, r) = match (l, r) {
        (Value::Empty, Value::Number(_)) => (&zero, r),
        (Value::Number(_), Value::Empty) => (l, &zero),
        (Value::Empty, Value::Text(_)) => (&blank, r),
        (Value::Text(_), Value::Empty) => (l, &blank),
        _ => (l, r),
    };
    let ord = match (l, r) {
        (Value::Empty, Value::Empty) => Some(Ordering::Equal),
        (Value::Number(a), Value::Number(b)) => a.partial_cmp(b),
        (Value::Date(a, _), Value::Date(b, _)) => Some(a.cmp(b)),
        (Value::Bool(a), Value::Bool(b)) => Some(a.cmp(b)),
        (Value::Text(a), Value::Text(b)) => {
            if !g.charge(a.len() + b.len()) {
                return Value::Error(FormulaError::Value);
            }
            Some(a.to_lowercase().cmp(&b.to_lowercase()))
        }
        _ => None,
    };
    match ord {
        Some(o) => Value::Bool(match op {
            Op::Eq => o == Ordering::Equal,
            Op::Ne => o != Ordering::Equal,
            Op::Lt => o == Ordering::Less,
            Op::Gt => o == Ordering::Greater,
            Op::Le => o != Ordering::Greater,
            Op::Ge => o != Ordering::Less,
            _ => false,
        }),
        // Mixed types are simply unequal; ordering them is an error.
        None => match op {
            Op::Eq => Value::Bool(false),
            Op::Ne => Value::Bool(true),
            _ => Value::Error(FormulaError::Value),
        },
    }
}

/// Rounds half away from zero. The small relative nudge makes decimal halves such as
/// 1,005 (stored as 1.00499999…) round up as a person expects.
fn round_half(y: f64) -> f64 {
    let nudge = (y.abs() * 4.0 * f64::EPSILON).copysign(y);
    (y + nudge).round()
}

fn call(f: Func, args: &[usize], g: &Grid) -> Result<Value, FormulaError> {
    let bad = FormulaError::Value;
    match f {
        Func::If => {
            let [c, a, b] = args else { return Err(bad) };
            let cond = match eval(*c, g) {
                Value::Bool(b) => b,
                Value::Number(n) => n != 0.0,
                Value::Error(e) => return Err(e),
                _ => return Err(bad),
            };
            Ok(eval(if cond { *a } else { *b }, g))
        }
        Func::Today => {
            let [] = args else { return Err(bad) };
            Ok(Value::Date(g.today, DateFmt::Iso))
        }
        Func::Round => {
            let [x, d] = args else { return Err(bad) };
            let (x, d) = (num_arg(*x, g)?, num_arg(*d, g)?.trunc());
            // Beyond 15 digits a double already has no more to round; far below -308 the result is 0.
            if d > 15.0 {
                return Ok(Value::Number(x));
            }
            if d < -308.0 {
                return Ok(Value::Number(0.0));
            }
            let r = if d >= 0.0 {
                let k = 10f64.powi(d as i32);
                let y = x * k;
                if y.is_finite() { round_half(y) / k } else { x }
            } else {
                let k = 10f64.powi((-d) as i32);
                round_half(x / k) * k
            };
            if r.is_finite() {
                Ok(Value::Number(r))
            } else {
                Err(bad)
            }
        }
        Func::Date => {
            let [y, m, d] = args else { return Err(bad) };
            let y = num_arg(*y, g)?.trunc() as i64;
            let m = num_arg(*m, g)?.trunc() as i64;
            let d = num_arg(*d, g)?.trunc() as i64;
            if !(0..=9999).contains(&y) {
                return Err(bad);
            }
            date::from_ymd(y, m, d)
                .map(|days| Value::Date(days, DateFmt::Iso))
                .ok_or(bad)
        }
        Func::Days => {
            let [end, start] = args else { return Err(bad) };
            let (end, _) = date_arg(*end, g)?;
            let (start, _) = date_arg(*start, g)?;
            Ok(Value::Number(f64::from(end) - f64::from(start)))
        }
        Func::Year | Func::Month | Func::Day => {
            let [d] = args else { return Err(bad) };
            let (d, _) = date_arg(*d, g)?;
            let (y, m, day) = date::civil_from_days(i64::from(d));
            let part = match f {
                Func::Year => y,
                Func::Month => m,
                _ => day,
            };
            Ok(Value::Number(part as f64))
        }
        Func::Sum | Func::Avg | Func::Min | Func::Max | Func::Count => {
            let items = collect(args, g)?;
            let nums = items.iter().filter_map(|v| {
                if let Value::Number(n) = v {
                    Some(*n)
                } else {
                    None
                }
            });
            match f {
                Func::Sum => Ok(finish(nums.sum())),
                Func::Avg => {
                    let (sum, n) = nums.fold((0.0, 0usize), |(s, c), x| (s + x, c + 1));
                    if n == 0 {
                        Err(FormulaError::Div0)
                    } else {
                        Ok(finish(sum / n as f64))
                    }
                }
                Func::Count => Ok(Value::Number(items.len() as f64)),
                Func::Min => Ok(min_max(&items, false)),
                _ => Ok(min_max(&items, true)),
            }
        }
    }
}

fn num_arg(idx: usize, g: &Grid) -> Result<f64, FormulaError> {
    match eval(idx, g) {
        Value::Error(e) => Err(e),
        v => num(&v).ok_or(FormulaError::Value),
    }
}

fn date_arg(idx: usize, g: &Grid) -> Result<(i32, DateFmt), FormulaError> {
    match eval(idx, g) {
        Value::Date(d, fmt) => Ok((d, fmt)),
        Value::Error(e) => Err(e),
        _ => Err(FormulaError::Value),
    }
}

/// Adds one cell to aggregate input: numbers and dates count, text and booleans are skipped,
/// errors propagate.
fn add_cell(items: &mut Vec<Value>, v: &Value) -> Result<(), FormulaError> {
    match v {
        Value::Error(e) => Err(*e),
        Value::Number(_) | Value::Date(..) => {
            items.push(v.clone());
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Values that aggregates use. A range or a single reference skips text and booleans;
/// a literal or computed argument that is text or a boolean is an error.
fn collect(args: &[usize], g: &Grid) -> Result<Vec<Value>, FormulaError> {
    let mut items = Vec::new();
    for &a in args {
        match &g.nodes[a] {
            Node::Range(x, y) => {
                for v in g.range(*x, *y).ok_or(FormulaError::Ref)? {
                    add_cell(&mut items, v)?;
                }
            }
            Node::Ref(x) => add_cell(&mut items, g.get(*x).ok_or(FormulaError::Ref)?)?,
            _ => match eval(a, g) {
                Value::Error(e) => return Err(e),
                v @ (Value::Number(_) | Value::Date(..)) => items.push(v),
                Value::Empty => {}
                _ => return Err(FormulaError::Value),
            },
        }
    }
    Ok(items)
}

/// MIN/MAX: a date if every used value is a date, otherwise a number (dates as day counts).
fn min_max(items: &[Value], max: bool) -> Value {
    if items.is_empty() {
        return Value::Number(0.0);
    }
    let dates: Vec<(i32, DateFmt)> = items
        .iter()
        .filter_map(|v| {
            if let Value::Date(d, fmt) = v {
                Some((*d, *fmt))
            } else {
                None
            }
        })
        .collect();
    if dates.len() == items.len() {
        let best = if max {
            dates.iter().max_by_key(|x| x.0)
        } else {
            dates.iter().min_by_key(|x| x.0)
        };
        return best.map_or(Value::Number(0.0), |&(d, fmt)| Value::Date(d, fmt));
    }
    let days = items.iter().map(|v| match v {
        Value::Number(n) => *n,
        Value::Date(d, _) => f64::from(*d),
        _ => 0.0,
    });
    let best = if max {
        days.fold(f64::NEG_INFINITY, f64::max)
    } else {
        days.fold(f64::INFINITY, f64::min)
    };
    finish(best)
}

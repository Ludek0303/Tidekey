//! The RRULE subset of RFC 5545 used by calendar events (ARCHITEKTURA §4.16b): FREQ, INTERVAL,
//! BYMONTH, BYDAY, BYMONTHDAY, COUNT and UNTIL. Any other part (BYSETPOS, unknown keys, invalid
//! values) is kept verbatim in `Rule::extra` and written back, so editing a line never rewrites
//! the user's rule; such a rule is not expanded (see `Rule::supported`).

use crate::formula::date::{civil_from_days, from_ymd};

/// Caps on list parts. A longer (distinct) list goes to `extra`, which makes the rule unsupported.
const MAX_BY_DAY: usize = 35;
const MAX_BY_MONTH_DAY: usize = 62;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Weekday {
    Mo,
    Tu,
    We,
    Th,
    Fr,
    Sa,
    Su,
}

/// `FREQ=…` with its parts. `until` is a day number, inclusive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub freq: Freq,
    pub interval: u32,
    /// Months 1..=12, in the order written.
    pub by_month: Vec<u8>,
    /// `(ordinal, weekday)`: `2TU` is `(Some(2), Tu)`, `-1FR` is `(Some(-1), Fr)`.
    pub by_day: Vec<(Option<i8>, Weekday)>,
    pub by_month_day: Vec<i8>,
    pub count: Option<u32>,
    pub until: Option<i32>,
    /// Parts this module does not expand (`BYSETPOS=-1`, unknown keys, invalid values), verbatim.
    pub extra: Vec<String>,
}

impl Rule {
    /// `true` if `expand` can produce the rule's real occurrences: nothing in `extra`, and no
    /// combination that needs a rule this module lacks (ordinals outside MONTHLY/YEARLY, YEARLY
    /// with BYMONTHDAY or ordinal BYDAY but no BYMONTH). `WKST=MO` is the default and always fine.
    pub fn supported(&self) -> bool {
        let ordinal = self.by_day.iter().any(|(o, _)| o.is_some());
        self.extra.is_empty()
            && match self.freq {
                Freq::Daily | Freq::Weekly => !ordinal,
                Freq::Monthly => true,
                Freq::Yearly => {
                    !self.by_month.is_empty() || (!ordinal && self.by_month_day.is_empty())
                }
            }
    }
}

impl Freq {
    fn parse(s: &str) -> Option<Freq> {
        Some(match s {
            "DAILY" => Freq::Daily,
            "WEEKLY" => Freq::Weekly,
            "MONTHLY" => Freq::Monthly,
            "YEARLY" => Freq::Yearly,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Freq::Daily => "DAILY",
            Freq::Weekly => "WEEKLY",
            Freq::Monthly => "MONTHLY",
            Freq::Yearly => "YEARLY",
        }
    }
}

impl Weekday {
    /// Monday first, the order of day numbers modulo 7 (ISO week).
    pub const ALL: [Weekday; 7] = [
        Weekday::Mo,
        Weekday::Tu,
        Weekday::We,
        Weekday::Th,
        Weekday::Fr,
        Weekday::Sa,
        Weekday::Su,
    ];

    /// Weekday of a day number; 1970-01-01 was a Thursday.
    pub fn of_day(day: i64) -> Weekday {
        Self::ALL[(day + 3).rem_euclid(7) as usize]
    }

    fn code(self) -> &'static str {
        ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][self as usize]
    }

    fn from_code(s: &str) -> Option<Weekday> {
        Self::ALL.into_iter().find(|w| w.code() == s)
    }
}

/// `None` only for an invalid or missing FREQ. Every other part that is not understood goes to
/// `Rule::extra` verbatim.
pub fn parse_rrule(s: &str) -> Option<Rule> {
    let mut freq = None;
    let mut rule = Rule {
        freq: Freq::Daily,
        interval: 1,
        by_month: Vec::new(),
        by_day: Vec::new(),
        by_month_day: Vec::new(),
        count: None,
        until: None,
        extra: Vec::new(),
    };
    let mut seen: Vec<String> = Vec::new();
    for part in s.split(';').map(str::trim).filter(|p| !p.is_empty()) {
        let Some((key, value)) = part.split_once('=') else {
            rule.extra.push(part.to_string());
            continue;
        };
        let key = key.trim().to_ascii_uppercase();
        let value = value.trim();
        if key == "FREQ" {
            let parsed = Freq::parse(&value.to_ascii_uppercase())?;
            if freq.is_none() {
                freq = Some(parsed);
                continue;
            }
        }
        let duplicate = seen.contains(&key);
        seen.push(key.clone());
        if duplicate || !apply(&mut rule, &key, value) {
            rule.extra.push(part.to_string());
        }
    }
    rule.freq = freq?;
    Some(rule)
}

/// Sets one known part. `false` if the value is invalid (the caller keeps the part verbatim).
fn apply(rule: &mut Rule, key: &str, value: &str) -> bool {
    match key {
        "INTERVAL" => match value.parse() {
            Ok(n) if n >= 1 => rule.interval = n,
            _ => return false,
        },
        "COUNT" => match value.parse() {
            Ok(n) if n >= 1 => rule.count = Some(n),
            _ => return false,
        },
        "UNTIL" => match parse_until(value) {
            Some(day) => rule.until = Some(day),
            None => return false,
        },
        "BYMONTH" => {
            let months = value
                .split(',')
                .map(|t| t.trim().parse().ok().filter(|m| (1..=12).contains(m)));
            match distinct(months, 12) {
                Some(v) => rule.by_month = v,
                None => return false,
            }
        }
        "BYDAY" => match distinct(value.split(',').map(parse_byday), MAX_BY_DAY) {
            Some(v) => rule.by_day = v,
            None => return false,
        },
        "BYMONTHDAY" => {
            let days = value.split(',').map(|t| {
                t.trim()
                    .parse::<i8>()
                    .ok()
                    .filter(|n| (-31..=31).contains(n) && *n != 0)
            });
            match distinct(days, MAX_BY_MONTH_DAY) {
                Some(v) => rule.by_month_day = v,
                None => return false,
            }
        }
        // Monday is the default week start, so the part is redundant and dropped.
        "WKST" => return value.eq_ignore_ascii_case("MO"),
        _ => return false,
    }
    true
}

/// The distinct values of a list (first occurrence kept). `None` if an item is invalid, the list
/// is empty, or it has more than `cap` distinct values.
fn distinct<T: PartialEq>(items: impl Iterator<Item = Option<T>>, cap: usize) -> Option<Vec<T>> {
    let mut out: Vec<T> = Vec::new();
    for item in items {
        let item = item?;
        if !out.contains(&item) {
            if out.len() == cap {
                return None;
            }
            out.push(item);
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Canonical order: FREQ, INTERVAL (only if above 1), BYMONTH, BYDAY, BYMONTHDAY, COUNT, UNTIL,
/// then the `extra` parts as they were written.
pub fn format_rrule(rule: &Rule) -> String {
    let mut parts = vec![format!("FREQ={}", rule.freq.name())];
    if rule.interval > 1 {
        parts.push(format!("INTERVAL={}", rule.interval));
    }
    if !rule.by_month.is_empty() {
        let months: Vec<String> = rule.by_month.iter().map(u8::to_string).collect();
        parts.push(format!("BYMONTH={}", months.join(",")));
    }
    if !rule.by_day.is_empty() {
        let days: Vec<String> = rule
            .by_day
            .iter()
            .map(|(ord, wd)| match ord {
                Some(n) => format!("{n}{}", wd.code()),
                None => wd.code().to_string(),
            })
            .collect();
        parts.push(format!("BYDAY={}", days.join(",")));
    }
    if !rule.by_month_day.is_empty() {
        let days: Vec<String> = rule.by_month_day.iter().map(i8::to_string).collect();
        parts.push(format!("BYMONTHDAY={}", days.join(",")));
    }
    if let Some(count) = rule.count {
        parts.push(format!("COUNT={count}"));
    }
    if let Some(until) = rule.until {
        let (y, m, d) = civil_from_days(i64::from(until));
        parts.push(format!("UNTIL={y:04}{m:02}{d:02}"));
    }
    parts.extend(rule.extra.iter().cloned());
    parts.join(";")
}

/// `2TU`, `-1FR`, `MO`. `None` for anything else.
fn parse_byday(token: &str) -> Option<(Option<i8>, Weekday)> {
    let token = token.trim().to_ascii_uppercase();
    let split = token.len().checked_sub(2)?;
    let weekday = Weekday::from_code(token.get(split..)?)?;
    let prefix = token.get(..split)?;
    let ord = if prefix.is_empty() {
        None
    } else {
        Some(
            prefix
                .parse::<i8>()
                .ok()
                .filter(|n| (-53..=53).contains(n) && *n != 0)?,
        )
    };
    Some((ord, weekday))
}

/// `YYYYMMDD`, optionally followed by a time (`T…`), which is ignored: events are local dates.
fn parse_until(value: &str) -> Option<i32> {
    let date = value.get(..8)?;
    if value.len() > 8 && value.as_bytes()[8] != b'T' {
        return None;
    }
    if !date.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    from_ymd(
        date[0..4].parse().ok()?,
        date[4..6].parse().ok()?,
        date[6..8].parse().ok()?,
    )
}

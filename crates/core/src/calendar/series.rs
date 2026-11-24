//! The occurrences of one event, generated period by period. `mod.rs` merges them in `expand`.

use super::rrule::{Freq, Rule, Weekday};
use super::{Event, MAX_STEPS, MINUTES_PER_DAY, Occurrence};
use crate::formula::date::{civil_from_days, days_from_civil};

/// Work units for one period of `rule`, see `WORK_BUDGET`: days examined, times the lists checked.
pub(super) fn period_cost(rule: &Rule) -> u64 {
    let lists = (1 + rule.by_day.len() + rule.by_month_day.len() + rule.by_month.len()) as u64;
    match rule.freq {
        Freq::Daily => lists,
        Freq::Weekly => 7 * lists,
        Freq::Monthly => 31 * lists,
        // One month per year, unless BYMONTH lists several or BYDAY without ordinals checks all.
        Freq::Yearly => {
            let months = if !rule.by_month.is_empty() {
                rule.by_month.len() as u64
            } else if rule.by_day.is_empty() {
                1
            } else {
                12
            };
            31 * months * (1 + rule.by_day.len() + rule.by_month_day.len()) as u64
        }
    }
}

/// Occurrences of one event in chronological order, generated period by period.
pub(super) struct Series<'a> {
    index: usize,
    event: &'a Event,
    /// `None` for a non-recurring event, or a rule that `Rule::supported` rejects: only the start
    /// is shown then.
    rule: Option<&'a Rule>,
    start: i64,
    start_min: i64,
    /// Minutes from the start to the end of the event.
    length: i64,
    from: i64,
    /// Last start day to generate: the query end, or UNTIL if earlier.
    upper: i64,
    /// Monday of the start week.
    monday: i64,
    /// Year, month and day of the start.
    ymd: (i64, i64, i64),
    /// Sorted, for binary search.
    exdates: Vec<i64>,
    /// Next period index to generate.
    period: i64,
    buf: Vec<i64>,
    pos: usize,
    /// Occurrences generated so far, exdates included (COUNT counts them, as RFC 5545 does).
    generated: u32,
    steps: u32,
    /// Work this series may still spend: its share of the budget.
    allowance: u64,
    /// Stopped on a limit while occurrences could still follow.
    pub(super) cut: bool,
    done: bool,
}

impl<'a> Series<'a> {
    pub(super) fn new(index: usize, event: &'a Event, from: i64, to: i64, allowance: u64) -> Self {
        let start = i64::from(event.start_day);
        let end_day = i64::from(event.end_day);
        let length = match (event.start_min, event.end_min) {
            (Some(s), Some(e)) => (end_day - start) * MINUTES_PER_DAY + i64::from(e) - i64::from(s),
            _ => (end_day - start) * MINUTES_PER_DAY,
        };
        let rule = event.rrule.as_ref().filter(|r| r.supported());
        let upper = rule
            .and_then(|r| r.until)
            .map_or(to, |u| to.min(i64::from(u)));
        let mut exdates: Vec<i64> = event.exdates.iter().map(|&d| i64::from(d)).collect();
        exdates.sort_unstable();
        exdates.dedup();
        let mut series = Series {
            index,
            event,
            rule,
            start,
            start_min: event.start_min.map_or(0, i64::from),
            length: length.max(0),
            from,
            upper,
            monday: start - (start + 3).rem_euclid(7),
            ymd: civil_from_days(start),
            exdates,
            period: 0,
            buf: Vec::new(),
            pos: 0,
            generated: 0,
            steps: 0,
            allowance,
            cut: false,
            done: false,
        };
        let lower = from - series.length / MINUTES_PER_DAY - 2;
        match rule {
            None => {
                series.buf = vec![start];
                series.done = true;
            }
            Some(r) if r.count.is_none() => series.period = series.first_period(r, lower),
            Some(r) => series.skip_counted(r, lower),
        }
        series
    }

    /// Skips periods that end before `lower`, so a far-away window is cheap.
    fn first_period(&self, rule: &Rule, lower: i64) -> i64 {
        let iv = i64::from(rule.interval);
        let k = match rule.freq {
            Freq::Daily => (lower - self.start).div_euclid(iv),
            Freq::Weekly => (lower - self.monday).div_euclid(7 * iv),
            Freq::Monthly => {
                let (y, m, _) = civil_from_days(lower);
                (y * 12 + m - 1 - (self.ymd.0 * 12 + self.ymd.1 - 1)).div_euclid(iv)
            }
            Freq::Yearly => (civil_from_days(lower).0 - self.ymd.0).div_euclid(iv),
        };
        (k - 1).max(0)
    }

    /// COUNT fast-forward. Periods after the first have the same number of occurrences in these
    /// cases, so the count before a period is computed, not walked: DAILY and WEEKLY without month
    /// filters, MONTHLY and YEARLY without BY* parts (start day up to 28; not Feb 29). Other COUNT
    /// rules are walked from DTSTART.
    fn skip_counted(&mut self, rule: &Rule, lower: i64) {
        let plain =
            rule.by_day.is_empty() && rule.by_month.is_empty() && rule.by_month_day.is_empty();
        let uniform = match rule.freq {
            Freq::Daily => plain,
            Freq::Weekly => rule.by_month.is_empty() && rule.by_month_day.is_empty(),
            Freq::Monthly => plain && self.ymd.2 <= 28,
            Freq::Yearly => plain && !(self.ymd.1 == 2 && self.ymd.2 == 29),
        };
        let k0 = self.first_period(rule, lower);
        if !uniform || k0 < 1 {
            return;
        }
        let per_period = self.candidates(rule, 1).len() as u64;
        let before = self.candidates(rule, 0).len() as u64 + (k0 as u64 - 1) * per_period;
        self.period = k0;
        self.generated = u32::try_from(before).unwrap_or(u32::MAX);
    }

    /// First day of period `k`.
    fn anchor(&self, rule: &Rule, k: i64) -> i64 {
        let step = k * i64::from(rule.interval);
        match rule.freq {
            Freq::Daily => self.start + step,
            Freq::Weekly => self.monday + 7 * step,
            Freq::Monthly => {
                let months = self.ymd.0 * 12 + self.ymd.1 - 1 + step;
                days_from_civil(months.div_euclid(12), months.rem_euclid(12) + 1, 1)
            }
            Freq::Yearly => days_from_civil(self.ymd.0 + step, 1, 1),
        }
    }

    /// Start days of period `k`, sorted. The start itself is always the first occurrence.
    fn candidates(&self, rule: &Rule, k: i64) -> Vec<i64> {
        let anchor = self.anchor(rule, k);
        let mut days = match rule.freq {
            Freq::Daily => vec![anchor],
            Freq::Weekly => (0..7).map(|i| anchor + i).collect(),
            Freq::Monthly => self.month_days(rule, anchor),
            Freq::Yearly => {
                let year = civil_from_days(anchor).0;
                let months: Vec<i64> = if !rule.by_month.is_empty() {
                    rule.by_month.iter().map(|&m| i64::from(m)).collect()
                } else if rule.by_day.is_empty() {
                    vec![self.ymd.1]
                } else {
                    (1..=12).collect()
                };
                months
                    .into_iter()
                    .flat_map(|m| self.month_days(rule, days_from_civil(year, m, 1)))
                    .collect()
            }
        };
        if matches!(rule.freq, Freq::Daily | Freq::Weekly) {
            days.retain(|&d| self.day_ok(rule, d));
        }
        if k == 0 {
            days.retain(|&d| d >= self.start);
            days.push(self.start);
        }
        days.sort_unstable();
        days.dedup();
        days
    }

    /// DAILY and WEEKLY: BYDAY (without ordinals), BYMONTH and BYMONTHDAY filter the days. A
    /// WEEKLY rule without BYDAY repeats on the start's weekday.
    fn day_ok(&self, rule: &Rule, d: i64) -> bool {
        let weekday_ok = if rule.by_day.is_empty() {
            rule.freq == Freq::Daily || Weekday::of_day(d) == Weekday::of_day(self.start)
        } else {
            rule.by_day.iter().any(|&(_, w)| w == Weekday::of_day(d))
        };
        if !weekday_ok {
            return false;
        }
        if rule.by_month.is_empty() && rule.by_month_day.is_empty() {
            return true;
        }
        let (y, m, day) = civil_from_days(d);
        month_ok(rule, m)
            && (rule.by_month_day.is_empty()
                || rule
                    .by_month_day
                    .iter()
                    .any(|&v| resolve_month_day(v, month_len(y, m)) == Some(day)))
    }

    /// MONTHLY and YEARLY: the days of the month that starts at `first`. BYDAY (with ordinals) and
    /// BYMONTHDAY narrow them. Without either, the start's day of the month is used, and months
    /// that lack it are skipped (RFC 5545).
    fn month_days(&self, rule: &Rule, first: i64) -> Vec<i64> {
        let (y, m, _) = civil_from_days(first);
        if !month_ok(rule, m) {
            return Vec::new();
        }
        let len = month_len(y, m);
        let mut out = Vec::new();
        if !rule.by_day.is_empty() {
            for &(ord, wd) in &rule.by_day {
                let days: Vec<i64> = (1..=len)
                    .map(|d| first + d - 1)
                    .filter(|&d| Weekday::of_day(d) == wd)
                    .collect();
                match ord {
                    None => out.extend(days),
                    Some(n) => {
                        let n = i64::from(n);
                        let idx = if n > 0 { n - 1 } else { days.len() as i64 + n };
                        if let Some(&d) = usize::try_from(idx).ok().and_then(|i| days.get(i)) {
                            out.push(d);
                        }
                    }
                }
            }
            if !rule.by_month_day.is_empty() {
                out.retain(|&d| {
                    rule.by_month_day
                        .iter()
                        .any(|&v| resolve_month_day(v, len) == Some(d - first + 1))
                });
            }
        } else if !rule.by_month_day.is_empty() {
            out.extend(
                rule.by_month_day
                    .iter()
                    .filter_map(|&v| resolve_month_day(v, len))
                    .map(|d| first + d - 1),
            );
        } else if self.ymd.2 <= len {
            out.push(first + self.ymd.2 - 1);
        }
        out
    }

    /// Next start day in order, or `None` when the series is over.
    fn next_start(&mut self, left: &mut u64) -> Option<i64> {
        if self.pos == self.buf.len() && !self.refill(left) {
            return None;
        }
        let day = self.buf[self.pos];
        self.pos += 1;
        let counted_out = self
            .rule
            .and_then(|r| r.count)
            .is_some_and(|c| self.generated >= c);
        if day > self.upper || counted_out {
            self.done = true;
            return None;
        }
        self.generated += 1;
        Some(day)
    }

    /// Loads the next non-empty period. Stops when the period starts after `upper` (the normal
    /// end), or, marking `cut`, when the step limit, this series' allowance or the shared budget
    /// runs out.
    fn refill(&mut self, left: &mut u64) -> bool {
        let Some(rule) = self.rule else {
            self.done = true;
            return false;
        };
        let cost = period_cost(rule);
        while !self.done {
            let k = self.period;
            if self.anchor(rule, k) > self.upper {
                self.done = true;
                break;
            }
            if self.steps >= MAX_STEPS || self.allowance < cost || *left < cost {
                self.cut = true;
                self.done = true;
                break;
            }
            self.allowance -= cost;
            *left -= cost;
            self.steps += 1;
            self.period += 1;
            self.buf = self.candidates(rule, k);
            self.pos = 0;
            if !self.buf.is_empty() {
                return true;
            }
        }
        false
    }

    pub(super) fn next_occurrence(&mut self, left: &mut u64) -> Option<Occurrence> {
        loop {
            let day = self.next_start(left)?;
            if self.rule.is_some() && self.exdates.binary_search(&day).is_ok() {
                continue;
            }
            let total = day * MINUTES_PER_DAY + self.start_min + self.length;
            let end_day = i32::try_from(total.div_euclid(MINUTES_PER_DAY)).ok()?;
            if i64::from(end_day) < self.from {
                continue;
            }
            return Some(Occurrence {
                event_index: self.index,
                start_day: i32::try_from(day).ok()?,
                start_min: self.event.start_min,
                end_day,
                end_min: self
                    .event
                    .start_min
                    .map(|_| total.rem_euclid(MINUTES_PER_DAY) as u16),
            });
        }
    }
}

fn month_ok(rule: &Rule, m: i64) -> bool {
    rule.by_month.is_empty() || rule.by_month.iter().any(|&b| i64::from(b) == m)
}

/// Days in month `m` of year `y`.
fn month_len(y: i64, m: i64) -> i64 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    days_from_civil(ny, nm, 1) - days_from_civil(y, m, 1)
}

/// Day of the month (1-based) for a BYMONTHDAY value: `-1` is the last day.
fn resolve_month_day(v: i8, len: i64) -> Option<i64> {
    let v = i64::from(v);
    let d = if v > 0 { v } else { len + v + 1 };
    (1..=len).contains(&d).then_some(d)
}

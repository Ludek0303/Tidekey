//! Calendar notes (ARCHITEKTURA §4.16b): event lines, the RRULE subset, and expansion of
//! repeated events into occurrences for a date range. Pure functions, no clock, no I/O, so the
//! same code runs in WASM.

mod parse;
mod rrule;
mod series;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_limits;
#[cfg(test)]
mod tests_rrule;

pub use parse::{format_event, parse_calendar};
pub use rrule::{Freq, Rule, Weekday, format_rrule, parse_rrule};

use crate::formula::date::civil_from_days;
use series::Series;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// A query longer than this is cut to `from_day + MAX_RANGE_DAYS`.
pub const MAX_RANGE_DAYS: i32 = 3700;
/// Occurrences returned by one `expand` call (the earliest ones, in order).
pub const MAX_OCCURRENCES: usize = 10_000;
/// Recurrence periods generated per series and query. COUNT series are fast-forwarded when every
/// period has the same number of occurrences (see `series::Series::skip_counted`); other COUNT
/// rules are walked from DTSTART and can run out of steps far from the start (then `truncated`).
pub const MAX_STEPS: u32 = 100_000;
/// Work units for one `expand` call, see `series::period_cost`: about one day examined per unit.
/// Split evenly between the recurring series, each getting at least `MIN_ALLOWANCE`, and never
/// more than the total. A series that runs out marks the result `truncated`.
pub const WORK_BUDGET: u64 = 1_000_000;
/// Smallest share of `WORK_BUDGET` per recurring series.
const MIN_ALLOWANCE: u64 = 10_000;

const MINUTES_PER_DAY: i64 = 1440;

/// The longest reminder, a week before the start (`🔔 <minutes>`); the shortest is one minute.
pub const MAX_REMINDER_MINUTES: u16 = 10_080;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// `^id` from the line. Without one: `#L<line>`, which `valid_id` rejects, so the UI must
    /// assign a real id on the first edit.
    pub id: String,
    /// 0-based line of the event in the note.
    pub line: usize,
    pub title: String,
    pub start_day: i32,
    /// `None` for an all-day event.
    pub start_min: Option<u16>,
    /// Inclusive: an all-day event ending on its start day has `end_day == start_day`.
    pub end_day: i32,
    pub end_min: Option<u16>,
    pub rrule: Option<Rule>,
    /// Days of removed occurrences (`⛔`), compared with the occurrence start day.
    pub exdates: Vec<i32>,
    pub color: Option<String>,
    /// Minutes before the start when the user is reminded (`🔔`), `1..=MAX_REMINDER_MINUTES`.
    pub reminder: Option<u16>,
    /// Indented lines below the event, joined with `\n`, indentation removed.
    pub description: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Calendar {
    /// The front matter has `typ: kalendarz` (or `type: calendar`).
    pub is_calendar: bool,
    pub events: Vec<Event>,
}

/// One concrete (possibly repeated) instance of an event. Times are minutes since midnight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    /// Index into `Calendar::events`.
    pub event_index: usize,
    pub start_day: i32,
    pub start_min: Option<u16>,
    pub end_day: i32,
    pub end_min: Option<u16>,
}

/// `true` for days whose year is 0000..=9999, the range the `RRRR-MM-DD` notation writes.
pub fn valid_day(day: i32) -> bool {
    (0..=9999).contains(&civil_from_days(i64::from(day)).0)
}

/// `true` for an id that the `^id` syntax can carry: letters, digits, `-` and `_`.
pub fn valid_id(id: &str) -> bool {
    parse::is_id(id)
}

/// All occurrences overlapping `from_day..=to_day`, sorted by start day, then start time (all-day
/// first), then title. At most `MAX_OCCURRENCES` are returned.
pub fn expand(cal: &Calendar, from_day: i32, to_day: i32) -> Vec<Occurrence> {
    expand_with_status(cal, from_day, to_day).0
}

/// `expand`, and whether the result may be incomplete: a limit or the work budget ran out, or
/// `MAX_OCCURRENCES` was reached (then the list is complete only if it had exactly that many).
pub fn expand_with_status(cal: &Calendar, from_day: i32, to_day: i32) -> (Vec<Occurrence>, bool) {
    let (out, truncated, _) = expand_budgeted(cal, from_day, to_day, WORK_BUDGET);
    (out, truncated)
}

/// `expand` with an explicit work budget. Also returns the work spent.
fn expand_budgeted(
    cal: &Calendar,
    from_day: i32,
    to_day: i32,
    budget: u64,
) -> (Vec<Occurrence>, bool, u64) {
    let to_day = to_day.min(from_day.saturating_add(MAX_RANGE_DAYS));
    if from_day > to_day {
        return (Vec::new(), false, 0);
    }
    let (from, to) = (i64::from(from_day), i64::from(to_day));
    let mut left = budget;
    let recurring = cal
        .events
        .iter()
        .filter(|e| e.rrule.as_ref().is_some_and(Rule::supported))
        .count() as u64;
    let allowance = (budget / recurring.max(1)).max(MIN_ALLOWANCE);
    let mut series: Vec<Series> = cal
        .events
        .iter()
        .enumerate()
        .map(|(i, e)| Series::new(i, e, from, to, allowance))
        .collect();
    let mut heads: Vec<Option<Occurrence>> = series
        .iter_mut()
        .map(|s| s.next_occurrence(&mut left))
        .collect();
    let mut heap: BinaryHeap<Reverse<SortKey>> = heads
        .iter()
        .flatten()
        .map(|o| Reverse(sort_key(o, &cal.events[o.event_index].title)))
        .collect();

    // k-way merge: every series yields its occurrences in order, so the heap gives a global order.
    let mut out = Vec::new();
    let mut truncated = false;
    while let Some(Reverse((_, _, _, i))) = heap.pop() {
        let Some(occurrence) = heads[i].take() else {
            continue;
        };
        out.push(occurrence);
        if out.len() == MAX_OCCURRENCES {
            truncated = true;
            break;
        }
        if let Some(next) = series[i].next_occurrence(&mut left) {
            heap.push(Reverse(sort_key(&next, &cal.events[i].title)));
            heads[i] = Some(next);
        }
    }
    truncated |= series.iter().any(|s| s.cut);
    (out, truncated, budget - left)
}

type SortKey<'a> = (i32, Option<u16>, &'a str, usize);

fn sort_key<'a>(o: &Occurrence, title: &'a str) -> SortKey<'a> {
    (o.start_day, o.start_min, title, o.event_index)
}

//! Limits of `expand`: range and output caps, step and work budgets, COUNT fast-forward.

use super::*;
use crate::formula::date::{civil_from_days, parse_iso};
use std::time::Instant;

fn day(s: &str) -> i32 {
    parse_iso(s).unwrap()
}

fn iso(d: i32) -> String {
    let (y, m, d) = civil_from_days(i64::from(d));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Start days of the occurrences of a note's events in `from..=to`.
fn starts(text: &str, from: &str, to: &str) -> Vec<String> {
    let cal = parse_calendar(text);
    expand(&cal, day(from), day(to))
        .iter()
        .map(|o| iso(o.start_day))
        .collect()
}

#[test]
fn range_is_capped_to_max_range_days() {
    let cal = parse_calendar("- 2026-10-22 🔁 FREQ=DAILY ^a");
    let from = day("2026-10-22");
    let out = expand(&cal, from, i32::MAX);
    assert_eq!(out.len(), MAX_RANGE_DAYS as usize + 1);
}

#[test]
fn output_is_capped_at_max_occurrences() {
    let text = "- 2026-10-22 🔁 FREQ=DAILY ^a\n- 2026-10-22 🔁 FREQ=DAILY ^b\n- 2026-10-22 🔁 FREQ=DAILY ^c";
    let cal = parse_calendar(text);
    let start = Instant::now();
    let out = expand(&cal, day("2026-10-22"), day("2026-10-22") + MAX_RANGE_DAYS);
    assert_eq!(out.len(), MAX_OCCURRENCES);
    assert!(out.windows(2).all(|w| w[0].start_day <= w[1].start_day));
    assert!(start.elapsed().as_secs() < 5);
}

#[test]
fn huge_interval_is_fast_and_correct() {
    let text = "- 2026-10-22 🔁 FREQ=DAILY;INTERVAL=1000000 ^a";
    assert_eq!(starts(text, "2026-01-01", "2026-12-31"), ["2026-10-22"]);
    let text = "- 2026-10-22 🔁 FREQ=WEEKLY;INTERVAL=4294967295 ^a";
    assert_eq!(starts(text, "2026-10-01", "2026-12-31"), ["2026-10-22"]);
}

#[test]
fn far_past_daily_series_is_fast_to_query() {
    let text = "- 1000-01-01 🔁 FREQ=DAILY ^a";
    let start = Instant::now();
    let out = starts(text, "2026-10-01", "2026-10-03");
    assert_eq!(out.len(), 3);
    assert!(start.elapsed().as_secs() < 5);
}

#[test]
fn count_series_far_in_the_past_is_bounded() {
    let text = "- 1000-01-01 🔁 FREQ=DAILY;COUNT=2000000 ^a";
    let start = Instant::now();
    let cal = parse_calendar(text);
    let out = expand(&cal, day("2026-10-01"), day("2026-10-03"));
    assert!(out.len() <= 3);
    assert!(start.elapsed().as_secs() < 5);
}

#[test]
fn never_matching_rule_terminates() {
    let text = "- 2026-01-01 🔁 FREQ=MONTHLY;BYMONTHDAY=31;BYDAY=MO ^a";
    let cal = parse_calendar(text);
    let start = Instant::now();
    let _ = expand(&cal, day("2026-01-01"), day("2026-01-01") + MAX_RANGE_DAYS);
    assert!(start.elapsed().as_secs() < 5);
}

#[test]
fn hostile_monthly_rule_stays_within_the_work_budget() {
    // 20 000 copies of one BYDAY item dedupe to one; a COUNT that no walk reaches; a query 7 000
    // years ahead. The walk must stop at the shared budget.
    let byday = vec!["1MO"; 20_000].join(",");
    let text = format!("- 2026-01-01 🔁 FREQ=MONTHLY;COUNT=4000000000;BYDAY={byday} ^a");
    let cal = parse_calendar(&text);
    let (out, truncated, spent) =
        expand_budgeted(&cal, day("9000-01-01"), day("9000-01-31"), WORK_BUDGET);
    assert!(out.is_empty());
    assert!(spent <= WORK_BUDGET);
    assert!(truncated, "the walk was cut, so the result must say so");
}

#[test]
fn many_far_past_count_series_are_cheap() {
    // 1000 lines, each DAILY with a COUNT that cannot be walked from year 1: COUNT is fast-forwarded,
    // so only the emitted occurrences cost work.
    let text: String = (0..1000)
        .map(|i| format!("- 0001-01-01 🔁 FREQ=DAILY;COUNT=4000000000 ^a{i:04}\n"))
        .collect();
    let cal = parse_calendar(&text);
    let (out, truncated, spent) =
        expand_budgeted(&cal, day("2026-01-01"), day("2026-01-31"), WORK_BUDGET);
    assert_eq!(out.len(), MAX_OCCURRENCES);
    assert!(truncated);
    // About one refill per emitted occurrence plus one head per series (1000 + 10 000 + the
    // occurrences pulled for the heap), far below what walking 2 billion days would cost.
    assert!(spent <= 15_000, "spent {spent}");
}

#[test]
fn small_budget_returns_what_it_found() {
    let cal = parse_calendar("- 2026-10-22 🔁 FREQ=DAILY ^a");
    let (out, truncated, spent) = expand_budgeted(&cal, day("2026-10-22"), day("2026-11-30"), 10);
    assert!(spent <= 10);
    assert!(!out.is_empty() && out.len() < 40);
    assert!(truncated);
}

#[test]
fn many_yearly_and_monthly_counts_are_all_visible() {
    // 100 anniversaries (YEARLY;COUNT=100) and 200 instalments (MONTHLY;COUNT=400) in October 2026.
    let mut text = String::new();
    for i in 0..100 {
        text += &format!(
            "- 1980-10-{:02} Urodziny {i} 🔁 FREQ=YEARLY;COUNT=100 ^y{i:03}\n",
            1 + i % 28
        );
    }
    for i in 0..200 {
        text += &format!(
            "- 2000-01-{:02} Rata {i} 🔁 FREQ=MONTHLY;COUNT=400 ^m{i:03}\n",
            1 + i % 28
        );
    }
    let cal = parse_calendar(&text);
    let (out, truncated, _) =
        expand_budgeted(&cal, day("2026-10-01"), day("2026-10-31"), WORK_BUDGET);
    assert_eq!(out.len(), 300);
    assert!(!truncated);
    // The last anniversary is 1980 + 99 years, the last instalment 2000-01 + 399 months.
    let last_year = cal.events.iter().position(|e| e.id == "y099").unwrap();
    let (out, truncated, _) =
        expand_budgeted(&cal, day("2079-10-01"), day("2079-10-31"), WORK_BUDGET);
    assert_eq!(out.iter().filter(|o| o.event_index == last_year).count(), 1);
    assert!(!truncated);
    let (out, _, _) = expand_budgeted(&cal, day("2080-10-01"), day("2080-10-31"), WORK_BUDGET);
    assert!(out.is_empty());
    let (out, truncated, _) =
        expand_budgeted(&cal, day("2033-04-01"), day("2033-04-30"), WORK_BUDGET);
    assert_eq!(out.len(), 200);
    assert!(!truncated);
    let (out, _, _) = expand_budgeted(&cal, day("2033-05-01"), day("2033-05-31"), WORK_BUDGET);
    assert!(out.is_empty());
}

#[test]
fn expand_with_status_reports_the_cap() {
    let text = "- 2026-10-22 🔁 FREQ=DAILY ^a\n- 2026-10-22 🔁 FREQ=DAILY ^b\n- 2026-10-22 🔁 FREQ=DAILY ^c";
    let cal = parse_calendar(text);
    let (out, truncated) =
        expand_with_status(&cal, day("2026-10-22"), day("2026-10-22") + MAX_RANGE_DAYS);
    assert_eq!(out.len(), MAX_OCCURRENCES);
    assert!(truncated);
    let (_, truncated) = expand_with_status(&cal, day("2026-10-22"), day("2026-10-23"));
    assert!(!truncated);
}

#[test]
fn daily_count_is_fast_forwarded() {
    let text = "- 2000-01-01 🔁 FREQ=DAILY;COUNT=1000000 ^a";
    assert_eq!(
        starts(text, "2026-10-01", "2026-10-03"),
        ["2026-10-01", "2026-10-02", "2026-10-03"]
    );
    // COUNT=1000000 ends with the day 999 999 after the start, and not one day later.
    let last = iso(day("2000-01-01") + 999_999);
    let after = iso(day("2000-01-01") + 1_000_000);
    assert_eq!(starts(text, &last, &after), [last]);
    assert!(starts(text, &after, &iso(day("2000-01-01") + 1_000_010)).is_empty());
}

#[test]
fn weekly_count_is_fast_forwarded() {
    // Weekly on Monday and Friday, 2 per week, 2000-01-03 is a Monday.
    let text = "- 2000-01-03 🔁 FREQ=WEEKLY;BYDAY=MO,FR;COUNT=100000 ^a";
    let last_week = iso(day("2000-01-03") + 7 * 49_999);
    let end = iso(day("2000-01-03") + 7 * 50_000);
    assert_eq!(
        starts(text, &last_week, &end),
        [last_week.clone(), iso(day("2000-01-03") + 7 * 49_999 + 4)]
    );
}

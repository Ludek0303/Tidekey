//! RRULE parsing and writing, expansion of repeated events, and the limits.

use super::*;
use crate::formula::date::{civil_from_days, parse_iso};

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
fn rrule_parts_and_canonical_order() {
    let rule = parse_rrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=4;X-FOO=1").unwrap();
    assert_eq!(rule.freq, Freq::Weekly);
    assert_eq!(rule.interval, 2);
    assert_eq!(rule.count, Some(4));
    assert_eq!(rule.extra, ["X-FOO=1"]);
    assert!(!rule.supported());
    assert_eq!(
        format_rrule(&rule),
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=4;X-FOO=1"
    );
    let plain = parse_rrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=4;WKST=MO").unwrap();
    assert!(plain.supported());
    assert_eq!(
        format_rrule(&plain),
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=4"
    );

    let rule =
        parse_rrule("freq=monthly;byday=2tu,-1FR;bymonthday=1,-1;until=20261224T235959Z").unwrap();
    assert_eq!(
        rule.by_day,
        vec![(Some(2), Weekday::Tu), (Some(-1), Weekday::Fr)]
    );
    assert_eq!(rule.by_month_day, vec![1, -1]);
    assert_eq!(rule.until, Some(day("2026-12-24")));
    assert_eq!(
        format_rrule(&rule),
        "FREQ=MONTHLY;BYDAY=2TU,-1FR;BYMONTHDAY=1,-1;UNTIL=20261224"
    );
}

#[test]
fn rrule_invalid_values() {
    assert!(parse_rrule("FREQ=HOURLY").is_none());
    assert!(parse_rrule("INTERVAL=2").is_none());
    assert!(parse_rrule("").is_none());
    assert_eq!(
        parse_rrule("FREQ=DAILY;UNTIL=20261340").unwrap().until,
        None
    );
    // Invalid parts are kept verbatim, so writing the line back does not rewrite the rule.
    let text = "FREQ=DAILY;INTERVAL=0;COUNT=0;BYMONTHDAY=0,40,5;BYDAY=XX,MO";
    let rule = parse_rrule(text).unwrap();
    assert_eq!(rule.interval, 1);
    assert_eq!(rule.count, None);
    assert!(rule.by_month_day.is_empty() && rule.by_day.is_empty());
    assert_eq!(
        rule.extra,
        ["INTERVAL=0", "COUNT=0", "BYMONTHDAY=0,40,5", "BYDAY=XX,MO"]
    );
    assert_eq!(format_rrule(&rule), text);
}

#[test]
fn by_month_is_expanded_and_round_trips() {
    let rule = parse_rrule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH").unwrap();
    assert!(rule.supported());
    assert_eq!(rule.by_month, [11]);
    assert_eq!(format_rrule(&rule), "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH");
    // Thanksgiving: the fourth Thursday of November.
    let text = "- 2026-11-26 🔁 FREQ=YEARLY;BYMONTH=11;BYDAY=4TH ^a";
    assert_eq!(
        starts(text, "2026-01-01", "2027-12-31"),
        ["2026-11-26", "2027-11-25"]
    );
    // Monthly on the 13th, only in March and June; the start (January) still counts.
    let text = "- 2026-01-13 🔁 FREQ=MONTHLY;BYMONTH=3,6;BYMONTHDAY=13 ^a";
    assert_eq!(
        starts(text, "2026-01-01", "2026-12-31"),
        ["2026-01-13", "2026-03-13", "2026-06-13"]
    );
}

#[test]
fn unsupported_rules_show_only_the_start() {
    let text = "- 2026-01-13 🔁 FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2 ^a";
    assert_eq!(starts(text, "2026-01-01", "2026-03-31"), ["2026-01-13"]);
    let cal = parse_calendar(text);
    assert_eq!(
        format_rrule(cal.events[0].rrule.as_ref().unwrap()),
        "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2"
    );
    // YEARLY with BYMONTHDAY but no BYMONTH means something this module does not expand.
    let text = "- 2026-01-13 🔁 FREQ=YEARLY;BYMONTHDAY=13 ^a";
    assert_eq!(starts(text, "2026-01-01", "2027-12-31"), ["2026-01-13"]);
    // Ordinals in WEEKLY are not expanded either.
    let text = "- 2026-01-13 🔁 FREQ=WEEKLY;BYDAY=2TU ^a";
    assert_eq!(starts(text, "2026-01-01", "2026-03-31"), ["2026-01-13"]);
}

#[test]
fn too_long_lists_are_kept_verbatim() {
    let days: Vec<String> = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
        .iter()
        .flat_map(|d| (1..=6).map(move |n| format!("{n}{d}")))
        .collect();
    assert_eq!(days.len(), 42);
    let text = format!("FREQ=MONTHLY;BYDAY={}", days.join(","));
    let rule = parse_rrule(&text).unwrap();
    assert!(rule.by_day.is_empty());
    assert!(!rule.supported());
    assert_eq!(format_rrule(&rule), text);
}

#[test]
fn repeated_list_items_are_deduplicated() {
    let rule = parse_rrule(&format!(
        "FREQ=MONTHLY;BYDAY={}",
        vec!["1MO"; 20_000].join(",")
    ))
    .unwrap();
    assert_eq!(rule.by_day, [(Some(1), Weekday::Mo)]);
    assert!(rule.supported());
}

#[test]
fn weekly_without_byday_uses_start_weekday() {
    // 2026-10-22 is a Thursday.
    let text = "- 2026-10-22 🔁 FREQ=WEEKLY ^a";
    assert_eq!(
        starts(text, "2026-10-01", "2026-11-05"),
        ["2026-10-22", "2026-10-29", "2026-11-05"]
    );
}

#[test]
fn weekly_interval_and_byday_on_a_monday_start() {
    let text = "- 2026-10-19 10:00 Standup 🔁 FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR ^a";
    assert_eq!(
        starts(text, "2026-10-19", "2026-11-05"),
        [
            "2026-10-19",
            "2026-10-21",
            "2026-10-23",
            "2026-11-02",
            "2026-11-04"
        ]
    );
}

#[test]
fn start_is_the_first_occurrence_even_if_not_in_byday() {
    let text = "- 2026-10-22 🔁 FREQ=WEEKLY;BYDAY=MO ^a";
    assert_eq!(
        starts(text, "2026-10-22", "2026-11-02"),
        ["2026-10-22", "2026-10-26", "2026-11-02"]
    );
}

#[test]
fn daily_with_byday_filters_and_interval() {
    let text = "- 2026-10-22 🔁 FREQ=DAILY;INTERVAL=3 ^a";
    assert_eq!(
        starts(text, "2026-10-22", "2026-11-01"),
        ["2026-10-22", "2026-10-25", "2026-10-28", "2026-10-31"]
    );
    let text = "- 2026-10-22 🔁 FREQ=DAILY;BYDAY=MO,TU ^a";
    assert_eq!(
        starts(text, "2026-10-22", "2026-10-31"),
        ["2026-10-22", "2026-10-26", "2026-10-27"]
    );
}

#[test]
fn monthly_31st_skips_short_months() {
    let text = "- 2026-01-31 🔁 FREQ=MONTHLY ^a";
    assert_eq!(
        starts(text, "2026-01-01", "2026-12-31"),
        [
            "2026-01-31",
            "2026-03-31",
            "2026-05-31",
            "2026-07-31",
            "2026-08-31",
            "2026-10-31",
            "2026-12-31"
        ]
    );
}

#[test]
fn monthly_last_friday() {
    let text = "- 2026-01-30 🔁 FREQ=MONTHLY;BYDAY=-1FR ^a";
    assert_eq!(starts(text, "2026-10-01", "2026-10-31"), ["2026-10-30"]);
}

#[test]
fn monthly_second_tuesday() {
    let text = "- 2026-01-13 🔁 FREQ=MONTHLY;BYDAY=2TU ^a";
    assert_eq!(starts(text, "2026-11-01", "2026-11-30"), ["2026-11-10"]);
}

#[test]
fn monthly_bymonthday_with_negative_day() {
    let text = "- 2026-01-05 🔁 FREQ=MONTHLY;BYMONTHDAY=1,-1 ^a";
    assert_eq!(
        starts(text, "2026-02-01", "2026-03-31"),
        ["2026-02-01", "2026-02-28", "2026-03-01", "2026-03-31"]
    );
}

#[test]
fn yearly_feb_29_only_in_leap_years() {
    let text = "- 2024-02-29 🔁 FREQ=YEARLY ^a";
    assert_eq!(
        starts(text, "2024-01-01", "2029-12-31"),
        ["2024-02-29", "2028-02-29"]
    );
}

#[test]
fn count_includes_exdates() {
    let text = "- 2026-10-22 🔁 FREQ=DAILY;COUNT=5 ⛔ 2026-10-24 ^a";
    assert_eq!(
        starts(text, "2026-10-01", "2026-11-30"),
        ["2026-10-22", "2026-10-23", "2026-10-25", "2026-10-26"]
    );
    let text = "- 2026-10-22 🔁 FREQ=DAILY;COUNT=3 ⛔ 2026-10-23 ^a";
    assert_eq!(
        starts(text, "2026-10-01", "2026-11-30"),
        ["2026-10-22", "2026-10-24"]
    );
}

#[test]
fn until_is_inclusive() {
    let text = "- 2026-10-22 🔁 FREQ=DAILY;UNTIL=20261024 ^a";
    assert_eq!(
        starts(text, "2026-10-01", "2026-10-31"),
        ["2026-10-22", "2026-10-23", "2026-10-24"]
    );
}

#[test]
fn exdate_removes_one_occurrence_of_a_series() {
    let text = "- 2026-10-22 10:00 Seria 🔁 FREQ=DAILY ⛔ 2026-10-23 ^a";
    assert_eq!(
        starts(text, "2026-10-22", "2026-10-24"),
        ["2026-10-22", "2026-10-24"]
    );
}

#[test]
fn multi_day_events_overlap_the_range_from_before() {
    let cal = parse_calendar(
        "- 2026-10-20-2026-10-23 Wyjazd ^a\n- 2026-10-30 18:00-2026-11-01 12:00 Trip ^b",
    );
    let o = expand(&cal, day("2026-10-22"), day("2026-10-22"));
    assert_eq!(o.len(), 1);
    assert_eq!(
        (iso(o[0].start_day), iso(o[0].end_day)),
        ("2026-10-20".into(), "2026-10-23".into())
    );
    assert!(expand(&cal, day("2026-10-24"), day("2026-10-29")).is_empty());

    let o = expand(&cal, day("2026-11-01"), day("2026-11-01"));
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].event_index, 1);
    assert_eq!(
        (o[0].start_min, o[0].end_day, o[0].end_min),
        (Some(1080), day("2026-11-01"), Some(720))
    );
}

#[test]
fn recurring_multi_day_event_is_seen_mid_span() {
    // Weekly event 2 days long, starting Tuesday 2026-10-20: the 10-20 occurrence covers 10-22.
    let text = "- 2026-10-20-2026-10-22 🔁 FREQ=WEEKLY ^a";
    assert_eq!(starts(text, "2026-10-22", "2026-10-22"), ["2026-10-20"]);
}

#[test]
fn far_window_matches_full_expansion() {
    let rules = [
        "FREQ=DAILY;INTERVAL=5",
        "FREQ=WEEKLY;INTERVAL=3;BYDAY=TU,SA",
        "FREQ=MONTHLY",
        "FREQ=MONTHLY;BYDAY=-2SU",
        "FREQ=YEARLY",
    ];
    for rule in rules {
        let text = format!("- 2020-01-29 10:00-11:30 Seria 🔁 {rule} ^a");
        let all = starts(&text, "2020-01-01", "2026-10-31");
        let window: Vec<String> = all
            .into_iter()
            .filter(|d| d.as_str() >= "2026-10-01")
            .collect();
        assert_eq!(starts(&text, "2026-10-01", "2026-10-31"), window, "{rule}");
    }
}

#[test]
fn occurrences_are_sorted_all_day_first_then_title() {
    let cal = parse_calendar("- 2026-10-22 10:00 B ^a\n- 2026-10-22 Zeta ^b\n- 2026-10-22 Alfa ^c");
    let order: Vec<usize> = expand(&cal, day("2026-10-22"), day("2026-10-22"))
        .iter()
        .map(|o| o.event_index)
        .collect();
    assert_eq!(order, [2, 1, 0]);
}

#[test]
fn reversed_range_is_empty() {
    let cal = parse_calendar("- 2026-10-22 Dzień ^a");
    assert!(expand(&cal, day("2026-10-23"), day("2026-10-21")).is_empty());
}

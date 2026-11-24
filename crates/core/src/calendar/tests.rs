//! Parsing and writing event lines.

use super::*;
use crate::formula::date::parse_iso;
use proptest::prelude::*;

fn day(s: &str) -> i32 {
    parse_iso(s).unwrap()
}

fn one(text: &str) -> Event {
    let cal = parse_calendar(text);
    assert_eq!(cal.events.len(), 1, "{text:?}");
    cal.events.into_iter().next().unwrap()
}

#[test]
fn parses_every_example_from_the_spec() {
    let text = "---\ntyp: kalendarz\n---\n\
        - 2026-10-22 10:00-11:00 Spotkanie zespołu 🔁 FREQ=WEEKLY;BYDAY=WE,FR ⛔ 2026-11-05 🎨 niebieski ^e7k2p\n\
        - 2026-10-24 Urodziny Ani 🔁 FREQ=YEARLY ^e1q9x\n\
        - 2026-10-30 18:00-2026-11-01 12:00 Wyjazd ^e4m0c\n\
        \x20   Opis wydarzenia to wcięte linie pod wydarzeniem.\n";
    let cal = parse_calendar(text);
    assert!(cal.is_calendar);
    assert_eq!(cal.events.len(), 3);

    let meeting = &cal.events[0];
    assert_eq!(meeting.id, "e7k2p");
    assert_eq!(meeting.line, 3);
    assert_eq!(meeting.title, "Spotkanie zespołu");
    assert_eq!(meeting.start_day, day("2026-10-22"));
    assert_eq!(meeting.start_min, Some(600));
    assert_eq!(meeting.end_day, day("2026-10-22"));
    assert_eq!(meeting.end_min, Some(660));
    assert_eq!(meeting.exdates, vec![day("2026-11-05")]);
    assert_eq!(meeting.color.as_deref(), Some("niebieski"));
    let rule = meeting.rrule.as_ref().unwrap();
    assert_eq!(rule.freq, Freq::Weekly);
    assert_eq!(rule.by_day, vec![(None, Weekday::We), (None, Weekday::Fr)]);

    let birthday = &cal.events[1];
    assert_eq!(birthday.id, "e1q9x");
    assert_eq!(birthday.title, "Urodziny Ani");
    assert_eq!((birthday.start_min, birthday.end_min), (None, None));
    assert_eq!(birthday.end_day, birthday.start_day);
    assert_eq!(birthday.rrule.as_ref().unwrap().freq, Freq::Yearly);

    let trip = &cal.events[2];
    assert_eq!(trip.id, "e4m0c");
    assert_eq!(trip.start_min, Some(18 * 60));
    assert_eq!(trip.end_day, day("2026-11-01"));
    assert_eq!(trip.end_min, Some(12 * 60));
    assert_eq!(
        trip.description,
        "Opis wydarzenia to wcięte linie pod wydarzeniem."
    );
}

#[test]
fn all_day_timed_and_multi_day_events() {
    let all_day = one("- 2026-10-22 Dzień");
    assert_eq!((all_day.start_min, all_day.end_min), (None, None));
    assert_eq!(all_day.end_day, all_day.start_day);

    let timed = one("- 2026-10-22 09:30-10:15 Krótko");
    assert_eq!((timed.start_min, timed.end_min), (Some(570), Some(615)));
    assert_eq!(timed.end_day, timed.start_day);

    let span = one("- 2026-10-20-2026-10-23 Wyjazd");
    assert_eq!((span.start_min, span.end_min), (None, None));
    assert_eq!(span.end_day, day("2026-10-23"));
}

#[test]
fn defaults_for_missing_end() {
    let timed = one("- 2026-10-22 10:00 Bez końca");
    assert_eq!(timed.end_day, day("2026-10-22"));
    assert_eq!(timed.end_min, Some(660));

    let late = one("- 2026-10-22 23:30 Północ");
    assert_eq!(late.end_day, day("2026-10-23"));
    assert_eq!(late.end_min, Some(30));
}

#[test]
fn end_before_start_is_clamped_to_start() {
    let timed = one("- 2026-10-22 12:00-09:00 Odwrotnie");
    assert_eq!(
        (timed.end_day, timed.end_min),
        (timed.start_day, timed.start_min)
    );

    let all_day = one("- 2026-10-22-2026-10-10 Odwrotnie");
    assert_eq!(all_day.end_day, all_day.start_day);
}

#[test]
fn timed_start_with_date_only_end_ends_at_midnight() {
    let event = one("- 2026-10-30 18:00-2026-11-01 Do północy");
    assert_eq!((event.end_day, event.end_min), (day("2026-11-01"), Some(0)));
}

#[test]
fn invalid_lines_are_ignored() {
    let text = "# Tytuł\n\
        Zwykły tekst 2026-10-22\n\
        - [ ] 2026-10-22 zadanie\n\
        - 2026-13-01 zły miesiąc\n\
        - 2026-10-22x bez spacji\n\
        -2026-10-22 bez spacji po myślniku\n\
\x20\x20- 2026-10-22 wcięty\n\
        - 2026-10-22 10:00-2026-10-22- zły koniec\n\
        * 2026-10-23 gwiazdka działa\n";
    let cal = parse_calendar(text);
    assert_eq!(cal.events.len(), 1);
    assert_eq!(cal.events[0].title, "gwiazdka działa");
    assert_eq!(cal.events[0].line, 8);
}

#[test]
fn is_calendar_needs_the_front_matter_type() {
    assert!(parse_calendar("---\ntype: calendar\n---\n").is_calendar);
    assert!(parse_calendar("---\ntyp: \"kalendarz\"\n---\n").is_calendar);
    assert!(!parse_calendar("---\ntags: kalendarz\n---\n").is_calendar);
    assert!(!parse_calendar("typ: kalendarz\n").is_calendar);
}

#[test]
fn front_matter_lines_are_not_events() {
    let cal = parse_calendar("---\n- 2026-10-22 nie\n---\n- 2026-10-23 tak\n");
    assert_eq!(cal.events.len(), 1);
    assert_eq!(cal.events[0].line, 3);
}

#[test]
fn event_without_id_gets_a_line_based_id_that_is_not_written_back() {
    let cal = parse_calendar("# A\n- 2026-10-22 Bez id\n");
    assert_eq!(cal.events[0].id, "#L1");
    assert!(!valid_id(&cal.events[0].id));
    assert_eq!(format_event(&cal.events[0]), "- 2026-10-22 Bez id");
}

#[test]
fn blank_lines_inside_a_description_round_trip() {
    let event = one("- 2026-10-22 X ^e1\n    a\n\n    b\n\nnext line\n");
    assert_eq!(event.description, "a\n\nb");
    assert_eq!(
        format_event(&event),
        "- 2026-10-22 X ^e1\n    a\n    \n    b"
    );
    assert_eq!(one(&format_event(&event)), event);
}

#[test]
fn all_day_title_that_looks_like_a_time_round_trips() {
    let event = Event {
        id: "e1".into(),
        line: 0,
        title: "10:00-11:00 standup".into(),
        start_day: day("2026-10-22"),
        start_min: None,
        end_day: day("2026-10-22"),
        end_min: None,
        rrule: None,
        exdates: vec![],
        color: None,
        reminder: None,
        description: String::new(),
    };
    let line = format_event(&event);
    assert_eq!(line, "- 2026-10-22 10\\:00-11:00 standup ^e1");
    assert_eq!(one(&line), event);
    // Without the escape the same line would be read as a timed event.
    assert_eq!(
        one("- 2026-10-22 10:00-11:00 standup ^e1").start_min,
        Some(600)
    );

    let escaped = one("- 2026-10-22 10\\:00 literal ^e1");
    assert_eq!(escaped.title, "10:00 literal");
    assert_eq!(one(&format_event(&escaped)), escaped);
}

#[test]
fn description_is_indented_lines_without_the_indent() {
    let cal = parse_calendar("- 2026-10-22 X ^e1\n    linia\n\tdwie\n  trzy\n\nkoniec\n");
    assert_eq!(cal.events[0].description, "linia\ndwie\ntrzy");
}

#[test]
fn title_markers_and_ids_in_any_order() {
    let event = one("- 2026-10-22 Tytuł 🎨 zielony ⛔ 2026-10-23,2026-10-24 🔁 FREQ=DAILY ^e1");
    assert_eq!(event.title, "Tytuł");
    assert_eq!(event.color.as_deref(), Some("zielony"));
    assert_eq!(event.exdates, vec![day("2026-10-23"), day("2026-10-24")]);
    assert_eq!(event.rrule.unwrap().freq, Freq::Daily);
    assert_eq!(event.id, "e1");
}

#[test]
fn invalid_rrule_leaves_the_event_non_recurring() {
    let event = one("- 2026-10-22 Zły 🔁 FREQ=HOURLY ^e1");
    assert!(event.rrule.is_none());
    assert_eq!(event.title, "Zły");
}

#[test]
fn format_writes_the_canonical_line() {
    let event = one(
        "- 2026-10-22 10:00-11:00 Spotkanie zespołu 🔁 FREQ=WEEKLY;BYDAY=WE,FR ⛔ 2026-11-05 🎨 niebieski ^e7k2p",
    );
    assert_eq!(
        format_event(&event),
        "- 2026-10-22 10:00 Spotkanie zespołu 🔁 FREQ=WEEKLY;BYDAY=WE,FR ⛔ 2026-11-05 🎨 niebieski ^e7k2p"
    );

    let default_end = one("- 2026-10-22 10:00 Standard ^e1");
    assert_eq!(
        format_event(&default_end),
        "- 2026-10-22 10:00 Standard ^e1"
    );

    let trip = one("- 2026-10-30 18:00-2026-11-01 12:00 Wyjazd ^e4m0c\n    opis\n  drugi");
    assert_eq!(
        format_event(&trip),
        "- 2026-10-30 18:00-2026-11-01 12:00 Wyjazd ^e4m0c\n    opis\n    drugi"
    );
}

#[test]
fn format_strips_markers_and_caret_words_from_title() {
    let event = Event {
        id: "e1".into(),
        line: 0,
        title: "Plan 🔁 ⛔ 🎨 ^x\nz\tdruga   linia".into(),
        start_day: day("2026-10-22"),
        start_min: None,
        end_day: day("2026-10-22"),
        end_min: None,
        rrule: None,
        exdates: vec![],
        color: Some("🎨 jasny ^y".into()),
        reminder: None,
        description: String::new(),
    };
    let line = format_event(&event);
    assert_eq!(line, "- 2026-10-22 Plan z druga linia 🎨 jasny ^e1");
    let back = one(&line);
    assert_eq!(back.title, "Plan z druga linia");
    assert_eq!(back.color.as_deref(), Some("jasny"));
}

fn word() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9ąęóśżźćłń]{1,8}"
}

/// A title: optionally starting with a time (`10:00`, `10:00-11:00`, `10\:00`), then words.
fn title() -> impl Strategy<Value = String> {
    (
        prop::option::of(prop_oneof![
            "[0-2][0-9]:[0-5][0-9]",
            "[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]",
            "[0-2][0-9]\\\\:[0-5][0-9]",
        ]),
        prop::collection::vec(word(), 0..4),
    )
        .prop_map(|(time, words)| {
            let mut all: Vec<String> = time.into_iter().collect();
            all.extend(words);
            all.join(" ")
        })
}

/// Distinct items, first occurrence kept (the parser does the same for lists).
fn dedup<T: PartialEq>(items: Vec<T>) -> Vec<T> {
    let mut out: Vec<T> = Vec::new();
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

fn rule_strategy() -> impl Strategy<Value = Rule> {
    (
        (0usize..4, 1u32..6, prop::collection::vec(1u8..=12, 0..3)),
        (
            prop::collection::vec(
                (prop::option::of(prop_oneof![-5i8..=-1, 1i8..=5]), 0usize..7),
                0..3,
            ),
            prop::collection::vec(prop_oneof![-31i8..=-1, 1i8..=31], 0..3),
        ),
        (
            prop::option::of(1u32..50),
            prop::option::of(0i32..60_000),
            prop::collection::vec(
                prop_oneof![
                    Just("BYSETPOS=-1".to_string()),
                    Just("BYWEEKNO=20".to_string()),
                    "X-[A-Z]{2,6}=[0-9]{1,3}",
                ],
                0..2,
            ),
        ),
    )
        .prop_map(
            |((f, interval, by_month), (by_day, by_month_day), (count, until, extra))| Rule {
                freq: [Freq::Daily, Freq::Weekly, Freq::Monthly, Freq::Yearly][f],
                interval,
                by_month: dedup(by_month),
                by_day: dedup(
                    by_day
                        .into_iter()
                        .map(|(o, w)| (o, Weekday::ALL[w]))
                        .collect(),
                ),
                by_month_day: dedup(by_month_day),
                count,
                until,
                extra,
            },
        )
}

/// Description lines: text lines and blank ones, without blank lines at either end.
fn description() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop_oneof![
            3 => "[a-zA-Z0-9][a-zA-Z0-9 ]{0,12}",
            1 => Just(String::new()),
        ],
        0..4,
    )
    .prop_map(|mut lines| {
        while lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
        while lines.first().is_some_and(String::is_empty) {
            lines.remove(0);
        }
        lines.join("\n")
    })
}

fn event_strategy() -> impl Strategy<Value = Event> {
    (
        (0i32..60_000, any::<bool>(), 0u16..1440, 0i64..5000),
        (0i32..30, title(), prop::option::of(rule_strategy())),
        (
            prop::collection::vec(0i32..60_000, 0..3),
            prop::option::of("[a-z]{1,6}"),
            description(),
            "e[a-z0-9]{5}",
            prop::option::of(1u16..=MAX_REMINDER_MINUTES),
        ),
    )
        .prop_map(
            |(
                (start_day, timed, start_min, offset),
                (days, title, rrule),
                (exdates, color, description, id, reminder),
            )| {
                let (end_day, end_min, start_min) = if timed {
                    let total =
                        i64::from(start_day) * MINUTES_PER_DAY + i64::from(start_min) + offset;
                    let end_day = i32::try_from(total.div_euclid(MINUTES_PER_DAY)).unwrap();
                    (
                        end_day,
                        Some(total.rem_euclid(MINUTES_PER_DAY) as u16),
                        Some(start_min),
                    )
                } else {
                    (start_day + days, None, None)
                };
                Event {
                    id,
                    line: 0,
                    title,
                    start_day,
                    start_min,
                    end_day,
                    end_min,
                    rrule,
                    exdates,
                    color,
                    reminder,
                    description,
                }
            },
        )
}

proptest! {
    #[test]
    fn format_then_parse_gives_the_same_event(e in event_strategy()) {
        let text = format_event(&e);
        let cal = parse_calendar(&text);
        prop_assert_eq!(cal.events.len(), 1, "{}", text);
        prop_assert_eq!(&cal.events[0], &e, "{}", text);
    }
}

#[test]
fn reminder_token_is_read_and_written_before_the_id() {
    let event = one("- 2026-10-22 10:00 Spotkanie 🔔 15 🎨 niebieski ^e1");
    assert_eq!(event.title, "Spotkanie");
    assert_eq!(event.reminder, Some(15));
    assert_eq!(event.color.as_deref(), Some("niebieski"));
    assert_eq!(
        format_event(&event),
        "- 2026-10-22 10:00 Spotkanie 🎨 niebieski 🔔 15 ^e1"
    );
    assert_eq!(one(&format_event(&event)), event);

    let bounds = one("- 2026-10-22 Dzień 🔔 10080 ^e1");
    assert_eq!(bounds.reminder, Some(MAX_REMINDER_MINUTES));
    assert_eq!(one("- 2026-10-22 Dzień 🔔 1 ^e1").reminder, Some(1));
}

#[test]
fn invalid_reminder_is_title_text_and_is_kept() {
    for value in ["0", "10081", "abc", "-5", "+5", "15 minut", "99999"] {
        let line = format!("- 2026-10-22 10:00 Zadanie 🔔 {value} ^e1");
        let event = one(&line);
        assert_eq!(event.reminder, None, "{line}");
        assert_eq!(event.title, format!("Zadanie 🔔 {value}"), "{line}");
    }
    let empty = one("- 2026-10-22 Zadanie 🔔 ^e1");
    assert_eq!(empty.reminder, None);
    assert_eq!(empty.title, "Zadanie 🔔");
}

#[test]
fn title_with_bell_that_is_not_a_reminder_keeps_its_words() {
    let event = one("- 2026-10-22 Dzwonek 🔔 w piątek 🎨 zielony ^e1");
    assert_eq!(event.title, "Dzwonek 🔔 w piątek");
    assert_eq!(event.color.as_deref(), Some("zielony"));
    assert_eq!(event.reminder, None);
    // The formatter removes marker characters from titles, as it does for the other markers.
    assert_eq!(
        format_event(&event),
        "- 2026-10-22 Dzwonek w piątek 🎨 zielony ^e1"
    );
}

#[test]
fn format_skips_a_reminder_outside_the_range() {
    let mut event = one("- 2026-10-22 Dzień ^e1");
    event.reminder = Some(0);
    assert_eq!(format_event(&event), "- 2026-10-22 Dzień ^e1");
    event.reminder = Some(MAX_REMINDER_MINUTES + 1);
    assert_eq!(format_event(&event), "- 2026-10-22 Dzień ^e1");
}

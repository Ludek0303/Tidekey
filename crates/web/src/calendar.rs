//! Calendar notes for the browser (ARCHITEKTURA §4.16b): event lines in and out as JSON strings.

use notes_core::calendar::{
    Event, MAX_REMINDER_MINUTES, expand_with_status, format_event, format_rrule, parse_calendar,
    parse_rrule, valid_day, valid_id,
};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

/// `{"isCalendar":bool,"events":[…]}`. `lineEnd` is the last line of the event, description included.
#[wasm_bindgen]
pub fn calendar_parse_json(text: &str) -> String {
    let cal = parse_calendar(text);
    let events: Vec<Value> = cal
        .events
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "line": e.line,
                "lineEnd": e.line + e.description.lines().count(),
                "title": e.title,
                "startDay": e.start_day,
                "startMin": e.start_min,
                "endDay": e.end_day,
                "endMin": e.end_min,
                "rrule": e.rrule.as_ref().map(format_rrule),
                "ruleSupported": e.rrule.as_ref().is_none_or(|r| r.supported()),
                "exdates": e.exdates,
                "color": e.color,
                "reminder": e.reminder,
                "description": e.description,
            })
        })
        .collect();
    json!({"isCalendar": cal.is_calendar, "events": events}).to_string()
}

/// `{"occurrences":[{"event","startDay","startMin","endDay","endMin"}],"truncated":bool}`, sorted,
/// for `from_day..=to_day`. `truncated` is true when a work or step limit cut the result.
#[wasm_bindgen]
pub fn calendar_expand_json(text: &str, from_day: i32, to_day: i32) -> String {
    let cal = parse_calendar(text);
    let (found, truncated) = expand_with_status(&cal, from_day, to_day);
    let occurrences: Vec<Value> = found
        .iter()
        .map(|o| {
            json!({
                "event": o.event_index,
                "startDay": o.start_day,
                "startMin": o.start_min,
                "endDay": o.end_day,
                "endMin": o.end_min,
            })
        })
        .collect();
    json!({"occurrences": occurrences, "truncated": truncated}).to_string()
}

/// The canonical lines of an event given in the shape `calendar_parse_json` returns (without
/// `line` and `lineEnd`). Empty string if the JSON or the dates are invalid.
#[wasm_bindgen]
pub fn calendar_format_event_json(event_json: &str) -> String {
    serde_json::from_str::<Value>(event_json)
        .ok()
        .and_then(|v| event_from_json(&v))
        .map(|e| format_event(&e))
        .unwrap_or_default()
}

fn event_from_json(v: &Value) -> Option<Event> {
    let start_day = day_field(v.get("startDay"))?;
    let end_day = day_field(v.get("endDay"))?;
    let start_min = minute_field(v.get("startMin"))?;
    let end_min = minute_field(v.get("endMin"))?;
    if start_min.is_some() != end_min.is_some()
        || (end_day, end_min.unwrap_or(0)) < (start_day, start_min.unwrap_or(0))
    {
        return None;
    }
    let rrule = match v.get("rrule") {
        None | Some(Value::Null) => None,
        Some(s) => Some(parse_rrule(s.as_str()?)?),
    };
    let exdates = match v.get("exdates") {
        None | Some(Value::Null) => Vec::new(),
        Some(list) => list
            .as_array()?
            .iter()
            .map(|d| day_field(Some(d)))
            .collect::<Option<Vec<i32>>>()?,
    };
    let text = |key: &str| {
        v.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let color = Some(text("color")).filter(|c| !c.is_empty());
    let reminder = match v.get("reminder") {
        None | Some(Value::Null) => None,
        Some(m) => Some(reminder_field(m)?),
    };
    let id = text("id");
    if !valid_id(&id) {
        return None;
    }
    Some(Event {
        id,
        line: 0,
        title: text("title"),
        start_day,
        start_min,
        end_day,
        end_min,
        rrule,
        exdates,
        color,
        reminder,
        description: text("description"),
    })
}

/// Minutes before the start, `1..=MAX_REMINDER_MINUTES`; anything else makes the event invalid.
fn reminder_field(v: &Value) -> Option<u16> {
    u16::try_from(v.as_u64()?)
        .ok()
        .filter(|m| (1..=MAX_REMINDER_MINUTES).contains(m))
}

fn day_field(v: Option<&Value>) -> Option<i32> {
    i32::try_from(v?.as_i64()?).ok().filter(|&d| valid_day(d))
}

/// Missing or `null` is `Some(None)` (all-day). A number must be below 1440.
fn minute_field(v: Option<&Value>) -> Option<Option<u16>> {
    match v {
        None | Some(Value::Null) => Some(None),
        Some(m) => u16::try_from(m.as_u64()?)
            .ok()
            .filter(|&m| m < 1440)
            .map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-10-22, counted from 1970-01-01.
    const DAY: i64 = 20748;

    #[test]
    fn parse_json_has_the_documented_shape() {
        let text = "---\ntyp: kalendarz\n---\n\
            - 2026-10-22 10:00 Zażółć \"gęślą\" \\ 🎉 🔁 FREQ=DAILY;COUNT=2 ⛔ 2026-10-23 🎨 niebieski ^e1\n\
            \x20   opis\n- 2026-10-24 Dzień ^e2\n";
        let v: Value = serde_json::from_str(&calendar_parse_json(text)).unwrap();
        assert_eq!(v["isCalendar"], true);
        let first = &v["events"][0];
        assert_eq!(first["id"], "e1");
        assert_eq!(first["line"], 3);
        assert_eq!(first["lineEnd"], 4);
        assert_eq!(first["title"], "Zażółć \"gęślą\" \\ 🎉");
        assert_eq!(first["startDay"], DAY);
        assert_eq!(first["startMin"], 600);
        assert_eq!(first["endMin"], 660);
        assert_eq!(first["rrule"], "FREQ=DAILY;COUNT=2");
        assert_eq!(first["ruleSupported"], true);
        assert_eq!(first["exdates"], serde_json::json!([DAY + 1]));
        assert_eq!(first["color"], "niebieski");
        assert_eq!(first["description"], "opis");
        let second = &v["events"][1];
        assert!(second["startMin"].is_null());
        assert!(second["rrule"].is_null());
        assert!(second["color"].is_null());
    }

    #[test]
    fn expand_json_lists_occurrences() {
        let text = "- 2026-10-22 🔁 FREQ=DAILY ^e1";
        let v: Value =
            serde_json::from_str(&calendar_expand_json(text, DAY as i32, DAY as i32 + 2)).unwrap();
        assert_eq!(v["truncated"], false);
        let items = v["occurrences"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[2]["event"], 0);
        assert_eq!(items[2]["startDay"], DAY + 2);
        assert!(items[2]["startMin"].is_null());
    }

    #[test]
    fn format_json_writes_the_canonical_line() {
        let input = serde_json::json!({
            "id": "e1",
            "title": "Zażółć \"x\" \\ 🎉 🔁 pęk",
            "startDay": DAY,
            "startMin": 600,
            "endDay": DAY,
            "endMin": 660,
            "rrule": "freq=weekly;byday=we,fr;interval=1",
            "exdates": [DAY + 7],
            "color": "zielony",
            "description": "linia",
        });
        assert_eq!(
            calendar_format_event_json(&input.to_string()),
            "- 2026-10-22 10:00 Zażółć \"x\" \\ 🎉 pęk 🔁 FREQ=WEEKLY;BYDAY=WE,FR ⛔ 2026-10-29 🎨 zielony ^e1\n    linia"
        );
    }

    #[test]
    fn format_json_rejects_invalid_input() {
        assert_eq!(calendar_format_event_json("nie json"), "");
        assert_eq!(calendar_format_event_json(r#"{"startDay":20748}"#), "");
        let backwards = r#"{"id":"e1","title":"x","startDay":20748,"startMin":600,"endDay":20748,"endMin":500}"#;
        assert_eq!(calendar_format_event_json(backwards), "");
        let bad_minute = r#"{"id":"e1","title":"x","startDay":20748,"startMin":1440,"endDay":20748,"endMin":1441}"#;
        assert_eq!(calendar_format_event_json(bad_minute), "");
        let bad_rule =
            r#"{"id":"e1","title":"x","startDay":20748,"endDay":20748,"rrule":"FREQ=NIGDY"}"#;
        assert_eq!(calendar_format_event_json(bad_rule), "");
        let derived_id = r##"{"id":"#L5","title":"x","startDay":20748,"endDay":20748}"##;
        assert_eq!(calendar_format_event_json(derived_id), "");
    }

    #[test]
    fn reminder_round_trips_through_json() {
        let text = "- 2026-10-22 10:00 Spotkanie 🎨 zielony 🔔 15 ^e1\n- 2026-10-23 Dzień ^e2\n";
        let v: Value = serde_json::from_str(&calendar_parse_json(text)).unwrap();
        assert_eq!(v["events"][0]["reminder"], 15);
        assert!(v["events"][1]["reminder"].is_null());

        let input = serde_json::json!({
            "id": "e1",
            "title": "Spotkanie",
            "startDay": DAY,
            "startMin": 600,
            "endDay": DAY,
            "endMin": 660,
            "color": "zielony",
            "reminder": 15,
        });
        assert_eq!(
            calendar_format_event_json(&input.to_string()),
            "- 2026-10-22 10:00 Spotkanie 🎨 zielony 🔔 15 ^e1"
        );
    }

    #[test]
    fn format_json_rejects_an_invalid_reminder() {
        for reminder in ["0", "10081", "\"15\"", "1.5"] {
            let input = format!(
                r#"{{"id":"e1","title":"x","startDay":20748,"endDay":20748,"reminder":{reminder}}}"#
            );
            assert_eq!(calendar_format_event_json(&input), "", "{reminder}");
        }
    }

    #[test]
    fn parse_json_flags_unsupported_rules() {
        let text = "- 2026-10-22 🔁 FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2 ^e1\n- 2026-10-22 🔁 FREQ=YEARLY;BYMONTH=11;BYDAY=4TH ^e2\n";
        let v: Value = serde_json::from_str(&calendar_parse_json(text)).unwrap();
        assert_eq!(v["events"][0]["ruleSupported"], false);
        assert_eq!(v["events"][1]["ruleSupported"], true);
    }
}

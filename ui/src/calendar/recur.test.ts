import { describe, expect, it } from "vitest";
import { dayOf } from "./dates";
import { describeRule, editableRule, formatRule, ordinalOf, parseRule, presetOf, presetOptions, presetRule, type Preset, type Rule } from "./recur";

const WED_21 = dayOf(2026, 10, 21); // a Wednesday, the 3rd of its month's Wednesdays
const LAST_WED = dayOf(2026, 10, 28); // the last Wednesday of October 2026

describe("RRULE text", () => {
  it("reads and writes the subset the core uses, in the core's order", () => {
    const rule = parseRule("freq=weekly;byday=fr,we;interval=1;count=5")!;
    expect(formatRule(rule)).toBe("FREQ=WEEKLY;BYDAY=FR,WE;COUNT=5");
    expect(formatRule(parseRule("FREQ=YEARLY;BYDAY=4TH;BYMONTH=11")!)).toBe("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH");
    expect(formatRule(parseRule("FREQ=MONTHLY;BYDAY=-1FR;INTERVAL=2")!)).toBe("FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR");
  });

  it("round-trips BYMONTH, so a Thanksgiving rule keeps its month", () => {
    const text = "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH";
    expect(formatRule(parseRule(text)!)).toBe(text);
    expect(editableRule(text)!.byMonth).toEqual([11]);
  });

  it("reads UNTIL as the inclusive day and writes it back as YYYYMMDD", () => {
    const rule = parseRule("FREQ=DAILY;UNTIL=20261030T000000")!;
    expect(rule.until).toBe(dayOf(2026, 10, 30));
    expect(formatRule(rule)).toBe("FREQ=DAILY;UNTIL=20261030");
  });

  it("returns null without a valid FREQ, and drops what it does not know", () => {
    expect(parseRule("COUNT=3")).toBeNull();
    expect(parseRule("FREQ=HOURLY")).toBeNull();
    expect(parseRule("FREQ=DAILY;BYHOUR=9;WKST=SU")).toEqual(parseRule("FREQ=DAILY"));
  });
});

describe("presets <-> RRULE", () => {
  const presets: Preset[] = ["daily", "weekly", "monthly-nth", "monthly-day", "yearly", "weekdays"];

  it("maps every preset to a rule that reads back as the same preset", () => {
    for (const preset of presets) {
      const rule = presetRule(preset, WED_21)!;
      expect(presetOf(parseRule(formatRule(rule)), WED_21), preset).toBe(preset);
    }
  });

  it("writes the rules Google Calendar writes for each preset", () => {
    const text = (p: Preset, day: number) => formatRule(presetRule(p, day)!);
    expect(text("daily", WED_21)).toBe("FREQ=DAILY");
    expect(text("weekly", WED_21)).toBe("FREQ=WEEKLY;BYDAY=WE");
    expect(text("monthly-nth", WED_21)).toBe("FREQ=MONTHLY;BYDAY=3WE");
    expect(text("monthly-nth", LAST_WED)).toBe("FREQ=MONTHLY;BYDAY=-1WE");
    expect(text("monthly-day", WED_21)).toBe("FREQ=MONTHLY;BYMONTHDAY=21");
    expect(text("yearly", WED_21)).toBe("FREQ=YEARLY");
    expect(text("weekdays", WED_21)).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  });

  it("uses the last weekday of the month for the 'ostatnią' preset", () => {
    expect(ordinalOf(WED_21)).toBe(3);
    expect(ordinalOf(LAST_WED)).toBe(-1);
    expect(ordinalOf(dayOf(2026, 10, 1))).toBe(1);
    expect(presetOptions(LAST_WED).find((o) => o.value === "monthly-nth")!.label).toBe("Co miesiąc w ostatnią środę");
    expect(presetOptions(WED_21).find((o) => o.value === "monthly-nth")!.label).toBe("Co miesiąc w 3. środę");
  });

  it("labels the options from the start day", () => {
    const labels = Object.fromEntries(presetOptions(WED_21).map((o) => [o.value, o.label]));
    expect(labels.weekly).toBe("Co tydzień w środę");
    expect(labels["monthly-day"]).toBe("Co miesiąc dnia 21");
    expect(labels.yearly).toBe("Co roku 21 października");
    expect(labels["custom"]).toBe("Niestandardowe…");
  });

  it("falls back to custom for rules no preset gives, for this start day", () => {
    expect(presetOf(null, WED_21)).toBe("none");
    expect(presetOf(parseRule("FREQ=WEEKLY;BYDAY=WE,FR")!, WED_21)).toBe("custom");
    expect(presetOf(parseRule("FREQ=DAILY;COUNT=5")!, WED_21)).toBe("custom");
    expect(presetOf(parseRule("FREQ=DAILY;INTERVAL=2")!, WED_21)).toBe("custom");
    // 3rd Wednesday of the month, but the series starts on the 4th one.
    expect(presetOf(parseRule("FREQ=MONTHLY;BYDAY=3WE")!, LAST_WED)).toBe("custom");
  });
});

describe("describeRule", () => {
  it("writes the rule in Polish, as the event popover shows it", () => {
    const rule: Rule = { ...parseRule("FREQ=WEEKLY;BYDAY=WE,FR")!, count: 5 };
    expect(describeRule(rule, WED_21)).toBe("Co tydzień w środę i piątek, 5 razy");
    expect(describeRule(parseRule("FREQ=MONTHLY;BYDAY=-1WE")!, LAST_WED)).toBe("Co miesiąc w ostatnią środę");
    expect(describeRule(parseRule("FREQ=DAILY;INTERVAL=3")!, WED_21)).toBe("Co 3 dni");
    expect(describeRule(parseRule("FREQ=WEEKLY;INTERVAL=2")!, WED_21)).toBe("Co 2 tygodnie");
    expect(describeRule(parseRule("FREQ=YEARLY")!, WED_21)).toBe("Co rok 21 października");
    expect(describeRule(parseRule("FREQ=DAILY;UNTIL=20261030")!, WED_21)).toBe("Codziennie, do 30 października 2026");
  });
});

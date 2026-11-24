// The "Niestandardowe…" part of the repeat select: every interval, unit, weekday, month and end.
import { el } from "./chips";
import { isoDay, parseIsoDay, WEEKDAYS_ACC, weekdayOf, ymdOf } from "./dates";
import { ordinalOf, type Freq, type Rule } from "./recur";

const UNITS: [Freq, string][] = [
  ["DAILY", "dzień"],
  ["WEEKLY", "tydzień"],
  ["MONTHLY", "miesiąc"],
  ["YEARLY", "rok"],
];
const LETTERS = ["P", "W", "Ś", "C", "P", "S", "N"];
let seq = 0;

/** The custom rule form. `onChange` gets a new rule each time a field changes; `rule` is not mutated. */
export function customForm(rule: Rule, startDay: number, onChange: (rule: Rule) => void): HTMLElement {
  const name = `cal-end-${++seq}`;
  const wrap = el("div", "cal-custom");
  let r: Rule = { ...rule, byDay: [...rule.byDay], byMonthDay: [...rule.byMonthDay] };
  const emit = (next: Rule) => {
    r = next;
    onChange(r);
  };

  // Interval and unit: "Powtarzaj co [2] [tydzień]".
  const line = el("div", "cal-row");
  const every = document.createElement("input");
  every.type = "number";
  every.min = "1";
  every.max = "999";
  every.value = String(r.interval);
  every.setAttribute("aria-label", "Co ile");
  const unit = document.createElement("select");
  unit.setAttribute("aria-label", "Jednostka");
  for (const [freq, label] of UNITS) unit.append(new Option(label, freq, false, freq === r.freq));
  line.append(el("span", "", "Powtarzaj co"), every, unit);
  wrap.append(line);

  // Weekly: the days of the week, Monday first.
  const days = el("div", "cal-days");
  const dayBtns = WEEKDAYS_ACC.map((label, wd) => {
    const btn = el("button", "cal-day", LETTERS[wd]);
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", () => {
      const has = r.byDay.some((d) => d.wd === wd);
      const next = has ? r.byDay.filter((d) => d.wd !== wd) : [...r.byDay, { n: null, wd }].sort((a, b) => a.wd - b.wd);
      if (next.length > 0) emit({ ...r, byDay: next });
      sync();
    });
    days.append(btn);
    return btn;
  });
  wrap.append(days);

  // Monthly: on a day of the month, or on the nth weekday.
  const monthly = el("div", "cal-row");
  const monthMode = document.createElement("select");
  monthMode.setAttribute("aria-label", "Dzień miesiąca");
  const { d } = ymdOf(startDay);
  const nth = ordinalOf(startDay);
  const wd = WEEKDAYS_ACC[weekdayOf(startDay)];
  monthMode.append(
    new Option(`w dniu ${d}`, "day"),
    new Option(`w ${nth === -1 ? "ostatnią" : `${nth}.`} ${wd}`, "nth"),
  );
  monthly.append(monthMode);
  wrap.append(monthly);

  // End: never, on a date, or after a number of occurrences.
  const ends = el("fieldset", "cal-ends");
  ends.append(el("legend", "", "Kończy się"));
  const endNever = radio("Nigdy");
  const endUntil = radio("Dnia");
  const untilDate = document.createElement("input");
  untilDate.type = "date";
  untilDate.lang = "pl";
  untilDate.setAttribute("aria-label", "Data końca");
  const endCount = radio("Po");
  const countInput = document.createElement("input");
  countInput.type = "number";
  countInput.min = "1";
  countInput.max = "999";
  countInput.setAttribute("aria-label", "Liczba wystąpień");
  ends.append(
    row(endNever.label),
    row(endUntil.label, untilDate),
    row(endCount.label, countInput, el("span", "", "wystąpieniach")),
  );
  wrap.append(ends);

  function radio(text: string) {
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    const label = document.createElement("label");
    label.className = "cal-radio";
    label.append(input, document.createTextNode(` ${text}`));
    return { input, label };
  }

  function row(...nodes: (HTMLElement | Node)[]): HTMLElement {
    const div = el("div", "cal-row");
    div.append(...nodes);
    return div;
  }

  // Every change goes through here: the rule is rebuilt from the fields.
  function fromFields(): void {
    const freq = unit.value as Freq;
    const n = Math.max(1, Math.min(999, Math.floor(Number(every.value)) || 1));
    let byDay = freq === "WEEKLY" ? r.byDay : [];
    let byMonthDay: number[] = [];
    if (freq === "WEEKLY" && byDay.length === 0) byDay = [{ n: null, wd: weekdayOf(startDay) }];
    if (freq === "MONTHLY") {
      if (monthMode.value === "nth") byDay = [{ n: nth, wd: weekdayOf(startDay) }];
      else byMonthDay = [d];
    }
    const byMonth = freq === "YEARLY" ? r.byMonth : [];
    const next: Rule = { freq, interval: n, byMonth, byDay, byMonthDay, count: null, until: null };
    if (endCount.input.checked) next.count = Math.max(1, Math.floor(Number(countInput.value)) || 1);
    if (endUntil.input.checked) {
      const until = parseIsoDay(untilDate.value);
      next.until = until !== null && until >= startDay ? until : startDay;
    }
    emit(next);
    sync();
  }

  // Shows the fields of the current rule (also after a click on a weekday).
  function sync(): void {
    every.value = String(r.interval);
    unit.value = r.freq;
    for (const [i, btn] of dayBtns.entries()) {
      const on = r.byDay.some((x) => x.wd === i);
      btn.setAttribute("aria-pressed", String(on));
    }
    days.hidden = r.freq !== "WEEKLY";
    monthly.hidden = r.freq !== "MONTHLY";
    monthMode.value = r.byDay.length > 0 ? "nth" : "day";
    endNever.input.checked = r.count === null && r.until === null;
    endUntil.input.checked = r.until !== null;
    endCount.input.checked = r.count !== null;
    untilDate.value = isoDay(r.until ?? startDay);
    untilDate.disabled = r.until === null;
    countInput.value = String(r.count ?? 10);
    countInput.disabled = r.count === null;
  }

  for (const input of [every, unit, monthMode, untilDate, countInput]) input.addEventListener("change", fromFields);
  for (const input of [endNever.input, endUntil.input, endCount.input]) input.addEventListener("change", fromFields);
  sync();
  return wrap;
}

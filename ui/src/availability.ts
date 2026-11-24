//! Planning iterates UTC instants and tests local wall times, so DST and different time zones remain explicit.
import { type DataRecord, str, ids } from "./records";
export interface Slot {
  day: number;
  start: number;
  end: number;
  preferred?: boolean;
}
export interface Override {
  date: string;
  start: number;
  end: number;
  available: boolean;
}
export interface Proposal {
  start: string;
  end: string;
  available: string[];
  unknown: string[];
  preferred: number;
}
const partsCache = new Map<string, Intl.DateTimeFormat>();
export function localParts(
  time: number,
  timezone: string,
): { date: string; day: number; minute: number } {
  let formatter = partsCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partsCache.set(timezone, formatter);
  }
  const p = Object.fromEntries(
    formatter.formatToParts(new Date(time)).map((p) => [p.type, p.value]),
  );
  const date = `${p.year}-${p.month}-${p.day}`;
  return {
    date,
    day: (new Date(`${date}T12:00Z`).getUTCDay() + 6) % 7,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}
/** Reject ambiguous/nonexistent wall times instead of silently choosing a DST offset. */
export function wallTimeToIso(value: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error("Podaj datę i godzinę.");
  const base = Date.parse(`${value}Z`);
  const minute = Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
  const matches: number[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const time = base + offset * 60000;
    const parts = localParts(time, timezone);
    if (parts.date === value.slice(0, 10) && parts.minute === minute)
      matches.push(time);
  }
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Ta godzina występuje dwa razy przy zmianie czasu. Wybierz jednoznaczną godzinę."
        : "Ta godzina nie istnieje w wybranej strefie czasu.",
    );
  return new Date(matches[0]).toISOString();
}
export function availabilityAt(
  record: DataRecord | undefined,
  time: number,
): "yes" | "preferred" | "no" | "unknown" {
  if (!record || record.disabled) return "unknown";
  const p = localParts(time, str(record, "timezone"));
  if (str(record, "valid_from") && p.date < str(record, "valid_from"))
    return "unknown";
  if (str(record, "valid_until") && p.date > str(record, "valid_until"))
    return "unknown";
  const overrides = (record.date_overrides ?? []) as Override[];
  const exceptions = overrides.filter(
    (o) => o.date === p.date && o.start <= p.minute && p.minute < o.end,
  );
  if (exceptions.length)
    return exceptions.some((o) => !o.available) ? "no" : "yes";
  const slots = (record.weekly_slots ?? []) as Slot[];
  const hit = slots.filter(
    (s) => s.day === p.day && s.start <= p.minute && p.minute < s.end,
  );
  return hit.some((s) => s.preferred) ? "preferred" : hit.length ? "yes" : "no";
}
export function occurrences(
  event: DataRecord,
  from: number,
  until: number,
): { start: number; end: number }[] {
  const start = Date.parse(str(event, "start")),
    end = Date.parse(str(event, "end"));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return [];
  const rule = str(event, "rrule");
  if (!rule) return end > from && start < until ? [{ start, end }] : [];
  const timezone = str(event, "timezone"),
    p = localParts(start, timezone),
    duration = end - start;
  const step = rule === "FREQ=DAILY" ? 1 : 7;
  const baseDate = Date.parse(`${p.date}T00:00Z`);
  const out: { start: number; end: number }[] = [];
  const first = Math.max(
    0,
    Math.floor((from - duration - baseDate) / (step * 86400000)) - 2,
  );
  for (let i = first; i < first + 400; i++) {
    const day = new Date(baseDate + i * step * 86400000)
      .toISOString()
      .slice(0, 10);
    if (Date.parse(`${day}T00:00Z`) > until + 86400000) break;
    if (str(event, "repeat_until") && day > str(event, "repeat_until")) break;
    if (ids(event, "exceptions").includes(day)) continue;
    const wall = `${day}T${String(Math.floor(p.minute / 60)).padStart(2, "0")}:${String(p.minute % 60).padStart(2, "0")}`;
    let time: number;
    try {
      time = Date.parse(wallTimeToIso(wall, timezone));
    } catch {
      continue;
    }
    if (time >= start && time < until && time + duration > from)
      out.push({ start: time, end: time + duration });
  }
  return out;
}
export function proposeMeetings(
  people: string[],
  required: string[],
  records: DataRecord[],
  events: DataRecord[],
  from: number,
  until: number,
  minutes: number,
  quorum = people.length,
): Proposal[] {
  if (
    !Number.isInteger(minutes) ||
    minutes <= 0 ||
    minutes > 480 ||
    until <= from ||
    until - from > 32 * 86400000 ||
    !people.length ||
    required.some((p) => !people.includes(p))
  )
    return [];
  const availability = new Map(
    records
      .filter((r) => r.kind === "availability" && !r.deleted)
      .map((r) => [str(r, "user_id"), r]),
  );
  const busy = events
    .filter((r) => r.kind === "event" && !r.deleted)
    .flatMap((r) =>
      occurrences(r, from, until).map((o) => ({
        ...o,
        participants: ids(r, "participants"),
      })),
    );
  const proposals: Proposal[] = [];
  for (
    let time = Math.ceil(from / 1800000) * 1800000;
    time + minutes * 60000 <= until;
    time += 1800000
  ) {
    const end = time + minutes * 60000;
    const available: string[] = [],
      unknown: string[] = [];
    let preferred = 0;
    for (const person of people) {
      let ok = true,
        prefers = true,
        missing = false;
      for (let t = time; t < end; t += 60000) {
        const status = availabilityAt(availability.get(person), t);
        if (status === "unknown") missing = true;
        if (status === "no" || status === "unknown") ok = false;
        if (status !== "preferred") prefers = false;
      }
      if (
        busy.some(
          (e) =>
            e.participants.includes(person) && e.start < end && e.end > time,
        )
      )
        ok = false;
      if (missing) unknown.push(person);
      if (ok) {
        available.push(person);
        if (prefers) preferred++;
      }
    }
    if (
      available.length >= quorum &&
      required.every((p) => available.includes(p))
    )
      proposals.push({
        start: new Date(time).toISOString(),
        end: new Date(end).toISOString(),
        available,
        unknown,
        preferred,
      });
  }
  return proposals
    .sort(
      (a, b) =>
        b.available.length - a.available.length ||
        b.preferred - a.preferred ||
        a.start.localeCompare(b.start),
    )
    .slice(0, 20);
}

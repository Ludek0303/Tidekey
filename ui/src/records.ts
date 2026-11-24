import { canAdminister } from "./taskhistory";
export interface DataRecord {
  id: string;
  kind: string;
  [key: string]: unknown;
}
export function participantsFor(
  record: DataRecord,
  identity: import("./taskhistory").OrganizationSnapshot,
): string[] {
  const known = new Set(identity.members.map((m) => m.user_id));
  const members = record.all_members ? [...known] : ids(record, "participants");
  for (const group of identity.groups ?? [])
    if (!group.archived && ids(record, "group_ids").includes(group.id))
      members.push(...group.member_ids);
  return [...new Set(members)].filter((id) => known.has(id));
}
/** What the viewer sees of an event: its participants (groups included), its organizer, and an organization-wide one (no people, no groups). */
export function visibleTo(
  record: DataRecord,
  identity: import("./taskhistory").OrganizationSnapshot,
): boolean {
  const orgWide = !ids(record, "participants").length && !ids(record, "group_ids").length;
  return orgWide || record.organizer === identity.me || participantsFor(record, identity).includes(identity.me);
}
/** The organization calendar's filter: an owner or admin sees every event, a member the ones visibleTo gives them. */
export function inOrgCalendar(record: DataRecord, identity: import("./taskhistory").OrganizationSnapshot): boolean {
  return canAdminister(identity) || visibleTo(record, identity);
}
export interface RecordOperation {
  event_id: string;
  actor_user_id: string;
  time_ms: number;
  // The operation the author last knew on this record (null: none). Missing on operations from before conflicts existed.
  base?: string | string[] | null;
  record: { before: DataRecord | null; after: DataRecord };
  signerUserId?: string;
  signature?: string;
}
export interface ModuleData {
  records: Record<string, DataRecord>;
  revisions: Record<string, string>;
  markdown: Record<string, string>;
  operations: RecordOperation[];
  empty_revision: string;
  // Verification of the operations and events (browser only, see signing.ts), keyed by event_id.
  checks?: Record<string, import("./signing").EventCheck>;
}
export interface RecordConflict {
  record: string;
  a: RecordOperation;
  b: RecordOperation;
}
export const baseIds = (op: RecordOperation): string[] => (op.base == null ? [] : Array.isArray(op.base) ? op.base : [op.base]);
/**
 * Concurrent operations on one record: two operations from different authors with the same base (both saw the same
 * last operation, neither saw the other). Legacy operations without `base` never conflict. A conflict stays until an
 * operation whose base names both of them is made (the resolution).
 */
export function recordConflicts(operations: RecordOperation[]): RecordConflict[] {
  const based = operations.filter((op) => op.base !== undefined);
  const resolutions = based.filter((op) => baseIds(op).length >= 2);
  const conflicts: RecordConflict[] = [];
  for (let i = 0; i < based.length; i++)
    for (let j = i + 1; j < based.length; j++) {
      const a = based[i];
      const b = based[j];
      if (a.record.after.id !== b.record.after.id || a.actor_user_id === b.actor_user_id) continue;
      if (JSON.stringify(baseIds(a).sort()) !== JSON.stringify(baseIds(b).sort())) continue;
      const resolved = resolutions.some((r) => r.record.after.id === a.record.after.id && baseIds(r).includes(a.event_id) && baseIds(r).includes(b.event_id));
      if (!resolved) conflicts.push({ record: a.record.after.id, a, b });
    }
  return conflicts;
}
export const str = (r: DataRecord, key: string): string =>
  typeof r[key] === "string" ? (r[key] as string) : "";
export const num = (r: DataRecord, key: string): number =>
  typeof r[key] === "number" ? (r[key] as number) : 0;
export const ids = (r: DataRecord, key: string): string[] =>
  Array.isArray(r[key])
    ? (r[key] as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
/** The ids of the movements that a movement_cancel operation cancels. Compute it once per operations array. */
export function cancelledIds(operations: RecordOperation[]): Set<string> {
  return new Set(
    operations
      .filter((op) => op.record.after.kind === "movement_cancel")
      .map((op) => str(op.record.after, "target_id")),
  );
}
export function inventoryBalance(
  item: DataRecord,
  operations: RecordOperation[],
  cancelled = cancelledIds(operations),
): { available: number; conflict: boolean } {
  let available = num(item, "quantity");
  const seen = new Set<string>();
  for (const op of operations) {
    const r = op.record.after;
    if (
      r.kind !== "movement" ||
      r.item_id !== item.id ||
      seen.has(r.id) ||
      cancelled.has(r.id)
    )
      continue;
    seen.add(r.id);
    available += num(r, "quantity") * (r.issue ? -1 : 1);
  }
  return {
    available,
    conflict: available < 0 || available > num(item, "quantity"),
  };
}
/** A value as a Markdown table cell: no pipe that would end it, no line break that would end the row. */
const mdCell = (v: unknown): string =>
  String(v ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
export function moduleMarkdown(module: DataRecord, data: ModuleData): string {
  const records = Object.values(data.records)
    .filter((r) => r.module_id === module.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  const history = data.operations.filter(
    (op) => op.record.after.module_id === module.id,
  );
  const rows = records
    .filter((r) => !r.deleted)
    .map(
      (r) => module.kind === "inventory"
        ? `| ${mdCell(r.id)} | ${mdCell(r.name)} | ${mdCell(r.category)} | ${mdCell(r.location)} | ${mdCell(r.quantity)} ${mdCell(r.unit)} | ${mdCell(r.status)} | ${mdCell(r.custodian)} |`
        : `| ${mdCell(r.id)} | ${mdCell(r.name)} | ${mdCell(r.start ?? r.location)} | ${mdCell(r.end ?? r.quantity)} |`,
    )
    .join("\n");
  const table = module.kind === "inventory"
    ? `| ID | Nazwa | Kategoria | Miejsce | Ilość | Status | Opiekun |\n|---|---|---|---|---:|---|---|`
    : `| ID | Nazwa | Początek / lokalizacja | Koniec / ilość |\n|---|---|---|---|`;
  return `---\ntyp: ${module.kind}\nid: ${module.id}\nschema: notes-module-v1\n---\n\n# ${mdCell(module.name)}\n\n${table}\n${rows}\n\n## Pełny zapis danych\n\n\`\`\`json\n${JSON.stringify({ schema: "notes-module-v1", module, records, history }, null, 2)}\n\`\`\`\n`;
}
/** The header and one row per item (by name) with every field; `custodian` names the person by id. */
function inventoryRows(
  items: DataRecord[],
  operations: RecordOperation[],
  custodian: (id: string) => string,
): string[][] {
  const cancelled = cancelledIds(operations);
  const rows = [...items]
    .sort((a, b) => str(a, "name").localeCompare(str(b, "name"), "pl"))
    .map((r) =>
      [
        r.id,
        r.name,
        r.category,
        r.manufacturer,
        r.model,
        r.serial,
        inventoryBalance(r, operations, cancelled).available,
        r.quantity,
        r.unit,
        r.location,
        r.status,
        custodian(str(r, "custodian")),
        r.project,
        r.purchase_date,
        r.supplier,
        r.price,
        r.notes,
      ].map((v) => String(v ?? "")),
    );
  return [INVENTORY_COLUMNS, ...rows];
}
const INVENTORY_COLUMNS = [
  "ID",
  "Nazwa",
  "Kategoria",
  "Producent",
  "Model",
  "Numer seryjny",
  "Dostępne",
  "Ilość razem",
  "Jednostka",
  "Miejsce",
  "Status",
  "Opiekun",
  "Projekt",
  "Data zakupu",
  "Dostawca",
  "Cena",
  "Uwagi",
];
/** The rows as CSV text, with a byte-order mark first so Excel reads the Polish letters. */
function csvText(rows: string[][]): string {
  // a line break inside a cell would split the row (and the CSV block of inventoryNote), so it becomes a space
  const quote = (v: string) => {
    let s = v.replace(/\r?\n/g, " ");
    if (/^[=+@-]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return "﻿" + rows.map((r) => r.map(quote).join(",")).join("\r\n");
}
export function inventoryCsv(
  items: DataRecord[],
  operations: RecordOperation[],
  custodian: (id: string) => string,
): string {
  return csvText(inventoryRows(items, operations, custodian));
}
/**
 * The note that mirrors an inventory: a Markdown table of every item and the same data as CSV, rewritten after each
 * change (modules.ts). Its first line says it is generated, so edits go to the module instead.
 */
export function inventoryNote(
  module: DataRecord,
  items: DataRecord[],
  operations: RecordOperation[],
  custodian: (id: string) => string,
): string {
  const rows = inventoryRows(items, operations, custodian);
  const [head] = rows;
  const table = rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`);
  table.splice(1, 0, `|${"---|".repeat(head.length)}`);
  // the CSV block without its byte-order mark, with LF line breaks
  const csv = csvText(rows).slice(1).replace(/\r\n/g, "\n");
  return `---\ntyp: inwentarz-tabela\nmodul: ${module.id}\n---\n> Notatka wygenerowana z inwentarza „${mdCell(str(module, "name"))}”. Po każdej zmianie w inwentarzu jest nadpisywana. Zmiany wprowadzaj w module Inwentarze.\n\n${table.join("\n")}\n\n## CSV\n\n\`\`\`csv\n${csv}\n\`\`\`\n`;
}
export function download(
  name: string,
  text: BlobPart,
  mime = "text/markdown;charset=utf-8",
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

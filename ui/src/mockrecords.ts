import {
  baseIds,
  inventoryBalance,
  moduleMarkdown,
  type ModuleData,
  type DataRecord,
} from "./records";
export interface MockRecordsState {
  data: ModuleData;
  seq: number;
}
export class MockRecords {
  private readonly deviceId = crypto.randomUUID();
  readonly data: ModuleData = {
    records: {},
    revisions: {},
    markdown: {},
    operations: [],
    empty_revision: "none",
  };
  private seq = 0;
  snapshot(): MockRecordsState {
    return { data: structuredClone(this.data), seq: this.seq };
  }
  restore(state: MockRecordsState): void {
    this.data.records = structuredClone(state.data.records);
    this.data.revisions = structuredClone(state.data.revisions);
    this.data.markdown = structuredClone(state.data.markdown);
    this.data.operations = structuredClone(state.data.operations);
    this.data.empty_revision = state.data.empty_revision;
    this.seq = Math.max(0, Number.isSafeInteger(state.seq) ? state.seq : 0);
  }
  importModule(
    text: string,
    expected: string | null,
    commit: boolean,
    me: string,
  ): unknown {
    const raw = text.split("```json\n")[1]?.split("\n```")[0];
    if (!raw) throw new Error("Brak pełnego zapisu danych.");
    const data = JSON.parse(raw);
    if (
      data.schema !== "notes-module-v1" ||
      !data.module?.id ||
      !Array.isArray(data.records)
    )
      throw new Error("Nieprawidłowy schemat.");
    const incoming = [data.module, ...data.records] as DataRecord[];
    const seen = new Set<string>();
    for (const r of incoming) {
      if (!r.id || !r.kind || seen.has(r.id))
        throw new Error("Nieprawidłowy lub powtórzony rekord.");
      if (r.kind === "item" && (!String(r.category ?? "").trim() || !String(r.location ?? "").trim()))
        throw new Error("Każdy przedmiot musi mieć kategorię i miejsce.");
      seen.add(r.id);
    }
    const version = JSON.stringify(this.data.records);
    const changes = incoming
      .filter(
        (r) => JSON.stringify(this.data.records[r.id]) !== JSON.stringify(r),
      )
      .map((after) => ({ before: this.data.records[after.id] ?? null, after }));
    if (commit) {
      if (version !== expected)
        throw new Error("Dane zmieniły się od podglądu importu.");
      for (const c of changes) this.commit(c.after, me);
    }
    return { version, name: data.module.name, changes, committed: commit };
  }
  // `base` is set when a conflict is resolved: the ids of the operations the choice was made between.
  save(record: DataRecord, expected: string, me: string, base?: string[]): ModuleData {
    if ((this.data.revisions[record.id] ?? "none") !== expected)
      throw new Error("Rekord zmienił się. Odśwież dane.");
    if (!record.id || !record.kind)
      throw new Error("Brak identyfikatora lub rodzaju.");
    if (
      record.kind === "event" &&
      Date.parse(String(record.end)) <= Date.parse(String(record.start))
    )
      throw new Error("Nieprawidłowy zakres czasu.");
    if (
      record.kind === "item" &&
      (!(typeof record.quantity === "number") || record.quantity < 0)
    )
      throw new Error("Nieprawidłowa ilość.");
    if (record.kind === "item" && (!String(record.category ?? "").trim() || !String(record.location ?? "").trim()))
      throw new Error("Każdy przedmiot musi mieć kategorię i miejsce.");
    if (record.kind === "settings" && (record.id !== "org-settings" || !Number.isInteger(record.task_retention_months) || Number(record.task_retention_months) < 0 || Number(record.task_retention_months) > 120 || (record.activity_visibility != null && !["admins", "members"].includes(String(record.activity_visibility)))))
      throw new Error("Nieprawidłowe ustawienia organizacji.");
    this.commit(record, me, base);
    return structuredClone(this.data);
  }
  // `base`: the operation(s) this author last saw on the record, i.e. its heads (none for a first one), so two operations
  // sharing a base from different authors are concurrent (see records.ts recordConflicts).
  private commit(record: DataRecord, me: string, base?: string[]): void {
    const before = this.data.records[record.id] ?? null;
    const ops = this.data.operations.filter((op) => op.record.after.id === record.id);
    const named = new Set(ops.flatMap(baseIds));
    const heads = ops.map((op) => op.event_id).filter((id) => !named.has(id));
    this.data.operations.push({
      event_id: `demo-${this.deviceId}-${++this.seq}`,
      actor_user_id: me,
      time_ms: Date.now(),
      base: base ?? (heads.length > 1 ? heads : (heads[0] ?? null)),
      record: {
        before: structuredClone(before),
        after: structuredClone(record),
      },
    });
    this.data.records[record.id] = structuredClone(record);
    this.data.revisions[record.id] = String(this.seq);
    for (const r of Object.values(this.data.records).filter(
      (r) => r.kind === "calendar" || r.kind === "inventory",
    ))
      this.data.markdown[r.id] = moduleMarkdown(r, this.data);
  }
  movement(
    id: string,
    itemId: string,
    quantity: number,
    issue: boolean,
    borrower: string,
    me: string,
  ): ModuleData {
    if (this.data.records[id]) return structuredClone(this.data);
    const item = this.data.records[itemId];
    if (
      !item ||
      item.kind !== "item" ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    )
      throw new Error("Nieprawidłowa operacja.");
    const balance = inventoryBalance(item, this.data.operations);
    const next = balance.available + (issue ? -quantity : quantity);
    if (balance.conflict || next < 0 || next > Number(item.quantity))
      throw new Error("Operacja przekracza stan magazynu.");
    this.commit(
      {
        id,
        kind: "movement",
        module_id: item.module_id,
        item_id: itemId,
        quantity,
        issue,
        borrower,
      },
      me,
    );
    return structuredClone(this.data);
  }
}

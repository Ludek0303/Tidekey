// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { afterEach, describe, expect, it } from "vitest";
import { checkersOf, mayTick, parseTableChecks, setTableCheckAccess, tableCheckGuard } from "./tablechecks";

afterEach(() => setTableCheckAccess(null));

const TABLE = [
  "| Osoba | Składka !zaznacza:@skarbnik | Ankieta |",
  "|---|:-:|---|",
  "| Ania @Ania | [x] @Ania 📅 2026-11-30 | [ ] |",
  "| Piotr | [ ] @Piotr | [ ] |",
].join("\n");

describe("parseTableChecks", () => {
  it("reads the box, the header, the row label, the people, the due date and the checkers of each cell", () => {
    const items = parseTableChecks(TABLE);
    expect(items.map((i) => [i.line, i.column])).toEqual([[3, 1], [3, 2], [4, 1], [4, 2]]);
    expect(items[0]).toEqual({
      line: 3,
      column: 1,
      at: TABLE.split("\n")[2].indexOf("[x]"),
      checked: true,
      header: "Składka",
      rowLabel: "Ania",
      people: ["Ania"],
      due: "2026-11-30",
      checkers: ["skarbnik"],
    });
    expect(items[1]).toMatchObject({ checked: false, header: "Ankieta", rowLabel: "Ania", people: [], checkers: [] });
    expect(items[2]).toMatchObject({ checked: false, rowLabel: "Piotr", people: ["Piotr"], due: undefined });
  });

  it("skips fenced code and the separator row, and needs a header with a separator under it", () => {
    expect(parseTableChecks("```\n| A | B |\n|---|---|\n| [ ] | x |\n```")).toEqual([]);
    expect(parseTableChecks("| A | B |\n| [ ] | x |")).toEqual([]);
    const after = parseTableChecks("```\n| x |\n```\n\n| A |\n|---|\n| [ ] |");
    expect(after.map((i) => i.line)).toEqual([7]);
  });

  it("reads several !zaznacza tokens of one header", () => {
    expect(checkersOf("Zapłacone !zaznacza:@skarbnik !zaznacza:Admin")).toEqual(["skarbnik", "Admin"]);
    expect(checkersOf("Zapłacone")).toEqual([]);
  });
});

describe("tick access", () => {
  it("lets everyone tick when no access function is set, and anyone when the column names no one", () => {
    expect(mayTick(["skarbnik"])).toBe(true);
    setTableCheckAccess(() => false);
    expect(mayTick([])).toBe(true);
    expect(mayTick(["skarbnik"])).toBe(false);
  });
});

describe("tableCheckGuard", () => {
  const boxAt = (text: string, box: string) => text.indexOf(box);
  const guarded = (doc: string) => EditorState.create({ doc, extensions: [tableCheckGuard] });

  it("drops a typed change to a box the user may not tick, and keeps the other boxes", () => {
    setTableCheckAccess((checkers) => !checkers.includes("skarbnik"));
    const state = guarded(TABLE);
    const protectedBox = boxAt(TABLE, "[ ] @Piotr");
    const blocked = state.update({ changes: { from: protectedBox + 1, insert: "x" }, userEvent: "input" });
    expect(blocked.state.doc.toString()).toBe(TABLE);
    const deleted = state.update({ changes: { from: protectedBox, to: protectedBox + 3 }, userEvent: "delete.backward" });
    expect(deleted.state.doc.toString()).toBe(TABLE);

    const free = TABLE.lastIndexOf("[ ] |"); // the Ankieta box of Piotr's row
    const ticked = state.update({ changes: { from: free + 1, to: free + 2, insert: "x" }, userEvent: "input" });
    expect(ticked.state.doc.toString()).toContain("| Piotr | [ ] @Piotr | [x] |");
  });

  it("lets a rewrite through that leaves the box as it is, and any change without a user event", () => {
    setTableCheckAccess(() => false);
    const state = guarded(TABLE);
    const same = state.update({ changes: { from: 0, to: TABLE.length, insert: TABLE }, userEvent: "input" });
    expect(same.state.doc.toString()).toBe(TABLE);
    const remote = state.update({ changes: { from: boxAt(TABLE, "[ ] @Piotr") + 1, to: boxAt(TABLE, "[ ] @Piotr") + 2, insert: "x" } });
    expect(remote.state.doc.toString()).toContain("[x] @Piotr");
  });

  it("does nothing without an access function", () => {
    const state = guarded(TABLE);
    const ticked = state.update({ changes: { from: boxAt(TABLE, "[ ] @Piotr") + 1, to: boxAt(TABLE, "[ ] @Piotr") + 2, insert: "x" }, userEvent: "input" });
    expect(ticked.state.doc.toString()).toContain("[x] @Piotr");
  });
});

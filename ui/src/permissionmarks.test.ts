// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MARKS_TEXT, permissionMarks, touchesPermissionMarks } from "./permissionmarks";

const note = (front: string, body = "# Projekt\n\nTreść.\n"): string => `---\n${front}---\n${body}`;
const base = note("typ: projekt\nstatus: aktywny\nosoby: Anna, Jan\ngrupy: g1\nprowadzacy: Anna\n");
const table = "| Imię | Składka !zaznacza:@Anna |\n|---|---|\n| Jan | [ ] |\n";

describe("permission marks", () => {
  it("ignores changes of the body and of other front matter fields", () => {
    expect(touchesPermissionMarks(base, base.replace("Treść.", "Inna treść.\n- [ ] zadanie @Jan"))).toBe(false);
    expect(touchesPermissionMarks(base, base.replace("status: aktywny", "status: zamknięty"))).toBe(false);
    expect(touchesPermissionMarks(base + table, base + table + "| Ola | [x] |\n")).toBe(false);
    expect(touchesPermissionMarks(base.replace("\n", "\r\n"), base)).toBe(false);
  });

  it("catches adding, removing or changing osoby:, grupy:, prowadzacy: and typ:", () => {
    expect(touchesPermissionMarks(base, base.replace("osoby: Anna, Jan", "osoby: Anna, Jan, Mallory"))).toBe(true);
    expect(touchesPermissionMarks(base, base.replace("osoby: Anna, Jan\n", ""))).toBe(true);
    expect(touchesPermissionMarks(base, base.replace("grupy: g1", "grupy: g1, g2"))).toBe(true);
    expect(touchesPermissionMarks(base, base.replace("prowadzacy: Anna", "prowadzacy: Jan"))).toBe(true);
    expect(touchesPermissionMarks(base, base.replace("typ: projekt", "typ: kalendarz"))).toBe(true);
    expect(touchesPermissionMarks("# Bez frontmattera\n", note("osoby: Mallory\n", "# Bez frontmattera\n"))).toBe(true);
    expect(touchesPermissionMarks(base, base.replace("osoby: Anna, Jan", "Osoby: Anna"))).toBe(true);
    // a YAML list under the key and an indented key count too
    const list = note("osoby:\n  - Anna\n");
    expect(touchesPermissionMarks(list, note("osoby:\n  - Anna\n  - Mallory\n"))).toBe(true);
    expect(touchesPermissionMarks(note("status: a\n"), note("status: a\n  osoby: Mallory\n"))).toBe(true);
    // breaking the front matter open removes the marks
    expect(touchesPermissionMarks(base, base.replace(/^---\n/, ""))).toBe(true);
  });

  it("catches adding, removing, changing or moving !zaznacza: tokens", () => {
    expect(touchesPermissionMarks(base, base + table)).toBe(true);
    expect(touchesPermissionMarks(base + table, base + table.replace(" !zaznacza:@Anna", ""))).toBe(true);
    expect(touchesPermissionMarks(base + table, base + table.replace("@Anna", "@Mallory"))).toBe(true);
    expect(touchesPermissionMarks(base + table, base + table.replace("| Imię | Składka !zaznacza:@Anna |", "| Imię !zaznacza:@Anna | Składka |"))).toBe(true);
    expect(touchesPermissionMarks(base + table, base + table.replace("!zaznacza:@Anna", "!zaznacza:@Anna !zaznacza:@Jan"))).toBe(true);
  });

  it("the extract is the same for the same marks", () => {
    expect(permissionMarks(base)).toBe(permissionMarks(base.replace("Treść.", "Zmieniona.")));
    expect(permissionMarks("# Nic\n")).toBe(permissionMarks("# Też nic\n"));
    expect(MARKS_TEXT).toBe("Czat nie zmienia osób, prowadzącego ani uprawnień kolumn. Zrób to w aplikacji.");
  });
});

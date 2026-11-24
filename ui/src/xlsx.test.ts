import { describe, expect, it } from "vitest";
import { crc32, xlsxBytes, type XlsxCell } from "./xlsx";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("xlsx", () => {
  it("CRC-32 of 123456789 is the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes a ZIP with six entries and a valid end record", () => {
    const bytes = xlsxBytes([[{ kind: "text", text: "a" }]]);
    expect(text(bytes.slice(0, 4))).toBe("PK\x03\x04");
    const eocd = bytes.length - 22;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 8, true)).toBe(6);
    expect(text(bytes)).toContain("xl/worksheets/sheet1.xml");
  });

  it("writes the cells: numbers, bold header, escaped text, bool, date serial, empty skipped", () => {
    const rows: XlsxCell[][] = [
      [
        { kind: "text", text: "Nazwa" },
        { kind: "text", text: "Kwota" },
        { kind: "text", text: "Data" },
        { kind: "text", text: "Ok" },
      ],
      [
        { kind: "text", text: "A<&>B\u0001" },
        { kind: "number", text: "-12,5" },
        { kind: "date", text: "2026-11-15" },
        { kind: "bool", text: "PRAWDA" },
      ],
      [
        { kind: "empty", text: "" },
        { kind: "date", text: "15.11.2026" },
        { kind: "error", text: "#DIV/0!" },
        { kind: "bool", text: "FAŁSZ" },
      ],
    ];
    const sheet = text(xlsxBytes(rows));
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Nazwa</t></is></c>');
    expect(sheet).toContain('<c r="A2" s="0" t="inlineStr"><is><t xml:space="preserve">A&lt;&amp;&gt;B</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>-12.5</v></c>');
    expect(sheet).toContain('<c r="C2" s="2"><v>46341</v></c>');
    expect(sheet).toContain('<c r="D2" t="b"><v>1</v></c>');
    expect(sheet).toContain('<c r="B3" s="2"><v>46341</v></c>');
    expect(sheet).toContain('<c r="C3" s="0" t="inlineStr"><is><t xml:space="preserve">#DIV/0!</t></is></c>');
    expect(sheet).toContain('<c r="D3" t="b"><v>0</v></c>');
    expect(sheet).not.toContain('r="A3"');
  });

  it("sanitises the sheet name and keeps it under 31 characters", () => {
    const wb = text(xlsxBytes([], "a/b:[c]" + "x".repeat(40)));
    expect(wb).toContain(`name="a_b__c_${"x".repeat(24)}"`);
  });
});

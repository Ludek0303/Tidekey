// A minimal .xlsx writer: one sheet, values only, inline strings, stored (uncompressed) ZIP entries.
import { colName } from "./table";
import type { CellKind } from "./formula";

export type XlsxCell = { kind: CellKind; text: string };

const enc = new TextEncoder();
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed DOS date (1980-01-01) and time 00:00, so the bytes do not depend on the clock.
const DOS_DATE = 0x21;

function zip(files: [string, string][]): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, data);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(14, DOS_DATE, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  const cdSize = centrals.reduce((n, p) => n + p.length, 0);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Control characters other than tab, LF and CR are not allowed in XML 1.0.
function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Numbers come from fmt_number in crates/core: a decimal comma, no thousands separator.
function numberValue(text: string): number | null {
  if (!/^-?\d+(,\d+)?$/.test(text)) return null;
  return Number(text.replace(",", "."));
}

// Dates are YYYY-MM-DD or DD.MM.YYYY (crates/core/src/formula/date.rs); the serial counts days from 1899-12-30.
function dateSerial(text: string): number | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  const parts = iso ? [+iso[1], +iso[2], +iso[3]] : dotted ? [+dotted[3], +dotted[2], +dotted[1]] : null;
  if (!parts) return null;
  const [y, m, d] = parts;
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  return back.getUTCDate() === d && back.getUTCMonth() === m - 1 ? ms / 86_400_000 + 25569 : null;
}

function cellXml(cell: XlsxCell, ref: string, header: boolean): string {
  const text = (s: string, style: number) =>
    `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
  switch (cell.kind) {
    case "empty":
      return "";
    case "number": {
      const n = numberValue(cell.text);
      return n === null ? text(cell.text, header ? 1 : 0) : `<c r="${ref}"${header ? ' s="1"' : ""}><v>${n}</v></c>`;
    }
    case "bool":
      return `<c r="${ref}"${header ? ' s="1"' : ""} t="b"><v>${cell.text === "PRAWDA" ? 1 : 0}</v></c>`;
    case "date": {
      const serial = dateSerial(cell.text);
      return serial === null ? text(cell.text, header ? 1 : 0) : `<c r="${ref}" s="2"><v>${serial}</v></c>`;
    }
    default:
      return text(cell.text, header ? 1 : 0);
  }
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

/** The table as an .xlsx file. Row 1 is the header (bold). Values only: formulas are not translated to Excel's English function names. */
// shortcut: values only, formulas are not translated to Excel's English function names; translate them when users ask for live formulas in Excel
export function xlsxBytes(rows: XlsxCell[][], sheetName = "Arkusz1"): Uint8Array<ArrayBuffer> {
  const name = esc(sheetName.replace(/[[\]:*?\/\\]/g, "_").slice(0, 31));
  const sheetRows = rows
    .map((row, r) => {
      const cells = row.map((cell, c) => cellXml(cell, `${colName(c)}${r + 1}`, r === 0)).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return zip([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    ["xl/styles.xml", STYLES],
    [
      "xl/worksheets/sheet1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ],
  ]);
}

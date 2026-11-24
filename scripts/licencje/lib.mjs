// Pure helpers of the notices generator (generate.mjs): SPDX expressions, which licence of "A OR B" we take, what
// licence a text is, copyright lines, and grouping of identical licence texts. Tests: lib.test.mjs (node --test).

// Our choice in "A OR B", most preferred first (docs/LICENCJE.md "Wybór przy licencjach A OR B").
export const PREFERENCE = [
  "MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC", "Zlib", "0BSD", "BSL-1.0", "Unicode-3.0",
  "CC0-1.0", "Unlicense", "CDLA-Permissive-2.0", "blessing", "MPL-2.0", "CC-BY-4.0", "LGPL-3.0-or-later", "LGPL-2.1-or-later",
];

function tokenize(expr) {
  return expr.replace(/\//g, " OR ").replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
}

// An SPDX expression as alternatives (disjunctive normal form): [["MIT"], ["Apache-2.0", "ISC"]].
// "X WITH Y" stays one licence ("Apache-2.0 WITH LLVM-exception").
export function alternatives(expr) {
  const t = tokenize(expr);
  let i = 0;
  const primary = () => {
    if (t[i] === "(") {
      i++;
      const r = or();
      i++; // ")"
      return r;
    }
    let id = t[i++];
    if (t[i] === "WITH") {
      id += ` WITH ${t[i + 1]}`;
      i += 2;
    }
    return [[id]];
  };
  const and = () => {
    let left = primary();
    while (t[i] === "AND") {
      i++;
      const right = primary();
      left = left.flatMap((a) => right.map((b) => [...a, ...b]));
    }
    return left;
  };
  const or = () => {
    let left = and();
    while (t[i] === "OR") {
      i++;
      left = [...left, ...and()];
    }
    return left;
  };
  return or();
}

const rank = (id) => {
  const r = PREFERENCE.indexOf(id);
  return r < 0 ? PREFERENCE.length + 1 : r;
};

// The alternatives in our order: the one whose least preferred licence is the most preferred first; ties go to fewer
// licences.
export function ranked(expr) {
  const alts = alternatives(expr).map((a) => [...new Set(a)].sort((x, y) => rank(x) - rank(y)));
  return alts.sort((a, b) => Math.max(...a.map(rank)) - Math.max(...b.map(rank)) || a.length - b.length);
}

// The alternative we take: the first in our order that `usable` accepts (we have its texts), else the first one.
export function choose(expr, usable = () => true) {
  const alts = ranked(expr);
  return alts.find(usable) ?? alts[0];
}

// Which licences a text contains, from its wording ([] when none is recognised, e.g. a COPYRIGHT or THIRD-PARTY file).
// A file may hold several (MIT and Apache-2.0 in one LICENSE).
export function detect(text) {
  // licence texts in source headers carry comment markers at line starts
  const t = text.replace(/^[ \t]*(\/\/+|#+|\*+|\/\*+|;+)/gm, " ").replace(/\s+/g, " ").toLowerCase();
  const found = [];
  const has = (...words) => words.every((w) => t.includes(w));
  if (has("apache license", "version 2.0")) found.push("Apache-2.0");
  if (has("mozilla public license", "2.0")) found.push("MPL-2.0");
  if (t.includes("unicode license v3") || t.includes("unicode, inc. license agreement")) found.push("Unicode-3.0");
  if (t.includes("boost software license")) found.push("BSL-1.0");
  if (t.includes("community data license agreement")) found.push("CDLA-Permissive-2.0");
  if (has("creative commons legal code", "cc0")) found.push("CC0-1.0");
  if (has("attribution 4.0 international")) found.push("CC-BY-4.0");
  if (t.includes("free and unencumbered software released into the public domain")) found.push("Unlicense");
  if (t.includes("permission is hereby granted, free of charge")) found.push("MIT");
  if (t.includes("redistribution and use in source and binary forms"))
    found.push(t.includes("neither the name") || t.includes("may not be used to endorse") ? "BSD-3-Clause" : "BSD-2-Clause");
  if (t.includes("permission to use, copy, modify, and/or distribute this software for any purpose"))
    found.push(t.includes("provided that the above copyright notice") ? "ISC" : "0BSD");
  else if (t.includes("permission to use, copy, modify, and distribute this software")) found.push("ISC");
  if (t.includes("this software is provided 'as-is'") || t.includes('this software is provided "as-is"')) found.push("Zlib");
  // MPL-2.0 names the LGPL among its "Secondary Licenses"; only the LGPL's own heading counts
  if (/gnu lesser general public license version \d/.test(t)) found.push("LGPL");
  return found;
}

// the licences' own lines: templates, and the copyright of the licence document itself (FSF)
const TEMPLATE = /free software foundation, inc|<year>|\[yyyy\]|<copyright holders>|\[name of copyright owner\]|<name of author>|copyright holders and contributors|copyright notice|copyright owner|copyright statement|copyright license|copyright holder/i;

// The copyright lines of licence and notice texts, without the licences' own template lines; sorted, no repeats.
export function copyrights(texts) {
  const out = new Set();
  for (const text of texts)
    for (const raw of text.split("\n")) {
      const line = raw.replace(/^[\s*#/;%!-]+/, "").replace(/\s+/g, " ").trim();
      // a notice: "Copyright (c) …", "Copyright 2019 …", "© …" or "(c) 2019 …", not prose that starts with the word
      if (!/^(copyright\s*(\(c\)|©|\d)|copyright\s+[a-z0-9]|©|\(c\)\s*\d)/i.test(line) || /^copyright (on|and|to|in|of|law|notice|license|holder)\b/i.test(line)) continue;
      if (TEMPLATE.test(line) || line.length > 200) continue;
      out.add(line);
    }
  return [...out].sort();
}

// A licence text with its copyright lines and formatting removed: two copies of MIT by different authors share it.
export function normalized(text) {
  return text
    .split("\n")
    .filter((l) => !/(^|\W)(copyright|\(c\)|©|all rights reserved)(\W|$)/i.test(l))
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

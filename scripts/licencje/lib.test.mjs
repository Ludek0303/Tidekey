// node --test scripts/licencje
import assert from "node:assert/strict";
import { test } from "node:test";
import { alternatives, choose, copyrights, detect, normalized } from "./lib.mjs";

test("SPDX expressions: OR, AND, parentheses, slash, WITH", () => {
  assert.deepEqual(alternatives("MIT OR Apache-2.0"), [["MIT"], ["Apache-2.0"]]);
  assert.deepEqual(alternatives("(MIT OR Apache-2.0) AND Unicode-3.0"), [["MIT", "Unicode-3.0"], ["Apache-2.0", "Unicode-3.0"]]);
  assert.deepEqual(alternatives("MIT/Apache-2.0"), [["MIT"], ["Apache-2.0"]]);
  assert.deepEqual(alternatives("Apache-2.0 WITH LLVM-exception OR MIT"), [["Apache-2.0 WITH LLVM-exception"], ["MIT"]]);
});

test("our choice: MIT before Apache, AND parts stay, GPL never when an alternative exists", () => {
  assert.deepEqual(choose("Apache-2.0 OR MIT"), ["MIT"]);
  assert.deepEqual(choose("(MIT OR Apache-2.0) AND Unicode-3.0"), ["MIT", "Unicode-3.0"]);
  assert.deepEqual(choose("MIT OR GPL-3.0-or-later"), ["MIT"]);
  assert.deepEqual(choose("Apache-2.0 AND ISC"), ["Apache-2.0", "ISC"]);
  assert.deepEqual(choose("CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception"), ["Apache-2.0"]);
});

test("licence texts are recognised by their wording", () => {
  assert.deepEqual(detect("Permission is hereby granted, free of charge, to any person"), ["MIT"]);
  assert.deepEqual(detect("Apache License\n Version 2.0, January 2004 ... Permission is hereby granted, free of charge"), ["Apache-2.0", "MIT"]);
  assert.deepEqual(detect("Redistribution and use in source and binary forms ... Neither the name of"), ["BSD-3-Clause"]);
  assert.deepEqual(detect("Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice"), ["ISC"]);
  assert.deepEqual(detect("Some project notice"), []);
});

test("copyright lines without licence templates; texts compared without them", () => {
  const a = "MIT License\n\nCopyright (c) 2020 Ala\n\nPermission is hereby granted";
  const b = "MIT License\nCopyright (c) 2021 Ola Kot\nPermission is hereby granted";
  assert.deepEqual(copyrights([a, "Copyright [yyyy] [name of copyright owner]", " * Copyright 2019 Jan"]), ["Copyright (c) 2020 Ala", "Copyright 2019 Jan"]);
  assert.equal(normalized(a), normalized(b));
});

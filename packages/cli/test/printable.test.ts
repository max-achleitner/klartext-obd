import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { printable } from "../src/printable.ts";

test("terminal control sequences are made visible instead of executed", () => {
  const hostile = "Carly\u001b[2J\u001b]0;owned\u0007\r\u0008\u009b31m";
  const safe = printable(hostile);
  assert.equal(safe, "Carly\\u{1b}[2J\\u{1b}]0;owned\\u{07}\\u{0d}\\u{08}\\u{9b}31m");
  assert.doesNotMatch(safe, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

test("bidirectional overrides are made visible", () => {
  assert.equal(printable("abc\u202egpj.exe"), "abc\\u{202e}gpj.exe");
});

test("ordinary text, umlauts, tabs and line breaks pass unchanged", () => {
  const text = "Steuergerät\tgeprüft\nZeile 2 – ok";
  assert.equal(printable(text), text);
});

test("the command line has no terminal output that bypasses printable()", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "main.ts"), "utf8");
  assert.doesNotMatch(source, /console\./, "use say() / complain()");
  // Direct writes are allowed only for the wrappers and the numeric progress counter.
  const direct = source.split("\n").filter((line) => /process\.std(out|err)\.write/.test(line));
  for (const line of direct) {
    assert.match(line, /printable\(|"\\r"|"\\n"|progress\.index/, `unreviewed direct write: ${line.trim()}`);
  }
});

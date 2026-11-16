import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLine, PolicyViolation } from "../src/policy.ts";

const allowed = [
  "ATZ",
  "ATI",
  "AT@1",
  "ATRV",
  "ATE0",
  "ATH1",
  "ATSP0",
  "ATSP6",
  "ATSH7E0",
  "ATSH7DF",
  "ATCRA77E",
  "ATFCSH714",
  "ATFCSD300000",
  "ATFCSM1",
  "ATFCSM0",
  "ATSTFF",
  "0100",
  "0902",
  "03",
  "07",
  "0A",
  "020200",
  "1902AF",
  "190108",
  "22F190",
  "3E00",
];

const refused: Array<[line: string, why: string]> = [
  ["04", "clear emission DTCs"],
  ["14FFFFFF", "clear fault memory"],
  ["1003", "extended session"],
  ["1002", "programming session"],
  ["1101", "ECU reset"],
  ["2701", "security access"],
  ["2EF19000", "write data"],
  ["2F123403", "actuator control"],
  ["31010203", "routine control"],
  ["3401", "request download"],
  ["3601", "transfer data"],
  ["3D", "write memory"],
  ["2800", "communication control"],
  ["8502", "DTC setting"],
  ["3E80", "tester present without response"],
  ["1906", "DTC sub-function that is not enabled"],
  ["22F190F187", "two identifiers in one request"],
  ["22F1", "truncated request"],
  ["0100000000000000", "more than one frame"],
  ["ATPP0CSV01", "programmable parameter (persistent)"],
  ["ATCAF0", "raw frame mode"],
  ["ATMA", "bus monitor"],
  ["AT@3ABCDEFGHIJKL", "writes adapter identifier permanently"],
  ["ATSH123", "transmit identifier outside the diagnostic range"],
  ["ATSH18DAF110", "29-bit identifier not enabled"],
  ["ATFCSH200", "flow control outside the diagnostic range"],
  ["ATFCSD300100", "non-standard flow control"],
  ["ATSP3", "protocol that is not enabled"],
  ["", "empty line repeats the previous command"],
  ["   ", "blank line repeats the previous command"],
  ["0100\rATZ", "embedded carriage return"],
  ["01 00;", "illegal character"],
  ["1", "odd number of hex digits"],
  ["HELLO", "garbage"],
];

test("read-only lines pass and are normalised", () => {
  for (const line of allowed) assert.equal(checkLine(line).line, line);
  assert.deepEqual(checkLine("at sh 7e0"), { line: "ATSH7E0", kind: "adapter-command" });
  assert.deepEqual(checkLine("22 f1 90"), { line: "22F190", kind: "diagnostic-request" });
});

test("everything else is refused", () => {
  for (const [line, why] of refused) {
    assert.throws(() => checkLine(line), PolicyViolation, `should refuse ${JSON.stringify(line)} (${why})`);
  }
});

test("every service identifier outside the allowlist is refused in every length", () => {
  const readOnly = new Set([0x01, 0x02, 0x03, 0x07, 0x09, 0x0a, 0x19, 0x22, 0x3e]);
  for (let sid = 0; sid <= 0xff; sid++) {
    if (readOnly.has(sid)) continue;
    for (let extra = 0; extra <= 6; extra++) {
      const line = sid.toString(16).padStart(2, "0") + "00".repeat(extra);
      assert.throws(() => checkLine(line), PolicyViolation, line);
    }
  }
});

test("random input never passes unless it matches an independent description of the allowlist", () => {
  // Deliberately written separately from policy.ts so a mistake there cannot hide here.
  const independent = [
    /^AT(Z|D|I|@1|RV|DP|DPN|E0|L0|S1|H1|CAF1|AR)$/,
    /^ATAT[012]$/,
    /^ATST[0-9A-F]{2}$/,
    /^ATSP[06]$/,
    /^AT(SH|CRA|FCSH)7[0-9A-F]{2}$/,
    /^ATFCSD300000$/,
    /^ATFCSM[01]$/,
    /^01[0-9A-F]{2}$/,
    /^02[0-9A-F]{4}$/,
    /^(03|07|0A)$/,
    /^09[0-9A-F]{2}$/,
    /^190[12][0-9A-F]{2}$/,
    /^22[0-9A-F]{4}$/,
    /^3E00$/,
  ];
  const alphabet = "0123456789ABCDEFATSHZ@ \r";
  let seed = 0x2545f491;
  const next = (): number => {
    // xorshift32: deterministic, so a failure is reproducible
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  let passed = 0;
  for (let i = 0; i < 200_000; i++) {
    const length = 1 + Math.floor(next() * 12);
    let line = next() < 0.3 ? "AT" : "";
    for (let j = 0; j < length; j++) line += alphabet[Math.floor(next() * alphabet.length)];
    let result;
    try {
      result = checkLine(line);
    } catch (error) {
      assert.ok(error instanceof PolicyViolation);
      continue;
    }
    passed++;
    assert.ok(
      independent.some((p) => p.test(result.line)),
      `policy let through ${JSON.stringify(line)}`,
    );
  }
  assert.ok(passed > 0, "fuzzer should produce some valid lines, otherwise it tests nothing");
});

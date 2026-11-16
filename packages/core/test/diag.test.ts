import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryCapture } from "../src/capture.ts";
import { DiagClient } from "../src/diag/client.ts";
import { decodeDtcsByStatusMask, decodeObdDtcs, formatSaeCode } from "../src/diag/dtc.ts";
import { ElmSession } from "../src/elm/session.ts";
import { fromHex } from "../src/hex.ts";
import { runRecon } from "../src/recon.ts";
import { createDemoVehicle, createSimEcu, ElmSimulator, type SimulatorOptions } from "../src/sim/simulator.ts";
import { responseIdFor, targetFor } from "../src/vag/modules.ts";
import { ScanAbortedError, scanVag } from "../src/vag/scan.ts";

function stack(options: Partial<SimulatorOptions> = {}) {
  const vehicle = createDemoVehicle();
  const simulator = new ElmSimulator({ ecus: vehicle.ecus, ...options });
  const capture = new MemoryCapture();
  const elm = new ElmSession(simulator, { capture, timeoutMs: 1000 });
  const client = new DiagClient(elm);
  return { vehicle, simulator, capture, elm, client };
}

async function ready(options: Partial<SimulatorOptions> = {}) {
  const s = stack(options);
  await s.elm.command("ATZ");
  await s.client.configureOutput();
  await s.client.selectProtocol(6);
  return s;
}

test("SAE code formatting covers all four systems", () => {
  assert.equal(formatSaeCode(0x03, 0x00), "P0300");
  assert.equal(formatSaeCode(0x41, 0x23), "C0123");
  assert.equal(formatSaeCode(0x91, 0x23), "B1123");
  assert.equal(formatSaeCode(0xc1, 0x21), "U0121");
  assert.equal(formatSaeCode(0x3f, 0xff), "P3FFF");
});

test("19 02 answer is decoded into codes, failure types and states", () => {
  const report = decodeDtcsByStatusMask(fromHex("59 02 FF 03 00 00 28 91 23 15 09 01 71 00 04 D0 13 00 20"));
  assert.equal(report.availabilityMask, 0xff);
  assert.deepEqual(
    report.dtcs.map((d) => [d.display, d.state]),
    [
      ["P0300-00", "stored"],
      ["B1123-15", "active"],
      ["P0171-00", "pending"],
      ["U1013-00", "history"],
    ],
  );
  assert.equal(report.dtcs[1]?.status.confirmed, true);
  assert.deepEqual(decodeDtcsByStatusMask(fromHex("59 02 FF")).dtcs, []);
  assert.throws(() => decodeDtcsByStatusMask(fromHex("59 02 FF 03 00")));
  assert.throws(() => decodeDtcsByStatusMask(fromHex("7F 19 31")));
});

test("OBD mode 03 answer is decoded and padding skipped", () => {
  assert.deepEqual(decodeObdDtcs(fromHex("43 02 03 00 01 71")), ["P0300", "P0171"]);
  assert.deepEqual(decodeObdDtcs(fromHex("47 00")), []);
  assert.deepEqual(decodeObdDtcs(fromHex("43 01 03 00 00 00")), ["P0300"]);
});

test("physical request: multi-frame answer arrives complete with explicit flow control", async () => {
  const { client, vehicle } = await ready();
  const outcome = await client.request(targetFor(0x7e0), fromHex("22 F1 90"));
  assert.equal(outcome.kind, "positive");
  if (outcome.kind === "positive") {
    assert.equal(String.fromCharCode(...outcome.payload.slice(3)), vehicle.vin);
  }
});

test("physical request to a unit outside the OBD range needs the flow control setup", async () => {
  const { client } = await ready();
  // Without the setup the simulator delivers only the first frame, like a real car would.
  const broken = await client.request(targetFor(0x710), fromHex("22 F1 87"), { singleFrameAnswer: true });
  assert.deepEqual(broken.kind === "fault" && broken.fault, "incomplete");
  const proper = await client.request(targetFor(0x710), fromHex("22 F1 87"));
  assert.equal(proper.kind, "positive");
});

test("negative response, silence and dead bus are distinguished", async () => {
  const { client } = await ready();
  assert.deepEqual(await client.request(targetFor(0x710), fromHex("22 12 34")), { kind: "negative", nrc: 0x31 });
  assert.deepEqual(await client.request(targetFor(0x700), fromHex("3E 00"), { singleFrameAnswer: true }), {
    kind: "no-response",
  });

  const dead = await ready({ ignitionOn: false });
  const outcome = await dead.client.request(targetFor(0x7e0), fromHex("3E 00"));
  assert.equal(outcome.kind === "fault" && outcome.fault, "can-error");
});

test("response pending followed by the answer is handled", async () => {
  const { client } = await ready();
  const outcome = await client.request(targetFor(0x7e0), fromHex("19 02 AF"));
  assert.equal(outcome.kind, "positive");
});

test("response pending without a final answer is retried, then reported", async () => {
  let calls = 0;
  const ecu = createSimEcu({ tx: 0x7e0, rx: 0x7e8 });
  const slow = { ...ecu, handle: () => (calls++, [Uint8Array.of(0x7f, 0x19, 0x78)]) };
  const simulator = new ElmSimulator({ ecus: [slow] });
  const client = new DiagClient(new ElmSession(simulator));
  await client.configureOutput();
  await client.selectProtocol(6);
  const outcome = await client.request(targetFor(0x7e0), fromHex("19 02 AF"));
  assert.equal(outcome.kind === "fault" && outcome.fault, "pending-timeout");
  assert.equal(calls, 3);
});

test("functional OBD request collects answers per control unit", async () => {
  const { client } = await ready();
  const outcomes = await client.requestFunctional(fromHex("03"));
  assert.deepEqual([...outcomes.keys()].sort(), [0x7e8, 0x7e9]);
  const engine = outcomes.get(0x7e8);
  assert.ok(engine?.kind === "positive");
  assert.deepEqual(decodeObdDtcs(engine.payload), ["P0300"]);
});

test("switching between functional and physical addressing restores flow control", async () => {
  const { client, vehicle } = await ready();
  assert.equal((await client.request(targetFor(0x710), fromHex("22 F1 87"))).kind, "positive");
  const vin = (await client.requestFunctional(fromHex("09 02"))).get(0x7e8);
  assert.ok(vin?.kind === "positive");
  assert.equal(String.fromCharCode(...vin.payload.slice(3)), vehicle.vin);
  assert.equal((await client.request(targetFor(0x710), fromHex("22 F1 87"))).kind, "positive");
});

test("response identifier rule", () => {
  assert.equal(responseIdFor(0x7e0), 0x7e8);
  assert.equal(responseIdFor(0x714), 0x77e);
  assert.equal(responseIdFor(0x710), 0x77a);
  assert.equal(responseIdFor(0x773), 0x7dd);
});

test("scan finds every simulated unit, labels known ones and reads fault memory", async () => {
  const { client, vehicle } = await ready();
  const report = await scanVag(client, { probeTimeoutMs: 20 });

  assert.deepEqual(
    report.ecus.map((e) => e.target.tx).sort((a, b) => a - b),
    vehicle.ecus.map((e) => e.tx).sort((a, b) => a - b),
  );
  // Identifiers that discovered units answer on must not be probed.
  for (const ecu of report.ecus) assert.ok(!report.skipped.includes(ecu.target.tx));
  assert.deepEqual(report.skipped, [0x776, 0x778, 0x77a, 0x77c, 0x77d, 0x77e, 0x77f]);
  assert.equal(report.probed + report.skipped.length, 0x80 + 8);

  const byTx = new Map(report.ecus.map((e) => [e.target.tx, e]));
  const engine = byTx.get(0x7e0);
  assert.equal(engine?.module?.address, 0x01);
  assert.equal(engine?.ident.systemName, "SIM ENGINE");
  assert.equal(engine?.ident.odxName, "EV_SIM_J623");
  assert.ok(engine?.faultMemory.readable);
  assert.deepEqual(
    engine.faultMemory.dtcs.map((d) => d.display),
    ["P0300-00", "P0171-00"],
  );

  const infotainment = byTx.get(0x773);
  assert.equal(infotainment?.module, undefined, "not in the known table: labelled by its own answers");
  assert.equal(infotainment?.ident.systemName, "SIM INFOTAIN");

  const airbag = byTx.get(0x715);
  assert.ok(airbag && !airbag.faultMemory.readable);
  assert.match(airbag.faultMemory.reason, /serviceNotSupportedInActiveSession/);

  assert.deepEqual(vehicle.unexpectedRequests, []);
});

test("scan aborts early on a dead bus instead of probing every identifier", async () => {
  const { client, simulator } = await ready({ ignitionOn: false });
  await assert.rejects(scanVag(client, { probeTimeoutMs: 20 }), ScanAbortedError);
  assert.ok(simulator.receivedLines.filter((l) => l === "3E00").length <= 5);
});

test("recon: full go on the simulated vehicle", async () => {
  const { client, vehicle } = stack();
  const report = await runRecon(client);
  assert.equal(report.verdict, "go", JSON.stringify(report.steps, null, 1));
  assert.equal(report.facts.vin, vehicle.vin);
  assert.equal(report.facts.adapterDescription, "carly-universal v200");
  assert.match(report.facts.protocol ?? "", /CAN 11\/500/);
  assert.ok(report.steps.every((s) => s.ok), JSON.stringify(report.steps.filter((s) => !s.ok)));
  assert.deepEqual(vehicle.unexpectedRequests, []);
});

test("recon: adapter without user flow control is reported as obd-only", async () => {
  const { client } = stack({ unsupportedCommands: ["ATFCSM1"] });
  const report = await runRecon(client);
  assert.equal(report.verdict, "obd-only");
  const failed = report.steps.filter((s) => !s.ok).map((s) => s.id);
  assert.ok(failed.includes("uds-engine-vin"));
});

test("recon: ignition off is reported as no-vehicle, with adapter facts still collected", async () => {
  const { client } = stack({ ignitionOn: false });
  const report = await runRecon(client);
  assert.equal(report.verdict, "no-vehicle");
  assert.equal(report.facts.adapterId, "ELM327 v1.4 v100");
});

test("recon: a device that is not an ELM-dialect adapter is reported as no-adapter", async () => {
  const silent = { write: async () => {}, onData: () => {}, close: async () => {} };
  const client = new DiagClient(new ElmSession(silent, { timeoutMs: 20 }));
  // Slow by design: the reset step waits its full timeout before giving up.
  const report = await runRecon(client);
  assert.equal(report.verdict, "no-adapter");
});

test("audit: recon plus scan send nothing but allowlisted read-only lines", async () => {
  const { client, simulator, vehicle, capture } = stack();
  await runRecon(client);
  await scanVag(client, { probeTimeoutMs: 20 });

  const readOnly = [
    /^AT(Z|I|@1|RV|DP|DPN|E0|L0|S1|H1|AR|AT0|FCSD300000|FCSM[01])$/,
    /^ATST[0-9A-F]{2}$/,
    /^ATSP[06]$/,
    /^AT(SH|CRA|FCSH)7[0-9A-F]{2}$/,
    /^(0100|0902|03|07|0A|3E00)$/,
    /^22F1[0-9A-F]{2}$/,
    /^1902AF$/,
  ];
  for (const line of simulator.receivedLines) {
    assert.ok(readOnly.some((p) => p.test(line)), `unexpected line sent to adapter: ${line}`);
  }
  assert.deepEqual(vehicle.unexpectedRequests, []);
  assert.equal(capture.events.filter((e) => e.kind === "blocked").length, 0);
  // The capture holds exactly what was sent, in order.
  assert.deepEqual(
    capture.events.filter((e) => e.kind === "tx").map((e) => e.data),
    simulator.receivedLines,
  );
});

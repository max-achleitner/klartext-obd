import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoVehicle, DiagClient, ElmSession, ElmSimulator, runRecon, scanVag } from "@klartext/core";
import { renderRecon, renderScan } from "../src/render.ts";

function client(): DiagClient {
  return new DiagClient(new ElmSession(new ElmSimulator({ ecus: createDemoVehicle().ecus })));
}

test("scan report groups units, orders faults by urgency and counts them", async () => {
  const diag = client();
  await diag.configureOutput();
  const text = renderScan(await scanVag(diag, { probeTimeoutMs: 20, now: () => 0 }));

  assert.ok(text.indexOf("== Antrieb ==") < text.indexOf("== Karosserie & Sicherheit =="));
  assert.match(text, /01 Motorelektronik {2}\(SIM ENGINE, J623, Teilenummer SIM906259A, SW 0001, CAN 7E0\/7E8\)/);
  assert.match(text, /B1123-15 {2}aktiv {2}\[Status 0x09\]/);
  assert.ok(text.indexOf("P0300-00") < text.indexOf("P0171-00"), "stored before pending");
  assert.match(text, /15 Airbag.*\n\s+Fehlerspeicher nicht lesbar: .*serviceNotSupportedInActiveSession/);
  // A unit that is not in the known table is listed under its self-reported name.
  assert.match(text, /== Sonstige ==\n {2}SIM INFOTAIN/);
  assert.match(text, /Steuergeräte gefunden: 10\. Fehlereinträge: 5 \(1 aktiv, 2 gespeichert, 1 vorläufig, 1 nur Historie\)\./);
  assert.match(text, /nicht lesbar: 1 Steuergeräte/);
});

test("recon report lists every step and ends with the verdict", async () => {
  const report = await runRecon(client());
  const text = renderRecon(report);
  assert.equal(text.split("\n").filter((l) => l.includes("[ok]")).length, report.steps.length);
  assert.ok(text.trimEnd().split("\n").at(-1)?.startsWith("GO:"));
});

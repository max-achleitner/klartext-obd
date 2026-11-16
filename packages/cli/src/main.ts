#!/usr/bin/env node
/**
 * klartext command line: bench tool for the first contact with an adapter and a car.
 *
 *   klartext doctor            Bluetooth check, lists nearby devices
 *   klartext recon             what can this adapter and this car do (read-only)
 *   klartext scan              fault memory of all control units (read-only)
 *   klartext all               recon, then scan if recon says go
 *
 * Options: --sim (simulated adapter and car), --device <name|id>, --seconds <n>
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type ByteTransport,
  type CaptureEvent,
  DiagClient,
  ElmSession,
  ElmSimulator,
  MemoryCapture,
  PolicyViolation,
  type ReconReport,
  ScanAbortedError,
  type ScanReport,
  createDemoVehicle,
  hexId,
  runRecon,
  scanVag,
} from "@klartext/core";
import { BluetoothUnavailableError, connect, scanForDevices, type SeenDevice } from "./bleTransport.ts";
import { printable } from "./printable.ts";
import { renderRecon, renderScan } from "./render.ts";

/**
 * The only ways this file writes text to the terminal. Device names and adapter replies
 * are untrusted, so everything is made inert first (see printable.ts). The only direct
 * writes further down print a progress counter built from our own numbers.
 */
function say(text: string): void {
  process.stdout.write(printable(text) + "\n");
}

function complain(text: string): void {
  process.stderr.write(printable(text) + "\n");
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const VERSION = "0.1.0";

type Command = "doctor" | "recon" | "scan" | "all";

interface Options {
  sim: boolean;
  device: string | undefined;
  seconds: number;
}

function usage(): string {
  return [
    "klartext <befehl> [optionen]",
    "",
    "  doctor   Bluetooth prüfen und Geräte in der Nähe auflisten",
    "  recon    Adapter und Fahrzeug erkunden (nur lesend)",
    "  scan     Fehlerspeicher aller Steuergeräte lesen (nur lesend)",
    "  all      recon, danach scan, falls recon GO meldet",
    "",
    "  --sim            simulierter Adapter mit simuliertem Fahrzeug (ohne Bluetooth)",
    "  --device <text>  Adapter über Namensteil oder Geräte-ID auswählen",
    "  --seconds <n>    Dauer der Bluetooth-Suche (Standard 6)",
  ].join("\n");
}

function describeDevice(device: SeenDevice): string {
  const name = device.name.length > 0 ? `"${device.name}"` : "(ohne Namen)";
  const services = device.serviceUuids.length > 0 ? ` Dienste: ${device.serviceUuids.join(",")}` : "";
  return `${name}  ${device.rssi} dBm  ID ${device.id}${services}`;
}

async function doctor(options: Options): Promise<number> {
  say(`Suche ${options.seconds} s nach Bluetooth-LE-Geräten ...`);
  const scan = await scanForDevices({ seconds: options.seconds, device: options.device });
  if (scan.devices.length === 0) {
    say("Kein Gerät gefunden. Bluetooth funktioniert, aber es sendet nichts in Reichweite.");
    return 1;
  }
  const candidates = scan.devices.filter((d) => d.match !== undefined);
  say(`\n${scan.devices.length} Geräte gesehen, ${candidates.length} mögliche Adapter:\n`);
  for (const device of scan.devices) {
    say(`  ${device.match !== undefined ? "*" : " "} ${describeDevice(device)}`);
  }
  if (candidates.length === 0) {
    say(
      "\nKein Gerät sieht nach dem Adapter aus. Steckt er im Auto (er braucht 12 V)? Ist die Carly-App am Handy geschlossen?" +
        "\nFalls er in der Liste steht: mit --device <Namensteil> auswählen.",
    );
  }
  return 0;
}

/** Local time as a folder-name-safe stamp, e.g. 2026-11-16_18-27-30. */
function localTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

interface Session {
  client: DiagClient;
  capture: MemoryCapture;
  directory: string;
  close(): Promise<void>;
}

async function openSession(command: Command, options: Options): Promise<Session> {
  const stamp = localTimestamp(new Date());
  const directory = join(REPO_ROOT, "captures", `${stamp}-${command}${options.sim ? "-sim" : ""}`);
  mkdirSync(directory, { recursive: true });
  const logFile = join(directory, "session.jsonl");
  // Written event by event so the evidence survives a crash or a dropped connection.
  const capture = new MemoryCapture({
    forward: (event: CaptureEvent) => appendFileSync(logFile, JSON.stringify(event) + "\n"),
  });
  capture.record(
    "note",
    JSON.stringify({
      tool: `klartext ${VERSION}`,
      command,
      simulated: options.sim,
      started: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
    }),
  );

  let transport: ByteTransport;
  if (options.sim) {
    say("Simulation: kein Bluetooth, kein echtes Fahrzeug. Alle Werte sind erfunden.\n");
    transport = new ElmSimulator({ ecus: createDemoVehicle().ecus });
  } else {
    say(`Suche ${options.seconds} s nach dem Adapter ...`);
    const scan = await scanForDevices({ seconds: options.seconds, device: options.device });
    const candidates = scan.devices.filter((d) => d.match !== undefined);
    capture.record("note", `devices seen: ${JSON.stringify(scan.devices)}`);
    const chosen = candidates[0];
    if (chosen === undefined) {
      // We never connect to a device on a guess. Show what is there and let the user choose.
      const seen = scan.devices.slice(0, 15).map((d) => `    ${describeDevice(d)}`);
      throw new Error(
        "Kein Adapter erkannt. Steckt er im Auto (er braucht 12 V)? Ist die Carly-App am Handy geschlossen?\n" +
          (seen.length > 0
            ? `Sichtbare Geräte (stärkstes Signal zuerst):\n${seen.join("\n")}\n` +
              "Falls der Adapter dabei ist: Befehl mit --device <Namensteil oder ID> wiederholen."
            : "Es ist überhaupt kein Bluetooth-LE-Gerät sichtbar."),
      );
    }
    if (candidates.length > 1) {
      say("Mehrere mögliche Adapter, nehme den mit dem stärksten Signal:");
      for (const device of candidates) say(`    ${describeDevice(device)}`);
    }
    say(`Verbinde mit ${describeDevice(chosen)} ...`);
    const connection = await connect(scan, chosen, (reason) => {
      capture.record("note", `connection lost: ${reason}`);
      complain(`\nVerbindung zum Adapter verloren (${reason}).`);
    });
    capture.record(
      "note",
      `connected: ${JSON.stringify({
        device: connection.device,
        services: connection.serviceUuids,
        ffe1: connection.characteristicProperties,
        mtu: connection.mtu,
      })}`,
    );
    say(
      `Verbunden. Dienste: ${connection.serviceUuids.join(", ")}; FFE1: ${connection.characteristicProperties.join(", ")}\n`,
    );
    transport = connection.transport;
  }

  const elm = new ElmSession(transport, { capture });
  return { client: new DiagClient(elm), capture, directory, close: () => elm.close() };
}

function save(session: Session, name: string, report: unknown, text: string): void {
  writeFileSync(join(session.directory, `${name}.json`), JSON.stringify(report, null, 2) + "\n");
  // The text report is meant to be read in a terminal or editor, so it is made inert too.
  writeFileSync(join(session.directory, `${name}.txt`), printable(text) + "\n");
}

async function recon(session: Session): Promise<ReconReport> {
  const report = await runRecon(session.client, {
    onStep: (step) => say(`  ${step.ok ? "[ok]" : "[--]"} ${step.title}: ${step.detail}`),
  });
  const text = renderRecon(report);
  save(session, "recon", report, text);
  say(`\n${text.split("\n").at(-1)}\n`);
  return report;
}

async function scan(session: Session, resetFirst: boolean): Promise<ScanReport> {
  if (resetFirst) {
    await session.client.elm.command("ATZ", { timeoutMs: 6000 });
    await session.client.configureOutput();
  }
  say("Suche Steuergeräte ...");
  let found = 0;
  const report = await scanVag(session.client, {
    onProgress: (progress) => {
      if (progress.phase === "discover") {
        // The counter line is redrawn in place on a terminal and left out of piped output.
        const live = process.stdout.isTTY === true;
        if (progress.found) {
          found++;
          if (live) process.stdout.write("\r");
          say(`  Steuergerät auf ${hexId(progress.tx)} gefunden (${found} bisher)        `);
        }
        if (live) {
          process.stdout.write(`\r  ${progress.index}/${progress.total} Kennungen geprüft`);
          if (progress.index === progress.total) process.stdout.write("\n");
        }
      } else {
        say(`  Lese ${progress.index}/${progress.total}: ${hexId(progress.target.tx)}`);
      }
    },
  });
  const text = renderScan(report);
  save(session, "scan", report, text);
  say(`\n${text}\n`);
  return report;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      sim: { type: "boolean", default: false },
      device: { type: "string" },
      seconds: { type: "string", default: "6" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || command === undefined || !["doctor", "recon", "scan", "all"].includes(command)) {
    say(usage());
    return values.help ? 0 : 2;
  }
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
    complain("--seconds muss zwischen 1 und 60 liegen.");
    return 2;
  }
  const options: Options = { sim: values.sim, device: values.device, seconds };

  if (command === "doctor") return doctor(options);

  const session = await openSession(command as Command, options);
  let exitCode = 0;
  try {
    if (command === "recon") {
      exitCode = (await recon(session)).verdict === "go" ? 0 : 1;
    } else if (command === "scan") {
      await scan(session, true);
    } else {
      const report = await recon(session);
      if (report.verdict === "go") await scan(session, false);
      else exitCode = 1;
    }
  } catch (error) {
    session.capture.record("note", `aborted: ${String(error)}`);
    throw error;
  } finally {
    await session.close().catch(() => undefined);
    say(`Mitschnitt: ${session.directory}`);
    say("Der Mitschnitt enthält die Fahrgestellnummer. Nicht ungeschwärzt veröffentlichen.");
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof PolicyViolation) {
      complain(`\nInterner Fehler: Die Sicherheitsprüfung hat einen Befehl gestoppt (${error.message}). Es wurde nichts gesendet.`);
    } else if (error instanceof BluetoothUnavailableError || error instanceof ScanAbortedError) {
      complain(`\n${error.message}`);
    } else {
      complain(`\nFehler: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  },
);

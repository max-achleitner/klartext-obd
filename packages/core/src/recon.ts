/**
 * Adapter reconnaissance: establishes what this adapter and this vehicle can do, using
 * read-only requests only. The result decides whether the rest of the stack can work
 * with the adapter (go / no-go) and records the evidence in the capture.
 *
 * Every step is independent and tolerant: a failing step is recorded and the next one
 * still runs, because the point is to learn as much as possible from one visit to the car.
 */
import { AdapterCommandError, type DiagClient, type DiagOutcome, describeOutcome } from "./diag/client.ts";
import { decodeDtcsByStatusMask, decodeObdDtcs, DTC_STATUS_MASK } from "./diag/dtc.ts";
import { ElmTimeoutError } from "./elm/session.ts";
import { asciiFromBytes, hexId, toHex } from "./hex.ts";
import { targetFor } from "./vag/modules.ts";

export interface ReconStep {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
}

export type ReconVerdict =
  /** Adapter and vehicle answer everything the scan needs. */
  | "go"
  /** Adapter works and generic OBD works, but addressing single control units does not. */
  | "obd-only"
  /** Adapter answers, vehicle does not (ignition off, not plugged in, unsupported protocol). */
  | "no-vehicle"
  /** Adapter does not behave like an ELM-dialect device. */
  | "no-adapter";

export interface ReconReport {
  verdict: ReconVerdict;
  steps: ReconStep[];
  facts: {
    adapterId?: string;
    adapterDescription?: string;
    voltage?: string;
    protocol?: string;
    vin?: string;
  };
}

export interface ReconOptions {
  onStep?: (step: ReconStep) => void;
}

const ENGINE = targetFor(0x7e0);
const GATEWAY = targetFor(0x710);

export async function runRecon(client: DiagClient, options: ReconOptions = {}): Promise<ReconReport> {
  const steps: ReconStep[] = [];
  const facts: ReconReport["facts"] = {};

  const step = async (id: string, title: string, run: () => Promise<{ ok: boolean; detail: string }>): Promise<boolean> => {
    client.elm.note(`recon step: ${id}`);
    let result: { ok: boolean; detail: string };
    try {
      result = await run();
    } catch (error) {
      // Timeouts and refused adapter commands are findings. Anything else is a bug.
      if (!(error instanceof ElmTimeoutError) && !(error instanceof AdapterCommandError)) throw error;
      result = { ok: false, detail: error.message };
    }
    const entry: ReconStep = { id, title, ...result };
    steps.push(entry);
    options.onStep?.(entry);
    return entry.ok;
  };

  // --- adapter ------------------------------------------------------------------------
  const resetOk = await step("reset", "Adapter zurücksetzen (ATZ)", async () => {
    const reply = await client.elm.command("ATZ", { timeoutMs: 6000 });
    return { ok: reply.length > 0, detail: reply.join(" | ") };
  });
  const outputOk = await step("output", "Ausgabeformat einstellen (Echo aus, Header an)", async () => {
    await client.configureOutput();
    return { ok: true, detail: "ATE0, ATL0, ATS1, ATH1 bestätigt" };
  });
  if (!resetOk && !outputOk) {
    return { verdict: "no-adapter", steps, facts };
  }

  await step("identity", "Adapter-Kennung (ATI)", async () => {
    facts.adapterId = await client.query("ATI");
    return { ok: facts.adapterId.length > 0, detail: facts.adapterId };
  });
  await step("description", "Gerätebeschreibung (AT@1)", async () => {
    facts.adapterDescription = await client.query("AT@1");
    return { ok: facts.adapterDescription.length > 0 && facts.adapterDescription !== "?", detail: facts.adapterDescription };
  });
  await step("voltage", "Bordspannung (ATRV)", async () => {
    facts.voltage = await client.query("ATRV");
    return { ok: /\d/.test(facts.voltage), detail: facts.voltage };
  });

  // --- generic OBD-II -----------------------------------------------------------------
  const obdOk = await step("obd-connect", "OBD-Verbindung mit automatischer Protokollsuche (01 00)", async () => {
    await client.selectProtocol(0);
    const outcomes = await client.requestFunctional(Uint8Array.of(0x01, 0x00), { timeoutMs: 20000 });
    return summarizeFunctional(outcomes);
  });
  await step("protocol", "Erkanntes Protokoll (ATDP)", async () => {
    facts.protocol = `${await client.query("ATDP")} [${await client.query("ATDPN")}]`;
    return { ok: obdOk, detail: facts.protocol };
  });
  if (obdOk) {
    await step("obd-vin", "Fahrgestellnummer über OBD (09 02)", async () => {
      const outcomes = await client.requestFunctional(Uint8Array.of(0x09, 0x02));
      for (const outcome of outcomes.values()) {
        if (outcome.kind === "positive") {
          facts.vin = asciiFromBytes(outcome.payload.slice(3));
          return { ok: facts.vin.length === 17, detail: facts.vin };
        }
      }
      return summarizeFunctional(outcomes);
    });
    for (const [mode, title] of [
      [0x03, "Gespeicherte Abgas-Fehler (Modus 03)"],
      [0x07, "Vorläufige Abgas-Fehler (Modus 07)"],
      [0x0a, "Permanente Abgas-Fehler (Modus 0A)"],
    ] as const) {
      await step(`obd-dtc-${mode.toString(16).padStart(2, "0")}`, title, async () => {
        const outcomes = await client.requestFunctional(Uint8Array.of(mode));
        const parts: string[] = [];
        let ok = false;
        for (const [id, outcome] of outcomes) {
          if (outcome.kind === "positive") {
            ok = true;
            const codes = decodeObdDtcs(outcome.payload);
            parts.push(`${hexId(id)}: ${codes.length === 0 ? "keine" : codes.join(", ")}`);
          } else {
            parts.push(`${hexId(id)}: ${describeOutcome(outcome)}`);
          }
        }
        return { ok, detail: parts.length > 0 ? parts.join("; ") : "keine Antwort" };
      });
    }
  }

  // --- addressing single control units (UDS) ------------------------------------------
  const fixedProtocolOk = await step("uds-setup", "Festes Protokoll CAN 500 kbit/s, feste Wartezeit", async () => {
    await client.selectProtocol(6);
    await client.setResponseTimeout(1020);
    return { ok: true, detail: "ATSP6, ATAT0, ATSTFF bestätigt" };
  });

  let singleFrameOk = false;
  let multiFrameOk = false;
  if (fixedProtocolOk) {
    singleFrameOk = await step("uds-engine-probe", "Motorsteuergerät direkt ansprechen (3E 00)", async () => {
      const outcome = await client.request(ENGINE, Uint8Array.of(0x3e, 0x00), { singleFrameAnswer: true });
      return { ok: outcome.kind === "positive" || outcome.kind === "negative", detail: describeOutcome(outcome) };
    });
    multiFrameOk = await step("uds-engine-vin", "Mehrteilige Antwort mit Flusskontrolle (22 F1 90)", async () => {
      const outcome = await client.request(ENGINE, Uint8Array.of(0x22, 0xf1, 0x90));
      if (outcome.kind !== "positive") return { ok: false, detail: describeOutcome(outcome) };
      const vin = asciiFromBytes(outcome.payload.slice(3));
      facts.vin ??= vin;
      return { ok: true, detail: vin };
    });
    await step("uds-engine-part", "Teilenummer Motorsteuergerät (22 F1 87)", async () => {
      return identDetail(await client.request(ENGINE, Uint8Array.of(0x22, 0xf1, 0x87)));
    });
    await step("uds-engine-dtc", "Fehlerspeicher Motor in Standardsitzung (19 02)", async () => {
      const outcome = await client.request(ENGINE, Uint8Array.of(0x19, 0x02, DTC_STATUS_MASK));
      if (outcome.kind !== "positive") return { ok: false, detail: describeOutcome(outcome) };
      const report = decodeDtcsByStatusMask(outcome.payload);
      const list = report.dtcs.map((d) => `${d.display} (${d.state})`).join(", ");
      return { ok: true, detail: report.dtcs.length === 0 ? "kein Eintrag" : list };
    });
    await step("uds-gateway", "Gateway ansprechen, Antwortkennung = Anfrage + 0x6A (22 F1 87)", async () => {
      return identDetail(await client.request(GATEWAY, Uint8Array.of(0x22, 0xf1, 0x87)));
    });
  }

  let verdict: ReconVerdict;
  if (singleFrameOk && multiFrameOk) verdict = "go";
  else if (obdOk) verdict = "obd-only";
  else verdict = "no-vehicle";
  return { verdict, steps, facts };
}

function identDetail(outcome: DiagOutcome): { ok: boolean; detail: string } {
  if (outcome.kind !== "positive") return { ok: false, detail: describeOutcome(outcome) };
  const value = outcome.payload.slice(3);
  return { ok: true, detail: `${asciiFromBytes(value)} [${toHex(value)}]` };
}

function summarizeFunctional(outcomes: Map<number, DiagOutcome>): { ok: boolean; detail: string } {
  if (outcomes.size === 0) return { ok: false, detail: "keine Antwort" };
  const parts: string[] = [];
  let ok = false;
  for (const [id, outcome] of outcomes) {
    if (outcome.kind === "positive") {
      ok = true;
      parts.push(`${hexId(id)}: ${toHex(outcome.payload, " ")}`);
    } else {
      parts.push(`${hexId(id)}: ${describeOutcome(outcome)}`);
    }
  }
  return { ok, detail: parts.join("; ") };
}

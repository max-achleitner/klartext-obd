/**
 * VAG fault memory scan (read-only).
 *
 *  1. Discovery: TesterPresent (3E 00) to every candidate identifier. Any UDS answer,
 *     positive or negative, proves a control unit is there.
 *  2. For every unit found: identification, then fault memory (19 02) in the default
 *     diagnostic session. We never switch sessions; a unit that refuses is reported as
 *     such so the decision about extended sessions can be made on evidence.
 */
import { type DiagClient, type DiagOutcome, type EcuTarget, describeOutcome, nrcName } from "../diag/client.ts";
import { type Dtc, DTC_STATUS_MASK, decodeDtcsByStatusMask } from "../diag/dtc.ts";
import { asciiFromBytes, hexByte, hexId, toHex } from "../hex.ts";
import { IDENT_DIDS, type IdentKey, type VagModule, discoveryCandidates, knownModuleByTx, targetFor } from "./modules.ts";

export type FaultMemory =
  | { readable: true; availabilityMask: number; dtcs: Dtc[] }
  | { readable: false; reason: string };

export interface EcuReport {
  target: EcuTarget;
  /** Entry from the known module table, if the request identifier is listed there. */
  module: VagModule | undefined;
  ident: Partial<Record<IdentKey, string>>;
  /** Raw outcome per identification request, for the record. */
  identDetail: Record<string, string>;
  faultMemory: FaultMemory;
}

export interface ScanReport {
  ecus: EcuReport[];
  /** Number of identifiers probed. */
  probed: number;
  /** Identifiers not probed because a discovered unit answers on them. */
  skipped: number[];
  /** Probes that ended with an adapter fault instead of an answer or silence. */
  probeFaults: Array<{ tx: number; detail: string }>;
  durationMs: number;
}

export type ScanProgress =
  | { phase: "discover"; index: number; total: number; tx: number; found: boolean }
  | { phase: "read"; index: number; total: number; target: EcuTarget };

export interface ScanOptions {
  onProgress?: (progress: ScanProgress) => void;
  /** Request identifiers to probe. Defaults to the full discovery range. */
  candidates?: readonly number[];
  /** Per-probe response timeout. */
  probeTimeoutMs?: number;
  now?: () => number;
}

const TESTER_PRESENT = Uint8Array.of(0x3e, 0x00);
/** Probe timeout: ECUs answer within 50 ms (P2), the rest is margin for gateway routing. */
const DEFAULT_PROBE_TIMEOUT_MS = 300;
/** The adapter's maximum (0xFF * 4 ms). Leaves room for "response pending" sequences. */
const READ_TIMEOUT_MS = 1020;
/** Stop discovery when the bus is evidently not working (ignition off, not plugged in). */
const MAX_CONSECUTIVE_PROBE_FAULTS = 5;

export class ScanAbortedError extends Error {
  constructor(detail: string) {
    super(`scan aborted: ${detail}`);
    this.name = "ScanAbortedError";
  }
}

export async function scanVag(client: DiagClient, options: ScanOptions = {}): Promise<ScanReport> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const candidates = options.candidates ?? discoveryCandidates();

  await client.selectProtocol(6);
  await client.setResponseTimeout(options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);

  // --- 1. discovery -----------------------------------------------------------------
  const found: EcuTarget[] = [];
  const answerIds = new Set<number>();
  const skipped: number[] = [];
  const probeFaults: ScanReport["probeFaults"] = [];
  let consecutiveFaults = 0;
  let probed = 0;

  for (const [index, tx] of candidates.entries()) {
    if (answerIds.has(tx)) {
      // A discovered unit transmits on this identifier. Never transmit on it ourselves.
      skipped.push(tx);
      continue;
    }
    const target = targetFor(tx);
    const outcome = await client.request(target, TESTER_PRESENT, { singleFrameAnswer: true });
    probed++;
    const present = outcome.kind === "positive" || outcome.kind === "negative";
    if (present) {
      found.push(target);
      answerIds.add(target.rx);
    }
    if (outcome.kind === "fault") {
      probeFaults.push({ tx, detail: describeOutcome(outcome) });
      consecutiveFaults++;
      if (consecutiveFaults >= MAX_CONSECUTIVE_PROBE_FAULTS && found.length === 0) {
        throw new ScanAbortedError(
          `no working bus communication (${describeOutcome(outcome)}). Ignition on? Adapter plugged in?`,
        );
      }
    } else {
      consecutiveFaults = 0;
    }
    options.onProgress?.({ phase: "discover", index: index + 1, total: candidates.length, tx, found: present });
  }

  // --- 2. identification and fault memory ---------------------------------------------
  await client.setResponseTimeout(READ_TIMEOUT_MS);
  const ecus: EcuReport[] = [];
  for (const [index, target] of found.entries()) {
    options.onProgress?.({ phase: "read", index: index + 1, total: found.length, target });
    client.elm.note(`reading unit ${hexId(target.tx)}/${hexId(target.rx)}`);
    ecus.push(await readEcu(client, target));
  }

  return { ecus, probed, skipped, probeFaults, durationMs: now() - started };
}

export async function readEcu(client: DiagClient, target: EcuTarget): Promise<EcuReport> {
  const ident: Partial<Record<IdentKey, string>> = {};
  const identDetail: Record<string, string> = {};
  for (const { key, did } of IDENT_DIDS) {
    const outcome = await client.request(target, Uint8Array.of(0x22, did >> 8, did & 0xff));
    if (outcome.kind === "positive") {
      const value = outcome.payload.slice(3);
      const text = asciiFromBytes(value);
      if (text.length > 0) ident[key] = text;
      identDetail[key] = toHex(value);
    } else {
      identDetail[key] = describeOutcome(outcome);
    }
  }

  const outcome = await client.request(target, Uint8Array.of(0x19, 0x02, DTC_STATUS_MASK));
  return {
    target,
    module: knownModuleByTx(target.tx),
    ident,
    identDetail,
    faultMemory: faultMemoryFrom(outcome),
  };
}

export function faultMemoryFrom(outcome: DiagOutcome): FaultMemory {
  switch (outcome.kind) {
    case "positive":
      try {
        const report = decodeDtcsByStatusMask(outcome.payload);
        return { readable: true, availabilityMask: report.availabilityMask, dtcs: report.dtcs };
      } catch (error) {
        return { readable: false, reason: `Antwort nicht dekodierbar: ${(error as Error).message}` };
      }
    case "negative":
      return {
        readable: false,
        reason: `Steuergerät lehnt ab: ${nrcName(outcome.nrc)} (0x${hexByte(outcome.nrc)})`,
      };
    case "no-response":
      return { readable: false, reason: "keine Antwort" };
    case "fault":
      return { readable: false, reason: `Übertragungsfehler: ${outcome.fault} (${outcome.detail})` };
  }
}

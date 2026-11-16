/**
 * Decoding of diagnostic trouble codes (DTCs).
 *
 * UDS (ISO 14229) reports a DTC as 3 bytes plus a status byte. The first two bytes are
 * the code in SAE J2012 notation (P0300 ...), the third is the failure type byte that
 * narrows the symptom ("circuit open", "signal implausible", ...).
 */
import { hexByte } from "../hex.ts";

/** Status mask requested with 19 02: every bit that marks a fault as currently or historically present. */
export const DTC_STATUS_MASK = 0xaf;

export interface DtcStatus {
  raw: number;
  /** bit 0: the test failed at the time of the request. */
  testFailed: boolean;
  /** bit 1 */
  testFailedThisOperationCycle: boolean;
  /** bit 2: failed in this or the previous operation cycle, not yet confirmed. */
  pending: boolean;
  /** bit 3: confirmed and stored in fault memory. */
  confirmed: boolean;
  /** bit 4 */
  testNotCompletedSinceLastClear: boolean;
  /** bit 5 */
  testFailedSinceLastClear: boolean;
  /** bit 6 */
  testNotCompletedThisOperationCycle: boolean;
  /** bit 7: the ECU requests a warning lamp for this fault. */
  warningIndicatorRequested: boolean;
}

/** How a fault is presented to a person. */
export type DtcState =
  | "active" // present right now
  | "stored" // confirmed in memory, currently not present (often called sporadic/intermittent)
  | "pending" // seen, not yet confirmed
  | "history"; // failed at some point since the memory was last cleared

export interface Dtc {
  /** SAE J2012 code, e.g. "P0300" or "U1123". */
  code: string;
  /** Failure type byte (ISO 15031-6); 0 means "no sub type". */
  failureType: number;
  /** Code plus failure type as shown in reports, e.g. "P0300-00". */
  display: string;
  status: DtcStatus;
  state: DtcState;
}

const SYSTEM_LETTERS = ["P", "C", "B", "U"] as const;

/** Formats the two code bytes in SAE notation. */
export function formatSaeCode(high: number, low: number): string {
  const letter = SYSTEM_LETTERS[(high >> 6) & 0x03] ?? "P";
  const firstDigit = (high >> 4) & 0x03;
  return `${letter}${firstDigit}${(high & 0x0f).toString(16).toUpperCase()}${hexByte(low)}`;
}

export function decodeStatus(raw: number): DtcStatus {
  return {
    raw,
    testFailed: (raw & 0x01) !== 0,
    testFailedThisOperationCycle: (raw & 0x02) !== 0,
    pending: (raw & 0x04) !== 0,
    confirmed: (raw & 0x08) !== 0,
    testNotCompletedSinceLastClear: (raw & 0x10) !== 0,
    testFailedSinceLastClear: (raw & 0x20) !== 0,
    testNotCompletedThisOperationCycle: (raw & 0x40) !== 0,
    warningIndicatorRequested: (raw & 0x80) !== 0,
  };
}

export function stateOf(status: DtcStatus): DtcState {
  if (status.testFailed) return "active";
  if (status.confirmed) return "stored";
  if (status.pending) return "pending";
  return "history";
}

export interface DtcReport {
  /** Status bits this ECU implements. */
  availabilityMask: number;
  dtcs: Dtc[];
}

/**
 * Decodes a positive response to 19 02 (reportDTCByStatusMask):
 *   59 02 <availability mask> { <dtc high> <dtc mid> <dtc low> <status> }*
 */
export function decodeDtcsByStatusMask(payload: Uint8Array): DtcReport {
  if (payload[0] !== 0x59 || payload[1] !== 0x02 || payload.length < 3) {
    throw new Error("not a response to ReadDTCInformation 19 02");
  }
  const records = payload.slice(3);
  if (records.length % 4 !== 0) {
    throw new Error(`DTC record list has ${records.length} bytes, expected a multiple of 4`);
  }
  const dtcs: Dtc[] = [];
  for (let i = 0; i < records.length; i += 4) {
    const high = records[i] ?? 0;
    const mid = records[i + 1] ?? 0;
    const failureType = records[i + 2] ?? 0;
    const status = decodeStatus(records[i + 3] ?? 0);
    const code = formatSaeCode(high, mid);
    dtcs.push({ code, failureType, display: `${code}-${hexByte(failureType)}`, status, state: stateOf(status) });
  }
  return { availabilityMask: payload[2] ?? 0, dtcs };
}

/**
 * Decodes a positive response to OBD mode 03, 07 or 0A on CAN:
 *   43|47|4A <count> { <dtc high> <dtc low> }*
 * Returns SAE codes. Emission DTCs carry no failure type and no status byte.
 */
export function decodeObdDtcs(payload: Uint8Array): string[] {
  const sid = payload[0];
  if (sid !== 0x43 && sid !== 0x47 && sid !== 0x4a) throw new Error("not a response to OBD mode 03/07/0A");
  const codes: string[] = [];
  for (let i = 2; i + 1 < payload.length; i += 2) {
    const high = payload[i] ?? 0;
    const low = payload[i + 1] ?? 0;
    if (high === 0 && low === 0) continue; // padding
    codes.push(formatSaeCode(high, low));
  }
  return codes;
}

/**
 * Safety policy: the single choke point between this codebase and the vehicle.
 *
 * Every line that goes to the adapter is checked here first. The policy is an
 * allowlist on the exact text of the line. Anything that is not explicitly known to be
 * read-only is refused before a single byte is written.
 *
 * Rules of this file (do not weaken without a design review, see CLAUDE.md):
 *  - Allowlist only. There is no "raw passthrough" and no way to disable the policy.
 *  - Diagnostic requests are single CAN frames (max 7 bytes). We never transmit
 *    multi-frame requests, which rules out every download/flash style service.
 *  - CAN transmit identifiers are restricted to the diagnostic range 0x700-0x7FF.
 *  - Adapter commands that persist settings in the adapter or put it into a raw
 *    frame mode are not allowed.
 */
import { hexByte } from "./hex.ts";

export class PolicyViolation extends Error {
  readonly line: string;
  readonly reason: string;
  constructor(line: string, reason: string) {
    super(`blocked by safety policy: "${line}" (${reason})`);
    this.name = "PolicyViolation";
    this.line = line;
    this.reason = reason;
  }
}

export type LineKind = "adapter-command" | "diagnostic-request";

export interface CheckedLine {
  /** Normalised text that is safe to send (upper case, no whitespace). */
  line: string;
  kind: LineKind;
}

/**
 * Adapter (AT) commands, matched against the normalised line.
 * Each entry documents why it is safe.
 */
const ADAPTER_COMMANDS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^ATZ$/, why: "reset adapter to power-on state (volatile)" },
  { pattern: /^ATD$/, why: "restore adapter defaults (volatile)" },
  { pattern: /^ATI$/, why: "read adapter identification" },
  { pattern: /^AT@1$/, why: "read adapter description" },
  { pattern: /^ATRV$/, why: "read supply voltage" },
  { pattern: /^ATDP$/, why: "describe current protocol" },
  { pattern: /^ATDPN$/, why: "describe current protocol by number" },
  { pattern: /^ATE0$/, why: "echo off" },
  { pattern: /^ATL0$/, why: "linefeeds off" },
  { pattern: /^ATS1$/, why: "spaces on" },
  { pattern: /^ATH1$/, why: "show CAN headers" },
  { pattern: /^ATCAF1$/, why: "automatic CAN formatting on (adapter builds single frames)" },
  { pattern: /^ATAT[012]$/, why: "adaptive timing mode" },
  { pattern: /^ATST[0-9A-F]{2}$/, why: "response timeout" },
  // 0 = automatic, 6 = ISO 15765-4 CAN 11 bit 500 kbit/s. Other protocols are added when a
  // vehicle profile needs them.
  { pattern: /^ATSP[06]$/, why: "select protocol" },
  { pattern: /^ATSH7[0-9A-F]{2}$/, why: "transmit header, diagnostic range 0x700-0x7FF only" },
  { pattern: /^ATCRA7[0-9A-F]{2}$/, why: "receive filter, diagnostic range only" },
  { pattern: /^ATAR$/, why: "automatic receive filter" },
  { pattern: /^ATFCSH7[0-9A-F]{2}$/, why: "flow control header, diagnostic range only" },
  { pattern: /^ATFCSD300000$/, why: "flow control frame: continue, no block limit, no delay" },
  { pattern: /^ATFCSM[01]$/, why: "flow control mode: automatic or user defined header+data" },
];

/** Service identifiers we refuse, with the reason shown to the user/log. */
const REFUSED_SERVICES: Readonly<Record<number, string>> = {
  0x04: "OBD mode 04 clears fault memory and readiness monitors",
  0x08: "OBD mode 08 controls on-board systems",
  0x10: "DiagnosticSessionControl changes ECU state",
  0x11: "ECUReset",
  0x14: "ClearDiagnosticInformation erases fault memory",
  0x23: "ReadMemoryByAddress is not needed for diagnostics and can expose protected memory",
  0x27: "SecurityAccess",
  0x28: "CommunicationControl",
  0x2c: "DynamicallyDefineDataIdentifier changes ECU state",
  0x2e: "WriteDataByIdentifier",
  0x2f: "InputOutputControlByIdentifier drives actuators",
  0x31: "RoutineControl",
  0x34: "RequestDownload",
  0x35: "RequestUpload",
  0x36: "TransferData",
  0x37: "RequestTransferExit",
  0x3d: "WriteMemoryByAddress",
  0x85: "ControlDTCSetting",
};

/** Maximum payload of an ISO-TP single frame on classic CAN. */
const MAX_REQUEST_BYTES = 7;

function checkDiagnosticRequest(line: string, bytes: number[]): void {
  const fail = (reason: string): never => {
    throw new PolicyViolation(line, reason);
  };
  const sid = bytes[0];
  if (sid === undefined) return fail("empty request");
  if (bytes.length > MAX_REQUEST_BYTES) return fail("multi-frame requests are never sent");

  const refused = REFUSED_SERVICES[sid];
  if (refused !== undefined) return fail(refused);

  switch (sid) {
    // --- OBD-II (SAE J1979), read-only modes ---------------------------------------
    case 0x01: // current data: one PID
      if (bytes.length !== 2) return fail("mode 01 takes exactly one PID");
      return;
    case 0x02: // freeze frame data: PID + frame number
      if (bytes.length !== 3) return fail("mode 02 takes PID and frame number");
      return;
    case 0x03: // stored emission DTCs
    case 0x07: // pending emission DTCs
    case 0x0a: // permanent emission DTCs
      if (bytes.length !== 1) return fail(`mode ${hexByte(sid)} takes no parameters`);
      return;
    case 0x09: // vehicle information: one info type
      if (bytes.length !== 2) return fail("mode 09 takes exactly one info type");
      return;

    // --- UDS (ISO 14229), read-only services ---------------------------------------
    case 0x19: {
      // ReadDTCInformation. Only the sub-functions we decode are allowed.
      const sub = bytes[1];
      if (sub === 0x01 || sub === 0x02) {
        // reportNumberOfDTCByStatusMask / reportDTCByStatusMask: one status mask byte
        if (bytes.length !== 3) return fail("19 01/02 takes exactly one status mask byte");
        return;
      }
      return fail(`ReadDTCInformation sub-function ${sub === undefined ? "missing" : hexByte(sub)} is not enabled`);
    }
    case 0x22: // ReadDataByIdentifier: exactly one 16-bit identifier
      if (bytes.length !== 3) return fail("22 takes exactly one data identifier");
      return;
    case 0x3e: // TesterPresent, response required (sub-function 00 only)
      if (bytes.length !== 2 || bytes[1] !== 0x00) return fail("only TesterPresent 3E 00 is allowed");
      return;
    default:
      return fail(`service ${hexByte(sid)} is not on the read-only allowlist`);
  }
}

/**
 * Validates one outgoing line. Returns the normalised line or throws PolicyViolation.
 * Pure function: no state, no I/O.
 */
export function checkLine(input: string): CheckedLine {
  // Whitespace inside a line is cosmetic for ELM adapters; everything else must be exact.
  // In particular a carriage return inside the text would smuggle a second command.
  const line = input.replace(/ /g, "").toUpperCase();
  if (line.length === 0) {
    // An empty line makes ELM adapters repeat the previous command.
    throw new PolicyViolation(input, "empty line would repeat the previous command");
  }
  if (!/^[0-9A-Z@]+$/.test(line)) {
    throw new PolicyViolation(input, "illegal character");
  }

  if (line.startsWith("AT")) {
    if (ADAPTER_COMMANDS.some((c) => c.pattern.test(line))) return { line, kind: "adapter-command" };
    throw new PolicyViolation(input, "adapter command is not on the allowlist");
  }

  if (!/^([0-9A-F]{2})+$/.test(line)) {
    throw new PolicyViolation(input, "not an adapter command and not a hex byte string");
  }
  const bytes: number[] = [];
  for (let i = 0; i < line.length; i += 2) bytes.push(parseInt(line.slice(i, i + 2), 16));
  checkDiagnosticRequest(input, bytes);
  return { line, kind: "diagnostic-request" };
}

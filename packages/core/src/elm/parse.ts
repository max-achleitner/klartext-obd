/**
 * Parses reply lines of a diagnostic request (headers on, ATH1) into CAN frames and
 * adapter status messages.
 */

export interface CanFrame {
  id: number;
  data: Uint8Array;
}

export interface ParsedReply {
  frames: CanFrame[];
  /** Lines that are not frames: "NO DATA", "CAN ERROR", "SEARCHING...", "?", ... */
  status: string[];
}

/**
 * A frame line is the CAN identifier followed by the data bytes, e.g.
 *   "7E8 06 41 00 BE 3F A8 13"          (11-bit identifier, 3 hex digits)
 *   "18 DA F1 10 06 41 00 BE 3F A8 13"  (29-bit identifier, 8 hex digits)
 * With spaces removed, an 11-bit line has an odd number of hex digits and a 29-bit line
 * an even number, so the format is unambiguous whether or not the adapter prints spaces.
 */
export function parseFrameLine(line: string): CanFrame | undefined {
  const compact = line.replace(/\s+/g, "").toUpperCase();
  if (!/^[0-9A-F]+$/.test(compact)) return undefined;
  const idDigits = compact.length % 2 === 1 ? 3 : 8;
  if (compact.length < idDigits + 2) return undefined;
  const dataDigits = compact.length - idDigits;
  if (dataDigits > 16) return undefined; // classic CAN carries at most 8 data bytes
  const id = parseInt(compact.slice(0, idDigits), 16);
  const data = new Uint8Array(dataDigits / 2);
  for (let i = 0; i < data.length; i++) {
    data[i] = parseInt(compact.slice(idDigits + i * 2, idDigits + i * 2 + 2), 16);
  }
  return { id, data };
}

export function parseReply(lines: readonly string[]): ParsedReply {
  const frames: CanFrame[] = [];
  const status: string[] = [];
  for (const line of lines) {
    const frame = parseFrameLine(line);
    if (frame !== undefined) frames.push(frame);
    else status.push(line.toUpperCase());
  }
  return { frames, status };
}

/** Status messages that mean the request did not get a usable answer. */
export type AdapterFault =
  | "no-data" // nobody answered within the timeout
  | "can-error" // no acknowledge on the bus (ignition off, wrong protocol, not plugged in)
  | "unable-to-connect" // protocol search found nothing
  | "rejected" // adapter did not understand the line
  | "adapter-error"; // buffer overflow, data error, low voltage reset, ...

export function classifyStatus(status: readonly string[]): AdapterFault | undefined {
  for (const s of status) {
    if (s === "?") return "rejected";
    if (s.includes("UNABLE TO CONNECT")) return "unable-to-connect";
    if (s.includes("CAN ERROR") || s.includes("BUS ERROR") || s.includes("BUS BUSY")) return "can-error";
    if (
      s.includes("BUFFER FULL") ||
      s.includes("DATA ERROR") ||
      s.includes("RX ERROR") ||
      s.includes("FB ERROR") ||
      s.includes("LV RESET") ||
      s.includes("STOPPED") ||
      /^ERR\d+/.test(s)
    ) {
      return "adapter-error";
    }
  }
  if (status.some((s) => s.includes("NO DATA"))) return "no-data";
  return undefined;
}

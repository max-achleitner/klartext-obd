/**
 * A simulated ELM-dialect adapter plugged into a simulated vehicle.
 *
 * It exists so the whole stack can be developed and tested without a car. It models the
 * adapter behaviours that matter for correctness:
 *  - prompt framing, echo, replies delivered in arbitrary small chunks (like BLE);
 *  - receive filters (ATCRA / automatic);
 *  - flow control: a multi-frame answer is only delivered completely when the flow
 *    control frame reaches the ECU's request identifier, otherwise only the first frame
 *    arrives - exactly the failure a wrong adapter setup produces on a real car;
 *  - automatic protocol search on the first request after ATSP0.
 *
 * It is a model built from the ELM327 documentation, not a recording of real hardware.
 */
import type { ByteTransport } from "../transport.ts";
import { bytesFromAscii, hexId, toHex } from "../hex.ts";

export interface SimEcu {
  tx: number;
  rx: number;
  /** True if the unit also answers OBD broadcasts on 0x7DF. */
  functional: boolean;
  /** Returns the payloads the unit sends in answer to a request (empty: stays silent). */
  handle(request: Uint8Array): Uint8Array[];
}

export interface SimulatorOptions {
  ecus: SimEcu[];
  /** Maximum bytes per delivered chunk (BLE notifications carry 20). */
  chunkSize?: number;
  identity?: string;
  description?: string;
  /** If false the bus is dead: no ECU acknowledges anything. */
  ignitionOn?: boolean;
  /** Adapter commands (normalised, e.g. "ATFCSM1") this adapter answers with "?". */
  unsupportedCommands?: readonly string[];
}

const PAD = 0xaa;

export class ElmSimulator implements ByteTransport {
  /** Every line the adapter received, in order. Tests use this to audit what was sent. */
  readonly receivedLines: string[] = [];

  readonly #ecus: SimEcu[];
  readonly #chunkSize: number;
  readonly #identity: string;
  readonly #description: string;
  readonly #ignitionOn: boolean;
  readonly #unsupported: ReadonlySet<string>;
  #listener: ((chunk: Uint8Array) => void) | undefined;
  #inbox = "";
  #closed = false;

  // adapter state
  #echo = true;
  #headers = false;
  #protocol = 0;
  #detectedProtocol: number | undefined;
  #header = 0x7df;
  #receiveFilter: number | undefined;
  #flowMode = 0;
  #flowHeader: number | undefined;
  #flowData: string | undefined;

  constructor(options: SimulatorOptions) {
    this.#ecus = options.ecus;
    this.#chunkSize = options.chunkSize ?? 20;
    this.#identity = options.identity ?? "ELM327 v1.4 v100";
    this.#description = options.description ?? "carly-universal v200";
    this.#ignitionOn = options.ignitionOn ?? true;
    this.#unsupported = new Set(options.unsupportedCommands ?? []);
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#listener = listener;
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("simulator transport is closed");
    for (const byte of data) {
      if (byte === 0x0d) {
        const line = this.#inbox;
        this.#inbox = "";
        this.#process(line);
      } else {
        this.#inbox += String.fromCharCode(byte);
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #process(rawLine: string): void {
    const line = rawLine.replace(/ /g, "").toUpperCase();
    this.receivedLines.push(line);
    const replyLines = line.startsWith("AT") ? this.#adapterCommand(line) : this.#diagnosticRequest(line);
    const text = (this.#echo ? rawLine + "\r" : "") + replyLines.join("\r") + "\r\r>";
    this.#deliver(text);
  }

  #deliver(text: string): void {
    const bytes = bytesFromAscii(text);
    for (let offset = 0; offset < bytes.length; offset += this.#chunkSize) {
      const chunk = bytes.slice(offset, offset + this.#chunkSize);
      // Asynchronous like a real link; microtasks keep the order and need no timers.
      queueMicrotask(() => {
        if (!this.#closed) this.#listener?.(chunk);
      });
    }
  }

  #resetState(): void {
    this.#echo = true;
    this.#headers = false;
    this.#header = 0x7df;
    this.#receiveFilter = undefined;
    this.#flowMode = 0;
    this.#flowHeader = undefined;
    this.#flowData = undefined;
  }

  #adapterCommand(line: string): string[] {
    if (this.#unsupported.has(line)) return ["?"];
    const command = line.slice(2);
    let match: RegExpExecArray | null;

    if (command === "Z") {
      this.#resetState();
      return [this.#identity];
    }
    if (command === "D") {
      this.#resetState();
      return ["OK"];
    }
    if (command === "I") return [this.#identity];
    if (command === "@1") return [this.#description];
    if (command === "RV") return ["12.4V"];
    if (command === "DP") return [this.#protocolName()];
    if (command === "DPN") return [this.#protocolNumber()];
    if ((match = /^E([01])$/.exec(command))) {
      this.#echo = match[1] === "1";
      return ["OK"];
    }
    if ((match = /^H([01])$/.exec(command))) {
      this.#headers = match[1] === "1";
      return ["OK"];
    }
    if (/^(L[01]|S[01]|CAF[01]|AT[012]|ST[0-9A-F]{2})$/.test(command)) return ["OK"];
    if ((match = /^SP([0-9A-C])$/.exec(command))) {
      this.#protocol = parseInt(match[1] ?? "0", 16);
      this.#detectedProtocol = undefined;
      return ["OK"];
    }
    if ((match = /^SH([0-9A-F]{3})$/.exec(command))) {
      this.#header = parseInt(match[1] ?? "0", 16);
      return ["OK"];
    }
    if ((match = /^CRA([0-9A-F]{3})$/.exec(command))) {
      this.#receiveFilter = parseInt(match[1] ?? "0", 16);
      return ["OK"];
    }
    if (command === "AR") {
      this.#receiveFilter = undefined;
      return ["OK"];
    }
    if ((match = /^FCSH([0-9A-F]{3})$/.exec(command))) {
      this.#flowHeader = parseInt(match[1] ?? "0", 16);
      return ["OK"];
    }
    if ((match = /^FCSD((?:[0-9A-F]{2}){1,5})$/.exec(command))) {
      this.#flowData = match[1];
      return ["OK"];
    }
    if ((match = /^FCSM([012])$/.exec(command))) {
      const mode = Number(match[1]);
      // The real chip refuses user modes until header and data have been provided.
      if (mode === 1 && (this.#flowHeader === undefined || this.#flowData === undefined)) return ["?"];
      this.#flowMode = mode;
      return ["OK"];
    }
    return ["?"];
  }

  #protocolName(): string {
    const active = this.#protocol === 0 ? this.#detectedProtocol : this.#protocol;
    const name = active === 6 ? "ISO 15765-4 (CAN 11/500)" : active === undefined ? "" : `PROTOCOL ${active}`;
    return this.#protocol === 0 ? `AUTO${name ? ", " + name : ""}` : name;
  }

  #protocolNumber(): string {
    if (this.#protocol !== 0) return this.#protocol.toString(16).toUpperCase();
    return this.#detectedProtocol === undefined ? "A0" : `A${this.#detectedProtocol}`;
  }

  #diagnosticRequest(line: string): string[] {
    if (!/^([0-9A-F]{2}){1,7}$/.test(line)) return ["?"];
    const prefix: string[] = [];
    const searching = this.#protocol === 0 && this.#detectedProtocol === undefined;
    if (searching) prefix.push("SEARCHING...");
    if (!this.#ignitionOn) return [...prefix, searching ? "UNABLE TO CONNECT" : "CAN ERROR"];
    if (searching) this.#detectedProtocol = 6;
    if ((this.#protocol === 0 ? this.#detectedProtocol : this.#protocol) !== 6) return [...prefix, "NO DATA"];

    const request = new Uint8Array(line.length / 2);
    for (let i = 0; i < request.length; i++) request[i] = parseInt(line.slice(i * 2, i * 2 + 2), 16);

    const receivers =
      this.#header === 0x7df ? this.#ecus.filter((e) => e.functional) : this.#ecus.filter((e) => e.tx === this.#header);

    const lines: string[] = [];
    for (const ecu of receivers) {
      if (!this.#passesFilter(ecu.rx)) continue;
      for (const payload of ecu.handle(request)) {
        for (const frame of this.#frames(ecu, payload)) lines.push(this.#formatFrame(ecu.rx, frame));
      }
    }
    return lines.length > 0 ? [...prefix, ...lines] : [...prefix, "NO DATA"];
  }

  #passesFilter(id: number): boolean {
    if (this.#receiveFilter !== undefined) return id === this.#receiveFilter;
    return id >= 0x7e8 && id <= 0x7ef;
  }

  /** Segments a payload into CAN frames, honouring whether flow control reaches the ECU. */
  #frames(ecu: SimEcu, payload: Uint8Array): Uint8Array[] {
    if (payload.length <= 7) {
      const frame = new Uint8Array(8).fill(PAD);
      frame[0] = payload.length;
      frame.set(payload, 1);
      return [frame];
    }
    const first = new Uint8Array(8);
    first[0] = 0x10 | (payload.length >> 8);
    first[1] = payload.length & 0xff;
    first.set(payload.slice(0, 6), 2);
    const frames = [first];

    const flowTarget = this.#flowMode === 1 ? this.#flowHeader : ecu.rx - 8;
    const flowOk = flowTarget === ecu.tx && (this.#flowMode !== 1 || this.#flowData?.startsWith("30") === true);
    if (!flowOk) return frames; // the ECU never sees "continue to send"

    let sequence = 1;
    for (let offset = 6; offset < payload.length; offset += 7) {
      const frame = new Uint8Array(8).fill(PAD);
      frame[0] = 0x20 | (sequence & 0x0f);
      frame.set(payload.slice(offset, offset + 7), 1);
      frames.push(frame);
      sequence++;
    }
    return frames;
  }

  #formatFrame(id: number, data: Uint8Array): string {
    return this.#headers ? `${hexId(id)} ${toHex(data, " ")}` : toHex(data, " ");
  }
}

// --- simulated control units ------------------------------------------------------------

export interface SimDtc {
  /** Three DTC bytes: SAE code high, SAE code low, failure type. */
  bytes: readonly [number, number, number];
  status: number;
}

export interface SimEcuSpec {
  tx: number;
  rx: number;
  /** ReadDataByIdentifier values, keyed by data identifier. */
  data?: Readonly<Record<number, string>>;
  dtcs?: readonly SimDtc[];
  /** Answers "response pending" once before the fault memory answer. */
  slowFaultMemory?: boolean;
  /** Refuses fault memory access outside an extended session (NRC 0x7F). */
  faultMemoryNeedsExtendedSession?: boolean;
  /** OBD-II behaviour for units that answer broadcasts. */
  obd?: { vin: string; storedCodes: ReadonlyArray<readonly [number, number]> };
}

const negative = (sid: number, nrc: number): Uint8Array => Uint8Array.of(0x7f, sid, nrc);

/**
 * Builds a UDS control unit. It answers the read-only services the stack uses and
 * rejects everything else with "service not supported"; `unexpectedRequests` records
 * those so tests can assert that nothing outside the allowlist ever arrived.
 */
export function createSimEcu(spec: SimEcuSpec, unexpectedRequests: string[] = []): SimEcu {
  return {
    tx: spec.tx,
    rx: spec.rx,
    functional: spec.obd !== undefined,
    handle(request: Uint8Array): Uint8Array[] {
      const sid = request[0] ?? 0;
      const a = request[1] ?? 0;
      const b = request[2] ?? 0;

      if (spec.obd !== undefined) {
        if (sid === 0x01 && a === 0x00) return [Uint8Array.of(0x41, 0x00, 0xbe, 0x3f, 0xa8, 0x13)];
        if (sid === 0x09 && a === 0x02) return [Uint8Array.of(0x49, 0x02, 0x01, ...bytesFromAscii(spec.obd.vin))];
        if (sid === 0x03) {
          const codes = spec.obd.storedCodes;
          return [Uint8Array.of(0x43, codes.length, ...codes.flatMap(([h, l]) => [h, l]))];
        }
        if (sid === 0x07) return [Uint8Array.of(0x47, 0x00)];
        if (sid === 0x0a) return [Uint8Array.of(0x4a, 0x00)];
      }

      if (sid === 0x3e && a === 0x00) return [Uint8Array.of(0x7e, 0x00)];

      if (sid === 0x22 && request.length === 3) {
        const value = spec.data?.[(a << 8) | b];
        if (value === undefined) return [negative(sid, 0x31)];
        return [Uint8Array.of(0x62, a, b, ...bytesFromAscii(value))];
      }

      if (sid === 0x19 && a === 0x02 && request.length === 3) {
        if (spec.faultMemoryNeedsExtendedSession === true) return [negative(sid, 0x7f)];
        const records = (spec.dtcs ?? []).filter((d) => (d.status & b) !== 0).flatMap((d) => [...d.bytes, d.status]);
        const answer = Uint8Array.of(0x59, 0x02, 0xff, ...records);
        return spec.slowFaultMemory === true ? [negative(sid, 0x78), answer] : [answer];
      }

      unexpectedRequests.push(`${hexId(spec.tx)}: ${toHex(request, " ")}`);
      return [negative(sid, 0x11)];
    },
  };
}

export interface DemoVehicle {
  ecus: SimEcu[];
  /** Requests that no read-only tool should ever have sent. Must stay empty. */
  unexpectedRequests: string[];
  vin: string;
}

/**
 * A synthetic vehicle shaped like an MQB-platform car. All identification values and
 * faults are invented; they are not data from a real vehicle or a real diagnostic database.
 */
export function createDemoVehicle(): DemoVehicle {
  const unexpectedRequests: string[] = [];
  const vin = "WVWZZZSIMULATOR01";
  const ident = (part: string, system: string, workshop: string): Record<number, string> => ({
    0xf187: part,
    0xf189: "0001",
    0xf191: part,
    0xf197: system,
    0xf1aa: workshop,
    0xf19e: `EV_SIM_${workshop}\0`,
    0xf1a2: "001001",
  });
  const unit = (spec: SimEcuSpec): SimEcu => createSimEcu(spec, unexpectedRequests);

  const ecus = [
    unit({
      tx: 0x7e0,
      rx: 0x7e8,
      data: { ...ident("SIM906259A ", "SIM ENGINE", "J623"), 0xf190: vin },
      dtcs: [
        { bytes: [0x03, 0x00, 0x00], status: 0x28 }, // P0300-00, stored
        { bytes: [0x01, 0x71, 0x00], status: 0x04 }, // P0171-00, pending
      ],
      slowFaultMemory: true,
      obd: { vin, storedCodes: [[0x03, 0x00]] },
    }),
    unit({ tx: 0x7e1, rx: 0x7e9, data: ident("SIM300012B ", "SIM GEARBOX", "J743"), obd: { vin, storedCodes: [] } }),
    unit({ tx: 0x70c, rx: 0x776, data: ident("SIM953507C ", "SIM STEERCOL", "J527") }),
    unit({
      tx: 0x70e,
      rx: 0x778,
      data: ident("SIM937084D ", "SIM BCM", "J519"),
      dtcs: [{ bytes: [0x91, 0x23, 0x15], status: 0x09 }], // B1123-15, active
    }),
    unit({ tx: 0x710, rx: 0x77a, data: ident("SIM907530E ", "SIM GATEWAY", "J533") }),
    unit({ tx: 0x712, rx: 0x77c, data: ident("SIM909144F ", "SIM STEERING", "J500") }),
    unit({
      tx: 0x713,
      rx: 0x77d,
      data: ident("SIM907379G ", "SIM ESP", "J104"),
      dtcs: [{ bytes: [0xc1, 0x21, 0x00], status: 0x08 }], // U0121-00, stored
    }),
    unit({ tx: 0x714, rx: 0x77e, data: ident("SIM920870H ", "SIM CLUSTER", "J285") }),
    unit({ tx: 0x715, rx: 0x77f, data: ident("SIM959655J ", "SIM AIRBAG", "J234"), faultMemoryNeedsExtendedSession: true }),
    unit({
      tx: 0x773,
      rx: 0x7dd,
      data: ident("SIM035880K ", "SIM INFOTAIN", "J794"),
      dtcs: [{ bytes: [0xd0, 0x13, 0x00], status: 0x20 }], // U1013-00, history only
    }),
  ];
  return { ecus, unexpectedRequests, vin };
}

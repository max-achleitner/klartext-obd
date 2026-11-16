/**
 * DiagClient: request/response diagnostics (UDS and OBD-II) on top of an ElmSession.
 *
 * The adapter is used as an ISO-TP capable CAN interface:
 *  - physical addressing: one ECU, explicit transmit/receive identifiers and explicit
 *    flow control (the ELM default sends flow control to "receive id - 8", which is only
 *    right for the OBD identifiers 0x7E8-0x7EF);
 *  - functional addressing: OBD broadcast on 0x7DF, answers from 0x7E8-0x7EF.
 */
import type { ElmSession } from "../elm/session.ts";
import { type AdapterFault, classifyStatus, parseReply } from "../elm/parse.ts";
import { type IsoTpMessage, reassemble } from "../isotp.ts";
import { hexByte, hexId, toHex } from "../hex.ts";

export interface EcuTarget {
  /** CAN identifier the tester transmits on. */
  tx: number;
  /** CAN identifier the ECU answers on. */
  rx: number;
}

export type DiagOutcome =
  | { kind: "positive"; payload: Uint8Array }
  | { kind: "negative"; nrc: number }
  | { kind: "no-response" }
  | { kind: "fault"; fault: AdapterFault | "incomplete" | "pending-timeout"; detail: string };

export class AdapterCommandError extends Error {
  readonly command: string;
  readonly reply: string[];
  constructor(command: string, reply: string[]) {
    super(`adapter answered "${reply.join(" | ")}" to ${command}`);
    this.name = "AdapterCommandError";
    this.command = command;
    this.reply = reply;
  }
}

const OBD_FUNCTIONAL_ID = 0x7df;
const NRC_RESPONSE_PENDING = 0x78;
/** How often a request is repeated when the ECU only answered "response pending". */
const PENDING_RETRIES = 2;

export interface RequestOptions {
  /**
   * Skip the flow control setup. Only valid when the answer is known to fit a single
   * frame (used for presence probes, where it saves three adapter round trips per ECU).
   */
  singleFrameAnswer?: boolean;
  /** Time to wait for the adapter prompt. */
  timeoutMs?: number;
}

export class DiagClient {
  readonly #elm: ElmSession;
  #addressing: string | undefined;
  #userFlowControl = false;

  constructor(elm: ElmSession) {
    this.#elm = elm;
  }

  get elm(): ElmSession {
    return this.#elm;
  }

  /** Sends an adapter command that must be acknowledged with OK. */
  async at(command: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const reply = await this.#elm.command(command, options);
    if (!reply.some((l) => l.toUpperCase() === "OK")) throw new AdapterCommandError(command, reply);
  }

  /** Sends an adapter command and reports whether it was acknowledged, without throwing. */
  async tryAt(command: string, options: { timeoutMs?: number } = {}): Promise<{ ok: boolean; reply: string[] }> {
    const reply = await this.#elm.command(command, options);
    return { ok: reply.some((l) => l.toUpperCase() === "OK"), reply };
  }

  /** Sends an adapter query (ATI, ATRV, ...) and returns the reply text. */
  async query(command: string, options: { timeoutMs?: number } = {}): Promise<string> {
    return (await this.#elm.command(command, options)).join(" ");
  }

  /** Output format this client depends on. Call after every adapter reset. */
  async configureOutput(): Promise<void> {
    this.#addressing = undefined;
    this.#userFlowControl = false;
    await this.at("ATE0");
    await this.at("ATL0");
    await this.at("ATS1");
    await this.at("ATH1");
  }

  async selectProtocol(protocol: 0 | 6): Promise<void> {
    this.#addressing = undefined;
    await this.at(`ATSP${protocol}`);
  }

  /** Fixed response timeout (adaptive timing off) so scan timing is predictable. */
  async setResponseTimeout(ms: number): Promise<void> {
    const units = Math.min(0xff, Math.max(1, Math.ceil(ms / 4)));
    await this.at("ATAT0");
    await this.at(`ATST${hexByte(units)}`);
  }

  /** One request to one ECU. */
  async request(target: EcuTarget, request: Uint8Array, options: RequestOptions = {}): Promise<DiagOutcome> {
    await this.#selectPhysical(target, options.singleFrameAnswer === true);
    const sid = request[0] ?? 0;
    let sawPending = false;

    for (let attempt = 0; attempt <= PENDING_RETRIES; attempt++) {
      const lines = await this.#elm.command(toHex(request), { timeoutMs: options.timeoutMs ?? 6000 });
      const reply = parseReply(lines);
      const messages = reassemble(reply.frames.filter((f) => f.id === target.rx));
      const result = interpret(sid, messages);
      if (result.outcome !== undefined) return result.outcome;
      if (!result.pending) {
        if (sawPending) break;
        return faultOutcome(reply.status);
      }
      // The ECU asked for more time and the adapter stopped listening before the final
      // answer arrived. Read requests are idempotent, so asking again is safe.
      sawPending = true;
      this.#elm.note(`response pending from ${hexId(target.rx)}, repeating request (${attempt + 1}/${PENDING_RETRIES})`);
    }
    return { kind: "fault", fault: "pending-timeout", detail: "ECU kept answering 'response pending'" };
  }

  /** One OBD request to all emission ECUs (0x7DF). Returns the outcome per answering identifier. */
  async requestFunctional(request: Uint8Array, options: RequestOptions = {}): Promise<Map<number, DiagOutcome>> {
    await this.#selectFunctional();
    const sid = request[0] ?? 0;
    const lines = await this.#elm.command(toHex(request), { timeoutMs: options.timeoutMs ?? 6000 });
    const reply = parseReply(lines);
    const byId = new Map<number, IsoTpMessage[]>();
    for (const message of reassemble(reply.frames)) {
      const list = byId.get(message.id) ?? [];
      list.push(message);
      byId.set(message.id, list);
    }
    const outcomes = new Map<number, DiagOutcome>();
    for (const [id, messages] of byId) {
      const result = interpret(sid, messages);
      if (result.outcome !== undefined) outcomes.set(id, result.outcome);
    }
    if (outcomes.size === 0) {
      const fault = faultOutcome(reply.status);
      if (fault.kind === "fault") outcomes.set(OBD_FUNCTIONAL_ID, fault);
    }
    return outcomes;
  }

  async #selectPhysical(target: EcuTarget, singleFrameAnswer: boolean): Promise<void> {
    const key = `physical:${target.tx}:${target.rx}:${singleFrameAnswer ? "probe" : "full"}`;
    if (this.#addressing === key) return;
    this.#addressing = undefined;
    await this.at(`ATSH${hexId(target.tx)}`);
    await this.at(`ATCRA${hexId(target.rx)}`);
    if (!singleFrameAnswer) {
      // Header and data must be set before the mode is switched to "user defined".
      await this.at(`ATFCSH${hexId(target.tx)}`);
      if (!this.#userFlowControl) {
        await this.at("ATFCSD300000");
        await this.at("ATFCSM1");
        this.#userFlowControl = true;
      }
    }
    this.#addressing = key;
  }

  async #selectFunctional(): Promise<void> {
    if (this.#addressing === "functional") return;
    this.#addressing = undefined;
    if (this.#userFlowControl) {
      await this.at("ATFCSM0");
      this.#userFlowControl = false;
    }
    await this.at("ATAR");
    await this.at(`ATSH${hexId(OBD_FUNCTIONAL_ID)}`);
    this.#addressing = "functional";
  }
}

function interpret(sid: number, messages: readonly IsoTpMessage[]): { outcome?: DiagOutcome; pending: boolean } {
  let pending = false;
  for (const message of messages) {
    const p = message.payload;
    if (p[0] === 0x7f && p[1] === sid) {
      if (p[2] === NRC_RESPONSE_PENDING) {
        pending = true;
        continue;
      }
      return { outcome: { kind: "negative", nrc: p[2] ?? 0 }, pending };
    }
    if (p[0] === sid + 0x40) {
      if (!message.complete) {
        return {
          outcome: {
            kind: "fault",
            fault: "incomplete",
            detail: `received ${p.length} of ${message.expectedLength} bytes`,
          },
          pending,
        };
      }
      return { outcome: { kind: "positive", payload: p }, pending };
    }
  }
  return { pending };
}

function faultOutcome(status: readonly string[]): DiagOutcome {
  const fault = classifyStatus(status);
  if (fault === undefined || fault === "no-data") return { kind: "no-response" };
  return { kind: "fault", fault, detail: status.join(" | ") };
}

const NRC_NAMES: Readonly<Record<number, string>> = {
  0x10: "generalReject",
  0x11: "serviceNotSupported",
  0x12: "subFunctionNotSupported",
  0x13: "incorrectMessageLengthOrInvalidFormat",
  0x14: "responseTooLong",
  0x21: "busyRepeatRequest",
  0x22: "conditionsNotCorrect",
  0x24: "requestSequenceError",
  0x31: "requestOutOfRange",
  0x33: "securityAccessDenied",
  0x78: "responsePending",
  0x7e: "subFunctionNotSupportedInActiveSession",
  0x7f: "serviceNotSupportedInActiveSession",
};

export function nrcName(nrc: number): string {
  return NRC_NAMES[nrc] ?? `nrc-0x${hexByte(nrc)}`;
}

export function describeOutcome(outcome: DiagOutcome): string {
  switch (outcome.kind) {
    case "positive":
      return `positive (${outcome.payload.length} bytes)`;
    case "negative":
      return `negative: ${nrcName(outcome.nrc)} (0x${hexByte(outcome.nrc)})`;
    case "no-response":
      return "no response";
    case "fault":
      return `fault: ${outcome.fault} (${outcome.detail})`;
  }
}

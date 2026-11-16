/**
 * ElmSession: talks the ELM327 command dialect over a byte transport.
 *
 * - One command at a time. The adapter is strictly request/response; a reply ends with
 *   the prompt character '>'.
 * - Transport chunk boundaries carry no meaning (BLE notifications split replies
 *   arbitrarily), so bytes are accumulated until the prompt arrives.
 * - This class is the only caller of `transport.write`, and it checks every line against
 *   the safety policy before writing.
 */
import type { ByteTransport } from "../transport.ts";
import { type CaptureSink, nullCapture } from "../capture.ts";
import { checkLine, PolicyViolation } from "../policy.ts";

const PROMPT = ">";

export class ElmTimeoutError extends Error {
  readonly line: string;
  readonly partial: string;
  constructor(line: string, timeoutMs: number, partial: string) {
    super(`adapter did not answer "${line}" within ${timeoutMs} ms`);
    this.name = "ElmTimeoutError";
    this.line = line;
    this.partial = partial;
  }
}

export interface ElmSessionOptions {
  capture?: CaptureSink;
  /** Default time to wait for the prompt. */
  timeoutMs?: number;
}

export interface CommandOptions {
  timeoutMs?: number;
}

export class ElmSession {
  readonly #transport: ByteTransport;
  readonly #capture: CaptureSink;
  readonly #defaultTimeoutMs: number;
  #queue: Promise<unknown> = Promise.resolve();
  #buffer = "";
  #pending: { resolve: (text: string) => void } | undefined;

  constructor(transport: ByteTransport, options: ElmSessionOptions = {}) {
    this.#transport = transport;
    this.#capture = options.capture ?? nullCapture;
    this.#defaultTimeoutMs = options.timeoutMs ?? 3000;
    transport.onData((chunk) => this.#onData(chunk));
  }

  /** Writes an annotation into the capture. Nothing is sent to the adapter. */
  note(text: string): void {
    this.#capture.record("note", text);
  }

  /**
   * Sends one line and returns the reply as trimmed, non-empty lines (prompt removed,
   * echo of the command removed).
   *
   * Throws PolicyViolation (nothing was sent) or ElmTimeoutError.
   */
  command(input: string, options: CommandOptions = {}): Promise<string[]> {
    const run = this.#queue.then(() => this.#exchange(input, options.timeoutMs ?? this.#defaultTimeoutMs));
    // Keep the queue alive after a failure; the caller still sees the rejection via `run`.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.#queue;
    await this.#transport.close();
  }

  async #exchange(input: string, timeoutMs: number): Promise<string[]> {
    let line: string;
    try {
      line = checkLine(input).line;
    } catch (error) {
      if (error instanceof PolicyViolation) this.#capture.record("blocked", `${input} :: ${error.reason}`);
      throw error;
    }

    if (this.#buffer.length > 0) {
      // Late bytes from an earlier, timed-out exchange. Keep them as evidence, then drop.
      this.#capture.record("note", `discarded stale bytes: ${JSON.stringify(this.#buffer)}`);
      this.#buffer = "";
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<string>((resolve, reject) => {
      this.#pending = { resolve };
      timer = setTimeout(() => {
        this.#pending = undefined;
        reject(new ElmTimeoutError(line, timeoutMs, this.#buffer));
      }, timeoutMs);
    });

    try {
      this.#capture.record("tx", line);
      await this.#transport.write(encodeAscii(line + "\r"));
      const text = await reply;
      return splitReply(text, line);
    } finally {
      clearTimeout(timer);
      this.#pending = undefined;
    }
  }

  #onData(chunk: Uint8Array): void {
    let text = "";
    for (const byte of chunk) {
      // ELM adapters occasionally emit NUL bytes; they carry no information.
      if (byte !== 0) text += String.fromCharCode(byte);
    }
    if (text.length === 0) return;
    this.#capture.record("rx", text);
    this.#buffer += text;

    const promptAt = this.#buffer.indexOf(PROMPT);
    if (promptAt === -1) return;
    if (this.#pending === undefined) return; // unsolicited; reported as stale on next command
    const reply = this.#buffer.slice(0, promptAt);
    this.#buffer = this.#buffer.slice(promptAt + 1);
    this.#pending.resolve(reply);
  }
}

function encodeAscii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** Splits a raw reply into lines and removes the command echo if the adapter sent one. */
export function splitReply(text: string, sentLine: string): string[] {
  const lines = text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const first = lines[0];
  if (first !== undefined && first.replace(/ /g, "").toUpperCase() === sentLine) lines.shift();
  return lines;
}

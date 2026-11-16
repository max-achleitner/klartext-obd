/**
 * Evidence log. Every byte exchanged with the adapter is recorded so that a session at
 * the car can be inspected and replayed later without the car.
 *
 * Captures contain vehicle-identifying data (VIN, serial numbers). They are private by
 * default; redact before publishing.
 */
export type CaptureKind =
  /** Line sent to the adapter (after it passed the safety policy). */
  | "tx"
  /** Raw text received from the adapter, exactly as it arrived (chunk boundaries preserved). */
  | "rx"
  /** Line refused by the safety policy. It never reached the adapter. */
  | "blocked"
  /** Free-form annotation written by the tool (step names, decisions, errors). */
  | "note";

export interface CaptureEvent {
  /** Milliseconds since the capture started. */
  t: number;
  kind: CaptureKind;
  data: string;
}

export interface CaptureSink {
  record(kind: CaptureKind, data: string): void;
}

export class MemoryCapture implements CaptureSink {
  readonly events: CaptureEvent[] = [];
  readonly #start: number;
  readonly #now: () => number;
  readonly #forward: ((event: CaptureEvent) => void) | undefined;

  constructor(options: { now?: () => number; forward?: (event: CaptureEvent) => void } = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#forward = options.forward;
    this.#start = this.#now();
  }

  record(kind: CaptureKind, data: string): void {
    const event: CaptureEvent = { t: this.#now() - this.#start, kind, data };
    this.events.push(event);
    this.#forward?.(event);
  }

  /** One JSON object per line. */
  toJsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
}

export const nullCapture: CaptureSink = { record() {} };

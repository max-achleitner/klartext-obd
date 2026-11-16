/**
 * ISO 15765-2 (ISO-TP) reassembly of received frames.
 *
 * The adapter takes care of the wire protocol (it sends the flow control frame); with
 * headers on it prints every received frame including the protocol control byte, and
 * this module puts the payload back together.
 */
import type { CanFrame } from "./elm/parse.ts";

export interface IsoTpMessage {
  /** CAN identifier the message was received from. */
  id: number;
  payload: Uint8Array;
  /** False if consecutive frames were missing (typically: flow control did not reach the ECU). */
  complete: boolean;
  /** Announced payload length. */
  expectedLength: number;
}

interface Assembly {
  expected: number;
  bytes: number[];
  nextSequence: number;
  broken: boolean;
}

/** Reassembles all messages in arrival order. Frames from different identifiers may interleave. */
export function reassemble(frames: readonly CanFrame[]): IsoTpMessage[] {
  const messages: IsoTpMessage[] = [];
  const open = new Map<number, Assembly>();

  const finish = (id: number, assembly: Assembly): void => {
    open.delete(id);
    const complete = !assembly.broken && assembly.bytes.length >= assembly.expected;
    messages.push({
      id,
      payload: Uint8Array.from(assembly.bytes.slice(0, assembly.expected)),
      complete,
      expectedLength: assembly.expected,
    });
  };

  for (const frame of frames) {
    const pci = frame.data[0];
    if (pci === undefined) continue;
    const type = pci >> 4;

    if (type === 0x0) {
      // Single frame: low nibble is the payload length, the rest is padding.
      const previous = open.get(frame.id);
      if (previous !== undefined) finish(frame.id, previous);
      const length = pci & 0x0f;
      if (length === 0 || length > frame.data.length - 1) continue; // malformed
      messages.push({
        id: frame.id,
        payload: frame.data.slice(1, 1 + length),
        complete: true,
        expectedLength: length,
      });
    } else if (type === 0x1) {
      // First frame: 12-bit length, then the first 6 payload bytes.
      const previous = open.get(frame.id);
      if (previous !== undefined) finish(frame.id, previous);
      const second = frame.data[1];
      if (second === undefined) continue;
      const expected = ((pci & 0x0f) << 8) | second;
      open.set(frame.id, {
        expected,
        bytes: Array.from(frame.data.slice(2)),
        nextSequence: 1,
        broken: false,
      });
    } else if (type === 0x2) {
      // Consecutive frame: 4-bit rolling sequence number, then up to 7 payload bytes.
      const assembly = open.get(frame.id);
      if (assembly === undefined) continue; // stray frame without a first frame
      if ((pci & 0x0f) !== assembly.nextSequence) assembly.broken = true;
      assembly.nextSequence = (assembly.nextSequence + 1) & 0x0f;
      assembly.bytes.push(...frame.data.slice(1));
      if (assembly.bytes.length >= assembly.expected) finish(frame.id, assembly);
    }
    // type 0x3 (flow control) carries no payload and is ignored.
  }

  for (const [id, assembly] of [...open]) finish(id, assembly);
  return messages;
}

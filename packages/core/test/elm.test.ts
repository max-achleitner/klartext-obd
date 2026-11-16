import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryCapture } from "../src/capture.ts";
import { classifyStatus, parseFrameLine, parseReply } from "../src/elm/parse.ts";
import { ElmSession, ElmTimeoutError } from "../src/elm/session.ts";
import { reassemble } from "../src/isotp.ts";
import { PolicyViolation } from "../src/policy.ts";
import type { ByteTransport } from "../src/transport.ts";

/** Transport whose replies are scripted per received line; delivers them in given chunks. */
class ScriptedTransport implements ByteTransport {
  readonly written: string[] = [];
  #listener: ((chunk: Uint8Array) => void) | undefined;
  readonly #script: (line: string) => string[] | undefined;

  constructor(script: (line: string) => string[] | undefined) {
    this.#script = script;
  }
  onData(listener: (chunk: Uint8Array) => void): void {
    this.#listener = listener;
  }
  async write(data: Uint8Array): Promise<void> {
    const line = String.fromCharCode(...data);
    this.written.push(line);
    const chunks = this.#script(line.replace(/\r$/, ""));
    for (const chunk of chunks ?? []) {
      setTimeout(() => this.push(chunk), 0);
    }
  }
  push(text: string): void {
    this.#listener?.(Uint8Array.from(text, (c) => c.charCodeAt(0)));
  }
  async close(): Promise<void> {}
}

test("reply is assembled across arbitrary chunk boundaries and the echo is removed", async () => {
  const transport = new ScriptedTransport(() => ["AT", "I\rELM3", "27 v1.4", " v100\r\r", ">"]);
  const elm = new ElmSession(transport);
  assert.deepEqual(await elm.command("ATI"), ["ELM327 v1.4 v100"]);
  assert.deepEqual(transport.written, ["ATI\r"]);
});

test("NUL bytes and linefeeds are ignored", async () => {
  const transport = new ScriptedTransport(() => ["\0OK\r\n\0\r\n>"]);
  assert.deepEqual(await new ElmSession(transport).command("ATE0"), ["OK"]);
});

test("a refused line is never written to the transport and is logged as blocked", async () => {
  const transport = new ScriptedTransport(() => ["OK\r>"]);
  const capture = new MemoryCapture();
  const elm = new ElmSession(transport, { capture });
  await assert.rejects(elm.command("14FFFFFF"), PolicyViolation);
  await assert.rejects(elm.command("1003"), PolicyViolation);
  assert.deepEqual(transport.written, []);
  assert.deepEqual(
    capture.events.map((e) => e.kind),
    ["blocked", "blocked"],
  );
  // The session still works afterwards.
  assert.deepEqual(await elm.command("ATE0"), ["OK"]);
});

test("timeout rejects, and late bytes do not leak into the next command", async () => {
  let calls = 0;
  const transport = new ScriptedTransport(() => (++calls === 1 ? [] : ["41 00\r>"]));
  const capture = new MemoryCapture();
  const elm = new ElmSession(transport, { capture, timeoutMs: 30 });
  await assert.rejects(elm.command("0100"), ElmTimeoutError);
  transport.push("LATE DATA\r>"); // arrives after the timeout
  assert.deepEqual(await elm.command("0100"), ["41 00"]);
  assert.ok(capture.events.some((e) => e.kind === "note" && e.data.includes("stale")));
});

test("commands are serialised even when issued concurrently", async () => {
  const transport = new ScriptedTransport((line) => [`${line === "ATI" ? "ID" : "12.4V"}\r>`]);
  const elm = new ElmSession(transport);
  const [a, b] = await Promise.all([elm.command("ATI"), elm.command("ATRV")]);
  assert.deepEqual(a, ["ID"]);
  assert.deepEqual(b, ["12.4V"]);
  assert.deepEqual(transport.written, ["ATI\r", "ATRV\r"]);
});

test("frame lines: 11-bit and 29-bit identifiers, with and without spaces", () => {
  assert.deepEqual(parseFrameLine("7E8 06 41 00 BE 3F A8 13"), {
    id: 0x7e8,
    data: Uint8Array.of(0x06, 0x41, 0x00, 0xbe, 0x3f, 0xa8, 0x13),
  });
  assert.deepEqual(parseFrameLine("7E8064100BE3FA813")?.id, 0x7e8);
  assert.deepEqual(parseFrameLine("18 DA F1 10 03 7F 22 31"), {
    id: 0x18daf110,
    data: Uint8Array.of(0x03, 0x7f, 0x22, 0x31),
  });
  assert.equal(parseFrameLine("NO DATA"), undefined);
  assert.equal(parseFrameLine("SEARCHING..."), undefined);
});

test("status lines are classified", () => {
  assert.equal(classifyStatus(parseReply(["NO DATA"]).status), "no-data");
  assert.equal(classifyStatus(parseReply(["SEARCHING...", "UNABLE TO CONNECT"]).status), "unable-to-connect");
  assert.equal(classifyStatus(parseReply(["CAN ERROR"]).status), "can-error");
  assert.equal(classifyStatus(parseReply(["?"]).status), "rejected");
  assert.equal(classifyStatus(parseReply(["BUFFER FULL"]).status), "adapter-error");
  assert.equal(classifyStatus(parseReply(["SEARCHING...", "7E8 06 41 00 BE 3F A8 13"]).status), undefined);
});

test("ISO-TP: single frame with padding", () => {
  const [message] = reassemble([{ id: 0x77e, data: Uint8Array.of(0x03, 0x7f, 0x22, 0x31, 0xaa, 0xaa, 0xaa, 0xaa) }]);
  assert.deepEqual(message, { id: 0x77e, payload: Uint8Array.of(0x7f, 0x22, 0x31), complete: true, expectedLength: 3 });
});

test("ISO-TP: multi-frame message, interleaved with another identifier", () => {
  const frames = [
    { id: 0x7e8, data: Uint8Array.of(0x10, 0x0a, 1, 2, 3, 4, 5, 6) },
    { id: 0x7e9, data: Uint8Array.of(0x02, 0x47, 0x00, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa) },
    { id: 0x7e8, data: Uint8Array.of(0x21, 7, 8, 9, 10, 0xaa, 0xaa, 0xaa) },
  ];
  const messages = reassemble(frames);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { id: 0x7e9, payload: Uint8Array.of(0x47, 0x00), complete: true, expectedLength: 2 });
  assert.deepEqual(messages[1], {
    id: 0x7e8,
    payload: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
    complete: true,
    expectedLength: 10,
  });
});

test("ISO-TP: missing consecutive frames and wrong sequence are reported as incomplete", () => {
  const firstOnly = reassemble([{ id: 0x77a, data: Uint8Array.of(0x10, 0x0e, 1, 2, 3, 4, 5, 6) }]);
  assert.equal(firstOnly[0]?.complete, false);
  assert.equal(firstOnly[0]?.expectedLength, 14);

  const wrongSequence = reassemble([
    { id: 0x77a, data: Uint8Array.of(0x10, 0x0a, 1, 2, 3, 4, 5, 6) },
    { id: 0x77a, data: Uint8Array.of(0x22, 7, 8, 9, 10, 0, 0, 0) },
  ]);
  assert.equal(wrongSequence[0]?.complete, false);
});

test("ISO-TP: sequence numbers wrap from F to 0", () => {
  const total = 6 + 7 * 17;
  const frames = [{ id: 0x7e8, data: Uint8Array.of(0x10, total, 0, 0, 0, 0, 0, 0) }];
  for (let i = 1; i <= 17; i++) frames.push({ id: 0x7e8, data: Uint8Array.of(0x20 | (i & 0x0f), 1, 1, 1, 1, 1, 1, 1) });
  const [message] = reassemble(frames);
  assert.equal(message?.complete, true);
  assert.equal(message?.payload.length, total);
});

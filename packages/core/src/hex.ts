/** Hex helpers. Core code uses Uint8Array only (no Node Buffer) so it runs on React Native too. */

export function toHex(bytes: Uint8Array, separator = ""): string {
  const parts: string[] = [];
  for (const b of bytes) parts.push(b.toString(16).toUpperCase().padStart(2, "0"));
  return parts.join(separator);
}

export function hexByte(value: number): string {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

/** Formats a CAN identifier the way ELM adapters print it: 3 hex digits (11-bit) or 8 (29-bit). */
export function hexId(id: number): string {
  return id.toString(16).toUpperCase().padStart(id > 0x7ff ? 8 : 3, "0");
}

/** Parses a hex string (whitespace allowed). Throws on anything that is not complete hex bytes. */
export function fromHex(text: string): Uint8Array {
  const compact = text.replace(/\s+/g, "");
  if (compact.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(compact)) {
    throw new Error(`not a hex byte string: "${text}"`);
  }
  const out = new Uint8Array(compact.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function asciiFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "";
  return out.trim();
}

export function bytesFromAscii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * A raw byte pipe to the adapter (BLE serial characteristic, simulator, replay, ...).
 *
 * Implementations must not interpret the bytes. The only component allowed to call
 * `write` is ElmSession, which runs every outgoing line through the safety policy first.
 */
export interface ByteTransport {
  write(data: Uint8Array): Promise<void>;
  /** Registers the single consumer of incoming bytes. Chunk boundaries are arbitrary. */
  onData(listener: (chunk: Uint8Array) => void): void;
  close(): Promise<void>;
}

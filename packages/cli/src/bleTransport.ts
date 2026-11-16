/**
 * Bluetooth LE transport for adapters that expose an ELM-dialect serial channel on
 * service FFE0 / characteristic FFE1 (the Carly Universal Adapter does).
 *
 * Hard rule: this file only ever writes to FFE1. Some adapters expose additional vendor
 * services, including firmware update services; they are listed for the record and
 * never opened, read or written.
 */
import type { ByteTransport } from "@klartext/core";
import type { Characteristic, Noble, Peripheral } from "@stoprocent/noble";

const SERIAL_SERVICE = "ffe0";
const SERIAL_CHARACTERISTIC = "ffe1";
/** Payload of one ATT write with the default MTU of 23. */
const MAX_WRITE_BYTES = 20;

export interface SeenDevice {
  id: string;
  address: string;
  name: string;
  rssi: number;
  serviceUuids: string[];
  /** Why this device is considered an adapter candidate, if it is one. */
  match: "name" | "service" | "requested" | undefined;
}

export class BluetoothUnavailableError extends Error {
  constructor(state: string) {
    super(`Bluetooth ist nicht verfügbar (Zustand: ${state}). Ist Bluetooth am Rechner eingeschaltet?`);
    this.name = "BluetoothUnavailableError";
  }
}

async function loadNoble(): Promise<Noble> {
  // Loaded lazily so that simulator runs work on machines without Bluetooth.
  const module = await import("@stoprocent/noble");
  return module.default;
}

function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

function isSerialService(uuid: string): boolean {
  const u = normalizeUuid(uuid);
  return u === SERIAL_SERVICE || u === `0000${SERIAL_SERVICE}00001000800000805f9b34fb`;
}

function classify(peripheral: Peripheral, requested: string | undefined): SeenDevice {
  const name = peripheral.advertisement?.localName ?? "";
  const serviceUuids = (peripheral.advertisement?.serviceUuids ?? []).map(normalizeUuid);
  let match: SeenDevice["match"];
  if (requested !== undefined) {
    const wanted = requested.toLowerCase();
    if (name.toLowerCase().includes(wanted) || peripheral.id.toLowerCase() === wanted || peripheral.address.toLowerCase() === wanted) {
      match = "requested";
    }
  } else if (/carly/i.test(name)) {
    match = "name";
  } else if (serviceUuids.some(isSerialService)) {
    match = "service";
  }
  return { id: peripheral.id, address: peripheral.address, name, rssi: peripheral.rssi, serviceUuids, match };
}

export interface ScanResult {
  devices: SeenDevice[];
  peripherals: Map<string, Peripheral>;
  noble: Noble;
}

/** Listens for advertisements for a fixed time and returns everything that was seen. */
export async function scanForDevices(options: { seconds: number; device?: string | undefined }): Promise<ScanResult> {
  const noble = await loadNoble();
  try {
    await noble.waitForPoweredOnAsync(5000);
  } catch {
    throw new BluetoothUnavailableError(noble.state);
  }
  const peripherals = new Map<string, Peripheral>();
  const onDiscover = (peripheral: Peripheral): void => {
    peripherals.set(peripheral.id, peripheral);
  };
  noble.on("discover", onDiscover);
  await noble.startScanningAsync([], false);
  await new Promise((resolve) => setTimeout(resolve, options.seconds * 1000));
  await noble.stopScanningAsync();
  noble.removeListener("discover", onDiscover);

  const devices = [...peripherals.values()].map((p) => classify(p, options.device)).sort((a, b) => b.rssi - a.rssi);
  return { devices, peripherals, noble };
}

export interface BleConnection {
  transport: ByteTransport;
  device: SeenDevice;
  /** Services the device exposes, for the record. Only FFE0 is used. */
  serviceUuids: string[];
  characteristicProperties: string[];
  mtu: number | null;
}

/**
 * Connects to the given device and opens the serial characteristic.
 * `onLost` is called if the link drops unexpectedly.
 */
export async function connect(scan: ScanResult, device: SeenDevice, onLost: (reason: string) => void): Promise<BleConnection> {
  const peripheral = scan.peripherals.get(device.id);
  if (peripheral === undefined) throw new Error(`Gerät ${device.id} ist nicht mehr sichtbar`);

  await peripheral.connectAsync();
  const services = await peripheral.discoverServicesAsync();
  const serviceUuids = services.map((s) => normalizeUuid(s.uuid));
  const serial = services.find((s) => isSerialService(s.uuid));
  if (serial === undefined) {
    await peripheral.disconnectAsync();
    throw new Error(
      `Das Gerät hat keinen seriellen Dienst FFE0 (gefunden: ${serviceUuids.join(", ") || "nichts"}). Es ist kein unterstützter Adapter.`,
    );
  }
  const characteristics = await serial.discoverCharacteristicsAsync();
  const characteristic: Characteristic | undefined = characteristics.find(
    (c) => normalizeUuid(c.uuid).endsWith(SERIAL_CHARACTERISTIC) || normalizeUuid(c.uuid).startsWith(`0000${SERIAL_CHARACTERISTIC}`),
  );
  if (characteristic === undefined) {
    await peripheral.disconnectAsync();
    throw new Error("Der Dienst FFE0 hat keine Characteristic FFE1.");
  }
  const properties = characteristic.properties;
  if (!properties.includes("notify") && !properties.includes("indicate")) {
    await peripheral.disconnectAsync();
    throw new Error(`FFE1 kann keine Daten melden (Eigenschaften: ${properties.join(", ")}).`);
  }
  const withoutResponse = properties.includes("writeWithoutResponse");
  if (!withoutResponse && !properties.includes("write")) {
    await peripheral.disconnectAsync();
    throw new Error(`FFE1 ist nicht beschreibbar (Eigenschaften: ${properties.join(", ")}).`);
  }

  let listener: ((chunk: Uint8Array) => void) | undefined;
  let closed = false;
  let lost = false;
  characteristic.on("data", (data: Buffer) => {
    listener?.(new Uint8Array(data));
  });
  peripheral.once("disconnect", (reason: unknown) => {
    lost = true;
    if (!closed) onLost(String(reason ?? "unbekannt"));
  });
  await characteristic.subscribeAsync();

  const transport: ByteTransport = {
    onData(next) {
      listener = next;
    },
    async write(data) {
      if (lost || closed) throw new Error("Verbindung zum Adapter ist getrennt");
      for (let offset = 0; offset < data.length; offset += MAX_WRITE_BYTES) {
        await characteristic.writeAsync(Buffer.from(data.subarray(offset, offset + MAX_WRITE_BYTES)), withoutResponse);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!lost) {
        await characteristic.unsubscribeAsync().catch(() => undefined);
        await peripheral.disconnectAsync().catch(() => undefined);
      }
    },
  };

  return { transport, device, serviceUuids, characteristicProperties: [...properties], mtu: peripheral.mtu };
}

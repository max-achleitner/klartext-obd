/**
 * VAG diagnostic addressing on CAN (UDS over ISO-TP, 11-bit identifiers).
 *
 * Every control unit has a two digit diagnostic address ("01 Engine", "19 Gateway")
 * and a CAN identifier pair. The response identifier follows from the request
 * identifier, see responseIdFor().
 *
 * The table below only lists pairs that are backed by more than one independent source
 * or by an observed capture. It is used for labelling; discovery does not depend on it
 * (the scan probes the whole diagnostic identifier range and asks each unit for its own
 * name). Extend it from real captures, not from memory.
 */
import type { EcuTarget } from "../diag/client.ts";

export type SystemGroup = "antrieb" | "fahrwerk" | "karosserie" | "komfort" | "infotainment" | "assistenz" | "sonstige";

export const SYSTEM_GROUP_LABELS: Readonly<Record<SystemGroup, string>> = {
  antrieb: "Antrieb",
  fahrwerk: "Fahrwerk & Bremsen",
  karosserie: "Karosserie & Sicherheit",
  komfort: "Komfort",
  infotainment: "Infotainment",
  assistenz: "Assistenzsysteme",
  sonstige: "Sonstige",
};

export interface VagModule {
  /** VAG diagnostic address, e.g. 0x19 for the gateway. */
  address: number;
  name: string;
  group: SystemGroup;
  /** Request CAN identifier. */
  tx: number;
}

export const KNOWN_MODULES: readonly VagModule[] = [
  { address: 0x01, name: "Motorelektronik", group: "antrieb", tx: 0x7e0 },
  { address: 0x02, name: "Getriebeelektronik", group: "antrieb", tx: 0x7e1 },
  { address: 0x03, name: "Bremsenelektronik (ABS/ESP)", group: "fahrwerk", tx: 0x713 },
  { address: 0x09, name: "Zentralelektrik (Bordnetz)", group: "karosserie", tx: 0x70e },
  { address: 0x15, name: "Airbag", group: "karosserie", tx: 0x715 },
  { address: 0x16, name: "Lenksäulenelektronik", group: "karosserie", tx: 0x70c },
  { address: 0x17, name: "Schalttafeleinsatz (Kombiinstrument)", group: "karosserie", tx: 0x714 },
  { address: 0x19, name: "Diagnoseinterface (Gateway)", group: "karosserie", tx: 0x710 },
  { address: 0x44, name: "Lenkhilfe", group: "fahrwerk", tx: 0x712 },
];

/**
 * Response identifier for a request identifier.
 *  - 0x7E0-0x7E7 (OBD powertrain units) answer on request + 8 (ISO 15765-4).
 *  - all other units answer on request + 0x6A.
 */
export function responseIdFor(tx: number): number {
  return tx >= 0x7e0 && tx <= 0x7e7 ? tx + 8 : tx + 0x6a;
}

export function targetFor(tx: number): EcuTarget {
  return { tx, rx: responseIdFor(tx) };
}

export function knownModuleByTx(tx: number): VagModule | undefined {
  return KNOWN_MODULES.find((m) => m.tx === tx);
}

/**
 * Request identifiers probed during discovery: the VAG unit range plus the OBD
 * powertrain range. The upper bound of the unit range is where request + 0x6A would
 * run into the OBD response identifiers.
 */
export function discoveryCandidates(): number[] {
  const ids: number[] = [];
  for (let tx = 0x700; tx <= 0x77f; tx++) ids.push(tx);
  for (let tx = 0x7e0; tx <= 0x7e7; tx++) ids.push(tx);
  return ids;
}

/** Identification data identifiers (ReadDataByIdentifier) common to VAG UDS units. */
export const IDENT_DIDS = [
  { key: "partNumber", did: 0xf187, label: "Teilenummer" },
  { key: "softwareVersion", did: 0xf189, label: "Softwarestand" },
  { key: "hardwareNumber", did: 0xf191, label: "Hardware-Teilenummer" },
  { key: "systemName", did: 0xf197, label: "Systembezeichnung" },
  { key: "workshopName", did: 0xf1aa, label: "Werkstattkürzel" },
  { key: "odxName", did: 0xf19e, label: "Diagnosedatensatz" },
  { key: "odxVersion", did: 0xf1a2, label: "Version Diagnosedatensatz" },
] as const;

export type IdentKey = (typeof IDENT_DIDS)[number]["key"];

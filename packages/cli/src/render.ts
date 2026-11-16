/** Plain-text rendering of reports for the terminal (German). Pure functions, no I/O. */
import {
  type Dtc,
  type DtcState,
  type EcuReport,
  type ReconReport,
  type ReconVerdict,
  type ScanReport,
  type SystemGroup,
  SYSTEM_GROUP_LABELS,
  hexByte,
  hexId,
} from "@klartext/core";

const STATE_LABELS: Readonly<Record<DtcState, string>> = {
  active: "aktiv",
  stored: "gespeichert, derzeit nicht aktiv",
  pending: "vorläufig, noch nicht bestätigt",
  history: "seit dem letzten Löschen aufgetreten, nicht gespeichert",
};

const VERDICT_TEXT: Readonly<Record<ReconVerdict, string>> = {
  go: "GO: Adapter und Fahrzeug beantworten alles, was der Steuergeräte-Scan braucht.",
  "obd-only":
    "TEILWEISE: Der Adapter arbeitet und Standard-OBD funktioniert, aber einzelne Steuergeräte lassen sich so nicht ansprechen. Der Mitschnitt zeigt, woran es hängt.",
  "no-vehicle":
    "KEIN FAHRZEUG: Der Adapter antwortet, das Fahrzeug nicht. Zündung an? Adapter richtig eingesteckt?",
  "no-adapter": "KEIN ADAPTER: Das Gerät verhält sich nicht wie ein ELM-kompatibler Adapter.",
};

export function renderRecon(report: ReconReport): string {
  const lines: string[] = ["Adapter-Erkundung", ""];
  for (const step of report.steps) {
    lines.push(`  ${step.ok ? "[ok]" : "[--]"} ${step.title}`);
    lines.push(`       ${step.detail}`);
  }
  lines.push("", VERDICT_TEXT[report.verdict]);
  return lines.join("\n");
}

function ecuTitle(ecu: EcuReport): string {
  const address = ecu.module !== undefined ? `${hexByte(ecu.module.address)} ` : "";
  const name = ecu.module?.name ?? ecu.ident.systemName ?? "Unbekanntes Steuergerät";
  const extras = [
    ecu.module !== undefined ? ecu.ident.systemName : undefined,
    ecu.ident.workshopName,
    ecu.ident.partNumber !== undefined ? `Teilenummer ${ecu.ident.partNumber}` : undefined,
    ecu.ident.softwareVersion !== undefined ? `SW ${ecu.ident.softwareVersion}` : undefined,
    `CAN ${hexId(ecu.target.tx)}/${hexId(ecu.target.rx)}`,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return `${address}${name}  (${extras.join(", ")})`;
}

function dtcLine(dtc: Dtc): string {
  const lamp = dtc.status.warningIndicatorRequested ? ", Warnlampe angefordert" : "";
  return `${dtc.display}  ${STATE_LABELS[dtc.state]}${lamp}  [Status 0x${hexByte(dtc.status.raw)}]`;
}

/** Order in which faults matter to a person reading the report. */
const STATE_ORDER: readonly DtcState[] = ["active", "stored", "pending", "history"];

export function renderScan(report: ScanReport): string {
  const lines: string[] = ["Fehlerspeicher aller Steuergeräte", ""];
  const groups = new Map<SystemGroup, EcuReport[]>();
  for (const ecu of report.ecus) {
    const group = ecu.module?.group ?? "sonstige";
    groups.set(group, [...(groups.get(group) ?? []), ecu]);
  }

  const counts: Record<DtcState, number> = { active: 0, stored: 0, pending: 0, history: 0 };
  const unreadable: string[] = [];

  for (const group of Object.keys(SYSTEM_GROUP_LABELS) as SystemGroup[]) {
    const ecus = groups.get(group);
    if (ecus === undefined) continue;
    lines.push(`== ${SYSTEM_GROUP_LABELS[group]} ==`);
    for (const ecu of ecus.sort((a, b) => a.target.tx - b.target.tx)) {
      lines.push(`  ${ecuTitle(ecu)}`);
      const memory = ecu.faultMemory;
      if (!memory.readable) {
        lines.push(`      Fehlerspeicher nicht lesbar: ${memory.reason}`);
        unreadable.push(ecuTitle(ecu));
      } else if (memory.dtcs.length === 0) {
        lines.push("      kein Eintrag");
      } else {
        const sorted = [...memory.dtcs].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
        for (const dtc of sorted) {
          counts[dtc.state]++;
          lines.push(`      ${dtcLine(dtc)}`);
        }
      }
    }
    lines.push("");
  }

  const total = counts.active + counts.stored + counts.pending + counts.history;
  lines.push(
    `Steuergeräte gefunden: ${report.ecus.length}. Fehlereinträge: ${total} ` +
      `(${counts.active} aktiv, ${counts.stored} gespeichert, ${counts.pending} vorläufig, ${counts.history} nur Historie).`,
  );
  if (unreadable.length > 0) {
    lines.push(`Fehlerspeicher in der Standardsitzung nicht lesbar: ${unreadable.length} Steuergeräte (siehe oben).`);
  }
  if (report.probeFaults.length > 0) {
    lines.push(`Abfragen mit Übertragungsfehler: ${report.probeFaults.length} (Details im Mitschnitt).`);
  }
  lines.push(`Dauer: ${Math.round(report.durationMs / 1000)} s. Klartexte zu den Codes folgen mit der Wissensdatenbank.`);
  return lines.join("\n");
}

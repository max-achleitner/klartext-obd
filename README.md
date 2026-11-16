# klartext

Freie, rein lesende Fahrzeugdiagnose für VAG-Fahrzeuge über Bluetooth-LE-Adapter mit
ELM327-Befehlsdialekt. Arbeitstitel. Erstes Ziel: den Fehlerspeicher aller Steuergeräte
auslesen, einordnen und im Klartext anzeigen.

Das Projekt steht in keiner Verbindung zu Adapter- oder Fahrzeugherstellern.

> **English summary:** Open-source, read-only vehicle diagnostics for Volkswagen Group
> cars over Bluetooth LE adapters that speak the ELM327 command dialect. The first goal is
> reading the fault memory of every control unit and explaining it in plain language.
> Every outgoing command passes an allowlist that only admits read requests. Early stage:
> the stack is tested against a simulator and has not yet run on real hardware. The
> documentation is in German for now.

## Stand

| Baustein | Stand |
|---|---|
| Sicherheitsprüfung (Allowlist, nur Lesebefehle) | fertig, getestet |
| ELM-Dialekt, ISO-TP, UDS/OBD-Client | fertig, gegen Simulator getestet |
| Adapter-Erkundung (`recon`) | fertig, **noch nicht an echter Hardware gelaufen** |
| Scan aller Steuergeräte (`scan`) | fertig, **noch nicht an echter Hardware gelaufen** |
| Klartexte zu Fehlercodes | offen |
| Handy-App | offen |

Getestete Hardware: bisher keine. Ziel der ersten Messung: Carly Universal Adapter an
einem Golf 7 (MQB).

## Was das Werkzeug sendet

Ausschließlich Lesebefehle: OBD-Modi 01, 02, 03, 07, 09, 0A sowie UDS `19 01/02`
(Fehlerspeicher lesen), `22` (Daten lesen) und `3E 00` (Anwesenheit). Alles andere
(Fehler löschen, Sitzungswechsel, Codieren, Stellgliedtests, Flashen) wird von der
Sicherheitsprüfung in `packages/core/src/policy.ts` abgelehnt, bevor ein Byte den Adapter
erreicht. Es gibt keinen Schalter, der die Prüfung abschaltet.

## Einrichten

Voraussetzung: [Node.js](https://nodejs.org) ab Version 24, für echte Messungen ein
Rechner mit Bluetooth LE.

```
npm install
npm run check
```

## Ohne Auto ausprobieren

```
npm run klartext -- all --sim
```

Der Simulator stellt einen erfundenen Adapter und ein erfundenes Fahrzeug bereit.

## Am Auto

1. Carly-App am Handy vollständig schließen oder Bluetooth am Handy ausschalten. Der
   Adapter nimmt nur eine Verbindung an.
2. Adapter in die OBD-Buchse stecken. Zündung an, Motor aus.
3. Am Laptop:

   ```
   npm run klartext -- doctor
   npm run klartext -- all
   ```

   `doctor` zeigt, ob der Adapter sichtbar ist. `all` erkundet erst Adapter und Fahrzeug
   und liest danach, falls alles antwortet, den Fehlerspeicher aller Steuergeräte. Dauer
   etwa zwei bis drei Minuten.
4. Wird der Adapter nicht automatisch erkannt, den Namen aus der Geräteliste angeben:
   `npm run klartext -- all --device <Namensteil>`.

Jeder Lauf legt unter `captures/` einen Ordner mit dem vollständigen Mitschnitt
(`session.jsonl`) und den Berichten an. Der Mitschnitt enthält die Fahrgestellnummer;
der Ordner ist deshalb von Git ausgenommen.

## Aufbau

```
packages/core   Protokolllogik ohne Plattformabhängigkeit (läuft später auch in der App)
packages/cli    Kommandozeile, Bluetooth-Anbindung, Mitschnitt
```

## Dank

Die Angaben zum Carly Universal Adapter (BLE-Dienst, Befehlsdialekt) stammen aus der
öffentlichen Dokumentation des Projekts [obdentic](https://github.com/frankherchet/obdentic)
(Apache-2.0).

## Lizenz

Apache-2.0, siehe `LICENSE`. Nutzung auf eigene Verantwortung.

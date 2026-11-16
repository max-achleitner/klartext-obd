# klartext: owner notes

Claude owns this codebase long-term: architecture and design decisions are Claude's to
make. The user is the project sponsor, the first user and the person with the car; they
want a briefing before a new phase or a change of direction, not before every edit.
Talk to the user in German. Code, comments and commit messages are English; text shown to
end users is German.

## What this is

Open-source, read-only diagnostics for VAG cars over BLE adapters that speak the ELM327
command dialect. First target hardware: Carly Universal Adapter (2025 unit) on a 2013
Golf 7 GTI (MQB, UDS over ISO-TP, 11-bit CAN identifiers).

## Safety invariants (never weaken without an explicit design review with the user)

1. `packages/core/src/policy.ts` is the only gate to the vehicle. It is an allowlist on
   the exact outgoing line. No bypass flag, no raw passthrough, not in tests, not in
   debug builds.
2. `ElmSession` is the only caller of `ByteTransport.write`.
3. Read-only services only. Adding anything that changes ECU state (session control
   `10`, clear `14` / OBD `04`, write `2E`, security `27`, routines `31`, actuators `2F`,
   reset `11`, flashing) requires: a written design, the user's agreement, and for writes
   a verified backup of the affected configuration first.
4. Requests are single CAN frames. Transmit identifiers stay in 0x700-0x7FF.
5. BLE: only FFE0/FFE1 is used. Never open, read or write any other service; the
   adapter's second vendor service has the UUID of TI's firmware update service.
6. Never transmit on an identifier that a discovered control unit answers on.
7. No data from proprietary sources (Carly, Ross-Tech/VCDS, ODIS, Bentley). Every entry
   in a knowledge database records its provenance and licence.
8. Captures contain the VIN. `captures/` is git-ignored; redact before anything from a
   capture becomes a test fixture or is published.

## Evidence over memory

Facts about adapters and cars enter the code from captures, not from recollection. The
module table in `vag/modules.ts` and the simulator are models; mark anything that has not
been seen on real hardware as unverified. `README.md` lists what has run on hardware.

## Layout

- `packages/core`: platform-independent (no Node APIs, `Uint8Array` only). Layers:
  `transport` < `elm/session` (+ `policy`) < `diag/client` < `vag/scan`, `recon`.
  `sim/` is the simulated adapter and vehicle used by tests and `--sim`.
- `packages/cli`: Node command line, BLE transport (`@stoprocent/noble`), rendering,
  capture files.
- Planned: `packages/knowledge` (DTC texts), `packages/app` (Expo, iOS first).

## Working here

- `npm run check` runs typecheck and tests. Node runs the TypeScript directly (type
  stripping), so use erasable syntax only and `.ts` import extensions.
- `npm run klartext -- all --sim` exercises the whole flow without hardware.
- The development machine is a desktop without Bluetooth. Hardware runs happen on the
  user's laptop at the car; plan each run to collect as much evidence as possible.
- Edit files with non-ASCII characters through the editor tools, not through inline
  Python in the shell (stdin is decoded as cp1252 on this machine).

## Open questions the first hardware run answers

- Does the adapter accept the ELM dialect without the vendor app's handshake?
- Advertised name and services (how to recognise it during scanning).
- Are `ATFCSH` / `ATFCSD` / `ATFCSM1` supported (needed for multi-frame answers)?
- Which control units answer, and which refuse `19 02` in the default session?
- Does the response identifier rule (request + 0x6A) hold for every unit?

# pxrd-backend

Local Windows-runnable backend for **kinematic powder-diffraction peaks and
systematic-extinction analysis** of orthorhombic point-atom crystals.

Scope (by design):

- Orthorhombic cells only (`alpha=beta=gamma=90 deg`), three independent
  edge lengths `a,b,c`.
- Point atoms with a **constant real scattering factor**, occupancy and
  fractional coordinates.
- Kinematic ideal intensities `I = |F(hkl)|^2`. There are **no**
  instrument profile, absorption, extinction or Debye-Waller (temperature)
  corrections; output must not be presented as a real experimental pattern.
- API + CLI + fictional crystal fixtures + automated tests only.
  No web UI, no mass-spectrum matching, no external materials database.

## Physics model

- Reciprocal length / interplanar spacing (the only definition of `d`):
  `1/d^2 = (h/a)^2 + (k/b)^2 + (l/c)^2`. It is never derived from
  interatomic distances.
- Complex structure factor:
  `F = sum_j occ_j f_j exp[2 pi i (h x_j + k y_j + l z_j)]`;
  phases come strictly from fractional coordinates.
- Bragg angle: `sin theta = lambda / (2d)`, reported as two-theta in
  degrees. Reflections with `lambda/(2d) > 1` are listed with exclusion
  reason `bragg_unreachable`; `(0,0,0)` is `zero_hkl`; reflections
  outside the configured window are `outside_angle_window`.
- Both the individual reflections and the merged powder lines are kept.
  Multiplicity is the count of enumerated sign/permutation members and
  the line intensity is their plain `sum |F|^2`; multiplicity is never
  multiplied in a second time.
- Simple-cubic / body-centred / face-centred extinction rules are not
  hardcoded: equal-amplitude atoms in antiphase cancel inside the complex
  sum. Extinct members are retained on their powder line with near-zero
  intensity and an `extinctMembers` list. Near-zero decisions use the
  public relative tolerances in `src/constants.ts`
  (`EXTINCTION_REL = 1e-8`, `D_MERGE_REL = 1e-9`); raw untruncated
  values are always returned/displayed as well.
- Every scan stores its hkl truncation box, wavelength, angle window and
  a full cell snapshot. Reports explicitly state the enumeration is a
  finite box, never "all reflections".

## Requirements

- Node.js >= 22.5 (developed on Node 25; uses the built-in
  `node:sqlite` module — no native compilation)
- npm (ships with Node)

## Install

```powershell
npm install
```

## Tests

```powershell
npm test
npm run typecheck
```

Tests cover hand-checked low-index values, reciprocal lengths, naturally
emerging I/F extinctions, broken extinctions with unequal factors,
whole-cell translation invariance, Friedel symmetry, merged-intensity
conservation, window boundaries, validation/failure paths, transaction
rollback, pagination, idempotent resubmission and persistence across
reopen. All temporary databases are created under `data/test-tmp`.

## Repeatable demo

```powershell
npm run demo
```

The demo uses a fixed injected clock and content-derived IDs, writes
`data/demo/*.sqlite` and `*_peaks.csv`, and is byte-repeatable.

## API server (start / stop)

```powershell
npm run start:bg
npm run stop
```

`start:bg` binds `127.0.0.1` on an automatic free port and writes
`data/server.json`; `stop` terminates only the pid recorded there.
Or run in the foreground with `npm start` and press Ctrl+C. Override the
port or database with `PXRD_PORT` / `PXRD_DB`; everything stays inside
the project `data/` directory and only the loopback interface is bound.

### Endpoints

- `GET  /health`
- `POST /cells` (JSON body; optional `Idempotency-Key` header; `id` in body)
- `GET  /cells?limit=&offset=`
- `GET  /cells/{id}`
- `POST /cells/{id}/scans` (scan parameters; `Idempotency-Key` supported)
- `GET  /cells/{id}/scans?limit=&offset=`
- `GET  /scans/{id}` (summary with parameter snapshot, report version,
  enumeration-box note)
- `GET  /scans/{id}/reflections?limit=&offset=&included=true|false`
- `GET  /scans/{id}/lines?limit=&offset=`
- `GET  /scans/{id}/export` (CSV peak table)
- `GET  /cells/{id}/contributions?h=&k=&l=` (per-atom phase breakdown)
- `GET  /cells/{id}/extinction?h=&k=&l=` (extinction explanation)
- `POST /compare` (`{base, revised, scan}` occupancy-revision comparison)

Errors use JSON envelopes `{error:{code,message,details}}` with stable
codes `VALIDATION` (400), `NOT_FOUND` (404), `CONFLICT` (409),
`UNPROCESSABLE` (422), `PERSISTENCE` (500). List endpoints return
`{data, page:{total,limit,offset,returned,hasMore,next}}`.

## CLI

`npm run cli -- <command>` (set `PXRD_DB` to choose the database):

```powershell
npm run cli -- cell create --id bcc --file data/bcc.json
npm run cli -- cell list
npm run cli -- scan --cell bcc --file data/scan.json
npm run cli -- scan show SCAN_ID
npm run cli -- reflections SCAN_ID --included false
npm run cli -- lines SCAN_ID
npm run cli -- trace --cell bcc --h 1 --k 1 --l 0
npm run cli -- extinction --cell bcc --h 1 --k 0 --l 0
npm run cli -- compare --base a.json --revised b.json --scan data/scan.json
npm run cli -- export SCAN_ID -o peaks.csv
```

`cell create` prints BEFORE/AFTER state. Object shapes:

```json
{"a":3,"b":3,"c":3,"atoms":[{"label":"Q","x":0,"y":0,"z":0,"occupancy":1,"f":6}]}
```
```json
{"wavelength":1.5406,"hMin":-3,"hMax":3,"kMin":-3,"kMax":3,
 "lMin":-3,"lMax":3,"twoThetaMin":0,"twoThetaMax":180}
```

## Layout

- `src/diffraction.ts` — reciprocal geometry, structure factors, scan,
  powder merging, extinction explanation, translation
- `src/validate.ts` — parameter validation
- `src/db.ts` — SQLite schema, repeatable migration, transactions, snapshots
- `src/service.ts` — scan creation, idempotency, revision compare, CSV
- `src/api.ts`, `src/server.ts` — loopback HTTP API
- `src/cli.ts` — CLI
- `src/fixtures.ts` — fictional SC/BCC/FCC/mixed/orthorhombic crystals
- `test/` — automated tests, `scripts/demo.ts` — repeatable E2E demo

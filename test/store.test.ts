import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { ScanService } from "../src/service.ts";
import { validateCell, validateScanParams } from "../src/validate.ts";
import { simpleCubic, FIXTURE_SCAN, bodyCentered } from "../src/fixtures.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function memStore(): Store {
  return Store.open(":memory:");
}

test("invalid cell parameters are rejected", () => {
  const bad = [
    { a: 0, b: 1, c: 1, atoms: [{ label: "Q", x: 0, y: 0, z: 0, occupancy: 1, f: 1 }] },
    { a: 1, b: -1, c: 1, atoms: [{ x: 0, y: 0, z: 0, occupancy: 1, f: 1 }] },
    { a: 1, b: 1, c: NaN, atoms: [{ x: 0, y: 0, z: 0, occupancy: 1, f: 1 }] },
    { a: 1, b: 1, c: 1, atoms: [] },
    { a: 1, b: 1, c: 1, atoms: [{ x: 0, y: 0, z: 0, occupancy: 0, f: 1 }] },
    { a: 1, b: 1, c: 1, atoms: [{ x: 0, y: 0, z: 0, occupancy: 1.5, f: 1 }] },
  ];
  for (const input of bad) assert.throws(() => validateCell(input));
});

test("invalid scan parameters are rejected", () => {
  assert.throws(() => validateScanParams({ wavelength: 0, hMin: 0, hMax: 1, kMin: 0, kMax: 1, lMin: 0, lMax: 1, twoThetaMin: 0, twoThetaMax: 180 }));
  assert.throws(() => validateScanParams({ wavelength: 1, hMin: 2, hMax: 1, kMin: 0, kMax: 1, lMin: 0, lMax: 1, twoThetaMin: 0, twoThetaMax: 180 }));
  assert.throws(() => validateScanParams({ wavelength: 1, hMin: 0, hMax: 1, kMin: 0, kMax: 1, lMin: 0, lMax: 1, twoThetaMin: 200, twoThetaMax: 180 }));
});

test("transaction rolls back every write on failure", () => {
  const store = memStore();
  assert.throws(() =>
    store.transaction(() => {
      store.upsertCell(simpleCubic(), "c1");
      throw new Error("boom");
    }),
  );
  assert.equal(store.getCell("c1"), undefined);
  store.close();
});

test("scan idempotency: identical submissions share one id", () => {
  const store = memStore();
  const fixed = { now: () => new Date("2026-01-01T00:00:00Z") };
  const service = new ScanService(store, fixed);
  store.upsertCell(simpleCubic(), "c1", fixed);
  const a = service.createScan("c1", FIXTURE_SCAN, "key-1");
  const b = service.createScan("c1", FIXTURE_SCAN, "key-1");
  assert.equal(a.id, b.id);
  const other = service.createScan("c1", FIXTURE_SCAN, "key-2");
  assert.notEqual(a.id, other.id);
  store.close();
});

test("scan snapshot freezes the cell even after later revision", () => {
  const store = memStore();
  const service = new ScanService(store);
  store.upsertCell(simpleCubic(), "c1");
  const scan = service.createScan("c1", FIXTURE_SCAN);
  store.upsertCell(bodyCentered(), "c1");
  const stored = store.getScan(scan.id)!;
  assert.equal(stored.cellSnapshot.atoms.length, 1);
  assert.equal(stored.reportVersion, 1);
  store.close();
});

test("data persists across store reopen (restart simulation)", () => {
  const path = ":memory:";
  // In-memory cannot simulate restart; use a temp file inside project.
  const tmp = resolveTestPath();
  const s1 = Store.open(tmp);
  s1.upsertCell(simpleCubic(), "persist-cell");
  s1.close();
  const s2 = Store.open(tmp);
  const rec = s2.requireCell("persist-cell");
  assert.equal(rec.a, 3);
  // migration must be safely repeatable
  s2.migrate();
  s2.close();
});

function resolveTestPath(): string {
  const dir = join(process.cwd(), "data", "test-tmp");
  mkdirSync(dir, { recursive: true });
  return mkdtempSync(join(dir, "db-")) + ".sqlite";
}

test("pagination metadata is correct", () => {
  const store = memStore();
  for (let i = 0; i < 5; i++) store.upsertCell(simpleCubic(), `cell-${i}`);
  const page1 = store.listCells(2, 0);
  assert.equal(page1.rows.length, 2);
  assert.equal(page1.total, 5);
  const page3 = store.listCells(2, 4);
  assert.equal(page3.rows.length, 1);
  store.close();
});

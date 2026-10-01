import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { simpleCubic, bodyCentred, defaultScan } from '../src/fixtures.ts';

const tmpDir = join(process.cwd(), 'data', 'test-db');
const dbPath = join(tmpDir, 'test.db');

function freshStore(clock?: () => Date) {
  rmSync(tmpDir, { recursive: true, force: true });
  return new Store(dbPath, clock);
}

test('createCell rollback leaves no partial rows when an atom is invalid', () => {
  const store = freshStore();
  const before = store.listCells(1, 0).total;
  assert.throws(() => store.createCell(simpleCubic.cell,
    [{ ...simpleCubic.atoms[0], x: 2 }]));
  const after = store.listCells(1, 0).total;
  assert.equal(after, before);
  store.close();
});

test('repeated migration is idempotent', () => {
  const store = freshStore();
  assert.doesNotThrow(() => { store.migrate(); store.migrate(); });
  const v = (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.ok(v >= 1);
  store.close();
});

test('scan with same idempotency key returns the same stored scan', () => {
  const store = freshStore();
  const cell = store.createCell(bodyCentred.cell, bodyCentred.atoms);
  const first = store.runScan(cell.id, defaultScan, 'fixed-key-1');
  const second = store.runScan(cell.id, defaultScan, 'fixed-key-1');
  assert.equal(first.id, second.id);
  assert.deepEqual(first.result.reflections.length, second.result.reflections.length);
  store.close();
});

test('injected clock controls timestamps', () => {
  const fixed = new Date('2030-05-05T05:05:05.000Z');
  const store = freshStore(() => fixed);
  const cell = store.createCell(simpleCubic.cell, simpleCubic.atoms);
  assert.equal(cell.createdAt, fixed.toISOString());
  store.close();
});

test('state persists across a store restart (simulated process restart)', () => {
  let store = freshStore();
  const cell = store.createCell(bodyCentred.cell, bodyCentred.atoms);
  store.runScan(cell.id, defaultScan, 'persist-key');
  store.close();

  store = new Store(dbPath);
  const reloaded = store.getCell(cell.id)!;
  assert.equal(reloaded.atoms.length, 2);
  const scan = store.findScanByRequestId('persist-key')!;
  assert.ok(scan.result.reflections.length > 0);
  assert.equal(scan.params.reportVersion, 1);
  store.close();
});

test('unknown cell scan fails with NOT_FOUND', () => {
  const store = freshStore();
  assert.throws(() => store.runScan(99999, defaultScan), /not found/);
  store.close();
});

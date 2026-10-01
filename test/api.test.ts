import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import type { Server } from 'node:http';
import { bodyCentred } from '../src/fixtures.ts';

const tmpDir = join(process.cwd(), 'data', 'test-api');
const dbPath = join(tmpDir, 'api.db');
let server: Server;
let store: { close: () => void };
let base: string;

before(async () => {
  rmSync(tmpDir, { recursive: true, force: true });
  const started = await startServer(dbPath, tmpDir);
  server = started.server;
  store = started.store;
  base = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  // Destroy keep-alive sockets so the ephemeral loopback server exits promptly.
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  store.close();
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json();
  return { status: res.status, body };
}

test('health endpoint', async () => {
  const { status, body } = await api('/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
});

test('create cell then scan through the HTTP API', async () => {
  const created = await api('/cells', { method: 'POST',
    body: JSON.stringify({ a: 3, b: 3, c: 3, atoms: bodyCentred.atoms }) });
  assert.equal(created.status, 201);
  const cellId = created.body.id;

  const scan = await api(`/cells/${cellId}/scans`, { method: 'POST',
    headers: { 'idempotency-key': 'api-key-1' },
    body: JSON.stringify({
      wavelength: 1.5406, hMin: -2, hMax: 2, kMin: -2, kMax: 2, lMin: -2, lMax: 2,
      twoThetaMin: 0, twoThetaMax: 180, reportVersion: 1,
    }) });
  assert.equal(scan.status, 201);
  const scanId = scan.body.id;

  const repeat = await api(`/cells/${cellId}/scans`, { method: 'POST',
    headers: { 'idempotency-key': 'api-key-1' },
    body: JSON.stringify({ reportVersion: 1 }) });
  assert.equal(repeat.body.id, scanId);

  const explain = await api(`/scans/${scanId}/explain?h=1&k=0&l=0`);
  assert.equal(explain.status, 200);
  assert.equal(explain.body.extinct, true);
});

test('invalid cell returns INVALID_PARAMS', async () => {
  const { status, body } = await api('/cells', { method: 'POST',
    body: JSON.stringify({ a: 0, b: 3, c: 3, atoms: bodyCentred.atoms }) });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_PARAMS');
});

test('invalid JSON returns INVALID_JSON', async () => {
  const res = await fetch(base + '/cells', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'INVALID_JSON');
});

test('unknown routes and ids return NOT_FOUND', async () => {
  assert.equal((await api('/nope')).status, 404);
  const { status, body } = await api('/cells/99999');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('paginated reflection listing keeps finite-box metadata', async () => {
  const created = await api('/cells', { method: 'POST',
    body: JSON.stringify({ a: 3, b: 3, c: 3, atoms: bodyCentred.atoms }) });
  const scan = await api(`/cells/${created.body.id}/scans`, { method: 'POST',
    body: JSON.stringify({ reportVersion: 1,
      hMin: -2, hMax: 2, kMin: -2, kMax: 2, lMin: -2, lMax: 2 }) });
  const page1 = await api(`/scans/${scan.body.id}?limit=5&offset=0&kind=reflections`);
  assert.equal(page1.body.data.length, 5);
  assert.ok(page1.body.page.total > 5);
  assert.equal(page1.body.meta.finiteEnumeration, true);
  assert.deepEqual(page1.body.meta.millerRange.h, [-2, 2]);
});

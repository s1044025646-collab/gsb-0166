import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { Store } from "../src/db.ts";
import { ScanService } from "../src/service.ts";
import { createApp } from "../src/api.ts";
import { simpleCubic, bodyCentered, FIXTURE_SCAN } from "../src/fixtures.ts";

const dir = join(process.cwd(), "data", "test-tmp");
const dbPath = mkdtempSync(join(dir, "api-")) + ".sqlite";
const store = Store.open(dbPath);
const service = new ScanService(store);
const server = createApp({ store, service });

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

after(() => {
  server.close();
  store.close();
});

async function api(path: string, init?: RequestInit & { json?: unknown }): Promise<{
  status: number;
  body: any;
}> {
  const res = await fetch(base + path, {
    method: init?.method ?? (init?.json ? "POST" : "GET"),
    headers: init?.json
      ? { "content-type": "application/json", ...(init.headers as Record<string, string>) }
      : init?.headers,
    body: init?.json ? JSON.stringify(init.json) : init?.body as BodyInit,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("health", async () => {
  const { status, body } = await api("/health");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
});

test("create cell, validation error path, idempotent POST", async () => {
  const bad = await api("/cells", { json: { a: -1, b: 1, c: 1, atoms: [] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "VALIDATION");

  const created = await api("/cells", {
    json: { id: "sc", ...simpleCubic() },
    headers: { "idempotency-key": "k1" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.before, null);
  assert.equal(created.body.after.id, "sc");

  const repeat = await api("/cells", {
    json: { id: "sc", ...simpleCubic() },
    headers: { "idempotency-key": "k1" },
  });
  assert.equal(repeat.status, 200);
  assert.ok(repeat.body.before);
});

test("404 has explicit code", async () => {
  const r = await api("/cells/nope");
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, "NOT_FOUND");
});

test("scan -> paginated reflections -> lines -> csv export", async () => {
  await api("/cells", { json: { id: "bcc", ...bodyCentered() } });
  const scan = await api("/cells/bcc/scans", {
    json: FIXTURE_SCAN,
    headers: { "idempotency-key": "scan-bcc" },
  });
  assert.equal(scan.status, 201);
  assert.equal(scan.body.reportVersion, 1);
  assert.equal(scan.body.finiteEnumeration, true);
  assert.ok(scan.body.enumerationNote.includes("finite truncation"));
  const scanId = scan.body.id;

  const repeated = await api("/cells/bcc/scans", {
    json: FIXTURE_SCAN,
    headers: { "idempotency-key": "scan-bcc" },
  });
  assert.equal(repeated.body.id, scanId);

  const page = await api(`/scans/${scanId}/reflections?limit=10&offset=0`);
  assert.equal(page.status, 200);
  assert.equal(page.body.data.length, 10);
  assert.equal(page.body.page.limit, 10);
  assert.ok(page.body.page.hasMore);
  assert.match(page.body.page.next, /offset=10/);

  const lines = await api(`/scans/${scanId}/lines`);
  const d3 = lines.body.data.find((l: any) => Math.abs(l.dSpacing - 3) < 1e-9);
  // BCC (100) family is retained as a zero-intensity line whose members
  // are all explicitly marked extinct (no hardcoded peak deletion).
  assert.ok(d3);
  assert.ok(d3.integratedIntensity < 1e-20);
  assert.equal(d3.extinctMembers.length, 6);

  const csv = await fetch(base + `/scans/${scanId}/export`);
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  const text = await csv.text();
  assert.match(text, /^two_theta_deg,d_spacing_A/);
});

test("excluded reflections remain queryable with reasons", async () => {
  const created = await api("/cells", { json: { id: "sc2", ...simpleCubic() } });
  assert.ok(created.status === 201 || created.status === 200);
  const scan = await api("/cells/sc2/scans", {
    json: { ...FIXTURE_SCAN, wavelength: 5.0 },
    headers: { "idempotency-key": "longwave" },
  });
  const excluded = await api(`/scans/${scan.body.id}/reflections?included=false&limit=400`);
  const reasons = new Set(excluded.body.data.map((r: any) => r.excludedReason));
  assert.ok(reasons.has("zero_hkl"));
  assert.ok(reasons.has("bragg_unreachable"));
});

test("contributions and extinction diagnostics", async () => {
  const c = await api("/cells/bcc/contributions?h=1&k=0&l=0");
  assert.equal(c.status, 200);
  assert.equal(c.body.contributions.length, 2);
  assert.ok(Math.abs(c.body.dSpacing - 3) < 1e-9);

  const e = await api("/cells/bcc/extinction?h=1&k=0&l=0");
  assert.ok(e.body.extinct);
  assert.match(e.body.summary, /antiphase/);

  const bad = await api("/cells/bcc/extinction?h=x&k=0&l=0");
  assert.equal(bad.status, 400);
});

test("compare endpoint reports occupancy revision intensity deltas", async () => {
  const r = await api("/compare", {
    json: {
      base: bodyCentered(),
      revised: { ...bodyCentered(), atoms: bodyCentered().atoms.map((a) => ({ ...a, occupancy: 0.5 })) },
      scan: FIXTURE_SCAN,
    },
  });
  assert.equal(r.status, 200);
  const surviving = r.body.comparison.find((x: any) => x.h === 2 && !x.k && !x.l);
  assert.ok(surviving.ratio !== null);
  // halving all occupancies quarters every |F|^2
  assert.ok(Math.abs(surviving.ratio - 0.25) < 1e-9);
});

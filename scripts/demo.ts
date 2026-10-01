/**
 * Repeatable end-to-end demonstration, entirely inside ./data/demo.
 * No network materials data, no randomness: IDs are derived from
 * content and the clock is fixed, so reruns are byte-identical.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../src/db.ts";
import { ScanService, exportPeakTable } from "../src/service.ts";
import {
  bodyCentered,
  bodyCenteredMixedFactors,
  faceCentered,
  FIXTURE_SCAN,
  simpleCubic,
} from "../src/fixtures.ts";
import { explainExtinction } from "../src/diffraction.ts";
import { writeFileSync } from "node:fs";

const demoDir = resolve("data/demo");
rmSync(demoDir, { recursive: true, force: true });

const fixedClock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
const dbPath = resolve(demoDir, "demo.sqlite");
const store = Store.open(dbPath);
const service = new ScanService(store, fixedClock);

const fixtures = {
  sc: simpleCubic(),
  bcc: bodyCentered(),
  fcc: faceCentered(),
  bcc_mixed: bodyCenteredMixedFactors(),
} as const;

for (const [id, cell] of Object.entries(fixtures)) {
  store.upsertCell(cell, id, fixedClock);
  const summary = service.createScan(id, FIXTURE_SCAN, `demo-${id}`);
  const lines = service.getLines(summary.id);
  writeFileSync(resolve(demoDir, `${id}_peaks.csv`), exportPeakTable(lines));
  console.log(`${id}: enumerated=${summary.stats.totalEnumerated} included=${summary.stats.included} lines=${lines.length}`);
}

console.log("\n--- natural extinction trace, BCC (100) ---");
console.log(explainExtinction(bodyCentered(), 1, 0, 0).summary);
console.log("\n--- same reflection after changing the centre atom factor ---");
console.log(explainExtinction(bodyCenteredMixedFactors(), 1, 0, 0).summary);

const firstId = service.createScan("bcc", FIXTURE_SCAN, "demo-bcc").id;
const secondId = service.createScan("bcc", FIXTURE_SCAN, "demo-bcc").id;
console.log(`\nidempotent resubmission ids equal: ${firstId === secondId}`);

store.close();
console.log(`\ndemo artifacts in ${demoDir}`);

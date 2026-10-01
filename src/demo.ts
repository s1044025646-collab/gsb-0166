// Repeatable end-to-end demo. Uses a fixed clock and fixed request ids, and
// recreates its own database file inside ./data so reruns are identical.
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './db.ts';
import { simpleCubic, bodyCentred, faceCentred, defaultScan, translated } from './fixtures.ts';

const dir = join(process.cwd(), 'data');
const dbPath = join(dir, 'demo.db');
rmSync(dbPath, { force: true });
mkdirSync(dir, { recursive: true });

const fixedTime = new Date('2026-01-01T00:00:00.000Z');
const store = new Store(dbPath, () => fixedTime);

const report: string[] = [];
const log = (line: string) => { report.push(line); console.log(line); };

log('=== powder diffraction backend demo (kinematic ideal peaks only) ===');
log('NOTE: intensities are |F|^2 from a kinematic point-atom model.');
log('They do NOT include instrument resolution, absorption, or temperature factors.');

const cells = [simpleCubic, bodyCentred, faceCentred].map((fx) =>
  store.createCell(fx.cell, fx.atoms));
cells.forEach((c, i) => log(`created cell ${c.id}: ${[simpleCubic, bodyCentred, faceCentred][i].name}`));

const scan = store.runScan(cells[1].id, defaultScan, 'demo-bcc-v1');
// Repeat submission with the same idempotency key returns the same row.
const scanAgain = store.runScan(cells[1].id, defaultScan, 'demo-bcc-v1');
log(`scan idempotency: ${scan.id === scanAgain.id ? 'OK (same scan row)' : 'FAIL'}`);

const extinct = scan.result.reflections.filter((r) => r.F2 < 1e-9);
log(`BCC scan: enumerated ${scan.result.enumeratedTriples} triples, ` +
  `${scan.result.reflections.length} evaluated, ${extinct.length} of which have |F|^2 < 1e-9`);
log('BCC examples (extinction emerges from structure factor, no hard-coded filter):');
for (const [h, k, l] of [[1, 0, 0], [1, 1, 0], [2, 0, 0], [1, 1, 1]] as Array<[number, number, number]>) {
  const r = scan.result.reflections.find((x) => x.h === h && x.k === k && x.l === l);
  log(`  (${h}${k}${l}) |F|^2 = ${r ? r.F2 : 'excluded'}`);
}

// Translation invariance check.
const fccShifted = translated(faceCentred, 0.25, 0.25, 0.25);
const cShift = store.createCell(fccShifted.cell, fccShifted.atoms);
const s1 = store.runScan(cells[2].id, defaultScan, 'demo-fcc');
const s2 = store.runScan(cShift.id, defaultScan, 'demo-fcc-shifted');
const key = (r: { h: number; k: number; l: number }) => `${r.h},${r.k},${r.l}`;
const m = new Map(s2.result.reflections.map((r) => [key(r), r.F2]));
let invariant = true;
for (const r of s1.result.reflections) if (Math.abs((m.get(key(r)) ?? NaN) - r.F2) > 1e-9) invariant = false;
log(`whole-cell translation invariance: ${invariant ? 'OK' : 'FAIL'}`);

// Powder line conservation: sum of merged lines equals sum of single peaks.
const sumSingles = scan.result.reflections.reduce((s, r) => s + r.F2, 0);
const sumLines = scan.result.lines.reduce((s, l) => s + l.F2, 0);
log(`merged intensity conservation: singles=${sumSingles} lines=${sumLines} ` +
  `${Math.abs(sumSingles - sumLines) < 1e-9 ? 'OK' : 'FAIL'}`);

writeFileSync(join(dir, 'demo-report.txt'), report.join('\n') + '\n');
const csv = ['index,hkl,multiplicity,d,twoTheta,mergedIntensity',
  ...scan.result.lines.map((l, i) =>
    `${i + 1},"${l.hklGroups.map((g) => `(${g.join(' ')})`).join(';')}",${l.multiplicity},${l.d},${l.twoTheta},${l.peakIntensity}`),
].join('\n');
writeFileSync(join(dir, 'demo-peaks.csv'), csv + '\n');
log(`wrote data/demo-report.txt and data/demo-peaks.csv (${scan.result.lines.length} lines)`);
store.close();

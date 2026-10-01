import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from './db.ts';
import { scanReflections, EPS } from './physics.ts';
import { allFixtures, translated, defaultScan } from './fixtures.ts';

// Parsed command-line flags of the form --key value / --flag.
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      const nextIsValue = next !== undefined &&
        (!next.startsWith('-') || /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(next));
      if (!nextIsValue) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

function num(args: Record<string, unknown>, key: string): number {
  const v = Number(args[key]);
  if (!Number.isFinite(v)) throw new Error(`--${key} must be a number`);
  return v;
}

function intArg(args: Record<string, unknown>, key: string, fallback: number): number {
  if (args[key] === undefined) return fallback;
  const v = Number(args[key]);
  if (!Number.isInteger(v)) throw new Error(`--${key} must be an integer`);
  return v;
}

function csv(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return '';
  const header = Object.keys(rows[0]);
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(','), ...rows.map((r) => header.map((h) => esc(r[h])).join(','))].join('\n');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const dbPath = String(args.db ?? join(process.cwd(), 'data', 'app.db'));

  if (command === 'server:start') {
    const infoPath = join(process.cwd(), 'data', 'server.json');
    if (existsSync(infoPath)) {
      const info = JSON.parse(readFileSync(infoPath, 'utf8'));
      console.log(`before: server already recorded pid=${info.pid} port=${info.port}`);
      return;
    }
    const child = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, 'server.ts')], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    // Wait for the project-local pid/port file.
    for (let i = 0; i < 50; i++) {
      if (existsSync(infoPath)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const info = JSON.parse(readFileSync(infoPath, 'utf8'));
    console.log(`after: server started pid=${info.pid} on http://127.0.0.1:${info.port}`);
    return;
  }

  if (command === 'stop' || command === 'server:stop') {
    const infoPath = join(process.cwd(), 'data', 'server.json');
    if (!existsSync(infoPath)) { console.log('before: no project server is running'); return; }
    const info = JSON.parse(readFileSync(infoPath, 'utf8'));
    console.log(`before: stopping project server pid=${info.pid}`);
    try { process.kill(info.pid); } catch (err: any) {
      if (err.code !== 'ESRCH') throw err;
    }
    for (let i = 0; i < 50; i++) {
      try { process.kill(info.pid, 0); } catch { break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    rmSync(infoPath, { force: true });
    console.log(`after: stopped pid=${info.pid} (this project's recorded server only)`);
    return;
  }

  const store = new Store(dbPath);
  try {
    switch (command) {
      case 'cell:create': {
        const before = store.listCells(1, 0).total;
        const name = String(args.fixture ?? 'simpleCubic');
        const fixture0 = allFixtures[name as keyof typeof allFixtures];
        if (!fixture0) throw new Error(`unknown fixture ${name}; choose ${Object.keys(allFixtures).join(',')}`);
        const fixture = args.translate
          ? translated(fixture0, num(args, 'tx'), num(args, 'ty'), num(args, 'tz'))
          : fixture0;
        const scale = args.a ? num(args, 'a') / fixture.cell.a : 1;
        const cell = { a: fixture.cell.a * scale, b: fixture.cell.b * scale, c: fixture.cell.c * scale };
        const created = store.createCell(cell, fixture.atoms);
        const after = store.listCells(1, 0).total;
        console.log(`before: cells=${before}`);
        console.log(`after:  cells=${after} -> created id=${created.id} (${fixture.name}) a=b=c=${cell.a}`);
        break;
      }
      case 'cell:list': {
        const { items, total } = store.listCells(num(args, 'limit') || 50, num(args, 'offset') || 0);
        console.log(`cells total=${total}`);
        for (const c of items) console.log(`  #${c.id} a=${c.a} b=${c.b} c=${c.c} created=${c.created_at}`);
        break;
      }
      case 'scan:run': {
        const cellId = num(args, 'cell');
        const before = store.listScans(cellId, 1, 0).total;
        const scan = store.runScan(cellId, {
          wavelength: args.wavelength ? num(args, 'wavelength') : defaultScan.wavelength,
          hMin: intArg(args, 'hmin', defaultScan.hMin), hMax: intArg(args, 'hmax', defaultScan.hMax),
          kMin: intArg(args, 'kmin', defaultScan.kMin), kMax: intArg(args, 'kmax', defaultScan.kMax),
          lMin: intArg(args, 'lmin', defaultScan.lMin), lMax: intArg(args, 'lmax', defaultScan.lMax),
          twoThetaMin: args.tmin ? num(args, 'tmin') : defaultScan.twoThetaMin,
          twoThetaMax: args.tmax ? num(args, 'tmax') : defaultScan.twoThetaMax,
          reportVersion: args.report ? num(args, 'report') : defaultScan.reportVersion,
        } as any, args['request-id'] ? String(args['request-id']) : undefined);
        const after = store.listScans(cellId, 1, 0).total;
        console.log(`before: scans for cell ${cellId}=${before}`);
        console.log(`after:  scans for cell ${cellId}=${after} -> scan id=${scan.id}`);
        console.log(`enumerated ${scan.result.enumeratedTriples} triples in finite box ` +
          `h[${scan.params.hMin},${scan.params.hMax}] k[${scan.params.kMin},${scan.params.kMax}] l[${scan.params.lMin},${scan.params.lMax}]`);
        console.log(`reflections=${scan.result.reflections.length} excluded=${scan.result.excluded.length} powderLines=${scan.result.lines.length}`);
        break;
      }
      case 'reflection:trace': {
        const scan = store.getScan(num(args, 'scan'));
        if (!scan) throw new Error('scan not found');
        const h = num(args, 'h'), k = num(args, 'k'), l = num(args, 'l');
        const ref = scan.result.reflections.find((r) => r.h === h && r.k === k && r.l === l);
        if (!ref) throw new Error(`reflection ${h}${k}${l} not present (check excluded list)`);
        console.log(`reflection (${h} ${k} ${l}): d=${ref.d} q=1/d=${ref.q} 2theta=${ref.twoTheta}`);
        console.log('atom contributions (phase radians, untruncated):');
        for (const c of ref.contributions) {
          console.log(`  ${c.label.padEnd(4)} f=${c.f} occ=${c.occ} phase=${c.phase} amp=(${c.ampRe}, ${c.ampIm})`);
        }
        console.log(`F=(${ref.FRe}, ${ref.FIm})  |F|^2=${ref.F2}`);
        break;
      }
      case 'extinction:explain': {
        const scan = store.getScan(num(args, 'scan'));
        if (!scan) throw new Error('scan not found');
        const { explainExtinction } = await import('./physics.ts');
        const out = explainExtinction(scan.result, num(args, 'h'), num(args, 'k'), num(args, 'l'));
        console.log(JSON.stringify(out, null, 2));
        break;
      }
      case 'occupancy:compare': {
        const cellId = num(args, 'cell');
        const base = store.getCell(cellId);
        if (!base) throw new Error('cell not found');
        const label = String(args.label);
        const newOcc = num(args, 'occ');
        const scanId = args.scan ? num(args, 'scan') : null;
        const p = scanParamsFrom(store, cellId, scanId);
        const before = scanReflections({ ...p, cell: { a: base.a, b: base.b, c: base.c }, atoms: base.atoms });
        const atoms2 = base.atoms.map((a) => a.label === label ? { ...a, occ: newOcc } : a);
        const after = scanReflections({ ...p, cell: { a: base.a, b: base.b, c: base.c }, atoms: atoms2 });
        console.log(`revision: atom ${label} occupancy -> ${newOcc} (public EPS=${EPS})`);
        const byKey = (r: any) => `${r.h},${r.k},${r.l}`;
        const map = new Map(after.reflections.map((r) => [byKey(r), r]));
        const changes: Array<{ hkl: string; before: number; after: number; delta: number }> = [];
        for (const r0 of before.reflections) {
          const r1 = map.get(byKey(r0));
          if (!r1) continue;
          const delta = r1.F2 - r0.F2;
          if (Math.abs(delta) > EPS) changes.push({ hkl: `(${r0.h} ${r0.k} ${r0.l})`, before: r0.F2, after: r1.F2, delta });
        }
        changes.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
        console.log(`${changes.length} reflections changed; strongest changes (max 12 shown):`);
        for (const ch of changes.slice(0, 12)) {
          console.log(`  ${ch.hkl.padEnd(12)} |F|^2 ${ch.before} -> ${ch.after}  delta=${ch.delta}`);
        }
        const sumBefore = before.reflections.reduce((s, r) => s + r.F2, 0);
        const sumAfter = after.reflections.reduce((s, r) => s + r.F2, 0);
        console.log(`total single-reflection |F|^2: ${sumBefore} -> ${sumAfter}`);
        break;
      }
      case 'peaks:export': {
        const scan = store.getScan(num(args, 'scan'));
        if (!scan) throw new Error('scan not found');
        const rows = scan.result.lines.map((line, idx) => ({
          index: idx + 1,
          hkl: line.hklGroups.map((g) => `(${g.join(' ')})`).join(';'),
          multiplicity: line.multiplicity,
          d: line.d,
          twoTheta: line.twoTheta,
          // Exported peak intensity is the SUM over merged reflections and is
          // not multiplied by multiplicity again.
          mergedIntensity: line.peakIntensity,
        }));
        const text = csv(rows);
        if (args.out) {
          writeFileSync(String(args.out), text + '\n');
          console.log(`wrote ${rows.length} powder lines to ${args.out}`);
        } else {
          console.log(text);
        }
        break;
      }
      default:
        console.log(`usage: cli <command> [flags]
commands:
  cell:create --fixture simpleCubic|bodyCentred|faceCentred|mixedScatter [--a 3] [--translate --tx 0.1 --ty 0 --tz 0]
  cell:list
  scan:run --cell ID [--wavelength 1.5406 --hmin -3 --hmax 3 --tmin 0 --tmax 180 --report 1] [--request-id ID]
  reflection:trace --scan ID --h 1 --k 1 --l 0
  extinction:explain --scan ID --h 1 --k 0 --l 0
  occupancy:compare --cell ID --label M2 --occ 0.5 [--scan ID]
  peaks:export --scan ID [--out path.csv]
  server:start | server:stop`);
    }
  } finally {
    store.close();
  }
}

function scanParamsFrom(store: Store, cellId: number, scanId: number | null) {
  if (scanId !== null) {
    const scan = store.getScan(scanId);
    if (!scan) throw new Error('scan not found');
    return scan.params;
  }
  return { ...defaultScan, cell: undefined as any, atoms: undefined as any };
}

main().catch((err) => {
  console.error(`error [${err.code ?? 'CLI_ERROR'}]: ${err.message}`);
  process.exitCode = 1;
});

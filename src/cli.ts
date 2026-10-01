#!/usr/bin/env node
import { resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Store } from "./db.ts";
import { ScanService, compareRevisions, exportPeakTable } from "./service.ts";
import { validateCell, validateScanParams } from "./validate.ts";
import { AppError } from "./errors.ts";
import { atomContributions, dSpacing, explainExtinction } from "./diffraction.ts";
import { EXTINCTION_REL } from "./constants.ts";

const dataDir = resolve(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.PXRD_DB ?? resolve(dataDir, "pxrd.sqlite");

function usage(): never {
  const text = [
    "pxrd - kinematic powder diffraction CLI (orthorhombic, point atoms)",
    "",
    "Usage:",
    "  pxrd cell create --id ID --file cell.json",
    "  pxrd cell show   ID",
    "  pxrd cell list   [--limit N] [--offset N]",
    "  pxrd scan        --cell ID --file scan.json [--idempotency-key K]",
    "  pxrd scan show   SCAN_ID",
    "  pxrd reflections SCAN_ID [--included true|false] [--limit N]",
    "  pxrd lines       SCAN_ID",
    "  pxrd trace       --cell ID --h H --k K --l L",
    "  pxrd extinction  --cell ID --h H --k K --l L",
    "  pxrd compare     --base cell1.json --revised cell2.json --scan scan.json",
    "  pxrd export      SCAN_ID [-o peaks.csv]",
    "",
    "Near-zero structure factors use relative tolerance " + EXTINCTION_REL.toExponential() + ".",
    "Intensities are kinematic |F|^2 only: no instrument, absorption or Debye-Waller terms.",
  ].join("\n");
  console.error(text);
  process.exit(2);
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("-")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        flags.set(a.replace(/^-+/, ""), "true");
      } else {
        flags.set(a.replace(/^-+/, ""), next);
        i++;
      }
    }
  }
  return flags;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file === "-" ? 0 : file, "utf-8"));
}

function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const positional: string[] = [];
  const flagArgs: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i]!.startsWith("-")) {
      flagArgs.push(args[i]!);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flagArgs.push(next);
        i++;
      }
    } else {
      positional.push(args[i]!);
    }
  }
  const sub = positional[0];
  const rest = positional;
  const flags = parseFlags(flagArgs);
  const store = Store.open(dbPath);
  const service = new ScanService(store);
  try {
    if (cmd === "cell" && sub === "create") {
      const id = flags.get("id");
      const file = flags.get("file");
      if (!id || !file) usage();
      const cell = validateCell(readJson(file));
      heading("BEFORE");
      console.log(store.getCell(id) ? "cell exists (will be updated)" : "no cell with this id");
      const saved = store.upsertCell(cell, id);
      heading("AFTER");
      console.log(JSON.stringify(saved, null, 2));
      return;
    }
    if (cmd === "cell" && sub === "show") {
      console.log(JSON.stringify(store.requireCell(rest[0]!), null, 2));
      return;
    }
    if (cmd === "cell" && sub === "list") {
      const limit = Number(flags.get("limit") ?? 20);
      const offset = Number(flags.get("offset") ?? 0);
      const { rows, total } = store.listCells(limit, offset);
      console.log(`cells ${offset + 1}-${offset + rows.length} of ${total}`);
      for (const r of rows) {
        console.log(`${r.id}  a=${r.a} b=${r.b} c=${r.c}  atoms=${r.atoms.length}  updated=${r.updatedAt}`);
      }
      return;
    }
    if (cmd === "scan" && !sub) {
      const cellId = flags.get("cell");
      const file = flags.get("file");
      if (!cellId || !file) usage();
      store.requireCell(cellId);
      const params = validateScanParams(readJson(file));
      const summary = service.createScan(cellId, params, flags.get("idempotency-key") ?? undefined);
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    if (cmd === "scan" && sub === "show") {
      const scan = store.getScan(rest[0]!);
      if (!scan) throw new AppError("NOT_FOUND", "scan not found");
      console.log(JSON.stringify(service.summarize(scan), null, 2));
      return;
    }
    if (cmd === "reflections") {
      const scan = store.getScan(rest[0]!);
      if (!scan) throw new AppError("NOT_FOUND", "scan not found");
      let rows = JSON.parse(scan.reflectionsJson) as Array<Record<string, unknown>>;
      if (flags.get("included") === "true") rows = rows.filter((r) => r.included);
      if (flags.get("included") === "false") rows = rows.filter((r) => !r.included);
      const limit = Number(flags.get("limit") ?? rows.length);
      for (const r of rows.slice(0, limit)) console.log(JSON.stringify(r));
      console.error(`showed ${Math.min(limit, rows.length)} of ${rows.length}`);
      return;
    }
    if (cmd === "lines") {
      const scan = store.getScan(rest[0]!);
      if (!scan) throw new AppError("NOT_FOUND", "scan not found");
      for (const line of JSON.parse(scan.linesJson) as unknown[]) console.log(JSON.stringify(line));
      return;
    }
    if (cmd === "trace") {
      const id = flags.get("cell");
      const h = Number(flags.get("h"));
      const k = Number(flags.get("k"));
      const l = Number(flags.get("l"));
      if (!id || ![h, k, l].every(Number.isInteger)) usage();
      const rec = store.requireCell(id);
      const cell = { a: rec.a, b: rec.b, c: rec.c, atoms: rec.atoms };
      const result = atomContributions(cell, h, k, l);
      heading(`atom contributions to (${h},${k},${l})`);
      for (const c of result.contributions) console.log(JSON.stringify(c));
      console.log(
        `F = ${result.real.toExponential(12)} ${result.imag >= 0 ? "+" : "-"} ` +
          `${Math.abs(result.imag).toExponential(12)}i  |F|^2 = ${Math.hypot(result.real, result.imag) ** 2}`,
      );
      console.log(`d(${h},${k},${l}) = ${dSpacing(cell, h, k, l)} A (from reciprocal lattice, not atom distances)`);
      return;
    }
    if (cmd === "extinction") {
      const id = flags.get("cell");
      const h = Number(flags.get("h"));
      const k = Number(flags.get("k"));
      const l = Number(flags.get("l"));
      if (!id || ![h, k, l].every(Number.isInteger)) usage();
      const rec = store.requireCell(id);
      const cell = { a: rec.a, b: rec.b, c: rec.c, atoms: rec.atoms };
      console.log(explainExtinction(cell, h, k, l).summary);
      return;
    }
    if (cmd === "compare") {
      const base = validateCell(readJson(flags.get("base")!));
      const revised = validateCell(readJson(flags.get("revised")!));
      const params = validateScanParams(readJson(flags.get("scan")!));
      for (const row of compareRevisions(base, revised, params)) console.log(JSON.stringify(row));
      return;
    }
    if (cmd === "export") {
      const scan = store.getScan(rest[0]!);
      if (!scan) throw new AppError("NOT_FOUND", "scan not found");
      const csv = exportPeakTable(JSON.parse(scan.linesJson));
      const out = flags.get("o");
      if (out) {
        writeFileSync(out, csv);
        console.log(`wrote ${out}`);
      } else {
        process.stdout.write(csv);
      }
      return;
    }
    usage();
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`error [${err.code}]: ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details));
      process.exit(1);
    }
    throw err;
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "./errors.ts";
import { Atom, Cell, ScanParams } from "./model.ts";
import { REPORT_VERSION } from "./constants.ts";

export interface CellRecord {
  id: string;
  a: number;
  b: number;
  c: number;
  atoms: Atom[];
  createdAt: string;
  updatedAt: string;
}

export interface ScanRecord {
  id: string;
  cellId: string;
  createdAt: string;
  reportVersion: number;
  params: ScanParams;
  /** Full cell snapshot at scan time, so revisions never rewrite history. */
  cellSnapshot: Cell;
  reflectionsJson: string;
  linesJson: string;
  stats: {
    totalEnumerated: number;
    included: number;
    excluded: number;
    extinct: number;
    fScale: number;
  };
}

export interface Clock {
  now(): Date;
}

export const defaultClock: Clock = { now: () => new Date() };

/**
 * Idempotent identifier: repeating the same submission (same key bytes)
 * returns the same id, which the API uses for idempotency keys.
 */
export function deriveId(scope: string, keyJson: string): string {
  const h = fnv1a(`${scope}|${keyJson}`);
  return `${scope}_${h.toString(16).padStart(16, "0")}`;
}

function fnv1a(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h;
}

export class Store {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

 static open(filePath: string): Store {
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
    const db = new DatabaseSync(filePath);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    const store = new Store(db);
    store.migrate();
    return store;
  }

  /** Re-runnable migration keyed by PRAGMA user_version. */
  migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version >= 1) return;
    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS cells (
          id TEXT PRIMARY KEY,
          a REAL NOT NULL,
          b REAL NOT NULL,
          c REAL NOT NULL,
          atoms_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scans (
          id TEXT PRIMARY KEY,
          cell_id TEXT NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          report_version INTEGER NOT NULL,
          params_json TEXT NOT NULL,
          cell_snapshot_json TEXT NOT NULL,
          reflections_json TEXT NOT NULL,
          lines_json TEXT NOT NULL,
          stats_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scans_cell ON scans(cell_id, created_at);
      `);
      this.db.exec("PRAGMA user_version = 1");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  upsertCell(cell: Cell, id: string, clock: Clock = defaultClock): CellRecord {
    const existing = this.getCellRaw(id);
    const ts = clock.now().toISOString();
    const createdAt: string = (existing?.created_at as string | undefined) ?? ts;
    this.db
      .prepare(
        `INSERT INTO cells (id, a, b, c, atoms_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           a=excluded.a, b=excluded.b, c=excluded.c,
           atoms_json=excluded.atoms_json, updated_at=excluded.updated_at`,
      )
      .run(id, cell.a, cell.b, cell.c, JSON.stringify(cell.atoms), createdAt, ts);
    return this.getCell(id)!;
  }

  private getCellRaw(id: string) {
    return this.db.prepare("SELECT * FROM cells WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  }
  getCell(id: string): CellRecord | undefined {
    const row = this.getCellRaw(id);
    if (!row) return undefined;
    return {
      id: row.id as string,
      a: row.a as number,
      b: row.b as number,
      c: row.c as number,
      atoms: JSON.parse(row.atoms_json as string) as Atom[],
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  requireCell(id: string): CellRecord {
    const rec = this.getCell(id);
    if (!rec) throw new AppError("NOT_FOUND", `cell ${id} not found`, { id });
    return rec;
  }

  listCells(limit: number, offset: number): { rows: CellRecord[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) n FROM cells").get() as { n: number }).n;
    const rows = this.db
      .prepare("SELECT id FROM cells ORDER BY created_at, id LIMIT ? OFFSET ?")
      .all(limit, offset) as Array<{ id: string }>;
    return { rows: rows.map((r) => this.getCell(r.id)!), total };
  }

  saveScan(rec: Omit<ScanRecord, "reportVersion">): ScanRecord {
    const full: ScanRecord = { ...rec, reportVersion: REPORT_VERSION };
    this.db
      .prepare(
        `INSERT INTO scans
          (id, cell_id, created_at, report_version, params_json,
           cell_snapshot_json, reflections_json, lines_json, stats_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        full.id,
        full.cellId,
        full.createdAt,
        full.reportVersion,
        JSON.stringify(full.params),
        JSON.stringify(full.cellSnapshot),
        full.reflectionsJson,
        full.linesJson,
        JSON.stringify(full.stats),
      );
    return full;
  }

  getScan(id: string): ScanRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM scans WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      cellId: row.cell_id as string,
      createdAt: row.created_at as string,
      reportVersion: row.report_version as number,
      params: JSON.parse(row.params_json as string),
      cellSnapshot: JSON.parse(row.cell_snapshot_json as string),
      reflectionsJson: row.reflections_json as string,
      linesJson: row.lines_json as string,
      stats: JSON.parse(row.stats_json as string),
    };
  }

  listScans(
    cellId: string,
    limit: number,
    offset: number,
  ): { rows: Array<{ id: string; cellId: string; createdAt: string }>; total: number } {
    const total = (
      this.db.prepare("SELECT COUNT(*) n FROM scans WHERE cell_id = ?").get(cellId) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        "SELECT id, cell_id, created_at FROM scans WHERE cell_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?",
      )
      .all(cellId, limit, offset) as Array<{ id: string; cell_id: string; created_at: string }>;
    return {
      rows: rows.map((r) => ({ id: r.id, cellId: r.cell_id, createdAt: r.created_at })),
      total,
    };
  }

  /**
   * Demonstration helper used by tests: every statement runs in one
   * transaction; a thrown error rolls back ALL writes.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

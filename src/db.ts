import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Atom, CellParams, ScanInput, ScanResult } from './physics.ts';
import { validateScan, scanReflections } from './physics.ts';

export interface StoredCell {
  id: number;
  a: number; b: number; c: number;
  atoms: Atom[];
  createdAt: string;
}

export interface StoredScan {
  id: number;
  cellId: number;
  requestId: string | null;
  reportVersion: number;
  params: ScanInput;
  result: ScanResult;
  createdAt: string;
}

// Repeatable migration set. user_version makes order explicit; every
// statement is idempotent so migrations are safe to run on every startup.
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cells (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        a REAL NOT NULL, b REAL NOT NULL, c REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS atoms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cell_id INTEGER NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
        f REAL NOT NULL, occ REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cell_id INTEGER NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
        request_id TEXT UNIQUE,
        report_version INTEGER NOT NULL,
        params_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  },
];

export class Store {
  db: DatabaseSync;
  private clock: () => Date;

  constructor(path: string, clock: () => Date = () => new Date()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.clock = clock;
    this.migrate();
  }

  migrate() {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      MIGRATIONS[v](this.db);
      this.db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  }

  close() { this.db.close(); }

  // Insert a cell and its atoms atomically. Any failure rolls the whole
  // transaction back, leaving no partial cell or atoms behind.
  createCell(cell: CellParams, atoms: Atom[]): StoredCell {
    // Validate physics-side before opening the transaction.
    validateScan({ cell, atoms, wavelength: 1.5406,
      hMin: 0, hMax: 0, kMin: 0, kMax: 0, lMin: 1, lMax: 1,
      twoThetaMin: 0, twoThetaMax: 180, reportVersion: 1 });
    const ts = this.clock().toISOString();
    const tx = this.db.exec.bind(this.db);
    tx('BEGIN');
    try {
      const info = this.db.prepare('INSERT INTO cells(a,b,c,created_at) VALUES(?,?,?,?)')
        .run(cell.a, cell.b, cell.c, ts);
      const id = Number(info.lastInsertRowid);
      const ins = this.db.prepare(
        'INSERT INTO atoms(cell_id,label,x,y,z,f,occ) VALUES(?,?,?,?,?,?,?)');
      for (const at of atoms) ins.run(id, at.label, at.x, at.y, at.z, at.f, at.occ);
      tx('COMMIT');
      return { id, ...cell, atoms, createdAt: ts };
    } catch (err) {
      tx('ROLLBACK');
      throw err;
    }
  }

  getCell(id: number): StoredCell | null {
    const cell = this.db.prepare('SELECT * FROM cells WHERE id=?').get(id) as
      { id: number; a: number; b: number; c: number; created_at: string } | undefined;
    if (!cell) return null;
    const atoms = this.db.prepare('SELECT label,x,y,z,f,occ FROM atoms WHERE cell_id=?')
      .all(id) as Atom[];
    return { id: cell.id, a: cell.a, b: cell.b, c: cell.c, atoms, createdAt: cell.created_at };
  }

  listCells(limit: number, offset: number) {
    const rows = this.db.prepare('SELECT id,a,b,c,created_at FROM cells ORDER BY id LIMIT ? OFFSET ?')
      .all(limit, offset) as Array<{ id: number; a: number; b: number; c: number; created_at: string }>;
    const total = (this.db.prepare('SELECT COUNT(*) n FROM cells').get() as { n: number }).n;
    return { items: rows, total };
  }

  // Idempotent scan: repeating the same requestId returns the stored scan.
  runScan(cellId: number, overrides: Partial<ScanInput>, requestId?: string): StoredScan {
    if (requestId) {
      const existing = this.findScanByRequestId(requestId);
      if (existing) return existing;
    }
    const stored = this.getCell(cellId);
    if (!stored) {
      const err = new Error(`cell ${cellId} not found`) as Error & { code: string };
      err.code = 'NOT_FOUND';
      throw err;
    }
    const params = validateScan({
      cell: { a: stored.a, b: stored.b, c: stored.c },
      atoms: stored.atoms,
      wavelength: overrides.wavelength ?? 1.5406,
      hMin: overrides.hMin ?? -3, hMax: overrides.hMax ?? 3,
      kMin: overrides.kMin ?? -3, kMax: overrides.kMax ?? 3,
      lMin: overrides.lMin ?? -3, lMax: overrides.lMax ?? 3,
      twoThetaMin: overrides.twoThetaMin ?? 0,
      twoThetaMax: overrides.twoThetaMax ?? 180,
      reportVersion: overrides.reportVersion ?? 1,
    });
    const result = scanReflections(params);
    const ts = this.clock().toISOString();
    const info = this.db.prepare(
      'INSERT INTO scans(cell_id,request_id,report_version,params_json,result_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(cellId, requestId ?? null, params.reportVersion,
        JSON.stringify(params), JSON.stringify(result), ts);
    return { id: Number(info.lastInsertRowid), cellId, requestId: requestId ?? null,
      reportVersion: params.reportVersion, params, result, createdAt: ts };
  }

  findScanByRequestId(requestId: string): StoredScan | null {
    const row = this.db.prepare('SELECT * FROM scans WHERE request_id=?').get(requestId) as
      { id: number; cell_id: number; request_id: string | null; report_version: number;
        params_json: string; result_json: string; created_at: string } | undefined;
    if (!row) return null;
    return { id: row.id, cellId: row.cell_id, requestId: row.request_id,
      reportVersion: row.report_version, params: JSON.parse(row.params_json),
      result: JSON.parse(row.result_json), createdAt: row.created_at };
  }

  getScan(id: number): StoredScan | null {
    const row = this.db.prepare('SELECT * FROM scans WHERE id=?').get(id) as
      { id: number; cell_id: number; request_id: string | null; report_version: number;
        params_json: string; result_json: string; created_at: string } | undefined;
    if (!row) return null;
    return { id: row.id, cellId: row.cell_id, requestId: row.request_id,
      reportVersion: row.report_version, params: JSON.parse(row.params_json),
      result: JSON.parse(row.result_json), createdAt: row.created_at };
  }

  listScans(cellId: number | null, limit: number, offset: number) {
    const rows = cellId === null
      ? this.db.prepare('SELECT id,cell_id,report_version,created_at FROM scans ORDER BY id LIMIT ? OFFSET ?').all(limit, offset)
      : this.db.prepare('SELECT id,cell_id,report_version,created_at FROM scans WHERE cell_id=? ORDER BY id LIMIT ? OFFSET ?').all(cellId, limit, offset);
    const total = (cellId === null
      ? this.db.prepare('SELECT COUNT(*) n FROM scans').get()
      : this.db.prepare('SELECT COUNT(*) n FROM scans WHERE cell_id=?').get(cellId)) as { n: number };
    return { items: rows, total: total.n };
  }
}

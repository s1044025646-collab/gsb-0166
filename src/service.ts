import { Cell, PowderLine, Reflection, ScanParams } from "./model.ts";
import { runScan } from "./diffraction.ts";
import { Clock, defaultClock, deriveId, Store } from "./db.ts";
import { REPORT_VERSION } from "./constants.ts";

export interface ScanSummary {
  id: string;
  cellId: string;
  createdAt: string;
  reportVersion: number;
  params: ScanParams;
  cellSnapshot: Cell;
  stats: {
    totalEnumerated: number;
    included: number;
    excluded: number;
    extinct: number;
    fScale: number;
  };
  finiteEnumeration: true;
  enumerationNote: string;
}

const ENUM_NOTE =
  "Reflections are enumerated only inside the configured hkl box; " +
  "the box is a finite truncation and must not be reported as all reflections.";

export class ScanService {
  constructor(
    private store: Store,
    private clock: Clock = defaultClock,
  ) {}

  static toCell(record: { a: number; b: number; c: number; atoms: Cell["atoms"] }): Cell {
    return { a: record.a, b: record.b, c: record.c, atoms: record.atoms };
  }

  /**
   * Create (or return the existing identical repeat of) a scan.
   * idempotencyKey lets a client safely retry a POST.
   */
  createScan(cellId: string, params: ScanParams, idempotencyKey?: string): ScanSummary {
    const cellRecord = this.store.requireCell(cellId);
    const cell = ScanService.toCell(cellRecord);
    const key =
      idempotencyKey ??
      JSON.stringify([cellId, params, cellRecord.updatedAt]);
    const id = deriveId("scan", key);
    const existing = this.store.getScan(id);
    if (existing) return this.summarize(existing);

    const result = runScan(cell, params);
    const saved = this.store.saveScan({
      id,
      cellId,
      createdAt: this.clock.now().toISOString(),
      params,
      cellSnapshot: cell,
      reflectionsJson: JSON.stringify(result.reflections),
      linesJson: JSON.stringify(result.lines),
      stats: {
        totalEnumerated: result.totalEnumerated,
        included: result.reflections.filter((r) => r.included).length,
        excluded: result.reflections.filter((r) => !r.included).length,
        extinct: result.reflections.filter((r) => r.extinct).length,
        fScale: result.fScale,
      },
    });
    return this.summarize(saved);
  }

  getReflections(scanId: string): Reflection[] {
    const scan = this.store.getScan(scanId);
    if (!scan) return [];
    return JSON.parse(scan.reflectionsJson) as Reflection[];
  }

  getLines(scanId: string): PowderLine[] {
    const scan = this.store.getScan(scanId);
    if (!scan) return [];
    return JSON.parse(scan.linesJson) as PowderLine[];
  }

  summarize(scan: NonNullable<ReturnType<Store["getScan"]>>): ScanSummary {
    return {
      id: scan.id,
      cellId: scan.cellId,
      createdAt: scan.createdAt,
      reportVersion: scan.reportVersion,
      params: scan.params,
      cellSnapshot: scan.cellSnapshot,
      stats: scan.stats,
      finiteEnumeration: true,
      enumerationNote: ENUM_NOTE,
    };
  }

 requireScan(scanId: string) {
    const scan = this.store.getScan(scanId);
    if (!scan) throw new Error(`scan ${scanId} not found`);
    return scan;
  }
}

/**
 * Compare two occupancy revisions of the SAME geometry: d/2theta positions
 * do not move, but structure factors and intensities do. Each side is
 * computed independently with its own snapshot.
 */
export function compareRevisions(
  base: Cell,
  revised: Cell,
  params: ScanParams,
): Array<{
  h: number;
  k: number;
  l: number;
  dSpacing: number;
  twoThetaDeg: number | null;
  baseIntensity: number;
  revisedIntensity: number;
  delta: number;
  ratio: number | null;
}> {
  const a = runScan(base, params).reflections;
  const b = runScan(revised, params).reflections;
  const bIndex = new Map(b.map((r) => [`${r.h},${r.k},${r.l}`, r]));
  return a.map((r) => {
    const other = bIndex.get(`${r.h},${r.k},${r.l}`)!;
    const delta = other.intensity - r.intensity;
    return {
      h: r.h, k: r.k, l: r.l,
      dSpacing: r.dSpacing,
      twoThetaDeg: r.twoThetaDeg,
      baseIntensity: r.intensity,
      revisedIntensity: other.intensity,
      delta,
      ratio: r.intensity > 0 ? other.intensity / r.intensity : null,
    };
  });
}

/** Deterministic CSV export of merged powder lines. */
export function exportPeakTable(lines: PowderLine[]): string {
  const header = [
    "two_theta_deg",
    "d_spacing_A",
    "multiplicity",
    "integrated_intensity",
    "mean_single_intensity",
    "representative_hkl",
    "members",
  ];
  const rows = lines.map((line) =>
    [
      line.twoThetaDeg,
      line.dSpacing,
      line.multiplicity,
      line.integratedIntensity,
      line.meanIntensity,
      `${line.representative.h} ${line.representative.k} ${line.representative.l}`,
      "\"" + line.members.map((m) => `${m.h} ${m.k} ${m.l}`).join(";") + "\"",
    ].join(","),
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

export { REPORT_VERSION, ENUM_NOTE };

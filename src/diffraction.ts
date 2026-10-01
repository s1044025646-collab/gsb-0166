import {
  AtomContribution,
  Cell,
  PowderLine,
  Reflection,
  ScanParams,
} from "./model.ts";
import {
  D_MERGE_REL,
  EPS_ABS,
  EXTINCTION_REL,
  SIN_THETA_SLACK,
} from "./constants.ts";

/**
 * Reciprocal-space magnitude for an orthorhombic lattice:
 *   1/d^2 = (h/a)^2 + (k/b)^2 + (l/c)^2
 * This is the ONLY definition of d used anywhere in the project.
 */
export function reciprocalLength(cell: Cell, h: number, k: number, l: number): number {
  return Math.hypot(h / cell.a, k / cell.b, l / cell.c);
}

export function dSpacing(cell: Cell, h: number, k: number, l: number): number {
  return 1 / reciprocalLength(cell, h, k, l);
}

/**
 * Atom-by-atom breakdown of F(hkl) = sum_j occ_j f_j exp[2pi i (h x + k y + l z)].
 * Phases come strictly from fractional coordinates; no geometric distances
 * enter the phase.
 */
export function atomContributions(cell: Cell, h: number, k: number, l: number): {
  real: number;
  imag: number;
  contributions: AtomContribution[];
} {
  let real = 0;
  let imag = 0;
  const contributions: AtomContribution[] = cell.atoms.map((atom) => {
    const phase = 2 * Math.PI * (h * atom.x + k * atom.y + l * atom.z);
    const amp = atom.occupancy * atom.f;
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    real += amp * c;
    imag += amp * s;
    return {
      label: atom.label,
      phase,
      real: amp * c,
      imag: amp * s,
      occupancy: atom.occupancy,
      f: atom.f,
    };
  });
  return { real, imag, contributions };
}

/** Enumerate every integer hkl triplet in the configured box. */
export function enumerateIndices(p: ScanParams): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let h = p.hMin; h <= p.hMax; h++) {
    for (let k = p.kMin; k <= p.kMax; k++) {
      for (let l = p.lMin; l <= p.lMax; l++) {
        out.push([h, k, l]);
      }
    }
  }
  return out;
}

export interface ScanResult {
  reflections: Reflection[];
  lines: PowderLine[];
  /** Largest |F| in the enumerated box, used for the relative extinction test. */
  fScale: number;
  totalEnumerated: number;
}

/**
 * Full kinematic scan. Returns:
 *  - reflections: one entry per enumerated hkl, included or excluded,
 *  - lines: powder lines merged by equal d (multiplicity counted once),
 *  - warnings that the box is a finite truncation, not "all reflections".
 */
export function runScan(cell: Cell, p: ScanParams): ScanResult {
  const triplets = enumerateIndices(p);
  const structure = triplets.map(([h, k, l]) => {
    const { real, imag, contributions } = atomContributions(cell, h, k, l);
    return { h, k, l, real, imag, contributions };
  });
  const fScale = structure.reduce(
    (m, s) => Math.max(m, Math.hypot(s.real, s.imag)),
    0,
  );

  const reflections: Reflection[] = structure.map((s) => {
    const { h, k, l } = s;
    const rl = reciprocalLength(cell, h, k, l);
    const isZero = h === 0 && k === 0 && l === 0;
    const d = isZero ? Infinity : 1 / rl;
    const sinTheta = isZero ? 0 : p.wavelength * rl / 2;
    let twoTheta: number | null = null;
    let included = false;
    let reason: Reflection["excludedReason"] = null;

    if (isZero) {
      reason = "zero_hkl";
    } else if (sinTheta > 1 + SIN_THETA_SLACK) {
      reason = "bragg_unreachable";
    } else {
      const clamped = Math.min(1, Math.max(-1, sinTheta));
      twoTheta = (2 * Math.asin(clamped) * 180) / Math.PI;
      if (twoTheta < p.twoThetaMin - EPS_ABS || twoTheta > p.twoThetaMax + EPS_ABS) {
        reason = "outside_angle_window";
        twoTheta = null;
      } else {
        included = true;
      }
    }

    const magnitude = Math.hypot(s.real, s.imag);
    const threshold = fScale * EXTINCTION_REL + EPS_ABS;
    return {
      h, k, l,
      reciprocalLength: rl,
      dSpacing: d,
      sinTheta: isZero ? 0 : sinTheta,
      twoThetaDeg: twoTheta,
      fReal: s.real,
      fImag: s.imag,
      fMagnitude: magnitude,
      intensity: magnitude * magnitude,
      included,
      excludedReason: reason,
      extinct: !isZero && magnitude <= threshold,
      contributions: s.contributions,
    };
  });

  const lines = mergePowderLines(
    reflections.filter((r) => r.included),
  );
  return { reflections, lines, fScale, totalEnumerated: triplets.length };
}

/**
 * Merge included reflections that share a d-spacing.
 *
 * Sign/multiplicity accounting: every member index is stored explicitly,
 * multiplicity is the COUNT of those members, and integrated intensity is
 * the plain SUM of individual |F|^2. Because each sign/permutation is
 * enumerated exactly once, the sum already carries multiplicity once; we
 * never multiply by multiplicity again afterwards.
 */
export function mergePowderLines(reflections: Reflection[]): PowderLine[] {
  const groups = new Map<number, Reflection[]>();
  for (const r of reflections) {
    const key = findGroupKey(groups, r.dSpacing);
    const list = groups.get(key);
    if (list) {
      list.push(r);
    } else {
      groups.set(r.dSpacing, [r]);
    }
  }
  const lines: PowderLine[] = [];
  for (const [dKey, list] of groups) {
    list.sort((a, b) => cmpHkl(a, b));
    const rep = list[0]!;
    const members = list.map((r) => ({ h: r.h, k: r.k, l: r.l }));
    const integrated = list.reduce((sum, r) => sum + r.intensity, 0);
    lines.push({
      representative: { h: rep.h, k: rep.k, l: rep.l },
      dSpacing: dKey,
      twoThetaDeg: rep.twoThetaDeg!,
      multiplicity: list.length,
      members,
      integratedIntensity: integrated,
      meanIntensity: integrated / list.length,
      extinctMembers: list
        .filter((r) => r.extinct)
        .map((r) => ({ h: r.h, k: r.k, l: r.l })),
    });
  }
  lines.sort((a, b) => a.twoThetaDeg - b.twoThetaDeg || cmpHkl(a.representative, b.representative));
  return lines;
}

function findGroupKey(groups: Map<number, Reflection[]>, d: number): number {
  for (const key of groups.keys()) {
    if (Math.abs(key - d) <= Math.abs(key) * D_MERGE_REL + EPS_ABS) return key;
  }
  return d;
}

function cmpHkl(
  a: { h: number; k: number; l: number },
  b: { h: number; k: number; l: number },
): number {
  return a.h - b.h || a.k - b.k || a.l - b.l;
}

/**
 * Human-readable explanation of why F(hkl) vanishes, derived from the
 * actual complex sum — no hardcoded BCC/FCC rules.
 */
export function explainExtinction(cell: Cell, h: number, k: number, l: number): {
  extinct: boolean;
  fReal: number;
  fImag: number;
  magnitude: number;
  summary: string;
  pairCancellations: Array<{ a: string; b: string; phaseDelta: number }>;
} {
  const { real, imag, contributions } = atomContributions(cell, h, k, l);
  const magnitude = Math.hypot(real, imag);
  const pairCancellations: Array<{ a: string; b: string; phaseDelta: number }> = [];
  for (let i = 0; i < cell.atoms.length; i++) {
    for (let j = i + 1; j < cell.atoms.length; j++) {
      const ai = cell.atoms[i]!;
      const aj = cell.atoms[j]!;
      if (Math.abs(ai.occupancy * ai.f - aj.occupancy * aj.f) <= EPS_ABS) {
        const delta =
          contributions[i]!.phase - contributions[j]!.phase;
        const wrapped = Math.atan2(Math.sin(delta), Math.cos(delta));
        if (Math.abs(Math.abs(wrapped) - Math.PI) <= 1e-9) {
          pairCancellations.push({
            a: ai.label,
            b: aj.label,
            phaseDelta: wrapped,
          });
        }
      }
    }
  }
  const extinct = magnitude <= EPS_ABS * Math.max(1, ...contributions.map((c) => Math.abs(c.f)));
  const parts = contributions
    .map((c) => `${c.label}: amp=${(c.occupancy * c.f).toExponential(6)} phase=${c.phase.toExponential(6)} rad`)
    .join("; ");
  const summary =
    `F(${h},${k},${l}) = ${real.toExponential(6)} ${imag >= 0 ? "+" : "-"} ` +
    `${Math.abs(imag).toExponential(6)}i, |F|=${magnitude.toExponential(6)}. ` +
    (pairCancellations.length
      ? "Equal-amplitude atom pairs are in antiphase (phase delta ~ pi): " +
        pairCancellations.map((p) => `${p.a}<->${p.b}`).join(", ") + ". "
      : "") +
    `Atom terms: ${parts}.`;
  return { extinct, fReal: real, fImag: imag, magnitude, summary, pairCancellations };
}

/** A uniform translation of every fractional coordinate leaves |F|^2 unchanged. */
export function translateCell(cell: Cell, tx: number, ty: number, tz: number): Cell {
  const wrap = (v: number) => ((v % 1) + 1) % 1;
  return {
    ...cell,
    atoms: cell.atoms.map((a) => ({
      ...a,
      x: wrap(a.x + tx),
      y: wrap(a.y + ty),
      z: wrap(a.z + tz),
    })),
  };
}

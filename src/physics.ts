// Pure diffraction physics for an orthorhombic point-atom model with
// wavelength-independent real scattering factors. No I/O here.

// Public tolerance. A value is treated as numeric zero when |v| < EPS.
export const EPS = 1e-9;
// Reflections are excluded when sin(theta) > 1 + EPS (EPS slack for round-off).
export const SIN_TOL = 1 + EPS;

export interface Atom {
  label: string;
  x: number; // fractional coordinate, range [0,1)
  y: number;
  z: number;
  f: number; // real, wavelength-independent scattering factor
  occ: number; // occupancy, 0 < occ <= 1
}

export interface CellParams {
  a: number; // lattice lengths in angstrom
  b: number;
  c: number;
}

export interface ScanInput {
  cell: CellParams;
  atoms: Atom[];
  wavelength: number; // angstrom
  hMin: number; hMax: number;
  kMin: number; kMax: number;
  lMin: number; lMax: number;
  twoThetaMin: number; // inclusive window, degrees
  twoThetaMax: number; // inclusive window, degrees
  reportVersion: number;
}

export interface Reflection {
  h: number; k: number; l: number;
  d: number; // angstrom
  twoTheta: number; // degrees
  q: number; // reciprocal length 1/d
  FRe: number; FIm: number;
  F2: number; // |F|^2 (single-reflection kinematic intensity)
  contributions: AtomContribution[];
}

export interface AtomContribution {
  label: string;
  phase: number; // phase = 2*pi*(h*x + k*y + l*z), radians (unwrapped)
  ampRe: number;
  ampIm: number;
  f: number;
  occ: number;
}

export interface ExcludedReflection {
  h: number; k: number; l: number;
  d: number | null;
  q: number | null;
  reason: 'ZERO_INDEX' | 'WAVELENGTH_NOT_DIFFRACTABLE' | 'OUTSIDE_WINDOW';
  detail: string;
  sinTheta: number | null;
}

export interface PowderLine {
  hklGroups: Array<[number, number, number]>;
  multiplicity: number; // count of merged single reflections
  d: number;
  twoTheta: number;
  F2: number; // SUM of single-reflection |F|^2 (NOT multiplicity times one peak)
  peakIntensity: number; // identical to F2; named to prevent accidental re-scaling
}

export interface ScanResult {
  reflections: Reflection[];
  excluded: ExcludedReflection[];
  lines: PowderLine[];
  enumeratedTriples: number;
  finite: boolean;
}

export class ValidationError extends Error {
  code = 'INVALID_PARAMS';
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

function isFiniteReal(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// Validate and normalize input. Throws ValidationError with a stable code.
export function validateScan(input: Partial<ScanInput>): ScanInput {
  const cell = input.cell as Partial<CellParams> | undefined;
  if (!cell || !isFiniteReal(cell.a) || !isFiniteReal(cell.b) || !isFiniteReal(cell.c)) {
    throw new ValidationError('cell lengths a,b,c must all be finite numbers');
  }
  if (cell.a <= EPS || cell.b <= EPS || cell.c <= EPS) {
    throw new ValidationError('cell lengths a,b,c must be strictly positive (|v| > EPS)');
  }
  if (!Array.isArray(input.atoms) || input.atoms.length === 0) {
    throw new ValidationError('atoms must be a non-empty array');
  }
  const atoms: Atom[] = input.atoms.map((raw, idx) => {
    const a0 = raw as Partial<Atom>;
    if (typeof a0.label !== 'string' || a0.label.length === 0) {
      throw new ValidationError(`atoms[${idx}].label must be a non-empty string`);
    }
    for (const key of ['x', 'y', 'z', 'f', 'occ'] as const) {
      if (!isFiniteReal(a0[key])) throw new ValidationError(`atoms[${idx}].${key} must be finite`);
    }
    const a = a0 as Atom;
    if (a.occ <= 0 || a.occ > 1) {
      throw new ValidationError(`atoms[${idx}].occ must be in (0,1]`);
    }
    for (const key of ['x', 'y', 'z'] as const) {
      if (a[key] < 0 || a[key] >= 1) {
        throw new ValidationError(`atoms[${idx}].${key} fractional coordinate must be in [0,1)`);
      }
    }
    return { ...a };
  });
  if (!isFiniteReal(input.wavelength) || input.wavelength <= EPS) {
    throw new ValidationError('wavelength must be a finite positive number');
  }
  const s = input as ScanInput;
  for (const name of ['hMin', 'hMax', 'kMin', 'kMax', 'lMin', 'lMax', 'twoThetaMin', 'twoThetaMax'] as const) {
    if (!isFiniteReal(s[name])) throw new ValidationError(`${name} must be finite`);
  }
  if (!Number.isInteger(s.hMin) || !Number.isInteger(s.hMax) ||
      !Number.isInteger(s.kMin) || !Number.isInteger(s.kMax) ||
      !Number.isInteger(s.lMin) || !Number.isInteger(s.lMax)) {
    throw new ValidationError('Miller index bounds must be integers');
  }
  if (s.hMin > s.hMax || s.kMin > s.kMax || s.lMin > s.lMax) {
    throw new ValidationError('Miller index minima cannot exceed maxima');
  }
  if (s.twoThetaMin < 0 || s.twoThetaMin > s.twoThetaMax || s.twoThetaMax > 180) {
    throw new ValidationError('require 0 <= twoThetaMin <= twoThetaMax <= 180 (degrees)');
  }
  if (!Number.isInteger(s.reportVersion) || s.reportVersion < 1) {
    throw new ValidationError('reportVersion must be a positive integer');
  }
  return { cell: { a: cell.a!, b: cell.b!, c: cell.c! }, atoms, wavelength: s.wavelength,
    hMin: s.hMin, hMax: s.hMax, kMin: s.kMin, kMax: s.kMax,
    lMin: s.lMin, lMax: s.lMax, twoThetaMin: s.twoThetaMin,
    twoThetaMax: s.twoThetaMax, reportVersion: s.reportVersion };
}

const TWO_PI = 2 * Math.PI;

// d-spacing from reciprocal length for orthorhombic cell:
// 1/d^2 = (h/a)^2 + (k/b)^2 + (l/c)^2
// This is the lattice-plane spacing, never an interatomic distance.
export function dSpacing(cell: CellParams, h: number, k: number, l: number): number {
  const g2 = (h / cell.a) ** 2 + (k / cell.b) ** 2 + (l / cell.c) ** 2;
  return 1 / Math.sqrt(g2);
}

// Complex structure factor; each atom contributes f*occ*exp(i*phase),
// phase = 2*pi*(h*x + k*y + l*z).
export function structureFactor(atoms: Atom[], h: number, k: number, l: number) {
  let re = 0;
  let im = 0;
  const contributions: AtomContribution[] = atoms.map((atom) => {
    const phase = TWO_PI * (h * atom.x + k * atom.y + l * atom.z);
    const weight = atom.f * atom.occ;
    const ampRe = weight * Math.cos(phase);
    const ampIm = weight * Math.sin(phase);
    re += ampRe;
    im += ampIm;
    return { label: atom.label, phase, ampRe, ampIm, f: atom.f, occ: atom.occ };
  });
  return { re, im, f2: re * re + im * im, contributions };
}

// Enumerate all triples inside the Miller box and classify each one.
export function scanReflections(raw: Partial<ScanInput>): ScanResult {
  const input = validateScan(raw);
  const reflections: Reflection[] = [];
  const excluded: ExcludedReflection[] = [];
  let enumeratedTriples = 0;

  for (let h = input.hMin; h <= input.hMax; h++) {
    for (let k = input.kMin; k <= input.kMax; k++) {
      for (let l = input.lMin; l <= input.lMax; l++) {
        enumeratedTriples++;
        if (h === 0 && k === 0 && l === 0) {
          excluded.push({ h, k, l, d: null, q: null, sinTheta: null,
            reason: 'ZERO_INDEX', detail: '(000) is the forward beam, not a reflection' });
          continue;
        }
        const d = dSpacing(input.cell, h, k, l);
        const q = 1 / d;
        const sinTheta = (input.wavelength * q) / 2;
        if (sinTheta > SIN_TOL) {
          excluded.push({ h, k, l, d, q, sinTheta,
            reason: 'WAVELENGTH_NOT_DIFFRACTABLE',
            detail: `lambda/(2d)=${sinTheta} > 1: wavelength ${input.wavelength} cannot diffract from this plane` });
          continue;
        }
        const theta = Math.asin(Math.min(1, Math.max(-1, sinTheta)));
        const twoTheta = (2 * theta * 180) / Math.PI;
        if (twoTheta < input.twoThetaMin - EPS || twoTheta > input.twoThetaMax + EPS) {
          excluded.push({ h, k, l, d, q, sinTheta, reason: 'OUTSIDE_WINDOW',
            detail: `2theta=${twoTheta} outside [${input.twoThetaMin},${input.twoThetaMax}]` });
          continue;
        }
        const sf = structureFactor(input.atoms, h, k, l);
        reflections.push({ h, k, l, d, twoTheta, q,
          FRe: sf.re, FIm: sf.im, F2: sf.f2, contributions: sf.contributions });
      }
    }
  }

  // Merge reflections with equal spacing into powder lines. Multiplicity is
  // the count of merged reflections; intensity is their SUMMED |F|^2. It is
  // deliberately not multiplied by multiplicity a second time.
  reflections.sort((r1, r2) =>
    r1.twoTheta - r2.twoTheta || r1.d - r2.d ||
    r1.h - r2.h || r1.k - r2.k || r1.l - r2.l);
  const lines: PowderLine[] = [];
  for (const r of reflections) {
    const last = lines[lines.length - 1];
    const same = last !== undefined && Math.abs(last.d - r.d) <= EPS * Math.max(1, Math.abs(r.d));
    if (same) {
      last.hklGroups.push([r.h, r.k, r.l]);
      last.multiplicity += 1;
      last.F2 += r.F2;
      last.peakIntensity = last.F2;
    } else {
      lines.push({ hklGroups: [[r.h, r.k, r.l]], multiplicity: 1,
        d: r.d, twoTheta: r.twoTheta, F2: r.F2, peakIntensity: r.F2 });
    }
  }

  return { reflections, excluded, lines, enumeratedTriples, finite: true };
}

// Explain whether a reflection is systematically extinct, using computed F.
export function explainExtinction(result: ScanResult, h: number, k: number, l: number) {
  const ref = result.reflections.find((r) => r.h === h && r.k === k && r.l === l);
  const exc = result.excluded.find((r) => r.h === h && r.k === k && r.l === l);
  if (!ref) {
    return { h, k, l, extinct: null as boolean | null, f2: null as number | null,
      explanation: exc ? `not evaluated: ${exc.reason} - ${exc.detail}` : 'index outside enumerated box' };
  }
  const extinct = ref.F2 < EPS;
  return { h, k, l, extinct, f2: ref.F2, FRe: ref.FRe, FIm: ref.FIm,
    explanation: extinct
      ? 'systematically extinct: atom amplitudes cancel so |F|^2 < EPS (cancellation emerges from fractional coordinates)'
      : `allowed: |F|^2 = ${ref.F2} (untruncated)`,
    contributions: ref.contributions };
}

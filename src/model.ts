export interface Atom {
  /** Arbitrary unique label within one cell, e.g. "A1". */
  label: string;
  /** Fractional coordinates in [0,1). */
 x: number;
  y: number;
  z: number;
  /** Occupancy in (0,1]. */
  occupancy: number;
  /** Constant real scattering factor (point atom, angle independent). */
  f: number;
}

export interface Cell {
  a: number;
  b: number;
  c: number;
  atoms: Atom[];
}

export interface ScanParams {
  /** Incident wavelength in angstrom. */
  wavelength: number;
  hMin: number;
  hMax: number;
  kMin: number;
  kMax: number;
  lMin: number;
  lMax: number;
  /** Inclusive two-theta window in degrees. */
  twoThetaMin: number;
  twoThetaMax: number;
}

export interface AtomContribution {
  label: string;
  /** 2 pi (h x + k y + l z), unrounded radians. */
  phase: number;
  /** cos/sin of the phase. */
  real: number;
  imag: number;
  occupancy: number;
  f: number;
}

export type ExclusionReason =
  | "zero_hkl"
  | "outside_angle_window"
  | "bragg_unreachable";

export interface Reflection {
  h: number;
  k: number;
  l: number;
  /** Reciprocal-space length 1/d, in angstrom^-1. */
  reciprocalLength: number;
  /** Interplanar spacing d in angstrom (NOT an interatomic distance). */
  dSpacing: number;
  /** sin(theta) = lambda / (2d). */
  sinTheta: number;
  /** Bragg two-theta in degrees; null when the reflection is excluded. */
  twoThetaDeg: number | null;
  /** Complex structure factor. */
  fReal: number;
  fImag: number;
  fMagnitude: number;
  /** Kinematic intensity I = |F|^2 (single reflection, no multiplicity). */
  intensity: number;
  included: boolean;
  excludedReason: ExclusionReason | null;
  /** True when the reflection survives but |F| is at the numerical floor. */
  extinct: boolean;
  contributions: AtomContribution[];
}

export interface PowderLine {
  /** Canonical (lowest h, then k, then l) member index label. */
  representative: { h: number; k: number; l: number };
  dSpacing: number;
  twoThetaDeg: number;
  /** Number of symmetry-distinct hkl permutations sharing this d. */
  multiplicity: number;
  /** Every member Miller index, signs shown explicitly. */
  members: Array<{ h: number; k: number; l: number }>;
  /** Sum of the single-reflection |F|^2 values; multiplicity applied once. */
  integratedIntensity: number;
  /** Average single-reflection |F|^2 over the members. */
  meanIntensity: number;
  /** Members whose structure factor vanished (systematic extinction). */
  extinctMembers: Array<{ h: number; k: number; l: number }>;
}

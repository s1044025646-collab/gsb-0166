import { Cell, ScanParams } from "./model.ts";

/**
 * Purely fictional pedagogical crystals (no real material data).
 * All edge lengths are in angstrom; scattering factors are arbitrary
 * real constants for the point-atom model.
 */

const L = 3.0;

/** One atom at the origin: primitive/simple cubic behaviour. */
export function simpleCubic(): Cell {
  return {
    a: L, b: L, c: L,
    atoms: [{ label: "Q", x: 0, y: 0, z: 0, occupancy: 1, f: 6 }],
  };
}

/** Same factor on corner + body centre: I-centred extinctions must emerge. */
export function bodyCentered(): Cell {
  return {
    a: L, b: L, c: L,
    atoms: [
      { label: "Q", x: 0, y: 0, z: 0, occupancy: 1, f: 6 },
      { label: "Qc", x: 0.5, y: 0.5, z: 0.5, occupancy: 1, f: 6 },
    ],
  };
}

/** Same factor on corners + all face centres: F-centred extinctions emerge. */
export function faceCentered(): Cell {
  return {
    a: L, b: L, c: L,
    atoms: [
      { label: "Q", x: 0, y: 0, z: 0, occupancy: 1, f: 6 },
      { label: "Fx", x: 0, y: 0.5, z: 0.5, occupancy: 1, f: 6 },
      { label: "Fy", x: 0.5, y: 0, z: 0.5, occupancy: 1, f: 6 },
      { label: "Fz", x: 0.5, y: 0.5, z: 0, occupancy: 1, f: 6 },
    ],
  };
}

/**
 * Corner vs centre atoms with DIFFERENT scattering factors:
 * the bcc rule is broken, formerly extinct odd-sum reflections reappear.
 */
export function bodyCenteredMixedFactors(): Cell {
  const cell = bodyCentered();
  cell.atoms[1]!.f = 2;
  cell.atoms[1]!.label = "Rc";
  return cell;
}

/** BCC lattice translated by an arbitrary non-lattice vector; |F|^2 invariant. */
export function bodyCenteredTranslated(tx = 0.137, ty = 0.271, tz = 0.089): Cell {
  return {
    a: L, b: L, c: L,
    atoms: [
      { label: "Q", x: tx % 1, y: ty % 1, z: tz % 1, occupancy: 1, f: 6 },
      { label: "Qc", x: (tx + 0.5) % 1, y: (ty + 0.5) % 1, z: (tz + 0.5) % 1, occupancy: 1, f: 6 },
    ],
  };
}

/** Non-cubic orthorhombic cell so a != b != c d-spacings stay distinct. */
export function orthorhombicMixed(): Cell {
  return {
    a: 3.0, b: 4.0, c: 5.0,
    atoms: [
      { label: "Q", x: 0, y: 0, z: 0, occupancy: 1, f: 6 },
      { label: "R", x: 0.2, y: 0.35, z: 0.7, occupancy: 0.75, f: -3 },
    ],
  };
}

export const FIXTURE_SCAN: ScanParams = {
  wavelength: 1.5406,
  hMin: -3, hMax: 3,
  kMin: -3, kMax: 3,
  lMin: -3, lMax: 3,
  twoThetaMin: 0,
  twoThetaMax: 180,
};

/** Window with an exact boundary reflection for edge-case tests. */
export function windowAround(twoTheta: number, halfWidthDeg = 0.0): ScanParams {
  return {
    wavelength: 1.5406,
    hMin: -3, hMax: 3,
    kMin: -3, kMax: 3,
    lMin: -3, lMax: 3,
    twoThetaMin: twoTheta - halfWidthDeg,
    twoThetaMax: twoTheta + halfWidthDeg,
  };
}

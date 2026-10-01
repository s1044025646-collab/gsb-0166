import { Atom, Cell, ScanParams } from "./model.ts";
import { validationError } from "./errors.ts";

const MAX_DIM = 1e6;
const MAX_INDEX = 50;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Orthorhombic cells only: three independent positive edge lengths,
 * all angles fixed at 90 deg. Non-positive, non-finite or absurd values
 * are rejected with field-level details.
 */
export function validateCell(input: unknown): Cell {
  if (typeof input !== "object" || input === null) {
    throw validationError("cell must be an object");
  }
  const obj = input as Record<string, unknown>;
  for (const edge of ["a", "b", "c"] as const) {
    const v = obj[edge];
    if (!isFiniteNumber(v) || v <= 0) {
      throw validationError(`${edge} must be a positive finite number`, {
        field: edge,
        received: v,
      });
    }
    if (v > MAX_DIM) {
      throw validationError(`${edge} exceeds supported limit ${MAX_DIM} A`, {
        field: edge,
      });
    }
  }
  if (!Array.isArray(obj.atoms) || obj.atoms.length === 0) {
    throw validationError("atoms must be a non-empty array");
  }
  const labels = new Set<string>();
  const atoms: Atom[] = obj.atoms.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw validationError(`atoms[${i}] must be an object`);
    }
    const a = raw as Record<string, unknown>;
    const label = typeof a.label === "string" && a.label.trim() ? a.label : `atom${i + 1}`;
    if (labels.has(label)) {
      throw validationError("duplicate atom label", { field: "label", label });
    }
    labels.add(label);
    for (const key of ["x", "y", "z", "occupancy", "f"] as const) {
      if (!isFiniteNumber(a[key])) {
        throw validationError(`atoms[${i}].${key} must be a finite number`, {
          field: `atoms[${i}].${key}`,
          received: a[key],
        });
      }
    }
    const occ = a.occupancy as number;
    if (occ <= 0 || occ > 1) {
      throw validationError(`atoms[${i}].occupancy must be in (0,1]`, {
        field: `atoms[${i}].occupancy`,
      });
    }
    // f may be negative (neutron-style contrast) but never NaN; zero is
    // pointless yet legal.
    const atom: Atom = {
      label,
      x: (a.x as number) % 1,
      y: (a.y as number) % 1,
      z: (a.z as number) % 1,
      occupancy: occ,
      f: a.f as number,
    };
    for (const axis of ["x", "y", "z"] as const) {
      if (atom[axis] < 0) atom[axis] += 1;
    }
    return atom;
  });
  return { a: obj.a as number, b: obj.b as number, c: obj.c as number, atoms };
}

function intInRange(v: unknown, field: string): number {
  if (!isFiniteNumber(v) || !Number.isInteger(v)) {
    throw validationError(`${field} must be an integer`, { field, received: v });
  }
  if (Math.abs(v) > MAX_INDEX) {
    throw validationError(`${field} must be within +/-${MAX_INDEX}`, { field });
  }
  return v;
}

export function validateScanParams(input: unknown): ScanParams {
  if (typeof input !== "object" || input === null) {
    throw validationError("scan parameters must be an object");
  }
  const p = input as Record<string, unknown>;
  if (!isFiniteNumber(p.wavelength) || p.wavelength <= 0) {
    throw validationError("wavelength must be a positive finite number", {
      field: "wavelength",
    });
  }
  const bounds: Array<[keyof ScanParams, keyof ScanParams]> = [
    ["hMin", "hMax"],
    ["kMin", "kMax"],
    ["lMin", "lMax"],
  ];
  const out: Record<string, number> = {};
  for (const [lo, hi] of bounds) {
    out[lo] = intInRange(p[lo], lo);
    out[hi] = intInRange(p[hi], hi);
    if (out[lo]! > out[hi]!) {
      throw validationError(`${lo} must be <= ${hi}`);
    }
  }
  for (const key of ["twoThetaMin", "twoThetaMax"] as const) {
    if (!isFiniteNumber(p[key])) {
      throw validationError(`${key} must be a finite number of degrees`, {
        field: key,
      });
    }
  }
  if ((p.twoThetaMin as number) < 0 || (p.twoThetaMax as number) > 180) {
    throw validationError("two-theta window must lie within [0,180] degrees");
  }
  if ((p.twoThetaMin as number) > (p.twoThetaMax as number)) {
    throw validationError("twoThetaMin must be <= twoThetaMax");
  }
  return {
    wavelength: p.wavelength as number,
    hMin: out.hMin!, hMax: out.hMax!,
    kMin: out.kMin!, kMax: out.kMax!,
    lMin: out.lMin!, lMax: out.lMax!,
    twoThetaMin: p.twoThetaMin as number,
    twoThetaMax: p.twoThetaMax as number,
  };
}

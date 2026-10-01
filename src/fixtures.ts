import type { Atom, CellParams, ScanInput } from './physics.ts';

// Fictional crystals used for deterministic demos and tests. All names are
// invented; they do not refer to any real material database entry.

const cube = (a: number): CellParams => ({ a, b: a, c: a });

export interface Fixture {
  name: string;
  description: string;
  cell: CellParams;
  atoms: Atom[];
}

// Primitive/simple cubic: a single atom at the origin (simple cubic rules
// must emerge from this one basis atom, not from a filter).
export const simpleCubic: Fixture = {
  name: 'fictional-sc-monium',
  description: 'fictional simple-cubic monoatomic crystal, a=3 A, f=6',
  cell: cube(3),
  atoms: [{ label: 'M', x: 0, y: 0, z: 0, f: 6, occ: 1 }],
};

// Body-centred: corner + (1/2,1/2,1/2). h+k+l odd cancellation is emergent.
export const bodyCentred: Fixture = {
  name: 'fictional-bcc-ite',
  description: 'fictional body-centred cubic crystal, a=3 A, equal f=6',
  cell: cube(3),
  atoms: [
    { label: 'M1', x: 0, y: 0, z: 0, f: 6, occ: 1 },
    { label: 'M2', x: 0.5, y: 0.5, z: 0.5, f: 6, occ: 1 },
  ],
};

// Face-centred: corner plus three face centres. Mixed-index extinction is
// emergent from the fractional coordinates.
export const faceCentred: Fixture = {
  name: 'fictional-fcc-ane',
  description: 'fictional face-centred cubic crystal, a=3 A, equal f=6',
  cell: cube(3),
  atoms: [
    { label: 'M1', x: 0, y: 0, z: 0, f: 6, occ: 1 },
    { label: 'M2', x: 0.5, y: 0.5, z: 0, f: 6, occ: 1 },
    { label: 'M3', x: 0.5, y: 0, z: 0.5, f: 6, occ: 1 },
    { label: 'M4', x: 0, y: 0.5, z: 0.5, f: 6, occ: 1 },
  ],
};

// Same basis as BCC but the centred atom has a different scattering factor.
export const mixedScatter: Fixture = {
  name: 'fictional-mixed-oid',
  description: 'fictional bcc-like crystal whose centre atom has a different f',
  cell: cube(3),
  atoms: [
    { label: 'A', x: 0, y: 0, z: 0, f: 6, occ: 1 },
    { label: 'B', x: 0.5, y: 0.5, z: 0.5, f: 3, occ: 1 },
  ],
};

// Whole-cell fractional translation applied to the FCC basis. A pure lattice
// translation must not change any |F|^2.
export function translated(fixture: Fixture, tx: number, ty: number, tz: number): Fixture {
  return {
    name: `${fixture.name}-translated`,
    description: `${fixture.description}; translated by (${tx},${ty},${tz})`,
    cell: fixture.cell,
    atoms: fixture.atoms.map((a) => ({
      ...a,
      x: ((a.x + tx) % 1 + 1) % 1,
      y: ((a.y + ty) % 1 + 1) % 1,
      z: ((a.z + tz) % 1 + 1) % 1,
    })),
  };
}

// Default scan window used by the demo and CLI unless overridden.
export const defaultScan: Omit<ScanInput, 'cell' | 'atoms'> = {
  wavelength: 1.5406,
  hMin: -3, hMax: 3, kMin: -3, kMax: 3, lMin: -3, lMax: 3,
  twoThetaMin: 0, twoThetaMax: 180,
  reportVersion: 1,
};

export const allFixtures = { simpleCubic, bodyCentred, faceCentred, mixedScatter };

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EPS, dSpacing, scanReflections, structureFactor, validateScan,
} from '../src/physics.ts';
import {
  simpleCubic, bodyCentred, faceCentred, mixedScatter, translated, defaultScan,
} from '../src/fixtures.ts';

const box = defaultScan;

test('hand-checked reciprocal length and d-spacing for cubic a=3', () => {
  const d100 = dSpacing(simpleCubic.cell, 1, 0, 0);
  assert.ok(Math.abs(d100 - 3) < 1e-12);
  const d110 = dSpacing(simpleCubic.cell, 1, 1, 0);
  assert.ok(Math.abs(d110 - 3 / Math.sqrt(2)) < 1e-12);
  const d111 = dSpacing(simpleCubic.cell, 1, 1, 1);
  assert.ok(Math.abs(d111 - 3 / Math.sqrt(3)) < 1e-12);
});

test('hand-checked low-index structure factors for monoatomic SC', () => {
  // Single atom f=6 at origin => F=6 for every reflection, |F|^2=36.
  for (const hkl of [[1, 0, 0], [1, 1, 0], [2, 1, 0], [1, 1, 1]] as Array<[number, number, number]>) {
    const sf = structureFactor(simpleCubic.atoms, ...hkl);
    assert.ok(Math.abs(sf.f2 - 36) < 1e-12);
  }
});

test('hand-checked Bragg 2theta for (100) at Cu K-alpha', () => {
  const result = scanReflections({ ...box, ...simpleCubic });
  const r100 = result.reflections.find((r) => r.h === 1 && r.k === 0 && r.l === 0)!;
  const expected = 2 * Math.asin(1.5406 / (2 * 3)) * 180 / Math.PI;
  assert.ok(Math.abs(r100.twoTheta - expected) < 1e-9);
});

test('BCC systematic extinction h+k+l odd emerges from structure factor', () => {
  const result = scanReflections({ ...box, ...bodyCentred });
  const find = (h: number, k: number, l: number) =>
    result.reflections.find((r) => r.h === h && r.k === k && r.l === l)!;
  assert.ok(find(1, 0, 0).F2 < EPS);   // sum 1 odd  -> extinct
  assert.ok(find(1, 1, 1).F2 < EPS);   // sum 3 odd  -> extinct
  assert.ok(Math.abs(find(1, 1, 0).F2 - 144) < EPS); // sum 2 even -> F=12
  assert.ok(Math.abs(find(2, 0, 0).F2 - 144) < EPS); // sum 2 even -> F=12
});

test('FCC extinction (mixed parity) emerges from structure factor', () => {
  const result = scanReflections({ ...box, ...faceCentred });
  const find = (h: number, k: number, l: number) =>
    result.reflections.find((r) => r.h === h && r.k === k && r.l === l)!;
  assert.ok(find(1, 0, 0).F2 < EPS);  // mixed parity -> extinct
  assert.ok(find(1, 1, 0).F2 < EPS);  // mixed parity -> extinct
  assert.ok(Math.abs(find(1, 1, 1).F2 - 576) < EPS); // all odd  -> F=24
  assert.ok(Math.abs(find(2, 0, 0).F2 - 576) < EPS); // all even -> F=24
});

test('different scattering factors break exact BCC cancellation', () => {
  const equal = scanReflections({ ...box, ...bodyCentred });
  const mixed = scanReflections({ ...box, ...mixedScatter });
  const e = equal.reflections.find((r) => r.h === 1 && r.k === 0 && r.l === 0)!;
  const m = mixed.reflections.find((r) => r.h === 1 && r.k === 0 && r.l === 0)!;
  assert.ok(e.F2 < EPS);
  // F = 6 + 3*exp(i pi) = 6 - 3 = 3 -> |F|^2 = 9
  assert.ok(Math.abs(m.F2 - 9) < EPS);
});

test('phase comes from fractional coordinates', () => {
  const sf = structureFactor(bodyCentred.atoms, 1, 0, 0);
  const corner = sf.contributions[0];
  const centre = sf.contributions[1];
  assert.ok(Math.abs(corner.phase) < EPS);
  assert.ok(Math.abs(centre.phase - Math.PI) < EPS); // 2*pi*(0.5)
});

test('whole-cell fractional translation leaves |F|^2 invariant', () => {
  const base = scanReflections({ ...box, ...faceCentred });
  const shifted = scanReflections({ ...box, ...translated(faceCentred, 0.25, 0.25, 0.25) });
  const key = (r: { h: number; k: number; l: number }) => `${r.h},${r.k},${r.l}`;
  const map = new Map(shifted.reflections.map((r) => [key(r), r.F2]));
  for (const r of base.reflections) {
    assert.ok(Math.abs((map.get(key(r)) ?? NaN) - r.F2) < 1e-9, `moved ${key(r)}`);
  }
});

test('Friedel symmetry F(-h,-k,-l)=conj(F(h,k,l))', () => {
  const result = scanReflections({ ...box, ...mixedScatter });
  for (const r of result.reflections) {
    const twin = result.reflections.find((x) =>
      x.h === -r.h && x.k === -r.k && x.l === -r.l);
    if (!twin) continue;
    assert.ok(Math.abs(twin.FRe - r.FRe) < 1e-9);
    assert.ok(Math.abs(twin.FIm + r.FIm) < 1e-9);
    assert.ok(Math.abs(twin.F2 - r.F2) < 1e-9);
  }
});

test('merged powder lines conserve total intensity and count multiplicity once', () => {
  const result = scanReflections({ ...box, ...simpleCubic });
  const sumSingles = result.reflections.reduce((s, r) => s + r.F2, 0);
  const sumLines = result.lines.reduce((s, l) => s + l.F2, 0);
  assert.ok(Math.abs(sumSingles - sumLines) < 1e-9);
  const totalMultiplicity = result.lines.reduce((s, l) => s + l.multiplicity, 0);
  assert.equal(totalMultiplicity, result.reflections.length);
  // The (100)/(010)/(001) family in cubic SC merges six sign/permutation mates.
  const line100 = result.lines.find((l) =>
    l.hklGroups.some(([h, k, l2]) => h === 1 && k === 0 && l2 === 0))!;
  assert.equal(line100.multiplicity, 6);
  assert.ok(Math.abs(line100.F2 - 6 * 36) < EPS);
});

test('zero index is excluded with a stated reason', () => {
  const result = scanReflections({ ...box, ...simpleCubic });
  const zero = result.excluded.find((e) => e.h === 0 && e.k === 0 && e.l === 0)!;
  assert.equal(zero.reason, 'ZERO_INDEX');
});

test('wavelength too long is excluded with a stated reason', () => {
  const result = scanReflections({
    ...box, ...simpleCubic, wavelength: 100,
    hMin: 1, hMax: 1, kMin: 0, kMax: 0, lMin: 0, lMax: 0,
  });
  assert.equal(result.reflections.length, 0);
  assert.equal(result.excluded[0].reason, 'WAVELENGTH_NOT_DIFFRACTABLE');
});

test('window boundaries are inclusive and out-of-window reflections recorded', () => {
  // (100) expected 2theta = 29.756587... deg at 1.5406 A.
  const narrow = scanReflections({
    ...box, ...simpleCubic,
    hMin: 1, hMax: 1, kMin: 0, kMax: 0, lMin: 0, lMax: 0,
    twoThetaMin: 30, twoThetaMax: 180,
  });
  assert.ok(narrow.excluded.some((e) => e.reason === 'OUTSIDE_WINDOW'));
  const included = scanReflections({
    ...box, ...simpleCubic,
    hMin: 1, hMax: 1, kMin: 0, kMax: 0, lMin: 0, lMax: 0,
    twoThetaMin: 29.75, twoThetaMax: 180,
  });
  assert.equal(included.reflections.length, 1);
});

test('illegal cell parameters and bad ranges are rejected', () => {
  assert.throws(() => validateScan({ ...box, ...simpleCubic, cell: { a: 0, b: 3, c: 3 } }),
    /strictly positive/);
  assert.throws(() => validateScan({ ...box, ...simpleCubic, cell: { a: -1, b: 3, c: 3 } }));
  assert.throws(() => validateScan({ ...box, ...simpleCubic, wavelength: 0 }));
  assert.throws(() => validateScan({ ...box, ...simpleCubic, atoms: [] }));
  assert.throws(() => validateScan({ ...box, ...simpleCubic, hMin: 2, hMax: 1 }));
  assert.throws(() => validateScan({ ...box, ...simpleCubic,
    atoms: [{ ...simpleCubic.atoms[0], occ: 2 }] }));
});

test('enumeration is finite and reports the box, not all reflections', () => {
  const result = scanReflections({
    ...box, ...simpleCubic, hMin: -1, hMax: 1, kMin: 0, kMax: 0, lMin: 0, lMax: 0,
  });
  assert.equal(result.enumeratedTriples, 3);
  assert.equal(result.finite, true);
});

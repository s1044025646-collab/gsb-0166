import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atomContributions,
  dSpacing,
  explainExtinction,
  mergePowderLines,
  reciprocalLength,
  runScan,
  translateCell,
} from "../src/diffraction.ts";
import {
  bodyCentered,
  bodyCenteredMixedFactors,
  bodyCenteredTranslated,
  faceCentered,
  FIXTURE_SCAN,
  orthorhombicMixed,
  simpleCubic,
  windowAround,
} from "../src/fixtures.ts";

const approx = (actual: number, expected: number, relTol = 1e-9) => {
  const tol = Math.abs(expected) * relTol + 1e-12;
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${expected}, got ${actual} (tol ${tol})`,
  );
};

test("reciprocal length and d-spacing match hand calculation for cubic (111)", () => {
  const cell = simpleCubic();
  // 1/d^2 = 3 / 9 -> d = sqrt(3) ~= 1.7320508076
  approx(reciprocalLength(cell, 1, 1, 1), Math.sqrt(3) / 3);
  approx(dSpacing(cell, 1, 1, 1), Math.sqrt(3));
});

test("orthorhombic d uses independent a,b,c", () => {
  const cell = orthorhombicMixed();
  const expected = 1 / Math.hypot(1 / 3, 1 / 4, 1 / 5);
  approx(dSpacing(cell, 1, 1, 1), expected);
});

test("single atom at origin: F = f for every reflection, I = f^2", () => {
  const cell = simpleCubic();
  const { real, imag } = atomContributions(cell, 2, -1, 3);
  approx(real, 6);
  approx(imag, 0);
  const scan = runScan(cell, FIXTURE_SCAN);
  const r = scan.reflections.find((x) => x.h === 1 && x.k === 0 && x.l === 0)!;
  approx(r.intensity, 36);
});

test("BCC odd h+k+l reflections vanish from the complex sum, not a rule table", () => {
  const cell = bodyCentered();
  for (const [h, k, l] of [[1, 0, 0], [1, 1, 1], [2, 1, 0]] as const) {
    const e = explainExtinction(cell, h, k, l);
    assert.ok(e.extinct, `(${h}${k}${l}) should be extinct`);
    approx(e.magnitude, 0);
  }
  for (const [h, k, l] of [[2, 0, 0], [2, 2, 0], [1, 1, 0]] as const) {
    const e = explainExtinction(cell, h, k, l);
    assert.ok(!e.extinct, `(${h}${k}${l}) should survive`);
    approx(e.magnitude, 12);
  }
});

test("FCC mixed/even parity emerges naturally", () => {
  const cell = faceCentered();
  for (const [h, k, l] of [[1, 0, 0], [2, 1, 0], [1, 1, 0]] as const) {
    const e = explainExtinction(cell, h, k, l);
    assert.ok(e.extinct, `(${h}${k}${l}) should be extinct`);
    approx(e.magnitude, 0);
  }
  for (const [h, k, l, f] of [[1, 1, 1, 24], [2, 0, 0, 24], [2, 2, 0, 24]] as const) {
    const e = explainExtinction(cell, h, k, l);
    assert.ok(!e.extinct);
    approx(e.magnitude, f);
  }
});

test("different scattering factors break the centring extinction", () => {
  const mixed = bodyCenteredMixedFactors();
  const e = explainExtinction(mixed, 1, 0, 0);
  assert.ok(!e.extinct);
  approx(e.magnitude, Math.abs(6 - 2));
});

test("uniform cell translation preserves |F|^2 but rotates F's phase", () => {
  const original = bodyCentered();
  const moved = bodyCenteredTranslated();
  for (const [h, k, l] of [[1, 1, 0], [2, 1, 1], [3, 2, -1]] as const) {
    const a = atomContributions(original, h, k, l);
    const b = atomContributions(moved, h, k, l);
    const ia = Math.hypot(a.real, a.imag) ** 2;
    const ib = Math.hypot(b.real, b.imag) ** 2;
    approx(ib, ia);
  }
  // Full fractional-coordinate translation helper keeps it invariant too.
  const translated = translateCell(orthorhombicMixed(), 0.31, 0.17, 0.63);
  const sa = runScan(orthorhombicMixed(), FIXTURE_SCAN);
  const sb = runScan(translated, FIXTURE_SCAN);
  for (let i = 0; i < sa.reflections.length; i++) {
    approx(sb.reflections[i]!.intensity, sa.reflections[i]!.intensity);
  }
});

test("Friedel symmetry: F(-h,-k,-l) is the complex conjugate, equal |F|^2", () => {
  const cell = orthorhombicMixed();
  const scan = runScan(cell, FIXTURE_SCAN);
  const index = new Map(scan.reflections.map((r) => [`${r.h},${r.k},${r.l}`, r]));
  for (const [h, k, l] of [[1, 2, 3], [2, -1, 0], [3, 3, 3]] as const) {
    const p = index.get(`${h},${k},${l}`)!;
    const n = index.get(`${-h},${-k},${-l}`)!;
    approx(n.fReal, p.fReal);
    approx(n.fImag, -p.fImag);
    approx(n.intensity, p.intensity);
  }
});

test("merged powder lines conserve total single-reflection intensity", () => {
  const cell = simpleCubic();
  const scan = runScan(cell, FIXTURE_SCAN);
  const included = scan.reflections.filter((r) => r.included);
  const singleSum = included.reduce((s, r) => s + r.intensity, 0);
  // Merge the included set by hand and demand equality, line by line.
  const lines = mergePowderLines(included);
  const mergedSum = lines.reduce((s, l) => s + l.integratedIntensity, 0);
  approx(mergedSum, singleSum);
  // multiplicity equals the enumerated member count, never applied twice
  for (const line of lines) {
    assert.equal(line.multiplicity, line.members.length);
    const handSum = line.members.reduce((s, m) => {
      const r = included.find((x) => x.h === m.h && x.k === m.k && x.l === m.l)!;
      return s + r.intensity;
    }, 0);
    approx(line.integratedIntensity, handSum);
    // integrated equals multiplicity * mean exactly by construction
    approx(line.integratedIntensity, line.multiplicity * line.meanIntensity);
  }
});

test("cubic {100} line has six signed members counted explicitly", () => {
  const lines = runScan(simpleCubic(), FIXTURE_SCAN).lines;
  const line100 = lines.find((l) => l.representative.h === 0 && l.representative.k === 0 && l.representative.l === 1)
    ?? lines.find((l) => l.dSpacing === simpleCubic().a);
  // (100) d = a: members are +/-100,0+/-10,00+/-1 within the box
  const dA = lines.find((l) => Math.abs(l.dSpacing - 3) < 1e-9)!;
  assert.equal(dA.multiplicity, 6);
});

test("zero hkl is flagged excluded and never emits a 2theta", () => {
  const r = runScan(simpleCubic(), FIXTURE_SCAN).reflections.find(
    (x) => x.h === 0 && x.k === 0 && x.l === 0,
  )!;
  assert.equal(r.included, false);
  assert.equal(r.excludedReason, "zero_hkl");
  assert.equal(r.twoThetaDeg, null);
});

test("reflections outside the wavelength reach are listed with reason", () => {
  // Very long wavelength: d must be >= lambda/2 = 2.5 A.
  const scan = runScan(simpleCubic(), { ...FIXTURE_SCAN, wavelength: 5.0 });
  const unreachable = scan.reflections.filter((r) => r.excludedReason === "bragg_unreachable");
  assert.ok(unreachable.some((r) => r.h === 1 && r.k === 1 && r.k === 1));
  assert.ok(unreachable.every((r) => r.twoThetaDeg === null));
});

test("angle window boundary is inclusive", () => {
  const cell = simpleCubic();
  // 2theta for (100): d=3, sin(theta)=1.5406/6
  const twoTheta = (2 * Math.asin(1.5406 / 6) * 180) / Math.PI;
  const scan = runScan(cell, windowAround(twoTheta, 0));
  const hits = scan.reflections.filter((r) => r.included && r.dSpacing === 3);
  assert.equal(hits.length, 6);
});

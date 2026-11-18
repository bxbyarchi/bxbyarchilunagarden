import { describe, it, expect } from "vitest";
import { bestMatch, isDescriptor, consistentSamples, distance } from "../lib/faceMath";

// Deterministic pseudo-random unit-ish vectors.
function vec(seed: number) { let x = seed; return Array.from({ length: 128 }, () => { x = (x * 9301 + 49297) % 233280; return (x / 233280 - 0.5) * 0.18; }); }
const near = (v: number[], k: number, seed = 7) => { const n = vec(seed); return v.map((x, i) => x + n[i] * k); };

describe("face matching", () => {
  const a = vec(1), b = vec(2);
  const enrolled = [{ staffId: 1, descriptor: a }, { staffId: 1, descriptor: near(a, 0.2, 3) }, { staffId: 2, descriptor: b }];
  it("validates descriptors", () => {
    expect(isDescriptor(a)).toBe(true);
    expect(isDescriptor(a.slice(1))).toBe(false);
    expect(isDescriptor([...a.slice(1), Number.NaN])).toBe(false);
  });
  it("recognises the right person", () => {
    expect(distance(a, b)).toBeGreaterThan(0.6);
    expect(bestMatch(near(a, 0.3), enrolled)).toMatchObject({ staffId: 1 });
    expect(bestMatch(near(b, 0.3), enrolled)).toMatchObject({ staffId: 2 });
  });
  it("refuses strangers, look-alikes and empty enrolment", () => {
    expect(bestMatch(vec(99), enrolled)).toMatchObject({ staffId: null, reason: "unknown" });
    const twin = near(a, 0.05, 11);
    expect(bestMatch(a, [...enrolled, { staffId: 3, descriptor: twin }])).toMatchObject({ staffId: null, reason: "ambiguous" });
    expect(bestMatch(a, [])).toMatchObject({ staffId: null, reason: "no_faces" });
  });
  it("checks enrolment samples are one person", () => {
    expect(consistentSamples([a, near(a, 0.2), near(a, 0.3, 5)])).toBe(true);
    expect(consistentSamples([a, near(a, 0.2), b])).toBe(false);
  });
});

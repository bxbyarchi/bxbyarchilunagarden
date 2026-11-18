/** Matching face-api descriptors (128 numbers) against enrolled staff. */

export const DESCRIPTOR_LEN = 128;
/** face-api's usual threshold is 0.6; stricter to avoid mixing up colleagues. */
export const MATCH_DISTANCE = 0.5;
/** The runner-up must be clearly further away, or we ask for the PIN instead. */
export const MIN_MARGIN = 0.06;

export function isDescriptor(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === DESCRIPTOR_LEN && v.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 10);
}

export function distance(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

export type FaceMatch = { staffId: number; distance: number } | { staffId: null; reason: "no_faces" | "unknown" | "ambiguous"; distance: number | null };

export function bestMatch(probe: number[], enrolled: { staffId: number; descriptor: number[] }[]): FaceMatch {
  if (!enrolled.length) return { staffId: null, reason: "no_faces", distance: null };
  const best = new Map<number, number>();
  for (const e of enrolled) {
    const d = distance(probe, e.descriptor);
    if (d < (best.get(e.staffId) ?? Infinity)) best.set(e.staffId, d);
  }
  const ranked = [...best.entries()].sort((x, y) => x[1] - y[1]);
  const [first, second] = ranked;
  if (first[1] > MATCH_DISTANCE) return { staffId: null, reason: "unknown", distance: first[1] };
  if (second && second[1] - first[1] < MIN_MARGIN) return { staffId: null, reason: "ambiguous", distance: first[1] };
  return { staffId: first[0], distance: first[1] };
}

/** Enrollment samples must look like the same person (catches a colleague walking into the frame). */
export function consistentSamples(samples: number[][]): boolean {
  for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) if (distance(samples[i], samples[j]) > 0.55) return false;
  return true;
}

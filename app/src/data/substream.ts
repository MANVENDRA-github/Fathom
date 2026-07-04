// Model-colored sub-streams (M4). A comet's lane hue stays the OUTCOME signal; within the lane,
// each provider/model pair gets a deterministic shade + y sub-band so distinct models read as
// parallel currents. Hash-based (not arrival-ordered) so the same model keeps the same identity
// across replay/live and across sessions.

/** FNV-1a 32-bit over a string. */
function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface ModelId {
  h1: number;   // unit float — sub-band position + shade scale
  h2: number;   // unit float — whiteness mix (decorrelated from h1)
}

/** Deterministic per-model identity floats from `provider/model` (null-safe). */
export function modelHash(provider: string | null | undefined, model: string | null | undefined): ModelId {
  const key = `${provider ?? '?'}/${model ?? '?'}`;
  const a = fnv1a(key);
  const b = fnv1a(key, a || 0x811c9dc5);   // second pass chained on the first → independent bits
  return { h1: a / 0x100000000, h2: b / 0x100000000 };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Shade the outcome color by the model identity: scale 0.78–1.23, then mix ≤10% toward white. */
export function modelTint(col: [number, number, number], id: ModelId): [number, number, number] {
  const scale = 0.78 + 0.45 * id.h1;
  const w = 0.10 * id.h2;
  return [
    clamp01(clamp01(col[0] * scale) * (1 - w) + w),
    clamp01(clamp01(col[1] * scale) * (1 - w) + w),
    clamp01(clamp01(col[2] * scale) * (1 - w) + w),
  ];
}

/**
 * Deterministic sub-band center within the outcome lane: band centers span the middle 70% of the
 * lane, and callers scatter ±0.12·laneWidth around it — strictly inside the lane by construction,
 * so lane legibility and the pick-check lane-band assertion are unaffected.
 */
export function subBandCenter(lane: [number, number], id: ModelId): number {
  const w = lane[1] - lane[0];
  return lane[0] + (0.15 + 0.7 * id.h1) * w;
}

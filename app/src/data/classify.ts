import type { TraceEvent } from '@shared/schema';

export type Outcome = 'pii' | 'cache' | 'fallback' | 'span';

export interface CometSpec {
  kind: Outcome;
  col: [number, number, number];
  lane: [number, number];   // clip-space y band
  k: number;                // trail particle count
  life: number;             // comet travel time (s)
  size: number;
  alpha: number;
  flare: 0 | 1;
}

/** Map a normalized event to its comet look, by REAL outcome (first match wins). */
export function classify(e: TraceEvent): CometSpec {
  const pii = e.pii || e.guardrail === 'block' || /pii/.test((e.piiCategories || []).join(','));
  if (pii) return { kind: 'pii', col: [1.0, 0.19, 0.25], lane: [-0.5, -0.24], k: 90, life: 5.2, size: 0.020, alpha: 1.0, flare: 1 };
  if (e.cacheHit) return { kind: 'cache', col: [0.11, 1.0, 0.72], lane: [0.18, 0.5], k: 26, life: 3.4, size: 0.011, alpha: 0.75, flare: 0 };
  if (e.fallbackUsed) return { kind: 'fallback', col: [1.0, 0.68, 0.13], lane: [-0.07, 0.09], k: 74, life: 7.0, size: 0.013, alpha: 0.8, flare: 0 };
  return { kind: 'span', col: [0.22, 0.5, 1.0], lane: [-0.62, -0.28], k: 52, life: 6.0, size: 0.011, alpha: 0.55, flare: 0 };
}

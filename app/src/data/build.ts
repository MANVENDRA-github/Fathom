import type { NormalizedTrace, TraceEvent } from '@shared/schema';
import { makeComet, outcomeOf } from './comet';
import type { Outcome } from './classify';

/** One comet's head (leading particle) + its source event — the pick index for replay mode. */
export interface ReplayHead {
  a: Float32Array;   // (spawnT, vx, size, life)   — first 4 floats of the head particle
  b: Float32Array;   // (x0, yStart, yTarget, phase) — next 4 floats
  event: TraceEvent;
  outcome: Outcome;
}

export interface BuiltParticles {
  data: Float32Array<ArrayBuffer>;   // 12 floats/particle (see comet.ts)
  particles: number;
  N: number;              // event count
  counters: Outcome[];    // outcome per event (in render/timeline order)
  tScaled: number[];      // event spawn position along the loop (seconds)
  cycle: number;          // loop length (s)
  heads: ReplayHead[];    // one per event (index-aligned with counters/tScaled) for drill-down
}

/**
 * Turn a normalized trace into a looping particle buffer of comets (replay mode).
 * Events are interleaved (the load-harness capture is ordered by scenario, not real arrival
 * timing) so every outcome flows together; spans + proportions are unchanged, only replay order.
 */
export function buildParticles(trace: NormalizedTrace, cycle = 16): BuiltParticles {
  const events = trace.events.slice();
  for (let i = events.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = events[i]; events[i] = events[j]; events[j] = tmp;
  }

  const N = events.length;
  const P: number[] = [];
  const counters: Outcome[] = new Array(N);
  const tScaled: number[] = new Array(N);
  const heads: ReplayHead[] = new Array(N);

  for (let i = 0; i < N; i++) {
    const base = (i / N) * (cycle * 0.85);
    counters[i] = outcomeOf(events[i]);
    tScaled[i] = base;
    const run = makeComet(events[i], base + (Math.random() - 0.5) * 0.08);
    // the head is the leading particle (trail j=0) — the first 12 floats of the run
    heads[i] = {
      a: Float32Array.of(run[0], run[1], run[2], run[3]),
      b: Float32Array.of(run[4], run[5], run[6], run[7]),
      event: events[i],
      outcome: counters[i],
    };
    P.push(...run);
  }

  return { data: new Float32Array(P), particles: P.length / 12, N, counters, tScaled, cycle, heads };
}

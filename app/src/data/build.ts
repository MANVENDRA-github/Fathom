import type { NormalizedTrace } from '@shared/schema';
import { makeComet, outcomeOf } from './comet';
import type { Outcome } from './classify';

export interface BuiltParticles {
  data: Float32Array<ArrayBuffer>;   // 12 floats/particle (see comet.ts)
  particles: number;
  N: number;              // event count
  counters: Outcome[];    // outcome per event (in render/timeline order)
  tScaled: number[];      // event spawn position along the loop (seconds)
  cycle: number;          // loop length (s)
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

  for (let i = 0; i < N; i++) {
    const base = (i / N) * (cycle * 0.85);
    counters[i] = outcomeOf(events[i]);
    tScaled[i] = base;
    P.push(...makeComet(events[i], base + (Math.random() - 0.5) * 0.08));
  }

  return { data: new Float32Array(P), particles: P.length / 12, N, counters, tScaled, cycle };
}

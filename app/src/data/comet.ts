import type { TraceEvent } from '@shared/schema';
import { classify, type Outcome } from './classify';

/** Upper bound on particles-per-comet, for sizing the live pool. */
export const COMET_MAX = 140;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Build one comet's particles for `event`, entering at `spawnBase` seconds.
 * Returns a flat run of 12-float particles: [spawnT,vx,size,life][x0,yStart,yTarget,phase][r,g,b,alpha].
 * Shared by the replay builder (spawnBase = timeline position) and the live pool (spawnBase = now).
 */
export function makeComet(event: TraceEvent, spawnBase: number): number[] {
  const c = classify(event);
  const out: number[] = [];
  const yT = rnd(c.lane[0], c.lane[1]);
  const yS = yT + rnd(-0.05, 0.05) + (c.flare ? rnd(0.05, 0.12) : 0);
  const cometLife = c.life * rnd(0.9, 1.1);
  const vx = 2.35 / cometLife;
  const K = Math.round(c.k * rnd(0.8, 1.15));
  for (let j = 0; j < K; j++) {
    const trail = j / K;
    const spawnT = spawnBase + trail * (c.flare ? 0.25 : 0.5);
    const size = c.size * (1 - 0.6 * trail) * rnd(0.7, 1.25);
    const life = cometLife * rnd(0.55, 1.0);
    const alpha = c.alpha * (1 - 0.55 * trail);
    const jy = rnd(-0.03, 0.03);
    out.push(spawnT, vx, size, life, -1.14, yS + jy, yT + jy, rnd(0, 6.2831),
      c.col[0], c.col[1], c.col[2], alpha);
  }
  return out;
}

export function outcomeOf(event: TraceEvent): Outcome {
  return classify(event).kind;
}

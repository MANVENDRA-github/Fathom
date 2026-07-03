/*
 * Pick-math unit harness (run: node server/node_modules/tsx/dist/cli.mjs app/tools/pick-check.ts).
 * Proves the CPU pick math in app/src/gpu/motion.ts inverts the shader's closed-form motion:
 *   round-trip (project a head → click that pixel → resolves the same head), the tau>life cull,
 *   the cycle wrap, nearest-wins, and the min-radius floor. Plus build.ts emits one head/comet.
 * No GPU, no browser — deterministic. The real-shader parity is proven by tools/pick-e2e.mjs.
 * (@shared imports in the graph are type-only, so tsx runs this without alias config.)
 */
import { headPos, ndcToPixel, pickHead, curl, MIN_HIT_PX, type HeadLike } from '../src/gpu/motion';
import { buildParticles } from '../src/data/build';
import { classify } from '../src/data/classify';
import { modelHash, modelTint, subBandCenter } from '../src/data/substream';
import type { NormalizedTrace, TraceEvent } from '../../shared/schema';

const RECT = { width: 1600, height: 900 };
let failures = 0;
const check = (name: string, cond: boolean) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

// A tagged head so we can assert identity survives the pick.
type Tagged = HeadLike & { tag: string };
const mk = (a: number[], b: number[], tag: string): Tagged => ({ a: Float32Array.from(a), b: Float32Array.from(b), tag });

// 1. Round-trip: project a head to its pixel, click exactly there, get the same head back.
const cycle = 16;
const h = mk([0, 0.3, 0.02, 6], [-1.0, 0.0, 0.1, 1.0], 'A');
const t = 2.0;
const pos = headPos(h.a, h.b, t, cycle)!;
check('head is visible mid-life', pos !== null && pos.fade > 0.5);
const { px, py } = ndcToPixel(pos.x, pos.y, RECT);
const hit = pickHead([h], px, py, t, cycle, RECT);
check('click on the head center resolves it', hit?.tag === 'A');

// A click well outside the sprite misses.
const miss = pickHead([h], px + 400, py + 300, t, cycle, RECT);
check('click far away resolves nothing', miss === null);

// 2. Cull: past its life the head is not pickable (mirrors river.wgsl tau>life discard).
const dead = headPos(h.a, h.b, 6.5, cycle);   // tau = 6.5 > life 6
check('past-life head is culled (null)', dead === null);
check('culled head is not pickable', pickHead([h], px, py, 6.5, cycle, RECT) === null);

// 3. Cycle wrap + curl composition. The sim wraps tau into [0,cycle) but samples the curl field
//    with GLOBAL time (coherent flow), so across loops the position differs ONLY by the field's
//    time drift. Recompute the base motion independently and assert headPos = base + curl(base)
//    exactly at both times — this pins the wrap AND the exact composition the shader uses.
{
  const base = (tt: number) => {
    // independent recomputation of river-sim.wgsl's base motion for head `h` (floats from mk() above)
    const tau = tt - Math.floor(tt / cycle) * cycle;
    const x = -1.0 + 0.3 * tau;
    const ease = 0.1 + (0.0 - 0.1) * Math.exp(-3 * tau);
    const turb = 0.022 * Math.sin(tau * 2.6 + 1.0) + 0.013 * Math.sin(tau * 6.1 + 1.7);
    return { x, ease, turb };
  };
  const at = (tt: number) => {
    const b0 = base(tt);
    const d = curl(b0.x, b0.ease, tt);
    return { x: b0.x + d.dx, y: b0.ease + b0.turb + d.dy };
  };
  const p0 = headPos(h.a, h.b, t, cycle)!;
  const p1 = headPos(h.a, h.b, t + 3 * cycle, cycle)!;
  const e0 = at(t);
  const e1 = at(t + 3 * cycle);
  check('headPos = base + curl(base) (composition, this loop)', near(p0.x, e0.x, 1e-6) && near(p0.y, e0.y, 1e-6));
  check('headPos = base + curl(base) (composition, 3 loops later)', near(p1.x, e1.x, 1e-6) && near(p1.y, e1.y, 1e-6));
  check('across loops the base repeats; only curl drifts (≤ bounds)',
    Math.abs(p0.x - p1.x) <= 2 * 0.0190 && Math.abs(p0.y - p1.y) <= 2 * 0.0150);
}

// 4. Nearest wins: two heads on the same lane; a click near one selects THAT one.
const hL = mk([0, 0.0, 0.02, 8], [-0.5, 0.0, 0.0, 0.0], 'L');
const hR = mk([0, 0.0, 0.02, 8], [0.5, 0.0, 0.0, 0.0], 'R');
const nearR = ndcToPixel(headPos(hR.a, hR.b, 1, cycle)!.x, 0, RECT);
check('nearest head wins the pick', pickHead([hL, hR], nearR.px, RECT.height / 2, 1, cycle, RECT)?.tag === 'R');

// 5. Min-radius floor: a sub-pixel sprite is still clickable within MIN_HIT_PX.
const tiny = mk([0, 0.0, 0.0005, 8], [0.0, 0.0, 0.0, 0.0], 'T');   // radius = 0.0005*800 = 0.4px
const c = ndcToPixel(headPos(tiny.a, tiny.b, 1, cycle)!.x, 0, RECT);
check('tiny sprite clickable within MIN_HIT_PX', pickHead([tiny], c.px + (MIN_HIT_PX - 1), RECT.height / 2, 1, cycle, RECT)?.tag === 'T');
check('tiny sprite misses beyond MIN_HIT_PX', pickHead([tiny], c.px + (MIN_HIT_PX + 5), RECT.height / 2, 1, cycle, RECT) === null);

// 6. build.ts emits exactly one head per comet, each in its outcome's lane band.
const ev = (o: Partial<TraceEvent>): TraceEvent => ({
  t: 0, model: 'gpt-4o', provider: 'openai', status: 200, latencyMs: 100, tokens: 50,
  costUsd: 0.001, cacheHit: false, fallbackUsed: false, guardrail: null, pii: false, piiCategories: [], ...o,
});
const trace: NormalizedTrace = {
  meta: { source: 'test', count: 4, durationMs: 0, cacheHitRate: 0, fallbacks: 0, piiBlocked: 0, models: ['gpt-4o'] },
  events: [ev({}), ev({ cacheHit: true }), ev({ fallbackUsed: true }), ev({ pii: true, piiCategories: ['pii.email'] })],
};
const built = buildParticles(trace);
check('one head per comet', built.heads.length === trace.events.length);
check('head events are the source events', new Set(built.heads.map((x) => x.event)).size === trace.events.length);
const laneOk = built.heads.every((head) => {
  const lane = classify(head.event).lane;
  const yTarget = head.b[2];
  return yTarget >= lane[0] - 0.06 && yTarget <= lane[1] + 0.06;   // yTarget = rnd(lane) + jitter(±0.03)
});
check('each head sits in its outcome lane band', laneOk);

// 7. Curl field (M4): amplitude stays inside the lane-legibility budget everywhere on screen,
//    and the field is divergence-free (it's the curl of a stream function — flow, not sources).
{
  let maxDx = 0, maxDy = 0, maxDiv = 0;
  const EPS = 1e-4;
  for (let xi = -1.2; xi <= 1.2; xi += 0.06) {
    for (let yi = -0.7; yi <= 0.6; yi += 0.05) {
      for (let ti = 0; ti <= 40; ti += 0.7) {
        const d = curl(xi, yi, ti);
        maxDx = Math.max(maxDx, Math.abs(d.dx));
        maxDy = Math.max(maxDy, Math.abs(d.dy));
        const ddx = (curl(xi + EPS, yi, ti).dx - curl(xi - EPS, yi, ti).dx) / (2 * EPS);
        const ddy = (curl(xi, yi + EPS, ti).dy - curl(xi, yi - EPS, ti).dy) / (2 * EPS);
        maxDiv = Math.max(maxDiv, Math.abs(ddx + ddy));
      }
    }
  }
  check(`curl |dx| bounded (${maxDx.toFixed(4)} < 0.0190) — lanes stay legible`, maxDx < 0.0190);
  check(`curl |dy| bounded (${maxDy.toFixed(4)} < 0.0150) — lanes stay legible`, maxDy < 0.0150);
  check(`curl field is divergence-free (max |div| ${maxDiv.toExponential(1)} < 1e-3)`, maxDiv < 1e-3);
}

// 8. Sub-streams (M4): model identity is deterministic, sub-bands stay strictly inside the lane,
//    and tints stay valid colors in the outcome's hue family.
{
  const a1 = modelHash('openai', 'gpt-4o');
  const a2 = modelHash('openai', 'gpt-4o');
  const b1 = modelHash('anthropic', 'claude-sonnet-5');
  check('modelHash is deterministic', a1.h1 === a2.h1 && a1.h2 === a2.h2);
  check('distinct models get distinct identities', a1.h1 !== b1.h1 || a1.h2 !== b1.h2);
  const lanes: [number, number][] = [[-0.5, -0.24], [0.18, 0.5], [-0.07, 0.09], [-0.62, -0.28]];
  let bandOk = true, tintOk = true;
  for (let i = 0; i < 500; i++) {
    const id = modelHash(`p${i}`, `m${i % 7}`);
    for (const lane of lanes) {
      const w = lane[1] - lane[0];
      const centre = subBandCenter(lane, id);
      // worst-case comet scatter around the band centre is ±0.12·w (comet.ts)
      if (centre - 0.12 * w < lane[0] || centre + 0.12 * w > lane[1]) bandOk = false;
    }
    const tint = modelTint([0.22, 0.5, 1.0], id);
    if (tint.some((v) => v < 0 || v > 1)) tintOk = false;
  }
  check('sub-band + scatter stays strictly inside every lane', bandOk);
  check('model tints stay valid colors', tintOk);
}

console.log(`\n${failures === 0 ? 'OK' : failures + ' FAILURES'} — pick math mirrors the shader (motion.ts) + build.ts heads`);
process.exit(failures === 0 ? 0 : 1);

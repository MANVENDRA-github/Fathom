/*
 * Pick-math unit harness (run: node server/node_modules/tsx/dist/cli.mjs app/tools/pick-check.ts).
 * Proves the CPU pick math in app/src/gpu/motion.ts inverts the shader's closed-form motion:
 *   round-trip (project a head → click that pixel → resolves the same head), the tau>life cull,
 *   the cycle wrap, nearest-wins, and the min-radius floor. Plus build.ts emits one head/comet.
 * No GPU, no browser — deterministic. The real-shader parity is proven by tools/pick-e2e.mjs.
 * (@shared imports in the graph are type-only, so tsx runs this without alias config.)
 */
import { headPos, ndcToPixel, pickHead, MIN_HIT_PX, type HeadLike } from '../src/gpu/motion';
import { buildParticles } from '../src/data/build';
import { classify } from '../src/data/classify';
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

// 3. Cycle wrap: the shader wraps tau into [0,cycle); position must repeat every `cycle`.
const p0 = headPos(h.a, h.b, t, cycle)!;
const p1 = headPos(h.a, h.b, t + 3 * cycle, cycle)!;
check('position repeats across the loop', near(p0.x, p1.x) && near(p0.y, p1.y));

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

console.log(`\n${failures === 0 ? 'OK' : failures + ' FAILURES'} — pick math mirrors the shader (motion.ts) + build.ts heads`);
process.exit(failures === 0 ? 0 : 1);

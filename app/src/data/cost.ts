import type { TraceEvent } from '@shared/schema';
import { outcomeOf } from './comet';

/**
 * Cost aggregation — the M3 data contract (Opus half).
 * Reduces a set of spans to a two-level flame tree (provider → model) with a normalized [0,1]
 * layout, carrying cost / tokens / requests per node. This is what the flame view renders and what
 * the Fable 3D WGSL pass will consume. Kept pure + CPU-side so its totals reconcile with the HUD
 * by construction (both are reductions over the same event set).
 *
 * Data note: the real capture has costUsd=null everywhere, so `cost` can be $0 (→ `unpriced`);
 * `tokens`/`requests` are always populated, hence the metric toggle. When the chosen metric's total
 * is 0 the layout falls back to `requests` so the tree still has sensible geometry.
 */

export type CostMetric = 'cost' | 'tokens' | 'requests';

export interface FlameNode {
  key: string;          // stable id: "openai" (provider) or "openai/gpt-4o-mini" (model)
  label: string;
  depth: 0 | 1;         // 0 = provider, 1 = model
  cost: number;
  tokens: number;
  requests: number;
  value: number;        // the selected metric's magnitude
  share: number;        // value / total (0 when the metric total is 0)
  x0: number;           // normalized flame span within its row [0,1]
  x1: number;
  color: [number, number, number];   // provider hue; models are shades (render hint)
  children: FlameNode[];             // models under a provider; [] for model leaves
}

export interface CostModel {
  metric: CostMetric;
  total: number;                                        // total of the selected metric (HUD anchor)
  totals: { cost: number; tokens: number; requests: number };
  providers: FlameNode[];                               // depth-0 nodes, each with model children
  unpriced: boolean;                                    // metric==='cost' && total===0
}

const PROVIDER_HUES: [number, number, number][] = [
  [0.22, 0.50, 1.00],  // blue
  [0.11, 0.85, 0.72],  // teal
  [1.00, 0.68, 0.13],  // amber
  [0.78, 0.45, 1.00],  // violet
  [1.00, 0.40, 0.45],  // coral
  [0.55, 0.85, 0.35],  // green
];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const shade = (c: [number, number, number], t: number): [number, number, number] =>
  [lerp(c[0], 1, t), lerp(c[1], 1, t), lerp(c[2], 1, t)];

type Agg = { cost: number; tokens: number; requests: number };
const metricOf = (n: Agg, m: CostMetric) => (m === 'cost' ? n.cost : m === 'tokens' ? n.tokens : n.requests);

export function aggregateCost(events: TraceEvent[], metric: CostMetric = 'cost'): CostModel {
  const totals: Agg = { cost: 0, tokens: 0, requests: 0 };
  const provMap = new Map<string, Agg & { models: Map<string, Agg> }>();

  for (const e of events) {
    const cost = e.costUsd ?? 0;
    const tokens = e.tokens ?? 0;
    totals.cost += cost; totals.tokens += tokens; totals.requests += 1;

    const pkey = e.provider ?? 'unknown';
    let p = provMap.get(pkey);
    if (!p) { p = { cost: 0, tokens: 0, requests: 0, models: new Map() }; provMap.set(pkey, p); }
    p.cost += cost; p.tokens += tokens; p.requests += 1;

    const mkey = e.model ?? 'unknown';
    let m = p.models.get(mkey);
    if (!m) { m = { cost: 0, tokens: 0, requests: 0 }; p.models.set(mkey, m); }
    m.cost += cost; m.tokens += tokens; m.requests += 1;
  }

  const total = metricOf(totals, metric);
  const unpriced = metric === 'cost' && total === 0;
  // Lay the tree out by the metric, but fall back to requests when its total is 0 (keeps geometry sane).
  const layoutMetric: CostMetric = total > 0 ? metric : 'requests';
  const layoutTotal = metricOf(totals, layoutMetric) || 1;

  const provEntries = [...provMap.entries()].sort(
    (a, b) => metricOf(b[1], layoutMetric) - metricOf(a[1], layoutMetric));

  let cum = 0;
  const providers: FlameNode[] = provEntries.map(([key, p], i) => {
    const pv = metricOf(p, layoutMetric);
    const x0 = cum / layoutTotal;
    cum += pv;
    const x1 = cum / layoutTotal;
    const hue = PROVIDER_HUES[i % PROVIDER_HUES.length];

    const modelEntries = [...p.models.entries()].sort(
      (a, b) => metricOf(b[1], layoutMetric) - metricOf(a[1], layoutMetric));
    let mcum = 0;
    const children: FlameNode[] = modelEntries.map(([mkey, m], j) => {
      const mv = metricOf(m, layoutMetric);
      const frac0 = pv > 0 ? mcum / pv : j / modelEntries.length;
      mcum += mv;
      const frac1 = pv > 0 ? mcum / pv : (j + 1) / modelEntries.length;
      const t = modelEntries.length > 1 ? j / (modelEntries.length - 1) : 0;
      return {
        key: `${key}/${mkey}`, label: mkey, depth: 1,
        cost: m.cost, tokens: m.tokens, requests: m.requests,
        value: metricOf(m, metric), share: total > 0 ? metricOf(m, metric) / total : 0,
        x0: x0 + (x1 - x0) * frac0, x1: x0 + (x1 - x0) * frac1,
        color: shade(hue, 0.12 + 0.55 * t), children: [],
      };
    });

    return {
      key, label: key, depth: 0,
      cost: p.cost, tokens: p.tokens, requests: p.requests,
      value: metricOf(p, metric), share: total > 0 ? metricOf(p, metric) / total : 0,
      x0, x1, color: hue, children,
    };
  });

  return { metric, total, totals, providers, unpriced };
}

/**
 * "$ saved by cache" estimator (M4 HUD counter). A cache hit spends ~$0, so what it *saved* is what
 * the same call would have cost uncached. We estimate that from the data itself — no price table:
 *
 *   est. saved = Σ over cache-hit spans of mean(costUsd of PRICED NON-CACHE spans, same provider/model)
 *
 * Honesty: if the event set has no priced non-cache span at all (the real capture is costUsd-null
 * everywhere), the estimate is `null` and the HUD shows "—", not a made-up number. A $0-priced
 * local model honestly contributes $0. Sample cache hits carry costUsd:0 — the basis therefore
 * uses non-cache spans only, or hits would poison the mean to zero.
 */
export interface SavedAcc {
  basis: Map<string, { sum: number; n: number }>;   // priced non-cache spans per provider/model
  hits: Map<string, number>;                         // cache hits per provider/model
}

export const newSavedAcc = (): SavedAcc => ({ basis: new Map(), hits: new Map() });

export function accSaved(acc: SavedAcc, e: TraceEvent): void {
  const key = `${e.provider ?? '?'}/${e.model ?? '?'}`;
  if (e.cacheHit) {
    acc.hits.set(key, (acc.hits.get(key) ?? 0) + 1);
    return;
  }
  if (e.costUsd == null) return;
  const b = acc.basis.get(key);
  if (b) { b.sum += e.costUsd; b.n += 1; }
  else acc.basis.set(key, { sum: e.costUsd, n: 1 });
}

/** Resolve the accumulator: `null` = unpriced data (no basis to estimate from). */
export function savedOf(acc: SavedAcc): number | null {
  if (acc.basis.size === 0) return null;
  let saved = 0;
  for (const [key, n] of acc.hits) {
    const b = acc.basis.get(key);
    if (b && b.n > 0) saved += n * (b.sum / b.n);
  }
  return saved;
}

/** One-shot estimator over a whole event set (pure; the flame/replay path). */
export function estimateSaved(events: TraceEvent[]): number | null {
  const acc = newSavedAcc();
  for (const e of events) accSaved(acc, e);
  return savedOf(acc);
}

/**
 * One-pass HUD summary over the same events (drives the HUD in flame view). Reuses `outcomeOf`, so
 * cache/fallback/pii match `river.ts` exactly, and `cost` matches `aggregateCost().totals.cost`.
 * `savedUsd` uses the same accumulator as the river statsFns, so HUD === flame by construction.
 */
export function summarize(events: TraceEvent[]) {
  let requests = 0, cache = 0, fallbacks = 0, pii = 0, cost = 0, tokens = 0;
  const acc = newSavedAcc();
  for (const e of events) {
    requests++;
    cost += e.costUsd ?? 0;
    tokens += e.tokens ?? 0;
    accSaved(acc, e);
    const o = outcomeOf(e);
    if (o === 'cache') cache++; else if (o === 'fallback') fallbacks++; else if (o === 'pii') pii++;
  }
  return { requests, cacheRate: requests ? cache / requests : 0, fallbacks, pii, cost, tokens, savedUsd: savedOf(acc) };
}

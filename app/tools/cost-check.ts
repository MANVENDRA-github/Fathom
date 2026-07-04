/*
 * Cost-aggregation unit harness (run: node server/node_modules/tsx/dist/cli.mjs app/tools/cost-check.ts).
 * Proves the M3 reduction in app/src/data/cost.ts reconciles — totals equal the raw sums, the flame
 * layout is contiguous and covers [0,1], the metric toggle changes geometry but not totals, and
 * summarize() agrees with aggregateCost() (the HUD invariant). Runs against BOTH real datasets.
 * (@shared imports in the graph are type-only, so tsx runs this without alias config.)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aggregateCost, summarize, estimateSaved, type FlameNode, type CostMetric } from '../src/data/cost';
import type { NormalizedTrace, TraceEvent } from '../../shared/schema';

const DIR = dirname(fileURLToPath(import.meta.url));
const load = (p: string) => (JSON.parse(readFileSync(join(DIR, p), 'utf8')) as NormalizedTrace).events;
const real = load('../../traces.json');
const sample = load('../../traces.sample.json');

let failures = 0;
const check = (name: string, cond: boolean) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const rawCost = (es: TraceEvent[]) => sum(es.map((e) => e.costUsd ?? 0));
const rawTokens = (es: TraceEvent[]) => sum(es.map((e) => e.tokens ?? 0));

// contiguity: a row of nodes must tile [start,end] with no gaps/overlaps
function tiles(nodes: FlameNode[], start: number, end: number): boolean {
  if (nodes.length === 0) return near(start, end) || end === 0;
  if (!near(nodes[0].x0, start)) return false;
  for (let i = 1; i < nodes.length; i++) if (!near(nodes[i].x0, nodes[i - 1].x1)) return false;
  return near(nodes[nodes.length - 1].x1, end);
}

function suite(label: string, events: TraceEvent[], metric: CostMetric) {
  const m = aggregateCost(events, metric);
  const provCost = sum(m.providers.map((p) => p.cost));
  const provTokens = sum(m.providers.map((p) => p.tokens));
  const provReq = sum(m.providers.map((p) => p.requests));

  check(`[${label}/${metric}] totals.requests === events.length (${events.length})`, m.totals.requests === events.length);
  check(`[${label}/${metric}] Σ providers.cost === totals.cost === raw`, near(provCost, m.totals.cost) && near(m.totals.cost, rawCost(events)));
  check(`[${label}/${metric}] Σ providers.tokens === totals.tokens === raw`, near(provTokens, m.totals.tokens) && near(m.totals.tokens, rawTokens(events)));
  check(`[${label}/${metric}] Σ providers.requests === totals.requests`, provReq === m.totals.requests);
  check(`[${label}/${metric}] provider.requests === Σ children.requests`, m.providers.every((p) => p.requests === sum(p.children.map((c) => c.requests))));
  check(`[${label}/${metric}] provider row tiles [0,1]`, tiles(m.providers, 0, 1));
  check(`[${label}/${metric}] each provider's models tile its slice`, m.providers.every((p) => tiles(p.children, p.x0, p.x1)));
  check(`[${label}/${metric}] total === metric total`, near(m.total, metric === 'cost' ? m.totals.cost : metric === 'tokens' ? m.totals.tokens : m.totals.requests));
}

// 1. Real capture: cost is unpriced ($0), tokens/requests non-empty.
const realCost = aggregateCost(real, 'cost');
check(`[real] unpriced flag set (costUsd null everywhere)`, realCost.unpriced && realCost.totals.cost === 0);
check(`[real] tokens > 0 so tokens metric renders`, realCost.totals.tokens > 0);
suite('real', real, 'tokens');
suite('real', real, 'requests');

// 2. Sample: real cost across 3 providers / 3 models.
const sampleCost = aggregateCost(sample, 'cost');
check(`[sample] priced (cost > 0)`, !sampleCost.unpriced && sampleCost.totals.cost > 0);
check(`[sample] 3 providers`, sampleCost.providers.length === 3);
check(`[sample] 3 models total`, sum(sampleCost.providers.map((p) => p.children.length)) === 3);
suite('sample', sample, 'cost');
suite('sample', sample, 'tokens');

// 3. Metric toggle changes geometry (value/share) but NOT the underlying totals.
const c = aggregateCost(sample, 'cost');
const t = aggregateCost(sample, 'tokens');
check(`[sample] toggle keeps totals stable`, near(c.totals.cost, t.totals.cost) && c.totals.tokens === t.totals.tokens && c.totals.requests === t.totals.requests);
check(`[sample] toggle changes the top provider's value`, c.providers[0].value !== t.providers[0].value || c.providers[0].key !== t.providers[0].key);

// 4. HUD invariant: summarize() agrees with aggregateCost().totals (so HUD === flame).
for (const [label, es] of [['real', real], ['sample', sample]] as const) {
  const s = summarize(es);
  const a = aggregateCost(es, 'cost');
  check(`[${label}] summarize.cost === aggregate.totals.cost`, near(s.cost, a.totals.cost));
  check(`[${label}] summarize.requests === aggregate.totals.requests`, s.requests === a.totals.requests);
  check(`[${label}] summarize.tokens === aggregate.totals.tokens`, s.tokens === a.totals.tokens);
}

// 5. "$ saved" estimator (M4): honest null on unpriced data; a sane positive estimate on the
//    sample, in the ballpark of the generator's own meta.dollarsSaved; summarize() reconciles.
{
  const meta = (JSON.parse(readFileSync(join(DIR, '../../traces.sample.json'), 'utf8')) as NormalizedTrace).meta as { dollarsSaved?: number };
  check('[real] $ saved is null (costUsd-null capture → HUD "—")', estimateSaved(real) === null);
  const s = estimateSaved(sample);
  check('[sample] $ saved is a positive estimate', s !== null && s > 0);
  const anchor = meta.dollarsSaved ?? 0;
  check(`[sample] estimate ≈ generator's dollarsSaved (${s?.toFixed(4)} vs ${anchor}, within 2×)`,
    s !== null && s > anchor / 2 && s < anchor * 2);
  check('[real] summarize.savedUsd === estimateSaved', summarize(real).savedUsd === estimateSaved(real));
  check('[sample] summarize.savedUsd === estimateSaved', summarize(sample).savedUsd === estimateSaved(sample));
}

console.log(`\n${failures === 0 ? 'OK' : failures + ' FAILURES'} — cost aggregation reconciles (real + sample, all metrics)`);
process.exit(failures === 0 ? 0 : 1);

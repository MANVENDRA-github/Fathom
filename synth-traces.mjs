/*
 * Dev-only: emit a schema-faithful *sample* trace in Fathom's normalized shape,
 * so the cinema renderer can be built before real sentinel data is wired in.
 * The FINAL deliverable uses real spans from `pnpm load` (see ingest.mjs);
 * this file only exists so the renderer has something to chew on during dev.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const MODELS = ['llama3.2', 'gpt-4o-mini', 'llama-3.3-70b-versatile'];
const PRICE = { 'llama3.2': 0, 'gpt-4o-mini': 0.00045, 'llama-3.3-70b-versatile': 0.0009 };
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const events = [];
let t = 0;
const DURATION = 60_000;
while (t < DURATION) {
  // bursty arrival: mostly tight gaps, occasional lulls
  t += Math.random() < 0.15 ? rnd(400, 1400) : rnd(20, 120);
  if (t > DURATION) break;
  const r = Math.random();
  const cacheHit = r < 0.30;                       // ~30% served from cache
  const guardrail = !cacheHit && Math.random() < 0.06 ? 'block' : 'ok';
  const pii = guardrail === 'block' && Math.random() < 0.8;
  const fallbackUsed = !cacheHit && guardrail === 'ok' && Math.random() < 0.10;
  const model = cacheHit ? pick(MODELS) : (fallbackUsed ? 'llama3.2' : pick(MODELS));
  const tokens = Math.round(rnd(60, 2200));
  const latencyMs = cacheHit ? rnd(3, 18) : rnd(180, 2600) * (fallbackUsed ? 1.6 : 1);
  const costUsd = cacheHit ? 0 : +(tokens / 1000 * (PRICE[model] || 0)).toFixed(6);
  events.push({
    t: Math.round(t), model, provider: model === 'llama3.2' ? 'ollama' : (model.startsWith('gpt') ? 'openai' : 'groq'),
    status: guardrail === 'block' ? 422 : 200, latencyMs: Math.round(latencyMs), tokens,
    costUsd, cacheHit, fallbackUsed, guardrail, pii,
    piiCategories: pii ? [pick(['pii.email', 'pii.card', 'pii.ssn', 'pii.phone'])] : [],
  });
}

const nCache = events.filter((e) => e.cacheHit).length;
const savedUsd = +events.filter((e) => e.cacheHit).reduce((s, e) => s + (e.tokens / 1000 * (PRICE[e.model] || 0)), 0).toFixed(4);
const out = {
  meta: {
    source: 'SYNTHETIC sample (schema-faithful) — replace with real `pnpm load` capture',
    count: events.length, durationMs: DURATION,
    cacheHitRate: +(nCache / events.length).toFixed(3),
    piiCaught: events.filter((e) => e.pii).length,
    dollarsSaved: savedUsd, models: MODELS,
  },
  events,
};
await writeFile(join(DIR, 'traces.sample.json'), JSON.stringify(out));
console.log(`wrote traces.sample.json — ${events.length} events, ${nCache} cache hits, ${out.meta.piiCaught} PII, $${savedUsd} saved`);

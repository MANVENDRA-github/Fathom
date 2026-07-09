/*
 * ingest.mjs — map raw sentinel TraceRecord[] (from GET /traces or the load dump)
 * into Fathom's normalized trace schema. This is the ONLY sentinel-aware code;
 * the renderer consumes the normalized output and knows nothing about the source.
 *
 *   node ingest.mjs <raw-tracerecords.json> <out-traces.json>
 */
import { readFile, writeFile } from 'node:fs/promises';

const [, , inPath, outPath = 'traces.json'] = process.argv;
if (!inPath) { console.error('usage: node ingest.mjs <raw.json> [out.json]'); process.exit(1); }

const raw = JSON.parse(await readFile(inPath, 'utf8'));
const records = Array.isArray(raw) ? raw : (raw.traces || raw.events || []);
if (!records.length) { console.error('no records in', inPath); process.exit(1); }

const sorted = records.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
const t0 = sorted[0].timestamp ?? 0;

const events = sorted.map((r) => {
  const viol = r.guardrailViolations || '';
  const piiCategories = viol.split(',').map((s) => s.trim()).filter((s) => s.startsWith('pii.'));
  const sum = (r.promptTokens || 0) + (r.completionTokens || 0);
  const tokens = r.totalTokens ?? (sum || null);
  return {
    t: (r.timestamp ?? t0) - t0,
    model: r.routedModel || r.model || null,
    provider: r.routedProvider || r.provider || null,
    status: r.status ?? 0,
    latencyMs: r.durationMs ?? null,
    tokens,
    costUsd: r.costUsd ?? null,
    cacheHit: r.cacheHit === true,
    fallbackUsed: r.fallbackUsed === true,
    guardrail: r.guardrailStatus || null,        // 'pass' | 'flag' | 'block'
    pii: piiCategories.length > 0 || r.guardrailStatus === 'block',  // match server mappers (otlp.ts/poller.ts)
    piiCategories,
  };
});

const models = [...new Set(events.map((e) => e.model).filter(Boolean))];
const meta = {
  source: 'REAL — sentinel `pnpm load` capture (in-process mock upstreams, no API keys)',
  count: events.length,
  durationMs: events.length ? events[events.length - 1].t : 0,
  cacheHitRate: +(events.filter((e) => e.cacheHit).length / events.length).toFixed(3),
  fallbacks: events.filter((e) => e.fallbackUsed).length,
  piiBlocked: events.filter((e) => e.pii || e.guardrail === 'block').length,
  models,
};
await writeFile(outPath, JSON.stringify({ meta, events }));
console.log(`ingested ${events.length} real spans -> ${outPath}`);
console.log(`  cache-hit ${(meta.cacheHitRate * 100).toFixed(0)}% · fallbacks ${meta.fallbacks} · PII blocked ${meta.piiBlocked} · models: ${models.join(', ')}`);

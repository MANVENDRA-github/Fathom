/*
 * emit-otlp — replay a normalized trace as OTLP/HTTP spans into the Fathom server.
 * Encodes each real captured event as a `chat.completion` span carrying sentinel's exact
 * attribute keys, so it exercises the real OTLP receiver (the same bytes sentinel would send).
 *
 *   node server/tools/emit-otlp.mjs [file] [url] [rateMs] [--loop]
 *   defaults: file=../../traces.json  url=http://localhost:4319/v1/traces  rateMs=120
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const loop = args.includes('--loop');
const pos = args.filter((a) => !a.startsWith('--'));
const FILE = pos[0] || join(DIR, '../../traces.json');
const URL = pos[1] || 'http://localhost:4319/v1/traces';
const RATE = Number(pos[2] || 120);

const trace = JSON.parse(await readFile(FILE, 'utf8'));
const events = trace.events ?? [];
if (!events.length) { console.error('no events in', FILE); process.exit(1); }

const kv = (key, v) => {
  if (v === undefined || v === null) return null;
  const value = typeof v === 'boolean' ? { boolValue: v }
    : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
    : { stringValue: String(v) };
  return { key, value };
};

function toSpan(e, i) {
  const now = Date.now() * 1e6;
  const attrs = [
    kv('gen_ai.request.model', e.model),
    kv('sentinel.provider', e.provider),
    kv('http.response.status_code', e.status),
    kv('gen_ai.usage.total_tokens', e.tokens),
    kv('sentinel.cost_usd', e.costUsd),
    kv('sentinel.cache_hit', e.cacheHit),
    kv('sentinel.fallback_used', e.fallbackUsed),
    e.guardrail ? kv('sentinel.guardrail_status', e.guardrail) : null,
    e.piiCategories?.length ? kv('sentinel.guardrail_violations', e.piiCategories.join(',')) : null,
  ].filter(Boolean);
  return {
    spanId: (Date.now().toString(16) + i.toString(16)).slice(-16),
    name: 'chat.completion',
    startTimeUnixNano: String(now),
    endTimeUnixNano: String(now + Math.round((e.latencyMs || 1) * 1e6)),
    attributes: attrs,
    status: { code: e.status >= 400 ? 2 : 1 },
  };
}

function envelope(span) {
  return {
    resourceSpans: [{
      resource: { attributes: [kv('service.name', '@sentinel/gateway')] },
      scopeSpans: [{ spans: [span] }],
    }],
  };
}

async function post(span) {
  await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope(span)) });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`[emit] ${events.length} events -> ${URL} @ ${RATE}ms${loop ? ' (loop)' : ''}`);
let sent = 0;
do {
  for (let i = 0; i < events.length; i++) {
    await post(toSpan(events[i], sent++));
    await sleep(RATE);
  }
} while (loop);
console.log(`[emit] done, ${sent} spans sent`);

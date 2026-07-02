/*
 * In-process M1 proof (run: npm --prefix server run e2e).
 * Encodes real captured spans (traces.json) as OTLP, runs them through the REAL server logic
 * (parseOtlp → Hub → SSE broadcast), and asserts the normalized mapping + live delivery.
 * No network, no browser — deterministic. The browser path is proven by tools/live-demo.mjs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Hub } from './src/hub';
import { parseOtlp, type OtlpBody } from './src/otlp';
import type { NormalizedTrace, StreamMessage } from '../shared/schema';

const DIR = dirname(fileURLToPath(import.meta.url));
const trace = JSON.parse(readFileSync(join(DIR, '../traces.json'), 'utf8')) as NormalizedTrace;
const events = trace.events;

const kv = (key: string, v: unknown) => {
  if (v === undefined || v === null) return null;
  const value = typeof v === 'boolean' ? { boolValue: v }
    : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
    : { stringValue: String(v) };
  return { key, value };
};

// Encode the captured events as one OTLP batch with sentinel's real attribute keys.
const otlp: OtlpBody = {
  resourceSpans: [{
    scopeSpans: [{
      spans: events.map((e, i) => ({
        spanId: String(i),
        name: 'chat.completion',
        startTimeUnixNano: String((1_700_000_000_000 + i) * 1e6),
        endTimeUnixNano: String((1_700_000_000_000 + i + Math.round(e.latencyMs ?? 1)) * 1e6),
        attributes: [
          kv('gen_ai.request.model', e.model),
          kv('sentinel.provider', e.provider),
          kv('http.response.status_code', e.status),
          kv('gen_ai.usage.total_tokens', e.tokens),
          kv('sentinel.cost_usd', e.costUsd),
          kv('sentinel.cache_hit', e.cacheHit),
          kv('sentinel.fallback_used', e.fallbackUsed),
          e.guardrail ? kv('sentinel.guardrail_status', e.guardrail) : null,
          e.piiCategories?.length ? kv('sentinel.guardrail_violations', e.piiCategories.join(',')) : null,
        ].filter(Boolean) as Array<{ key: string; value: object }>,
        status: { code: e.status >= 400 ? 2 : 1 },
      })),
    }],
  }],
};

let failures = 0;
const check = (name: string, cond: boolean) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

// 1. parseOtlp maps the real attributes faithfully.
const parsed = parseOtlp(otlp);
check(`parsed all ${events.length} spans`, parsed.length === events.length);
const srcCache = events.filter((e) => e.cacheHit).length;
const srcPii = events.filter((e) => e.pii).length;
const srcFb = events.filter((e) => e.fallbackUsed).length;
check(`cache_hit preserved (${srcCache})`, parsed.filter((e) => e.cacheHit).length === srcCache);
check(`pii/guardrail preserved (${srcPii})`, parsed.filter((e) => e.pii).length === srcPii);
check(`fallback preserved (${srcFb})`, parsed.filter((e) => e.fallbackUsed).length === srcFb);
check('model + status round-tripped', parsed[0].model === events[0].model && parsed[0].status === events[0].status);

// 2. Hub broadcasts each span live + gives a new client a snapshot.
const hub = new Hub(5000);
const received: StreamMessage[] = [];
const fakeClient = {
  writeHead() {}, write(line: string) {
    const s = line.trim();
    if (s.startsWith('data:')) received.push(JSON.parse(s.slice(5)) as StreamMessage);
  }, on() {},
} as unknown as Parameters<Hub['addClient']>[0];

hub.addClient(fakeClient);                 // should push a snapshot (buffer empty ⇒ 0 events)
hub.ingest(parsed);                         // should broadcast one 'span' each
const spanMsgs = received.filter((m) => m.type === 'span');
const snapMsgs = received.filter((m) => m.type === 'snapshot');
check('client got a snapshot on connect', snapMsgs.length === 1);
check(`client got ${events.length} live span messages`, spanMsgs.length === events.length);
check(`ring buffer holds ${events.length}`, hub.size === events.length);

// 3. a late client's snapshot carries the backlog.
const late: StreamMessage[] = [];
hub.addClient({ writeHead() {}, write(l: string) { const s = l.trim(); if (s.startsWith('data:')) late.push(JSON.parse(s.slice(5))); }, on() {} } as never);
const lateSnap = late.find((m) => m.type === 'snapshot');
check('late client snapshot has the backlog', !!lateSnap && lateSnap.type === 'snapshot' && lateSnap.events.length === Math.min(events.length, 500));

console.log(`\n${failures === 0 ? 'OK' : failures + ' FAILURES'} — ${events.length} real spans through OTLP→map→Hub→SSE`);
process.exit(failures === 0 ? 0 : 1);

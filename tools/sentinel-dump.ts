/*
 * Fathom capture script (reference copy — kept here for reproducibility).
 *
 * HOW TO USE (keeps sentinel pristine — this is a TEMPORARY file there):
 *   1. Copy this file to  <sentinel>/load/run.dump.ts   (imports below resolve from load/).
 *   2. Run:  <sentinel>/node_modules/.bin/tsx <sentinel>/load/run.dump.ts
 *            -> writes D:/Fathom/data/sentinel-traces-raw.json  (does NOT write load/RESULTS.md)
 *   3. Delete <sentinel>/load/run.dump.ts  and verify:  git -C <sentinel> status  (clean).
 *   4. Back in Fathom:  npm run ingest   -> traces.json
 *
 * It is a trimmed copy of sentinel's load/run.ts: same real gateway + in-process mock upstreams
 * (no API keys, no network), a slightly larger scenario, and it DUMPS the raw TraceRecord[] instead
 * of only summarizing to RESULTS.md. Adjust N / flaky / pii counts for a denser or longer river.
 */
import http from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  createRegistry,
  createTraceStore,
  createSemanticCache,
  createOllamaEmbedder,
  createBucketRegistry,
  createVerifier,
  buildServer,
} from '../packages/gateway/src/index.js';
import { initTelemetry } from '../packages/gateway/src/telemetry/otel.js';

const RELIABLE_PORT = 8082;
const FLAKY_PORT = 8081;
const CFG_PATH = fileURLToPath(new URL('./load.sentinel.config.json', import.meta.url));
const OUT_PATH = 'D:/Fathom/data/sentinel-traces-raw.json';

function hash32(str: string, seed: number) {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
function embed(text: string) {
  const dims = 64; const v = new Array(dims);
  for (let d = 0; d < dims; d++) v[d] = (hash32(text, d) / 0xffffffff) * 2 - 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
function completion(content: string) {
  return { id: 'mock', object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } };
}
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
}

const reliable = http.createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.url && req.url.startsWith('/embeddings')) {
    const input = JSON.parse(body).input;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: embed(String(input)) }] })); return;
  }
  if (req.url && req.url.startsWith('/chat/completions')) {
    const model = JSON.parse(body).model;
    const content = model === 'pii' ? 'Sure, reach me at agent@example.com anytime.' : 'All good.';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion(content))); return;
  }
  res.writeHead(404); res.end();
});
const flaky = http.createServer(async (req, res) => {
  await readBody(req); res.writeHead(429, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'rate limited' } }));
});

await new Promise((r) => reliable.listen(RELIABLE_PORT, () => r(undefined)));
await new Promise((r) => flaky.listen(FLAKY_PORT, () => r(undefined)));

const config = loadConfig({ path: CFG_PATH, env: process.env });
const store = createTraceStore({ kind: 'memory' });
const shutdownTelemetry = initTelemetry(store, {});
const cache = createSemanticCache({
  embedder: createOllamaEmbedder({ baseUrl: `http://localhost:${RELIABLE_PORT}`, model: 'mock-embed' }),
  threshold: 0.92, ttlMs: 300_000, maxEntries: 2000, embedModel: 'mock-embed',
});
const throttle = createBucketRegistry({ defaultRpm: 0 });
const verifier = createVerifier({ store, guardrails: { block: true, ...config.guardrails } });
const app = buildServer({
  registry: createRegistry(config), apiKeys: new Set(['load-key']), traceStore: store, adminKey: 'admin', cache,
  routing: { config: config.routing, maxRetries: 1, timeoutMs: 5000, baseBackoffMs: 5, maxWaitMs: 0, throttle },
  verifier, logger: false,
});

async function call(model: string, content: string) {
  const res = await app.inject({
    method: 'POST', url: '/v1/chat/completions',
    headers: { authorization: 'Bearer load-key', 'content-type': 'application/json' },
    payload: { model, messages: [{ role: 'user', content }] },
  });
  return res.statusCode;
}

console.log('capturing a richer scenario for Fathom (cache · fallback · guardrails)...');
for (let i = 0; i < 8; i++) await call('warmup', `warmup ${i}`);

const N = 140;
const prompts = Array.from({ length: N }, (_, i) => `unique load request ${i}`);
for (const p of prompts) await call('std', p);   // misses
for (const p of prompts) await call('std', p);   // exact repeats -> cache hits
for (let i = 0; i < 95; i++) await call('svc', `flaky ${i}`);   // always-429 -> fallback
for (let i = 0; i < 85; i++) await call('pii', `pii ${i}`);     // injected PII -> blocked

const all = store.query({ limit: 100000 });
const measured = all.filter((t) => t.model !== 'warmup');
mkdirSync('D:/Fathom/data', { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(measured));
console.log(`wrote ${measured.length} trace records -> ${OUT_PATH}`);
console.log(`  cache hits: ${measured.filter((t) => t.cacheHit).length} · fallbacks: ${measured.filter((t) => t.fallbackUsed).length} · blocked(422): ${measured.filter((t) => t.status === 422).length}`);

await app.close();
await shutdownTelemetry();
reliable.close();
flaky.close();
process.exit(0);

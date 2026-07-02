/*
 * Reference: run sentinel's REAL gateway and export its spans to Fathom over OTLP.
 * Proves the literal M1 exit criterion — "start sentinel with OTEL_EXPORTER_OTLP_ENDPOINT → Fathom".
 * Copy into <sentinel>/load/ to run (imports resolve from load/); delete after. Keyless/offline.
 *
 *   FATHOM_OTLP=http://localhost:4319/v1/traces <sentinel>/node_modules/.bin/tsx <sentinel>/load/_fathom_otlp.ts
 *
 * (server/tools/sentinel-otlp-check.mjs does the copy+run+delete + assertion automatically.)
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, createRegistry, createTraceStore, createSemanticCache,
  createOllamaEmbedder, createBucketRegistry, createVerifier, buildServer,
} from '../packages/gateway/src/index.js';
import { initTelemetry } from '../packages/gateway/src/telemetry/otel.js';

const RELIABLE_PORT = 8082;
const FLAKY_PORT = 8081;
const CFG_PATH = fileURLToPath(new URL('./load.sentinel.config.json', import.meta.url));
const FATHOM_OTLP = process.env.FATHOM_OTLP || 'http://localhost:4319/v1/traces';

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
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: embed(String(JSON.parse(body).input)) }] })); return;
  }
  if (req.url && req.url.startsWith('/chat/completions')) {
    const model = JSON.parse(body).model;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion(model === 'pii' ? 'Sure, reach me at agent@example.com anytime.' : 'All good.'))); return;
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
// THE KEY LINE: export real spans to Fathom's OTLP receiver.
const shutdownTelemetry = initTelemetry(store, { otlpEndpoint: FATHOM_OTLP });
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
  await app.inject({ method: 'POST', url: '/v1/chat/completions',
    headers: { authorization: 'Bearer load-key', 'content-type': 'application/json' },
    payload: { model, messages: [{ role: 'user', content }] } });
}

console.log(`[harness] real sentinel gateway → OTLP → ${FATHOM_OTLP}`);
for (let i = 0; i < 4; i++) await call('warmup', `warmup ${i}`);
const N = 40;
const prompts = Array.from({ length: N }, (_, i) => `unique load request ${i}`);
for (const p of prompts) await call('std', p);   // misses
for (const p of prompts) await call('std', p);   // repeats -> cache hits
for (let i = 0; i < 30; i++) await call('svc', `flaky ${i}`);   // 429 -> fallback
for (let i = 0; i < 30; i++) await call('pii', `pii ${i}`);     // PII -> blocked

await app.close();
await shutdownTelemetry();   // flushes the OTLP BatchSpanProcessor to Fathom
reliable.close();
flaky.close();
console.log('[harness] done — real spans exported to Fathom');
process.exit(0);

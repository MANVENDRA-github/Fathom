/*
 * M1 live end-to-end proof (real network path):
 *   spawns the Fathom server → opens the client in ?source=live (SSE) → POSTs real captured
 *   spans as OTLP → screenshots the browser as comets arrive. Then tears everything down.
 *
 *   node server/tools/live-demo.mjs [out.png]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '../..');
const OUT = process.argv[2] || join(ROOT, 'app', 'm1-live.png');
const SERVER_PORT = 4319;
const STATIC_PORT = 8974;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. spawn the Fathom server (single node process via tsx) ----
const tsxCli = join(ROOT, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsxCli, join(ROOT, 'server', 'src', 'index.ts')], {
  cwd: ROOT, env: { ...process.env, PORT: String(SERVER_PORT) }, stdio: 'inherit',
});

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://localhost:${SERVER_PORT}/health`)).ok) return true; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not become healthy');
}

// ---- 2. static-serve app/dist ----
const DIST = join(ROOT, 'app', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const staticServer = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    const file = p === '/' ? 'index.html' : decodeURIComponent(p);
    const body = await readFile(join(DIST, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});

// ---- OTLP encoding for real captured events ----
const kv = (key, v) => {
  if (v === undefined || v === null) return null;
  const value = typeof v === 'boolean' ? { boolValue: v }
    : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
    : { stringValue: String(v) };
  return { key, value };
};
function otlpOf(e, i) {
  const now = Date.now() * 1e6;
  const span = {
    spanId: (Date.now().toString(16) + i).slice(-16), name: 'chat.completion',
    startTimeUnixNano: String(now), endTimeUnixNano: String(now + Math.round((e.latencyMs || 1) * 1e6)),
    attributes: [
      kv('gen_ai.request.model', e.model), kv('sentinel.provider', e.provider),
      kv('http.response.status_code', e.status), kv('gen_ai.usage.total_tokens', e.tokens),
      kv('sentinel.cost_usd', e.costUsd), kv('sentinel.cache_hit', e.cacheHit),
      kv('sentinel.fallback_used', e.fallbackUsed),
      e.guardrail ? kv('sentinel.guardrail_status', e.guardrail) : null,
      e.piiCategories?.length ? kv('sentinel.guardrail_violations', e.piiCategories.join(',')) : null,
    ].filter(Boolean),
    status: { code: e.status >= 400 ? 2 : 1 },
  };
  return { resourceSpans: [{ resource: { attributes: [kv('service.name', '@sentinel/gateway')] }, scopeSpans: [{ spans: [span] }] }] };
}

let browser, code = 0;
try {
  await waitHealth();
  await new Promise((r) => staticServer.listen(STATIC_PORT, r));
  console.log('[demo] server healthy; client on', STATIC_PORT);

  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--force_high_performance_gpu'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', (m) => { const t = m.text(); if (t.includes('[fathom]')) console.log('[page]', t); });
  await page.goto(`http://localhost:${STATIC_PORT}/?source=live`, { waitUntil: 'load' });
  await sleep(1500);   // let EventSource connect

  // stream real captured spans as OTLP while the browser is watching
  const trace = JSON.parse(await readFile(join(ROOT, 'traces.json'), 'utf8'));
  const events = trace.events;
  // Interleave: the capture is ordered by scenario (misses, then hits, then fallbacks, then PII),
  // not real arrival timing. Shuffle so a live window carries a representative mix of outcomes.
  for (let k = events.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); const t = events[k]; events[k] = events[j]; events[j] = t; }
  const url = `http://localhost:${SERVER_PORT}/v1/traces`;
  const post = (b) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < 7000) {
    await post(otlpOf(events[i % events.length], i)); i++;
    await sleep(60);
  }
  console.log(`[demo] streamed ${i} OTLP spans`);
  await sleep(800);
  await page.screenshot({ path: OUT });
  const recent = await (await fetch(`http://localhost:${SERVER_PORT}/debug/recent?n=1000`)).json();
  console.log(`[demo] server buffer holds ${recent.length} events; screenshot -> ${OUT}`);
} catch (e) {
  console.log('[demo] FAILED:', e.message.split('\n')[0]); code = 1;
} finally {
  if (browser) await browser.close();
  staticServer.close();
  child.kill();
  process.exit(code);
}

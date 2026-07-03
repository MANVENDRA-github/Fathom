/*
 * M2 drill-down end-to-end proof (real GPU + real network path):
 *   spawns the Fathom server → opens the client in ?source=live&debug=1 → POSTs real captured
 *   spans as OTLP → freezes the river → clicks a real comet on the GPU canvas → asserts the
 *   drill-down readout shows that span's id AND that GET /traces/:id returns its raw attributes.
 *   Screenshots app/m2-drill.png. Then tears everything down.
 *
 *   node server/tools/pick-e2e.mjs [out.png]
 *
 * This closes the loop the unit harness (app/tools/pick-check.ts) can't: it proves the CPU pick
 * math resolves clicks against the ACTUAL shader output on the real GPU, end to end to the server.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '../..');
const OUT = process.argv[2] || join(ROOT, 'app', 'm2-drill.png');
const SERVER_PORT = 4319;
const STATIC_PORT = 8975;
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

// ---- OTLP encoding for real captured events (unique spanId per post) ----
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
    spanId: ('span-' + i).padStart(16, '0').slice(-16), name: 'chat.completion',
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

let browser, code = 0, gpuLine = '';
let failures = 0;
const check = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

try {
  await waitHealth();
  await new Promise((r) => staticServer.listen(STATIC_PORT, r));

  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--force_high_performance_gpu'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', (m) => { const t = m.text(); if (t.includes('[fathom]')) { gpuLine = t; console.log('[page]', t); } });
  await page.goto(`http://localhost:${STATIC_PORT}/?source=live&debug=1`, { waitUntil: 'load' });
  await sleep(1500);   // let EventSource connect

  // stream real captured spans as OTLP while the browser renders them as comets
  const trace = JSON.parse(await readFile(join(ROOT, 'traces.json'), 'utf8'));
  const events = trace.events;
  const postUrl = `http://localhost:${SERVER_PORT}/v1/traces`;
  const post = (b) => fetch(postUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

  // Stream, freeze, and read the visible heads. Retry once if the frame came up empty.
  let heads = [];
  let streamed = 0;
  for (let attempt = 0; attempt < 2 && heads.length === 0; attempt++) {
    await page.evaluate(() => window.__fathom?.pause(false));
    const start = Date.now();
    while (Date.now() - start < 6000) { await post(otlpOf(events[streamed % events.length], streamed)); streamed++; await sleep(60); }
    await sleep(500);
    await page.evaluate(() => window.__fathom?.pause(true));   // freeze so the click lands on a still comet
    await sleep(150);
    heads = await page.evaluate(() => window.__fathom?.heads() ?? []);
  }
  console.log(`[e2e] streamed ${streamed} OTLP spans; ${heads.length} comet heads visible after freeze`);
  check('comet heads are visible', heads.length > 0);

  // Pick a head with an id, nearest screen center, inside a panel-free safe zone.
  const CX = 800, CY = 450;
  const withId = heads.filter((h) => h.id);
  const safe = withId.filter((h) => h.x > 340 && h.x < 1260 && h.y > 150 && h.y < 760);
  const pool = (safe.length ? safe : withId).sort(
    (a, b) => Math.hypot(a.x - CX, a.y - CY) - Math.hypot(b.x - CX, b.y - CY));
  check('a head with a span id is available', pool.length > 0);
  const target = pool[0];

  if (target) {
    // click the comet on the real GPU canvas
    await page.mouse.click(target.x, target.y);
    await page.waitForSelector('.detail', { timeout: 3000 }).catch(() => {});
    const domId = await page.getAttribute('.detail', 'data-span-id').catch(() => null);
    check(`click resolved the clicked comet (id ${target.id})`, domId === target.id);

    // the readout fetched /traces/:id and rendered the raw attributes
    await page.waitForSelector('.detail-attrs .arow', { timeout: 3000 }).catch(() => {});
    const attrRows = await page.locator('.detail-attrs .arow').count().catch(() => 0);
    check('drill-down rendered raw attributes', attrRows > 0);

    // independent server-side confirmation: /traces/:id returns the retained attributes
    const res = await fetch(`http://localhost:${SERVER_PORT}/traces/${encodeURIComponent(target.id)}`);
    const detail = res.ok ? await res.json() : null;
    check('GET /traces/:id → 200', res.ok);
    check('server detail id matches the clicked comet', detail?.id === target.id);
    const nAttrs = detail?.attributes ? Object.keys(detail.attributes).length : 0;
    check('server detail carries raw attributes', nAttrs > 0);
    check('DOM id === server id (full loop consistent)', domId === detail?.id);

    await page.screenshot({ path: OUT });
    const buffered = await (await fetch(`http://localhost:${SERVER_PORT}/debug/recent?n=5000`)).json();
    console.log('\n--- M2 drill-down proof ---');
    console.log(`  GPU:            ${gpuLine.replace('[fathom]', '').trim() || 'unknown'}`);
    console.log(`  OTLP spans:     ${streamed} posted · ${buffered.length} retained in ring`);
    console.log(`  clicked comet:  id=${target.id}  outcome=${target.outcome}  at (${target.x.toFixed(0)},${target.y.toFixed(0)})px`);
    console.log(`  /traces/:id:    ${nAttrs} raw attributes returned`);
    console.log(`  screenshot:     ${OUT}`);
  }

  console.log(`\n${failures === 0 ? 'OK' : failures + ' FAILURES'} — click → correct span → /traces/:id on the real GPU`);
  code = failures === 0 ? 0 : 1;
} catch (e) {
  console.log('[e2e] FAILED:', (e?.message || String(e)).split('\n')[0]); code = 1;
} finally {
  if (browser) await browser.close();
  staticServer.close();
  child.kill();
  process.exit(code);
}

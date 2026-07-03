/*
 * M4 perf proof — measure the river's real per-pass GPU times (compute sim + curl, scene render,
 * bloom chain) with `timestamp-query` on the real GPU, bloom ON then OFF, on the real capture.
 *   npm run build && node app/perf.mjs
 * Prints the PROOF.md §7 table and writes app/m4-richness.png (bloom on, river filled).
 * Windows: powerPreference is ignored (crbug/369219127) — --force_high_performance_gpu selects
 * the discrete GPU; the adapter that actually ran is reported in the table.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const DIST = join(DIR, 'dist');
const OUT = join(DIR, 'm4-richness.png');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    const f = join(DIST, p === '/' ? 'index.html' : decodeURIComponent(p));
    const body = await readFile(f);
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
const PORT = 8974;
await new Promise((r) => server.listen(PORT, r));
console.log(`[perf] serving app/dist at http://localhost:${PORT}`);

const { chromium } = await import('playwright-core');
let browser, code = 0;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--force_high_performance_gpu'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  let ready = false;
  page.on('console', (m) => { const t = m.text(); if (t.includes('[fathom]')) { ready = true; console.log('[page]', t); } });
  page.on('pageerror', (e) => console.log('[page:err]', e.message));
  await page.goto(`http://localhost:${PORT}/?source=real&debug=1`, { waitUntil: 'load' });
  for (let i = 0; i < 60 && !ready; i++) await page.waitForTimeout(100);
  if (!ready) throw new Error('app did not initialize');

  const sample = async (label, bloomOn) => {
    await page.evaluate((on) => { window.__fathom.bloom(on); window.__fathom.perf(true); }, bloomOn);
    await page.waitForTimeout(6000);                       // ~360 rAF frames, ~90 GPU samples
    const p = await page.evaluate(() => window.__fathom.perf());
    if (!p) throw new Error(`no perf samples (${label})`);
    console.log(`[perf] ${label}: ${p.samples} GPU samples · ${p.frames} frame samples · tsq=${p.timestampQuery}`);
    return p;
  };

  await page.waitForTimeout(4500);                          // let the river fill
  const on = await sample('bloom ON', true);
  await page.screenshot({ path: OUT });                     // hero: full richness pass
  console.log('[perf] wrote', OUT);
  const off = await sample('bloom OFF', false);

  const f = (x) => x.toFixed(3).padStart(7);
  console.log('\n--- M4 richness perf (real capture, 1600×900) ---');
  console.log(`  GPU: ${on.gpu}   timestamp-query: ${on.timestampQuery ? 'yes' : 'NO — frame pacing only'}`);
  console.log('  config     | compute | scene   | bloom   | totalGPU | GPU p95 | frame avg | frame p95');
  for (const [label, p] of [['bloom on ', on], ['bloom off', off]]) {
    console.log(`  ${label}  |${f(p.computeMs)} |${f(p.sceneMs)} |${f(p.bloomMs)} |${f(p.totalGpuMs)}  |${f(p.totalP95)} |${f(p.frameAvgMs)}   |${f(p.frameP95Ms)}`);
  }
  console.log(`  budget: 16.7 ms/frame (60fps) — ${on.totalGpuMs < 16.7 ? 'PASS' : 'FAIL'} with bloom on (${(16.7 / Math.max(on.totalGpuMs, 1e-6)).toFixed(1)}× headroom)`);
  if (!on.timestampQuery) console.log('  NOTE: GPU columns unavailable; judge by frame pacing.');
} catch (e) {
  console.log('[perf] FAILED:', e.message.split('\n')[0]); code = 1;
} finally {
  if (browser) await browser.close();
  server.close();
  process.exit(code);
}

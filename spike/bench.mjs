/*
 * Headless-driver for the Fathom spike.
 * Serves the folder on localhost, drives the page with your REAL GPU via the
 * installed Chrome/Edge (playwright-core, channel:'chrome'), runs the auto-sweep,
 * captures the numbers + a screenshot of the 1M-particle river.
 *
 *   npm i -D playwright-core   &&   node bench.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const file = join(DIR, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});

const PORT = 8971;
await new Promise((r) => server.listen(PORT, r));
const base = `http://localhost:${PORT}`;
console.log(`[bench] serving ${DIR} at ${base}`);

const { chromium } = await import('playwright-core');

async function launch() {
  const tries = [
    { channel: 'chrome', headless: false, args: ['--force_high_performance_gpu'] },
    { channel: 'msedge', headless: false, args: ['--force_high_performance_gpu'] },
    { channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] },
  ];
  let lastErr;
  for (const opt of tries) {
    try {
      const b = await chromium.launch(opt);
      console.log(`[bench] launched ${opt.channel} (headless=${opt.headless})`);
      return b;
    } catch (e) { lastErr = e; console.log(`[bench] ${opt.channel} headless=${opt.headless} failed: ${e.message.split('\n')[0]}`); }
  }
  throw lastErr;
}

let browser, exitCode = 0;
try {
  browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page:error]', m.text()); });
  page.on('pageerror', (e) => console.log('[page:exception]', e.message));

  await page.goto(`${base}/?auto=1`, { waitUntil: 'load' });

  // Wait for the sweep to finish (or the page to report an error).
  await page.waitForFunction(
    () => window.__fathomBench && (window.__fathomBench.status === 'done' || window.__fathomBench.status === 'error'),
    null, { timeout: 180000 });

  const data = await page.evaluate(() => window.__fathomBench);

  if (data.status === 'error') {
    console.log('\n[bench] page reported error:', data.error);
    exitCode = 2;
  } else {
    console.log('\n================  FATHOM SPIKE — RESULTS  ================');
    console.log('GPU:', data.adapter?.label, '| timestamp-query:', data.adapter?.timestampQuery);
    console.log('---------------------------------------------------------');
    console.log('  count     fps     frame(ms)   GPU(ms)   verdict');
    for (const r of data.results) {
      const pass = r.fps >= 58 && (r.gpuMs <= 0 || r.gpuMs <= 16.7);
      const c = r.count >= 1e6 ? (r.count / 1e6) + 'M' : (r.count / 1e3) + 'k';
      console.log(`  ${c.padEnd(7)} ${String(r.fps.toFixed(0)).padStart(4)}   ${r.frameMs.toFixed(2).padStart(8)}   ${(r.gpuMs > 0 ? r.gpuMs.toFixed(2) : '—').padStart(7)}   ${pass ? 'PASS' : 'fail'}`);
    }
    console.log('---------------------------------------------------------');
    console.log('VERDICT:', data.verdict?.class?.toUpperCase(), '—', data.verdict?.text);
    console.log('=========================================================\n');

    // Capture the 1M-particle river as a still.
    await page.evaluate(() => window.__fathomSetCount && window.__fathomSetCount(1_000_000));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(DIR, 'river-1M.png') });
    console.log('[bench] screenshot -> river-1M.png');
  }
} catch (e) {
  console.log('[bench] FAILED:', e.message.split('\n')[0]);
  console.log('[bench] Fallback: run  python -m http.server 8971  in this folder, then open');
  console.log('         http://localhost:8971/?auto=1  in Chrome/Edge and read the on-screen verdict.');
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
  process.exit(exitCode);
}

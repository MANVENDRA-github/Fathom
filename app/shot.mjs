/*
 * M0 render check — serve app/dist and screenshot the running cinema on the real GPU.
 *   npm run build && node app/shot.mjs [out.png]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const DIST = join(DIR, 'dist');
const OUT = process.argv[2] || join(DIR, 'm0-app.png');
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
const PORT = 8973;
await new Promise((r) => server.listen(PORT, r));
console.log(`[shot] serving app/dist at http://localhost:${PORT}`);

const { chromium } = await import('playwright-core');
let browser, code = 0;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--force_high_performance_gpu'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  let ready = false;
  page.on('console', (m) => { const t = m.text(); if (t.includes('[fathom]')) ready = true; console.log('[page:' + m.type() + ']', t); });
  page.on('pageerror', (e) => console.log('[page:err]', e.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  for (let i = 0; i < 40 && !ready; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(4500);       // let the river fill
  await page.screenshot({ path: OUT });
  console.log('[shot] wrote', OUT);
} catch (e) {
  console.log('[shot] FAILED:', e.message.split('\n')[0]); code = 1;
} finally {
  if (browser) await browser.close();
  server.close();
  process.exit(code);
}

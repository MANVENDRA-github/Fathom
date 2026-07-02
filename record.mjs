/*
 * record.mjs — capture the Fathom cinema to a video (+ hero still) on the real GPU.
 *   node record.mjs [dataFile=traces.json] [outPrefix=fathom-river] [seconds=18]
 * Produces <prefix>.webm and <prefix>.png; if ffmpeg is present, also .mp4 and .gif.
 */
import { createServer } from 'node:http';
import { readFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = dirname(fileURLToPath(import.meta.url));
const [, , DATA = 'traces.json', PREFIX = 'fathom-river', SECS = '18'] = process.argv;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    const body = await readFile(join(DIR, p === '/' ? 'fathom.html' : decodeURIComponent(p)));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
const PORT = 8972;
await new Promise((r) => server.listen(PORT, r));
console.log(`[record] serving at http://localhost:${PORT}  data=${DATA}`);

const { chromium } = await import('playwright-core');
let browser, ctx, code = 0;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--force_high_performance_gpu'] });
  ctx = await browser.newContext({ viewport: { width: 1600, height: 900 },
    recordVideo: { dir: join(DIR, '.rec'), size: { width: 1600, height: 900 } } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[page:err]', e.message));
  page.on('console', (m) => console.log('[page:' + m.type() + ']', m.text()));
  await page.goto(`http://localhost:${PORT}/fathom.html?data=${encodeURIComponent(DATA)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__fathomReady === true || window.__fathomError, null, { timeout: 30000 });
  const err = await page.evaluate(() => window.__fathomError);
  if (err) throw new Error('page: ' + err);

  const secs = +SECS;
  await page.waitForTimeout(Math.round(secs * 0.5 * 1000));       // let the river fill
  await page.screenshot({ path: join(DIR, `${PREFIX}.png`) });
  console.log(`[record] hero -> ${PREFIX}.png`);
  await page.waitForTimeout(Math.round(secs * 0.5 * 1000));

  const video = page.video();
  await ctx.close();                                              // finalizes the video
  const vp = await video.path();
  await rename(vp, join(DIR, `${PREFIX}.webm`));
  await rm(join(DIR, '.rec'), { recursive: true, force: true });
  console.log(`[record] video -> ${PREFIX}.webm`);

  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  if (hasFfmpeg) {
    const webm = join(DIR, `${PREFIX}.webm`);
    spawnSync('ffmpeg', ['-y', '-i', webm, '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:-2', join(DIR, `${PREFIX}.mp4`)], { stdio: 'ignore' });
    const pal = join(DIR, `${PREFIX}.pal.png`);
    spawnSync('ffmpeg', ['-y', '-i', webm, '-vf', 'fps=24,scale=900:-1:flags=lanczos,palettegen', pal], { stdio: 'ignore' });
    spawnSync('ffmpeg', ['-y', '-i', webm, '-i', pal, '-lavfi', 'fps=24,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse', join(DIR, `${PREFIX}.gif`)], { stdio: 'ignore' });
    await rm(pal, { force: true });
    console.log(`[record] ffmpeg -> ${PREFIX}.mp4, ${PREFIX}.gif`);
  } else {
    console.log('[record] ffmpeg not found — webm only (still fine to share).');
  }
} catch (e) {
  console.log('[record] FAILED:', e.message.split('\n')[0]); code = 1;
} finally {
  if (ctx) { try { await ctx.close(); } catch {} }
  if (browser) await browser.close();
  server.close();
  process.exit(code);
}

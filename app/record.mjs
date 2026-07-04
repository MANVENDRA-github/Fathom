/*
 * app/record.mjs — capture the *new* Fathom cinema (app/dist) to a demo clip on the real GPU.
 *   npm run build && npm run app:record   [outPrefix=fathom-demo] [seconds=14] [source=real]
 * Produces app/<prefix>.webm + app/<prefix>.png; if ffmpeg is present, also .mp4 and .gif.
 *
 * This is the M5 hero-clip recorder. It differs from the root record.mjs (which targets the
 * legacy fathom.html): it serves the built app/dist, waits on the new app's `[fathom]` console
 * ready signal, and drives ?source=<real|sample> — the labeled client-side replay (HUD reads
 * "requests replayed"), i.e. real captured sentinel spans, replayed. No manipulation beyond that.
 *
 * The gif is ~16fps for size; the demo itself runs at 60fps (PROOF.md §7) and the .mp4/.webm carry
 * the full framerate. Windows: powerPreference is ignored (crbug/369219127) —
 * --force_high_performance_gpu selects the discrete GPU (the RTX 4070 on the dev box).
 */
import { createServer } from 'node:http';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = dirname(fileURLToPath(import.meta.url));
const DIST = join(DIR, 'dist');
const [, , PREFIX = 'fathom-demo', SECS = '14', SOURCE = 'real'] = process.argv;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';   // override if ffmpeg isn't on PATH (e.g. fresh winget install)
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
const PORT = 8976;
await new Promise((r) => server.listen(PORT, r));
console.log(`[record] serving app/dist at http://localhost:${PORT}  source=${SOURCE}`);

const { chromium } = await import('playwright-core');
let browser, ctx, code = 0;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--force_high_performance_gpu'] });
  ctx = await browser.newContext({ viewport: { width: 1600, height: 900 },
    recordVideo: { dir: join(DIR, '.rec'), size: { width: 1600, height: 900 } } });
  const page = await ctx.newPage();
  let ready = false;
  page.on('console', (m) => { const t = m.text(); if (t.includes('[fathom]')) { ready = true; console.log('[page]', t); } });
  page.on('pageerror', (e) => console.log('[page:err]', e.message));
  await page.goto(`http://localhost:${PORT}/?source=${SOURCE}`, { waitUntil: 'load' });
  for (let i = 0; i < 60 && !ready; i++) await page.waitForTimeout(100);
  if (!ready) throw new Error('app did not initialize');

  const secs = +SECS;
  await page.waitForTimeout(4500);                          // let the river fill
  await page.screenshot({ path: join(DIR, `${PREFIX}.png`) });
  console.log(`[record] hero still -> ${PREFIX}.png`);
  await page.waitForTimeout(Math.round(secs * 1000));

  const video = page.video();
  await ctx.close();                                        // finalizes the video
  const vp = await video.path();
  const webm = join(DIR, `${PREFIX}.webm`);
  await rename(vp, webm);
  await rm(join(DIR, '.rec'), { recursive: true, force: true });
  console.log(`[record] video -> ${PREFIX}.webm`);

  const hasFfmpeg = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;
  if (hasFfmpeg) {
    const mp4 = join(DIR, `${PREFIX}.mp4`);
    spawnSync(FFMPEG, ['-y', '-i', webm, '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:-2', mp4], { stdio: 'ignore' });
    // README-hero recipe: dense full-screen particle motion is worst-case for gif, so trade
    // framerate/size for weight — 16fps · 760px · 128 colors · 8s keeps it ~6-7 MB (GitHub-friendly).
    // The .mp4/.webm carry the full framerate; the README states the gif is ~16fps.
    const pal = join(DIR, `${PREFIX}.pal.png`);
    const gifVf = 'fps=16,scale=760:-1:flags=lanczos';
    spawnSync(FFMPEG, ['-y', '-t', '8', '-i', webm, '-vf', `${gifVf},palettegen=stats_mode=diff:max_colors=128`, pal], { stdio: 'ignore' });
    const gif = join(DIR, `${PREFIX}.gif`);
    spawnSync(FFMPEG, ['-y', '-t', '8', '-i', webm, '-i', pal, '-lavfi', `${gifVf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`, gif], { stdio: 'ignore' });
    await rm(pal, { force: true });
    const sizes = await Promise.all([webm, mp4, gif].map(async (f) => {
      try { return `${f.split(/[\\/]/).pop()} ${(((await stat(f)).size) / 1e6).toFixed(2)} MB`; } catch { return `${f} (missing)`; }
    }));
    console.log(`[record] ffmpeg -> ${PREFIX}.mp4, ${PREFIX}.gif`);
    console.log('[record] outputs: ' + sizes.join(' · '));
  } else {
    console.log('[record] ffmpeg not found — webm only. Install ffmpeg for .gif/.mp4 (e.g. winget install Gyan.FFmpeg).');
  }
} catch (e) {
  console.log('[record] FAILED:', e.message.split('\n')[0]); code = 1;
} finally {
  if (ctx) { try { await ctx.close(); } catch {} }
  if (browser) await browser.close();
  server.close();
  process.exit(code);
}

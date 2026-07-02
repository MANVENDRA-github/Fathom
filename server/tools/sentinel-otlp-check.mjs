/*
 * Definitive M1 proof: start the Fathom server, run the REAL sentinel gateway with its OTLP
 * exporter pointed at Fathom, and assert real spans (cache/fallback/PII) arrive. Copies the
 * reference harness into <sentinel>/load/, runs it via sentinel's tsx, then deletes it.
 *
 *   node server/tools/sentinel-otlp-check.mjs [sentinelDir=D:/sentinel]
 */
import { spawn } from 'node:child_process';
import { copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '../..');
const SENTINEL = process.argv[2] || 'D:/sentinel';
const PORT = 4319;
const OTLP = `http://localhost:${PORT}/v1/traces`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sentinelTsx = join(SENTINEL, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const tempHarness = join(SENTINEL, 'load', '_fathom_otlp.ts');
const fathomTsx = join(ROOT, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!existsSync(sentinelTsx)) { console.log(`[check] sentinel tsx not found at ${SENTINEL} — SKIP (run \`pnpm install\` in sentinel).`); process.exit(0); }

const server = spawn(process.execPath, [fathomTsx, join(ROOT, 'server', 'src', 'index.ts')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit',
});

async function waitHealth() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch { /* */ } await sleep(200); }
  throw new Error('server not healthy');
}

let code = 0;
try {
  await waitHealth();
  await copyFile(join(DIR, 'sentinel-otlp-harness.ts'), tempHarness);
  console.log('[check] running real sentinel gateway → OTLP → Fathom …');
  await new Promise((resolve, reject) => {
    const h = spawn(process.execPath, [sentinelTsx, tempHarness], {
      cwd: SENTINEL, env: { ...process.env, FATHOM_OTLP: OTLP }, stdio: 'inherit',
    });
    h.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('harness exit ' + c))));
    h.on('error', reject);
  });
  await sleep(1500); // allow the final OTLP batch to arrive

  const recent = await (await fetch(`http://localhost:${PORT}/debug/recent?n=1000`)).json();
  const cache = recent.filter((e) => e.cacheHit).length;
  const fb = recent.filter((e) => e.fallbackUsed).length;
  const pii = recent.filter((e) => e.pii).length;
  console.log(`\n[check] Fathom received ${recent.length} REAL spans via OTLP: cache=${cache} fallback=${fb} pii=${pii}`);
  const ok = recent.length > 0 && cache > 0 && fb > 0 && pii > 0;
  console.log(ok ? '[check] PASS — real sentinel spans rendered-ready in Fathom' : '[check] FAIL — expected cache/fallback/pii > 0');
  if (!ok) code = 1;
} catch (e) {
  console.log('[check] FAILED:', e.message.split('\n')[0]); code = 1;
} finally {
  await rm(tempHarness, { force: true });
  server.kill();
  process.exit(code);
}

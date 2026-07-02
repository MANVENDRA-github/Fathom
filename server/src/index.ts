import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Hub } from './hub';
import { parseOtlp, type OtlpBody } from './otlp';
import { startReplay } from './replay';
import { startPoller } from './poller';

/**
 * Fathom server (M1): generic OTLP/HTTP receiver + SSE live stream.
 *   POST /v1/traces   OTLP/HTTP JSON  (point any OTel gateway here via OTEL_EXPORTER_OTLP_ENDPOINT)
 *   GET  /stream      Server-Sent Events: {type:'snapshot'|'span'|'judge'}
 *   GET  /debug/recent?n=  the ring buffer as JSON (tests)
 *   GET  /health
 * Optional: REPLAY_FILE (demo), SENTINEL_TRACES_URL + SENTINEL_ADMIN_KEY (judge-score poller).
 */

const PORT = Number(process.env.PORT ?? 4319);
const hub = new Hub(Number(process.env.BUFFER ?? 2000));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

function cors(res: ServerResponse) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type,authorization');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}

const server = createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url ?? '/', 'http://x');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && url.pathname === '/v1/traces') {
    try {
      const body = await readBody(req);
      const events = parseOtlp(JSON.parse(body || '{}') as OtlpBody);
      hub.ingest(events);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      if (events.length) console.log(`[otlp] +${events.length} span(s)  buffer=${hub.size} clients=${hub.clientCount}`);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/stream') { hub.addClient(res); return; }

  if (req.method === 'GET' && url.pathname === '/debug/recent') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hub.recent(Number(url.searchParams.get('n') ?? 100))));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[fathom-server] http://localhost:${PORT}  (OTLP POST /v1/traces · SSE /stream)`);
});

if (process.env.REPLAY_FILE) {
  startReplay(hub, process.env.REPLAY_FILE, Number(process.env.REPLAY_MS ?? 120))
    .then((n) => console.log(`[replay] streaming ${n} events from ${process.env.REPLAY_FILE}`))
    .catch((e) => console.error('[replay] failed:', e));
}
if (process.env.SENTINEL_TRACES_URL && process.env.SENTINEL_ADMIN_KEY) {
  startPoller(hub, process.env.SENTINEL_TRACES_URL, process.env.SENTINEL_ADMIN_KEY, Number(process.env.POLL_MS ?? 2000));
  console.log(`[poller] enabled → ${process.env.SENTINEL_TRACES_URL}`);
}

import type { ServerResponse } from 'node:http';
import type { TraceEvent, StreamMessage } from '../../shared/schema';

/**
 * The live core: a bounded ring buffer of recent spans + a set of SSE clients.
 * New clients get a `snapshot`, then every ingested span is broadcast as it arrives.
 */
export class Hub {
  private buf: TraceEvent[] = [];
  private clients = new Set<ServerResponse>();

  constructor(private max = 2000) {
    // heartbeat so proxies/browsers keep the SSE connection open
    setInterval(() => this.raw(':\n\n'), 20_000).unref();
  }

  get size() { return this.buf.length; }
  get clientCount() { return this.clients.size; }

  ingest(events: TraceEvent[]) {
    for (const event of events) {
      this.buf.push(event);
      if (this.buf.length > this.max) this.buf.shift();
      this.broadcast({ type: 'span', event });
    }
  }

  judge(id: string, judgeScore: number) {
    this.broadcast({ type: 'judge', id, judgeScore });
  }

  recent(n = 500): TraceEvent[] {
    return this.buf.slice(-n);
  }

  addClient(res: ServerResponse) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(': connected\n\n');
    this.send(res, { type: 'snapshot', events: this.recent() });
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  private send(res: ServerResponse, msg: StreamMessage) {
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  private broadcast(msg: StreamMessage) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    this.raw(line);
  }

  private raw(line: string) {
    for (const c of this.clients) {
      try { c.write(line); } catch { this.clients.delete(c); }
    }
  }
}

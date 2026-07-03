import type { ServerResponse } from 'node:http';
import type { TraceEvent, SpanDetail, StreamMessage } from '../../shared/schema';

/** The lean view sent over SSE: the normalized event WITHOUT the retained raw attributes/name. */
function streamView(e: SpanDetail): TraceEvent {
  const rest = { ...e };
  delete (rest as Partial<SpanDetail>).attributes;
  delete (rest as Partial<SpanDetail>).name;
  return rest;
}

/**
 * The live core: a bounded ring buffer of recent spans + a set of SSE clients.
 * New clients get a `snapshot`, then every ingested span is broadcast as it arrives.
 * Full spans (with raw attributes) are retained in `byId` for M2 drill-down (`GET /traces/:id`);
 * the SSE stream carries only the lean `streamView` so frames stay small.
 */
export class Hub {
  private buf: SpanDetail[] = [];
  private byId = new Map<string, SpanDetail>();
  private clients = new Set<ServerResponse>();

  constructor(private max = 2000) {
    // heartbeat so proxies/browsers keep the SSE connection open
    setInterval(() => this.raw(':\n\n'), 20_000).unref();
  }

  get size() { return this.buf.length; }
  get clientCount() { return this.clients.size; }

  ingest(events: SpanDetail[]) {
    for (const event of events) {
      this.buf.push(event);
      if (event.id) this.byId.set(event.id, event);   // last-write-wins (replay repeats ids)
      if (this.buf.length > this.max) {
        const evicted = this.buf.shift();
        // only drop the index entry if it still points at the evicted object
        if (evicted?.id && this.byId.get(evicted.id) === evicted) this.byId.delete(evicted.id);
      }
      this.broadcast({ type: 'span', event: streamView(event) });
    }
  }

  judge(id: string, judgeScore: number) {
    this.broadcast({ type: 'judge', id, judgeScore });
  }

  /** Full span (incl. raw attributes) by id, for drill-down. Undefined if evicted/unknown. */
  getById(id: string): SpanDetail | undefined {
    return this.byId.get(id);
  }

  recent(n = 500): TraceEvent[] {
    return this.buf.slice(-n).map(streamView);
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

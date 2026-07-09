/**
 * Fathom normalized telemetry schema — the ingestion contract boundary.
 * The renderer consumes ONLY these types; any source (OTLP receiver, sentinel poller,
 * a replayed file) is just a mapper to `NormalizedTrace`. Imported by `app/` and (M1) `server/`.
 */

export type Guardrail = 'pass' | 'flag' | 'block' | null;

/** One normalized gateway request. */
export interface TraceEvent {
  /** stable id (span id) — optional until the OTLP/poller path fills it (M1/M2 drill-down). */
  id?: string;
  /**
   * File/replay path: ms from the first event in the trace (`ingest.mjs` relativizes to t0).
   * Live server path (OTLP/poller): absolute epoch ms — there is no single trace t0 in a
   * streaming ring buffer; live consumers position comets by arrival time, not `t`.
   */
  t: number;
  model: string | null;
  provider: string | null;
  status: number;
  latencyMs: number | null;
  tokens: number | null;
  costUsd: number | null;
  cacheHit: boolean;
  fallbackUsed: boolean;
  guardrail: Guardrail;
  pii: boolean;
  piiCategories: string[];
}

/**
 * A `TraceEvent` plus the raw source attributes retained server-side for drill-down (M2).
 * Returned by `GET /traces/:id`; the SSE stream deliberately sends the lean `TraceEvent`
 * (no `attributes`/`name`) so high-frequency frames stay small and `/traces/:id` is the
 * single source of truth for a span's real attributes.
 */
export interface SpanDetail extends TraceEvent {
  /** span name (OTLP `span.name`, e.g. "chat.completion"). */
  name?: string;
  /** raw source attributes (`gen_ai.*`, `sentinel.*`, `http.*`, …), verbatim from the source. */
  attributes?: Record<string, string | number | boolean>;
}

export interface TraceMeta {
  source: string;
  count: number;
  durationMs: number;
  cacheHitRate: number;
  fallbacks: number;
  piiBlocked: number;
  models: string[];
}

export interface NormalizedTrace {
  meta: TraceMeta;
  events: TraceEvent[];
}

/** Live-stream envelope (used by the M1 server + client transport). */
export type StreamMessage =
  | { type: 'snapshot'; meta?: Partial<TraceMeta>; events: TraceEvent[] }
  | { type: 'span'; event: TraceEvent }
  | { type: 'judge'; id: string; judgeScore: number };

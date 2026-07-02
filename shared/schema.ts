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
  /** ms from the first event in the trace. */
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

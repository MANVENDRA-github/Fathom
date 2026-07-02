import type { Hub } from './hub';
import type { TraceEvent, Guardrail } from '../../shared/schema';

/**
 * Optional sentinel adapter: poll GET /traces?since=<cursor> to enrich the stream with
 * LLM-judge scores (which never reach the OTLP span). Also ingests any traces the OTLP
 * path missed. Cursor discipline: trail by a safety window, dedupe by id (sentinel's
 * `since` is inclusive + start-time based). Enabled only when SENTINEL_TRACES_URL is set.
 */

/** sentinel TraceRecord → normalized TraceEvent (mirrors ingest.mjs). */
function recordToEvent(r: Record<string, unknown>): TraceEvent {
  const viol = String(r.guardrailViolations ?? '');
  const piiCategories = viol ? viol.split(',').map((s) => s.trim()).filter((s) => s.startsWith('pii.')) : [];
  const total = (r.totalTokens as number | null) ?? null;
  const sum = ((r.promptTokens as number) || 0) + ((r.completionTokens as number) || 0);
  return {
    id: r.id as string,
    t: (r.timestamp as number) ?? 0,
    model: (r.routedModel as string) || (r.model as string) || null,
    provider: (r.routedProvider as string) || (r.provider as string) || null,
    status: (r.status as number) ?? 0,
    latencyMs: (r.durationMs as number) ?? null,
    tokens: total ?? (sum || null),
    costUsd: (r.costUsd as number | null) ?? null,
    cacheHit: r.cacheHit === true,
    fallbackUsed: r.fallbackUsed === true,
    guardrail: ((r.guardrailStatus as string) ?? null) as Guardrail,
    pii: piiCategories.length > 0 || r.guardrailStatus === 'block',
    piiCategories,
  };
}

export function startPoller(hub: Hub, baseUrl: string, adminKey: string, pollMs = 2000) {
  let cursor = 0;
  const seen = new Map<string, number>();   // id -> timestamp, pruned to the trailing window
  const SAFETY_MS = 5000;
  const timer = setInterval(async () => {
    try {
      const since = Math.max(0, cursor - SAFETY_MS);
      const res = await fetch(`${baseUrl}/traces?since=${since}&limit=500`, {
        headers: { authorization: `Bearer ${adminKey}` },
      });
      if (!res.ok) return;
      const records = (await res.json()) as Array<Record<string, unknown>>;
      const fresh: TraceEvent[] = [];
      for (const r of records) {
        const id = r.id as string;
        const ts = (r.timestamp as number) ?? 0;
        if (ts > cursor) cursor = ts;
        if (id && !seen.has(id)) {
          seen.set(id, ts);
          fresh.push(recordToEvent(r));
        } else if (id && r.judgeScore != null) {
          hub.judge(id, r.judgeScore as number); // late-arriving judge verdict
        }
      }
      if (fresh.length) hub.ingest(fresh);
      // prune ids that can no longer be returned by `since` (bounds memory on a long-running server)
      const cutoff = cursor - 4 * SAFETY_MS;
      for (const [k, v] of seen) if (v < cutoff) seen.delete(k);
    } catch {
      /* transient poll error — try again next tick */
    }
  }, pollMs);
  timer.unref();
}

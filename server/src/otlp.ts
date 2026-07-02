import type { TraceEvent, Guardrail } from '../../shared/schema';

/**
 * OTLP/HTTP JSON → normalized TraceEvent[].
 * This is the generic front-door: any OTel gateway that exports OTLP works. sentinel's
 * `sentinel.*` + `gen_ai.*` span attributes arrive verbatim (confirmed against sentinel).
 */

type OtlpValue = { stringValue?: string; boolValue?: boolean; intValue?: string | number; doubleValue?: number };
type OtlpAttr = { key: string; value?: OtlpValue };
type OtlpSpan = {
  spanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpAttr[];
  status?: { code?: number };
};
export type OtlpBody = { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }> };

function attrValue(v?: OtlpValue): string | number | boolean | undefined {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);      // int64 encoded as string in OTLP/JSON
  if (v.doubleValue !== undefined) return v.doubleValue;
  return undefined;
}

function attrMap(list?: OtlpAttr[]): Record<string, string | number | boolean | undefined> {
  const m: Record<string, string | number | boolean | undefined> = {};
  for (const a of list ?? []) m[a.key] = attrValue(a.value);
  return m;
}

function nanoToMs(n?: string | number): number {
  if (n === undefined) return 0;
  return Number(BigInt(String(n).split('.')[0])) / 1e6;
}

export function spanToEvent(span: OtlpSpan): TraceEvent {
  const a = attrMap(span.attributes);
  const start = nanoToMs(span.startTimeUnixNano);
  const end = nanoToMs(span.endTimeUnixNano);
  const viol = String(a['sentinel.guardrail_violations'] ?? '');
  const piiCategories = viol ? viol.split(',').map((s) => s.trim()).filter((s) => s.startsWith('pii.')) : [];
  return {
    id: span.spanId,
    t: start,
    model: (a['sentinel.routed_model'] ?? a['gen_ai.request.model'] ?? null) as string | null,
    provider: (a['sentinel.routed_provider'] ?? a['sentinel.provider'] ?? null) as string | null,
    status: Number(a['http.response.status_code'] ?? 0),
    latencyMs: end > start ? Math.round((end - start) * 1000) / 1000 : null,
    tokens: (a['gen_ai.usage.total_tokens'] as number | undefined) ?? null,
    costUsd: (a['sentinel.cost_usd'] as number | undefined) ?? null,
    cacheHit: a['sentinel.cache_hit'] === true,
    fallbackUsed: a['sentinel.fallback_used'] === true,
    guardrail: (a['sentinel.guardrail_status'] ?? null) as Guardrail,
    pii: piiCategories.length > 0 || a['sentinel.guardrail_status'] === 'block',
    piiCategories,
  };
}

export function parseOtlp(body: OtlpBody): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const rs of body.resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? [])
      for (const sp of ss.spans ?? [])
        out.push(spanToEvent(sp));
  return out;
}

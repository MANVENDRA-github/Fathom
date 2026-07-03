import type { ReactNode } from 'react';
import type { TraceEvent, SpanDetail as SpanDetailData } from '@shared/schema';
import type { Outcome } from '../data/classify';

const OUTCOME_LABEL: Record<Outcome, string> = {
  pii: 'PII / blocked',
  cache: 'cache hit',
  fallback: 'fallback',
  span: 'request',
};

function Row({ k, v }: { k: string; v: ReactNode }) {
  return <div className="metric"><span className="k">{k}</span><span className="v">{v}</span></div>;
}

/**
 * Minimal drill-down readout for a clicked comet (M2 "the Math" slice).
 * Shows the normalized fields it always has, plus the raw source attributes when the live
 * `/traces/:id` fetch supplies them. Deliberately plain — the rich visual panel is the Fable
 * pass (see SPEC model policy); this is the correct-data seam it will restyle.
 */
export function SpanDetail({ event, outcome, detail, loading, onClose }: {
  event: TraceEvent;
  outcome: Outcome;
  detail: SpanDetailData | null;
  loading: boolean;
  onClose: () => void;
}) {
  const attrs = detail?.attributes ? Object.entries(detail.attributes) : [];
  const num = (n: number | null, suffix = '') => (n == null ? '—' : `${n}${suffix}`);

  return (
    <div className="detail panel" data-span-id={event.id ?? ''}>
      <div className="detail-head">
        <span className={`otag ${outcome}`}>{OUTCOME_LABEL[outcome]}</span>
        <button className="x" onClick={onClose} aria-label="close">✕</button>
      </div>
      <div className="detail-title">{detail?.name ?? event.model ?? 'span'}</div>

      <Row k="model" v={event.model ?? '—'} />
      <Row k="provider" v={event.provider ?? '—'} />
      <Row k="status" v={event.status} />
      <Row k="latency" v={num(event.latencyMs, ' ms')} />
      <Row k="tokens" v={num(event.tokens)} />
      <Row k="cost" v={event.costUsd == null ? '—' : `$${event.costUsd.toFixed(6)}`} />
      <Row k="cache" v={event.cacheHit ? 'hit' : 'miss'} />
      <Row k="fallback" v={event.fallbackUsed ? 'yes' : 'no'} />
      <Row k="pii" v={event.pii ? (event.piiCategories.join(', ') || 'yes') : 'no'} />
      {event.id && <Row k="span id" v={<code>{event.id}</code>} />}

      <div className="detail-attrs">
        {loading && <div className="muted">loading attributes…</div>}
        {!loading && attrs.length === 0 && (
          <div className="muted">no raw attributes (static replay source — live mode fetches /traces/:id)</div>
        )}
        {attrs.map(([k, v]) => (
          <div className="arow" key={k}><span className="ak">{k}</span><span className="av">{String(v)}</span></div>
        ))}
      </div>
    </div>
  );
}

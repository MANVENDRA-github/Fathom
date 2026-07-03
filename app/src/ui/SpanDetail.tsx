import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { TraceEvent, SpanDetail as SpanDetailData } from '@shared/schema';
import type { Outcome } from '../data/classify';

/** The exact hues classify.ts/Legend use — the caught comet's color becomes the panel's light. */
const ACCENT: Record<Outcome, string> = {
  pii: '#ff3140',
  cache: '#1cffb8',
  fallback: '#ffad21',
  span: '#3880ff',
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  pii: 'pii · blocked',
  cache: 'cache hit',
  fallback: 'fallback',
  span: 'request',
};

function Row({ k, v, tone }: { k: string; v: ReactNode; tone?: 'hot' | 'bad' }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className={`v${tone ? ` ${tone}` : ''}`}>{v}</span>
    </div>
  );
}

function Sec({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sec">
      <div className="eyebrow">{label}</div>
      {children}
    </div>
  );
}

/** Dim the telemetry namespace (`gen_ai.` / `sentinel.` / `http.`) so the leaf key reads first. */
function AttrKey({ k }: { k: string }) {
  const i = k.lastIndexOf('.');
  if (i <= 0) return <span className="ak">{k}</span>;
  return <span className="ak"><span className="ns">{k.slice(0, i + 1)}</span>{k.slice(i + 1)}</span>;
}

/**
 * Drill-down callout for a picked comet (M2, Fable pass).
 * A reticle marks the caught comet, a leader line ties it to this card, and the card is lit
 * by the outcome's color — the same hue its lane and legend dot use. Sections mirror the data
 * contract: normalized fields (always present) vs raw attributes (live `GET /traces/:id` only).
 */
export function SpanDetail({ event, outcome, detail, loading, live, screen, onClose }: {
  event: TraceEvent;
  outcome: Outcome;
  detail: SpanDetailData | null;
  loading: boolean;
  live: boolean;
  screen: { x: number; y: number };
  onClose: () => void;
}) {
  const accent = { '--accent': ACCENT[outcome] } as CSSProperties;
  const panelRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Track the card's rect (its height changes as attributes load) for the leader line.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const measure = () => setRect(el.getBoundingClientRect());
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const attrs = detail?.attributes ? Object.entries(detail.attributes) : [];
  const num = (n: number | null, suffix = '') => (n == null ? '—' : `${n}${suffix}`);
  // Park the card on the opposite side from the comet so the callout never hides its subject.
  const side = screen.x > window.innerWidth / 2 ? 'at-left' : 'at-right';

  // Leader line: anchor to whichever card edge faces the comet (bottom or side); none if hidden.
  const clampN = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  let anchor: { x: number; y: number } | null = null;
  if (rect) {
    if (screen.y > rect.bottom + 18) anchor = { x: clampN(screen.x, rect.left + 24, rect.right - 24), y: rect.bottom };
    else if (screen.x > rect.right + 18) anchor = { x: rect.right, y: clampN(screen.y, rect.top + 16, rect.bottom - 16) };
    else if (screen.x < rect.left - 18) anchor = { x: rect.left, y: clampN(screen.y, rect.top + 16, rect.bottom - 16) };
  }
  // nudge the endpoint 3px out from the edge, toward the comet
  const d = anchor ? Math.hypot(screen.x - anchor.x, screen.y - anchor.y) || 1 : 1;
  const end = anchor ? { x: anchor.x + (screen.x - anchor.x) / d * 3, y: anchor.y + (screen.y - anchor.y) / d * 3 } : null;

  return (
    <>
      {end && (
        <svg className="leader" style={accent} aria-hidden="true">
          <line x1={screen.x} y1={screen.y} x2={end.x} y2={end.y} pathLength={1} />
          <circle cx={end.x} cy={end.y} r="2" />
        </svg>
      )}
      <div className="reticle" style={{ ...accent, left: screen.x, top: screen.y }} />
      <div
        ref={panelRef}
        className={`detail panel ${outcome} ${side}`}
        style={accent}
        data-span-id={event.id ?? ''}
        role="dialog"
        aria-label="span detail"
      >
        <div className="detail-head">
          <span className="otag">{OUTCOME_LABEL[outcome]}</span>
          <button className="x" onClick={onClose} aria-label="close">✕</button>
        </div>
        <div className="detail-title">{detail?.name ?? event.model ?? 'span'}</div>

        <Sec label="route">
          <Row k="model" v={event.model ?? '—'} />
          <Row k="provider" v={event.provider ?? '—'} />
          {event.id && <Row k="span id" v={<code>{event.id}</code>} />}
        </Sec>

        <Sec label="outcome">
          <Row k="status" v={event.status} tone={event.status >= 400 ? 'bad' : undefined} />
          {event.guardrail && <Row k="guardrail" v={event.guardrail} tone={event.guardrail === 'block' ? 'bad' : undefined} />}
          <Row k="cache" v={event.cacheHit ? 'hit' : 'miss'} tone={event.cacheHit ? 'hot' : undefined} />
          <Row k="fallback" v={event.fallbackUsed ? 'yes' : 'no'} tone={event.fallbackUsed ? 'hot' : undefined} />
          <Row k="pii" v={event.pii ? (event.piiCategories.join(', ') || 'yes') : 'no'} tone={event.pii ? 'hot' : undefined} />
        </Sec>

        <Sec label="usage">
          <Row k="latency" v={num(event.latencyMs, ' ms')} />
          <Row k="tokens" v={num(event.tokens)} />
          <Row k="cost" v={event.costUsd == null ? '—' : `$${event.costUsd.toFixed(6)}`} />
        </Sec>

        <div className="sec detail-attrs">
          <div className="eyebrow">{live ? 'raw attributes · /traces/:id' : 'raw attributes'}</div>
          {loading && <div className="muted">fetching /traces/:id…</div>}
          {!loading && attrs.length === 0 && (live && event.id
            ? <div className="muted">span left the ring buffer — raw attributes unavailable</div>
            : <div className="muted">static replay file — raw attributes stream in live mode</div>
          )}
          {attrs.map(([k, v]) => (
            <div className="arow" key={k}><AttrKey k={k} /><span className="av">{String(v)}</span></div>
          ))}
        </div>
      </div>
    </>
  );
}

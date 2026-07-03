import type { CostMetric, CostModel } from '../data/cost';

/**
 * Flame legend (M3) — the numeric truth beside the 3D flame. The canvas renders the bars; this
 * right-docked panel carries the exact values, the metric toggle, and the honest states. Hovering
 * a bar in 3D lights its row here (`hotKey`); clicking a bar scrolls its row into view.
 */

const METRICS: CostMetric[] = ['cost', 'tokens', 'requests'];

export function fmt(v: number, metric: CostMetric): string {
  if (metric === 'cost') return v === 0 ? '$0' : `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
  return Math.round(v).toLocaleString();
}
const rgb = (c: [number, number, number]) => `rgb(${c.map((x) => Math.round(x * 255)).join(', ')})`;

export function FlameView({ model, metric, onMetric, loading, hotKey }: {
  model: CostModel;
  metric: CostMetric;
  onMetric: (m: CostMetric) => void;
  loading?: boolean;
  hotKey?: string | null;
}) {
  const empty = model.providers.length === 0;
  const hot = (key: string) => (hotKey === key ? ' hot' : '');

  return (
    <div className="flame panel" data-total-cost={model.totals.cost}>
      <div className="flame-head">
        <div>
          <div className="flame-title">{metric} by provider → model</div>
          <div className="flame-total"><b>{fmt(model.total, metric)}</b> <span className="k">total {metric}</span></div>
        </div>
      </div>
      <div className="flame-metrics">
        {METRICS.map((m) => (
          <button key={m} className={metric === m ? 'active' : ''} onClick={() => onMetric(m)}>{m}</button>
        ))}
      </div>

      {loading && <div className="muted">loading live buffer…</div>}
      {!loading && empty && <div className="muted">no spans yet — data will appear as it arrives</div>}
      {!loading && !empty && (
        <>
          {model.unpriced && (
            <div className="flame-note">
              no cost captured for this source (<code>costUsd</code> is null) — bars show request volume.
              switch to <button className="linkish" onClick={() => onMetric('tokens')}>tokens</button>.
            </div>
          )}
          <div className="flame-table">
            {model.providers.map((p) => (
              <div className="ftgroup" key={p.key}>
                <div className={`ftrow ftp${hot(p.key)}`} data-key={p.key}>
                  <span className="dot" style={{ background: rgb(p.color) }} />
                  <span className="ftlabel">{p.label}</span>
                  <span className="ftv">{fmt(p.value, metric)}</span>
                  <span className="ftpct">{Math.round(p.share * 100)}%</span>
                </div>
                {p.children.map((m) => (
                  <div className={`ftrow ftm${hot(m.key)}`} data-key={m.key} key={m.key}>
                    <span className="dot" style={{ background: rgb(m.color) }} />
                    <span className="ftlabel">{m.label}</span>
                    <span className="ftv">{fmt(m.value, metric)}</span>
                    <span className="ftpct">{Math.round(m.share * 100)}%</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="flame-hint">drag to orbit · scroll to zoom · hover a bar</div>
        </>
      )}
    </div>
  );
}

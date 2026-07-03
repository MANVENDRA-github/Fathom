import type { CostMetric, CostModel, FlameNode } from '../data/cost';

/**
 * Flame graph — the M3 Opus seam (plain DOM). Renders the cost aggregation as a two-level
 * provider→model breakdown with a metric toggle, from the exact `x0/x1` layout the Fable 3D WGSL
 * pass will consume. Deliberately plain: this proves the data + reconciliation; Fable builds the
 * cinematic 3D flame on the canvas next.
 */

const METRICS: CostMetric[] = ['cost', 'tokens', 'requests'];

function fmt(v: number, metric: CostMetric): string {
  if (metric === 'cost') return v === 0 ? '$0' : `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
  return Math.round(v).toLocaleString();
}
const rgb = (c: [number, number, number]) => `rgb(${c.map((x) => Math.round(x * 255)).join(', ')})`;

function Seg({ node, metric }: { node: FlameNode; metric: CostMetric }) {
  const w = (node.x1 - node.x0) * 100;
  return (
    <div
      className="fseg"
      style={{ left: `${node.x0 * 100}%`, width: `${w}%`, ['--seg' as string]: rgb(node.color) }}
      title={`${node.label} · ${fmt(node.value, metric)} · ${Math.round(node.share * 100)}%`}
    >
      {w > 6 && <span className="fseg-l">{node.label}</span>}
    </div>
  );
}

export function FlameView({ model, metric, onMetric, loading }: {
  model: CostModel;
  metric: CostMetric;
  onMetric: (m: CostMetric) => void;
  loading?: boolean;
}) {
  const models = model.providers.flatMap((p) => p.children);
  const empty = model.providers.length === 0;

  return (
    <div className="flame panel" data-total-cost={model.totals.cost}>
      <div className="flame-head">
        <div>
          <div className="flame-title">cost by provider → model</div>
          <div className="flame-total"><b>{fmt(model.total, metric)}</b> <span className="k">total {metric}</span></div>
        </div>
        <div className="flame-metrics">
          {METRICS.map((m) => (
            <button key={m} className={metric === m ? 'active' : ''} onClick={() => onMetric(m)}>{m}</button>
          ))}
        </div>
      </div>

      {loading && <div className="muted">loading live buffer…</div>}
      {!loading && empty && <div className="muted">no spans yet — data will appear as it arrives</div>}
      {!loading && !empty && (
        <>
          {model.unpriced && (
            <div className="flame-note">
              no cost captured for this source (<code>costUsd</code> is null) — laid out by request volume.
              switch to <button className="linkish" onClick={() => onMetric('tokens')}>tokens</button>.
            </div>
          )}
          <div className="flame-rows">
            <div className="flame-row">{model.providers.map((p) => <Seg key={p.key} node={p} metric={metric} />)}</div>
            <div className="flame-row">{models.map((m) => <Seg key={m.key} node={m} metric={metric} />)}</div>
          </div>
          <div className="flame-table">
            {model.providers.map((p) => (
              <div className="ftgroup" key={p.key}>
                <div className="ftrow ftp">
                  <span className="dot" style={{ background: rgb(p.color) }} />
                  <span className="ftlabel">{p.label}</span>
                  <span className="ftv">{fmt(p.value, metric)}</span>
                  <span className="ftpct">{Math.round(p.share * 100)}%</span>
                </div>
                {p.children.map((m) => (
                  <div className="ftrow ftm" key={m.key}>
                    <span className="dot" style={{ background: rgb(m.color) }} />
                    <span className="ftlabel">{m.label}</span>
                    <span className="ftv">{fmt(m.value, metric)}</span>
                    <span className="ftpct">{Math.round(m.share * 100)}%</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

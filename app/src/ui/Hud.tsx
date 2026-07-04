import type { TraceMeta } from '@shared/schema';
import type { RiverStats } from '../gpu/river';
import type { SourceKey } from './Controls';

export function Hud({
  stats, meta, source, connected,
}: {
  stats: RiverStats | null;
  meta: TraceMeta | null;
  source: SourceKey;
  connected: boolean;
}) {
  const pct = stats ? Math.round(stats.cacheRate * 100) : 0;
  const cost = stats?.costUsd ?? 0;
  const spend = cost === 0 ? '$0' : `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
  const savedUsd = stats?.savedUsd ?? null;   // null = unpriced data — show "—", never a fake $0
  const saved = savedUsd === null ? '—' : savedUsd === 0 ? '$0' : `$${savedUsd.toFixed(savedUsd < 1 ? 4 : 2)}`;

  let badge: { cls: string; text: string };
  if (source === 'live') badge = connected ? { cls: 'live', text: '● live stream' } : { cls: 'connecting', text: 'connecting…' };
  else if (/synthetic|sample/i.test(meta?.source ?? '')) badge = { cls: 'synthetic', text: 'synthetic sample' };
  else badge = { cls: '', text: 'real capture' };

  return (
    <div id="hud" className="panel">
      <h1>FATHOM</h1>
      <div className="tag">LLM-ops observability cinema</div>
      <span className={`src ${badge.cls}`}>{badge.text}</span>
      <div className="metric"><span className="k">{source === 'live' ? 'spans streamed' : 'requests replayed'}</span><span className="v">{stats?.requests ?? 0}</span></div>
      <div className="metric"><span className="k">spend so far</span><span className="v">{spend}</span></div>
      <div className="metric" title={savedUsd === null ? 'no priced spans in this data' : 'estimated from this data’s own priced cache misses'}>
        <span className="k">est. $ saved (cache)</span><span className="v">{saved}</span>
      </div>
      <div className="metric"><span className="k">cache-hit rate</span><span className="v">{pct}%</span></div>
      <div className="metric"><span className="k">429s survived → fallback</span><span className="v">{stats?.fallbacks ?? 0}</span></div>
      <div className="metric"><span className="k">PII blocked in-path</span><span className="v">{stats?.pii ?? 0}</span></div>
    </div>
  );
}

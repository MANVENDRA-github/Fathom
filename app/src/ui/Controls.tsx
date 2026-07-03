export type SourceKey = 'live' | 'real' | 'sample';
export type ViewKey = 'river' | 'flame';

export const REPLAY_FILES: Record<'real' | 'sample', string> = {
  real: 'traces.json',
  sample: 'traces.sample.json',
};

const LABELS: Record<SourceKey, string> = { live: '● live', real: 'real', sample: 'sample' };
const VIEW_LABELS: Record<ViewKey, string> = { river: 'river', flame: '$ flame' };

export function Controls({
  source, onSource, view, onView, paused, onPause, bloom, onBloom,
}: {
  source: SourceKey;
  onSource: (s: SourceKey) => void;
  view: ViewKey;
  onView: (v: ViewKey) => void;
  paused: boolean;
  onPause: () => void;
  bloom: boolean;
  onBloom: () => void;
}) {
  return (
    <div className="controls panel">
      {(['live', 'real', 'sample'] as SourceKey[]).map((s) => (
        <button key={s} className={source === s ? 'active' : ''} onClick={() => onSource(s)}>{LABELS[s]}</button>
      ))}
      <span className="ctl-sep" />
      {(['river', 'flame'] as ViewKey[]).map((v) => (
        <button key={v} className={view === v ? 'active' : ''} onClick={() => onView(v)}>{VIEW_LABELS[v]}</button>
      ))}
      {view === 'river' && <button className={bloom ? 'active' : ''} onClick={onBloom} title="bloom post pass (M4)">✦ bloom</button>}
      {view === 'river' && <button onClick={onPause}>{paused ? '▶ play' : '⏸ pause'}</button>}
    </div>
  );
}

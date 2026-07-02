export type SourceKey = 'live' | 'real' | 'sample';

export const REPLAY_FILES: Record<'real' | 'sample', string> = {
  real: 'traces.json',
  sample: 'traces.sample.json',
};

const LABELS: Record<SourceKey, string> = { live: '● live', real: 'real', sample: 'sample' };

export function Controls({
  source, onSource, paused, onPause,
}: {
  source: SourceKey;
  onSource: (s: SourceKey) => void;
  paused: boolean;
  onPause: () => void;
}) {
  return (
    <div className="controls panel">
      {(['live', 'real', 'sample'] as SourceKey[]).map((s) => (
        <button key={s} className={source === s ? 'active' : ''} onClick={() => onSource(s)}>{LABELS[s]}</button>
      ))}
      <button onClick={onPause}>{paused ? '▶ play' : '⏸ pause'}</button>
    </div>
  );
}

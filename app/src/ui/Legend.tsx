const ROWS: Array<{ color: string; label: string }> = [
  { color: '#3f7fff', label: 'span → provider (cache miss)' },
  { color: '#19ffb0', label: 'cache hit — served from memory (tributary)' },
  { color: '#ffb020', label: '429 → retried & failed over' },
  { color: '#ff3040', label: 'PII caught — blocked in-path (422)' },
];

export function Legend() {
  return (
    <div className="legend panel">
      {ROWS.map((r) => (
        <div key={r.label} className="row" style={{ color: r.color }}>
          <span className="dot" />
          <span>{r.label}</span>
        </div>
      ))}
      <div className="row" style={{ color: '#8b93a7' }}>
        <span>shade within a lane = model</span>
      </div>
    </div>
  );
}

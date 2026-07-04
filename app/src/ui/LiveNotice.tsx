/**
 * Shown when `live` is selected but no gateway has answered (M5 polish). On the hosted demo
 * this is the common case — there is no public server; live mode listens for one on the
 * visitor's own machine. Honest: explains the stuck "connecting…" badge instead of hiding it.
 */
export function LiveNotice({ server, onReplay }: { server: string; onReplay: () => void }) {
  const hostedToLocal = location.protocol === 'https:' && server.startsWith('http://localhost');
  return (
    <div className="live-notice panel" role="status">
      <div className="ln-title">no gateway connected</div>
      <p>
        Fathom is listening for a live OTLP stream from <code>{server}</code> and hasn't heard
        back{hostedToLocal ? ' — this hosted demo can only reach a gateway running on your machine' : ''}.
      </p>
      <p className="ln-how">
        To feed it real spans: <code>npm run server</code>, then point any OTel gateway at it —{' '}
        <code>OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4319</code>
        <span className="ln-aside">(own deploy? set <code>VITE_FATHOM_SERVER</code>)</span>
      </p>
      <button className="ln-replay" onClick={onReplay}>▶ watch the real capture instead</button>
    </div>
  );
}

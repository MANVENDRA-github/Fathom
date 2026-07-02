import { useEffect, useRef, useState } from 'react';
import type { NormalizedTrace, TraceMeta } from '@shared/schema';
import { createRiver, type RiverHandle, type RiverStats } from './gpu/river';
import { hasWebGPU } from './gpu/capabilities';
import { connectStream } from './lib/stream';
import { Hud } from './ui/Hud';
import { Legend } from './ui/Legend';
import { Controls, type SourceKey, REPLAY_FILES } from './ui/Controls';

const SERVER = import.meta.env.VITE_FATHOM_SERVER || 'http://localhost:4319';

function initialSource(): SourceKey {
  const s = new URLSearchParams(location.search).get('source');
  return s === 'live' || s === 'sample' || s === 'real' ? s : 'real';
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<RiverHandle | null>(null);
  const [source, setSource] = useState<SourceKey>(initialSource);
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState<RiverStats | null>(null);
  const [meta, setMeta] = useState<TraceMeta | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasWebGPU()) { setError('WebGPU not available — use Chrome/Edge 113+.'); return; }
    const canvas = canvasRef.current!;
    let cancelled = false;
    let disconnect: (() => void) | null = null;
    setStats(null); setMeta(null); setConnected(false);

    if (source === 'live') {
      const handle = createRiver(canvas, { mode: 'live' }, setStats);
      handle.setPaused(paused);
      handleRef.current = handle;
      disconnect = connectStream(`${SERVER}/stream`, {
        onOpen: () => setConnected(true),
        onError: () => setConnected(false),
        // spawn the backlog immediately (river dedups by id, so a reconnect's snapshot is a no-op)
        onSnapshot: (events) => events.forEach((e) => handle.spawn(e)),
        onSpan: (e) => handle.spawn(e),
      });
    } else {
      (async () => {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}${REPLAY_FILES[source]}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`${REPLAY_FILES[source]}: ${res.status}`);
          const trace = (await res.json()) as NormalizedTrace;
          if (cancelled) return;
          setMeta(trace.meta);
          const handle = createRiver(canvas, { mode: 'replay', trace }, setStats);
          handle.setPaused(paused);
          handleRef.current = handle;
        } catch (e) {
          if (!cancelled) setError(String(e));
        }
      })();
    }

    return () => {
      cancelled = true;
      disconnect?.();
      handleRef.current?.destroy();
      handleRef.current = null;
    };
    // re-create only on source change; pause is applied imperatively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const togglePause = () => setPaused((p) => { const n = !p; handleRef.current?.setPaused(n); return n; });

  if (error) return <div className="err"><div>{error}</div></div>;

  return (
    <>
      <canvas ref={canvasRef} id="gpu-canvas" />
      <Hud stats={stats} meta={meta} source={source} connected={connected} />
      <div className="title-r panel">
        <div className="big">{stats?.gpu ?? 'initializing WebGPU…'}</div>
        <div className="small">
          {source === 'live'
            ? 'live OTLP stream · one comet per span as it arrives'
            : 'every particle is one real span · replayed as a live stream'}
        </div>
      </div>
      <Legend />
      <Controls source={source} onSource={setSource} paused={paused} onPause={togglePause} />
      {source !== 'live' && (
        <div id="timeline"><div id="playhead" style={{ width: `${(stats?.playFrac ?? 0) * 100}%` }} /></div>
      )}
    </>
  );
}

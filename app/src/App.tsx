import { useEffect, useRef, useState } from 'react';
import type { NormalizedTrace, TraceMeta, SpanDetail as SpanDetailData } from '@shared/schema';
import { createRiver, type RiverHandle, type RiverStats, type PickResult } from './gpu/river';
import { hasWebGPU } from './gpu/capabilities';
import { connectStream } from './lib/stream';
import { fetchSpanDetail } from './lib/detail';
import { Hud } from './ui/Hud';
import { Legend } from './ui/Legend';
import { SpanDetail } from './ui/SpanDetail';
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
  const [selected, setSelected] = useState<PickResult | null>(null);
  const [detail, setDetail] = useState<SpanDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!hasWebGPU()) { setError('WebGPU not available — use Chrome/Edge 113+.'); return; }
    const canvas = canvasRef.current!;
    let cancelled = false;
    let disconnect: (() => void) | null = null;
    setStats(null); setMeta(null); setConnected(false);
    setSelected(null); setDetail(null);   // clear any open drill-down when the source changes

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

  // Click a comet → resolve it to its span, then (live) fetch its raw attributes from /traces/:id.
  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const hit = handleRef.current?.pick(e.clientX, e.clientY) ?? null;
    setSelected(hit);
    setDetail(null);
    if (hit && source === 'live' && hit.id) {
      setDetailLoading(true);
      fetchSpanDetail(SERVER, hit.id).then((d) => { setDetail(d); setDetailLoading(false); });
    } else {
      setDetailLoading(false);
    }
  };
  const closeDetail = () => { setSelected(null); setDetail(null); };

  // Test/debug hook (E2E pick harness): exposed only under ?debug=1 or in dev — keeps prod clean.
  useEffect(() => {
    if (!import.meta.env.DEV && !new URLSearchParams(location.search).has('debug')) return;
    (window as unknown as Record<string, unknown>).__fathom = {
      heads: () => handleRef.current?.debugHeads() ?? [],
      pick: (x: number, y: number) => handleRef.current?.pick(x, y) ?? null,
      pause: (p: boolean) => handleRef.current?.setPaused(p),
    };
    return () => { delete (window as unknown as Record<string, unknown>).__fathom; };
  }, []);

  if (error) return <div className="err"><div>{error}</div></div>;

  return (
    <>
      <canvas ref={canvasRef} id="gpu-canvas" onPointerDown={onCanvasPointerDown} />
      {selected && (
        <SpanDetail
          event={selected.event} outcome={selected.outcome} screen={selected.screen}
          live={source === 'live'} detail={detail} loading={detailLoading} onClose={closeDetail}
        />
      )}
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

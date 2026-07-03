import { useEffect, useMemo, useRef, useState } from 'react';
import type { NormalizedTrace, TraceMeta, TraceEvent, SpanDetail as SpanDetailData } from '@shared/schema';
import { createRiver, type RiverHandle, type RiverStats, type PickResult } from './gpu/river';
import { hasWebGPU } from './gpu/capabilities';
import { connectStream } from './lib/stream';
import { fetchSpanDetail } from './lib/detail';
import { aggregateCost, summarize, type CostMetric } from './data/cost';
import { Hud } from './ui/Hud';
import { Legend } from './ui/Legend';
import { SpanDetail } from './ui/SpanDetail';
import { FlameView } from './ui/FlameView';
import { Controls, type SourceKey, type ViewKey, REPLAY_FILES } from './ui/Controls';

const SERVER = import.meta.env.VITE_FATHOM_SERVER || 'http://localhost:4319';

function initialSource(): SourceKey {
  const s = new URLSearchParams(location.search).get('source');
  return s === 'live' || s === 'sample' || s === 'real' ? s : 'real';
}
function initialView(): ViewKey {
  return new URLSearchParams(location.search).get('view') === 'flame' ? 'flame' : 'river';
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<RiverHandle | null>(null);
  const [source, setSource] = useState<SourceKey>(initialSource);
  const [view, setView] = useState<ViewKey>(initialView);
  const [metric, setMetric] = useState<CostMetric>('cost');
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState<RiverStats | null>(null);
  const [meta, setMeta] = useState<TraceMeta | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PickResult | null>(null);
  const [detail, setDetail] = useState<SpanDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [events, setEvents] = useState<TraceEvent[] | null>(null);   // flame view's aggregation input
  const [flameLoading, setFlameLoading] = useState(false);

  useEffect(() => {
    if (!hasWebGPU()) { setError('WebGPU not available — use Chrome/Edge 113+.'); return; }
    const canvas = canvasRef.current!;
    let cancelled = false;
    let disconnect: (() => void) | null = null;
    let refresh: ReturnType<typeof setInterval> | null = null;
    setStats(null); setMeta(null); setConnected(false);
    setSelected(null); setDetail(null);

    if (view === 'flame') {
      // Flame view: no river/GPU — aggregate the event set for cost-by-model/provider.
      setEvents(null); setFlameLoading(true);
      if (source === 'live') {
        // Aggregate the server's live ring buffer (poll so the flame tracks the stream).
        const loadLive = async () => {
          try {
            const res = await fetch(`${SERVER}/debug/recent?n=2000`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`/debug/recent: ${res.status}`);
            const evs = (await res.json()) as TraceEvent[];
            if (cancelled) return;
            setEvents(evs); setFlameLoading(false); setConnected(true);
          } catch { if (!cancelled) { setConnected(false); setFlameLoading(false); } }
        };
        loadLive();
        refresh = setInterval(loadLive, 2000);
      } else {
        (async () => {
          try {
            const res = await fetch(`${import.meta.env.BASE_URL}${REPLAY_FILES[source as 'real' | 'sample']}`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`${REPLAY_FILES[source as 'real' | 'sample']}: ${res.status}`);
            const trace = (await res.json()) as NormalizedTrace;
            if (cancelled) return;
            setMeta(trace.meta); setEvents(trace.events); setFlameLoading(false);
          } catch (e) { if (!cancelled) setError(String(e)); }
        })();
      }
    } else if (source === 'live') {
      const handle = createRiver(canvas, { mode: 'live' }, setStats);
      handle.setPaused(paused);
      handleRef.current = handle;
      disconnect = connectStream(`${SERVER}/stream`, {
        onOpen: () => setConnected(true),
        onError: () => setConnected(false),
        onSnapshot: (evs) => evs.forEach((e) => handle.spawn(e)),
        onSpan: (e) => handle.spawn(e),
      });
    } else {
      (async () => {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}${REPLAY_FILES[source as 'real' | 'sample']}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`${REPLAY_FILES[source as 'real' | 'sample']}: ${res.status}`);
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
      if (refresh) clearInterval(refresh);
      handleRef.current?.destroy();
      handleRef.current = null;
    };
    // re-create only on source/view change; pause is applied imperatively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, view]);

  // Flame aggregation + a HUD summary over the same events (so the HUD reconciles with the flame).
  const costModel = useMemo(() => aggregateCost(events ?? [], metric), [events, metric]);
  const flameStats = useMemo<RiverStats>(() => {
    const s = summarize(events ?? []);
    return { gpu: 'WebGPU', live: source === 'live', requests: s.requests, cacheRate: s.cacheRate, fallbacks: s.fallbacks, pii: s.pii, costUsd: s.cost, playFrac: 0 };
  }, [events, source]);
  const hudStats = view === 'flame' ? flameStats : stats;

  const togglePause = () => setPaused((p) => { const n = !p; handleRef.current?.setPaused(n); return n; });
  const changeView = (v: ViewKey) => { setSelected(null); setDetail(null); setView(v); };

  // Click a comet → resolve it to its span, then (live) fetch its raw attributes from /traces/:id.
  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (view !== 'river') return;
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

  // Test/debug hook (E2E harness): exposed only under ?debug=1 or in dev — keeps prod clean.
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

  const flameView = view === 'flame';

  return (
    <>
      <canvas ref={canvasRef} id="gpu-canvas" onPointerDown={onCanvasPointerDown} style={flameView ? { display: 'none' } : undefined} />
      {flameView && <FlameView model={costModel} metric={metric} onMetric={setMetric} loading={flameLoading} />}
      {!flameView && selected && (
        <SpanDetail
          event={selected.event} outcome={selected.outcome} screen={selected.screen}
          live={source === 'live'} detail={detail} loading={detailLoading} onClose={closeDetail}
        />
      )}
      <Hud stats={hudStats} meta={meta} source={source} connected={connected} />
      <div className="title-r panel">
        <div className="big">{flameView ? 'cost flame graph' : (stats?.gpu ?? 'initializing WebGPU…')}</div>
        <div className="small">
          {flameView
            ? (source === 'live' ? 'aggregated from the live buffer · cost by provider → model' : 'cost by provider → model · from the replayed trace')
            : source === 'live'
              ? 'live OTLP stream · one comet per span as it arrives'
              : 'every particle is one real span · replayed as a live stream'}
        </div>
      </div>
      <Legend />
      <Controls source={source} onSource={setSource} view={view} onView={changeView} paused={paused} onPause={togglePause} />
      {!flameView && source !== 'live' && (
        <div id="timeline"><div id="playhead" style={{ width: `${(stats?.playFrac ?? 0) * 100}%` }} /></div>
      )}
    </>
  );
}

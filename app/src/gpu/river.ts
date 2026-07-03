import type { NormalizedTrace, TraceEvent } from '@shared/schema';
import { buildParticles, type ReplayHead } from '../data/build';
import { makeComet, outcomeOf, COMET_MAX } from '../data/comet';
import type { Outcome } from '../data/classify';
import { pickHead, headPos, ndcToPixel, type HeadLike } from './motion';
import riverWGSL from './shaders/river.wgsl?raw';

export interface RiverStats {
  gpu: string;
  live: boolean;
  requests: number;
  cacheRate: number;    // 0..1
  fallbacks: number;
  pii: number;
  playFrac: number;     // 0..1 (replay only)
}

export type RiverOpts =
  | { mode: 'replay'; trace: NormalizedTrace }
  | { mode: 'live'; capacity?: number };

/** Result of resolving a click to a comet (M2 drill-down). */
export interface PickResult {
  id?: string;                    // span id (live spans; absent for id-less static replay data)
  event: TraceEvent;              // the resolved source span
  outcome: Outcome;
  screen: { x: number; y: number };   // head center in client pixels (for the selection marker)
}

/** A visible head exposed for test/debug harnesses (client-pixel coords). */
export interface DebugHead { id?: string; outcome: Outcome; x: number; y: number; size: number }

/** A live comet's head + identity, kept in a ring parallel to the particle pool. */
interface LiveHead extends HeadLike { event: TraceEvent; outcome: Outcome }

export interface RiverHandle {
  destroy(): void;
  setPaused(paused: boolean): void;
  spawn(event: TraceEvent): void;   // live mode; no-op in replay
  /** Resolve a click (client px) to the comet under the cursor, or null. */
  pick(clientX: number, clientY: number): PickResult | null;
  /** Currently-visible heads with client-pixel centers (test/debug harnesses). */
  debugHeads(): DebugHead[];
}

const PARTICLE_FLOATS = 12;
const PARTICLE_BYTES = PARTICLE_FLOATS * 4;
const LIVE_CYCLE = 1e7;             // effectively no wrap in live mode

/**
 * Imperative WebGPU controller (create → {destroy}). Two modes share one pipeline:
 *  - replay: a fixed looping buffer built from a whole trace
 *  - live:   a recycling pool; `spawn(event)` writes a comet at "now" as spans arrive over SSE
 * Async init is guarded so it's safe under React StrictMode's mount/unmount/mount in dev.
 */
export function createRiver(
  canvas: HTMLCanvasElement,
  opts: RiverOpts,
  onStats: (s: RiverStats) => void,
): RiverHandle {
  let destroyed = false;
  let paused = false;
  let ready = false;
  let raf = 0;
  let ro: ResizeObserver | null = null;
  let device: GPUDevice | null = null;

  // live state
  let particleBuffer: GPUBuffer | null = null;
  let t0 = 0;
  let pauseAccum = 0;
  let pauseStart = 0;
  const capacity = opts.mode === 'live' ? (opts.capacity ?? 120_000) : 0;
  let cursor = 0;
  const live = { requests: 0, cache: 0, fallbacks: 0, pii: 0 };
  const pending: TraceEvent[] = [];

  // ---- pick index (M2 drill-down) --------------------------------------------
  // Hoisted so the returned pick()/debugHeads() can see them; filled during async init/spawn.
  let cycle = 0;                       // loop length (uniform u.cycle); pick mirrors the shader
  let renderTime = 0;                  // last time written to the uniform (frozen while paused)
  let replayHeads: ReplayHead[] | null = null;   // replay: static, one head per comet
  // live: heads kept in a ring parallel to the particle pool, evicted as slots are overwritten
  const headSlots: (LiveHead | null)[] = opts.mode === 'live' ? new Array(capacity).fill(null) : [];
  const activeHeadSlots = new Set<number>();
  const liveHeadList = (): LiveHead[] => {
    const out: LiveHead[] = [];
    for (const s of activeHeadSlots) { const h = headSlots[s]; if (h) out.push(h); }
    return out;
  };
  const pickHeads = (): (LiveHead | ReplayHead)[] => replayHeads ?? liveHeadList();
  // Dedup by span id: an SSE reconnect re-sends the snapshot, which must NOT re-spawn or
  // double-count already-seen spans (that would silently inflate the HUD's headline metrics).
  // Bounded to the last N ids — only the recent snapshot window can ever duplicate.
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  function firstSee(id: string): boolean {
    if (seen.has(id)) return false;
    seen.add(id); seenOrder.push(id);
    if (seenOrder.length > 4096) { const old = seenOrder.shift(); if (old) seen.delete(old); }
    return true;
  }
  // Freezes while paused (subtracts the in-progress pause) so spans arriving mid-pause spawn
  // correctly on resume instead of unspooling with a delay.
  const elapsed = () => {
    const now = performance.now();
    const pausedNow = pauseStart ? now - pauseStart : 0;
    return (now - t0 - pauseAccum - pausedNow) / 1000;
  };

  function writeComet(event: TraceEvent) {
    if (!device || !particleBuffer) return;
    if (event.id && !firstSee(event.id)) return;   // skip SSE-reconnect duplicates
    const floats = makeComet(event, elapsed());
    const k = floats.length / PARTICLE_FLOATS;
    if (cursor + k > capacity) cursor = 0;
    // Evict heads whose particles are about to be overwritten (keeps the pick ring in lock-step).
    for (let s = cursor; s < cursor + k; s++) {
      if (headSlots[s]) { activeHeadSlots.delete(s); headSlots[s] = null; }
    }
    device.queue.writeBuffer(particleBuffer, cursor * PARTICLE_BYTES, new Float32Array(floats));
    const o: Outcome = outcomeOf(event);
    // Record this comet's head (leading particle at `cursor`) for drill-down.
    headSlots[cursor] = {
      a: Float32Array.of(floats[0], floats[1], floats[2], floats[3]),
      b: Float32Array.of(floats[4], floats[5], floats[6], floats[7]),
      event, outcome: o,
    };
    activeHeadSlots.add(cursor);
    cursor += k;
    live.requests++;
    if (o === 'cache') live.cache++;
    else if (o === 'fallback') live.fallbacks++;
    else if (o === 'pii') live.pii++;
  }

  (async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter || destroyed) return;
    device = await adapter.requestDevice();
    if (destroyed) { device.destroy(); return; }

    const info = adapter.info;
    const gpuLabel = [info?.description, info?.vendor, info?.architecture].filter(Boolean).join(' · ') || 'WebGPU';

    const ctx = canvas.getContext('webgpu')!;
    const format = navigator.gpu.getPreferredCanvasFormat();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    };
    resize();
    ctx.configure({ device, format, alphaMode: 'opaque' });

    // ---- mode-specific particle buffer + stats ------------------------------
    let drawCount: number;
    let statsFn: (cycleT: number) => RiverStats;

    if (opts.mode === 'replay') {
      const built = buildParticles(opts.trace);
      const { data, particles, N, counters, tScaled } = built;
      cycle = built.cycle;
      replayHeads = built.heads;   // static pick index for replay mode
      drawCount = particles;
      particleBuffer = device.createBuffer({ size: Math.max(PARTICLE_BYTES, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(particleBuffer, 0, data);
      statsFn = (cycleT) => {
        let requests = 0, cache = 0, fallbacks = 0, pii = 0;
        for (let i = 0; i < N; i++) {
          if (tScaled[i] > cycleT) break;
          requests++;
          const c = counters[i];
          if (c === 'cache') cache++; else if (c === 'fallback') fallbacks++; else if (c === 'pii') pii++;
        }
        return { gpu: gpuLabel, live: false, requests, cacheRate: requests ? cache / requests : 0, fallbacks, pii, playFrac: cycleT / cycle };
      };
    } else {
      cycle = LIVE_CYCLE;
      drawCount = capacity;
      particleBuffer = device.createBuffer({ size: capacity * PARTICLE_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      statsFn = () => ({ gpu: gpuLabel, live: true, requests: live.requests, cacheRate: live.requests ? live.cache / live.requests : 0, fallbacks: live.fallbacks, pii: live.pii, playFrac: 0 });
    }

    const uniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const uArr = new Float32Array(4);

    const module = device.createShaderModule({ code: riverWGSL });
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{ format, blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list' },
    });
    const bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: particleBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
      ],
    });

    t0 = performance.now();
    ready = true;
    for (const e of pending) writeComet(e);   // flush spawns that arrived before init finished
    pending.length = 0;

    let frameNo = 0;
    const frame = () => {
      if (destroyed) return;
      if (paused) { raf = requestAnimationFrame(frame); return; }

      const time = elapsed();
      renderTime = time;   // freeze-consistent: pick()/debugHeads() evaluate the drawn frame
      const cycleT = time % cycle;
      uArr[0] = time; uArr[1] = cycle; uArr[2] = canvas.width / canvas.height; uArr[3] = 0;
      device!.queue.writeBuffer(uniformBuffer, 0, uArr);

      const enc = device!.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0.016, g: 0.02, b: 0.043, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(drawCount * 6);
      pass.end();
      device!.queue.submit([enc.finish()]);

      if ((frameNo++ & 7) === 0) onStats(statsFn(cycleT));
      raf = requestAnimationFrame(frame);
    };

    ro = new ResizeObserver(resize);
    ro.observe(canvas);
    raf = requestAnimationFrame(frame);
    // eslint-disable-next-line no-console
    console.log('[fathom]', opts.mode, 'mode ·', opts.mode === 'replay' ? `${drawCount.toLocaleString()} particles` : `pool ${capacity.toLocaleString()} (max ${COMET_MAX}/comet)`, '·', gpuLabel);
  })().catch((e) => console.error('[fathom] init failed:', e));

  return {
    destroy() {
      destroyed = true;
      ready = false;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      device?.destroy();
    },
    setPaused(p: boolean) {
      const now = performance.now();
      if (p && !paused) pauseStart = now;
      else if (!p && paused) { pauseAccum += now - pauseStart; pauseStart = 0; }
      paused = p;
    },
    spawn(event: TraceEvent) {
      if (opts.mode !== 'live') return;
      if (!ready) { pending.push(event); return; }
      writeComet(event);
    },
    pick(clientX: number, clientY: number): PickResult | null {
      if (!ready) return null;
      const rect = canvas.getBoundingClientRect();
      const dims = { width: rect.width, height: rect.height };
      const hit = pickHead(pickHeads(), clientX - rect.left, clientY - rect.top, renderTime, cycle, dims);
      if (!hit) return null;
      const pos = headPos(hit.a, hit.b, renderTime, cycle)!;   // non-null: pickHead already passed it
      const { px, py } = ndcToPixel(pos.x, pos.y, dims);
      return { id: hit.event.id, event: hit.event, outcome: hit.outcome, screen: { x: rect.left + px, y: rect.top + py } };
    },
    debugHeads(): DebugHead[] {
      if (!ready) return [];
      const rect = canvas.getBoundingClientRect();
      const dims = { width: rect.width, height: rect.height };
      const out: DebugHead[] = [];
      for (const h of pickHeads()) {
        const pos = headPos(h.a, h.b, renderTime, cycle);
        if (!pos || pos.fade < 0.05) continue;
        const { px, py } = ndcToPixel(pos.x, pos.y, dims);
        out.push({ id: h.event.id, outcome: h.outcome, x: rect.left + px, y: rect.top + py, size: pos.size });
      }
      return out;
    },
  };
}

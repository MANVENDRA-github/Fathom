import type { NormalizedTrace, TraceEvent } from '@shared/schema';
import { buildParticles, type ReplayHead } from '../data/build';
import { makeComet, outcomeOf, COMET_MAX } from '../data/comet';
import { accSaved, newSavedAcc, savedOf } from '../data/cost';
import type { Outcome } from '../data/classify';
import { pickHead, headPos, ndcToPixel, type HeadLike } from './motion';
import riverWGSL from './shaders/river.wgsl?raw';
import riverSimWGSL from './shaders/river-sim.wgsl?raw';
import { createBloom } from './bloom';

export interface RiverStats {
  gpu: string;
  live: boolean;
  requests: number;
  cacheRate: number;    // 0..1
  fallbacks: number;
  pii: number;
  costUsd: number;      // running cost total (M3 HUD anchor; reconciles with the flame graph)
  savedUsd: number | null;  // est. $ saved by cache hits (M4); null = unpriced data → HUD shows "—"
  playFrac: number;     // 0..1 (replay only)
}

export type RiverOpts =
  | { mode: 'replay'; trace: NormalizedTrace; perf?: boolean }
  | { mode: 'live'; capacity?: number; perf?: boolean };

/** M4 perf snapshot — GPU pass times via timestamp-query when available, else frame pacing only. */
export interface RiverPerf {
  gpu: string;
  timestampQuery: boolean;   // false = GPU numbers unavailable; trust frame pacing only
  bloom: boolean;            // whether the bloom pass was active for these samples
  samples: number;           // GPU timing samples collected
  computeMs: number;         // medians
  sceneMs: number;
  bloomMs: number;
  totalGpuMs: number;
  computeP95: number;
  sceneP95: number;
  bloomP95: number;
  totalP95: number;
  frames: number;            // rAF pacing samples
  frameAvgMs: number;
  frameP95Ms: number;
}

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
  /** Toggle the bloom post pass (M4). Off = render straight to the swapchain, exactly as pre-M4. */
  setBloom(on: boolean): void;
  spawn(event: TraceEvent): void;   // live mode; no-op in replay
  /** Resolve a click (client px) to the comet under the cursor, or null. */
  pick(clientX: number, clientY: number): PickResult | null;
  /** Currently-visible heads with client-pixel centers (test/debug harnesses). */
  debugHeads(): DebugHead[];
  /** Perf snapshot (perf opt only; null before samples exist). `reset` clears the sample rings —
   *  use it when changing config (e.g. toggling bloom) so snapshots don't mix regimes. */
  perf(reset?: boolean): RiverPerf | null;
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
  let bloomOn = true;
  let ready = false;
  // ---- perf instrumentation (M4; opts.perf only) -------------------------------------------
  const wantPerf = !!opts.perf;
  let tsq = false;                 // timestamp-query granted
  let gpuName = 'WebGPU';
  let perfBloomFlag = true;        // bloom state when the last GPU sample was recorded
  const ring = { compute: [] as number[], scene: [] as number[], bloom: [] as number[], total: [] as number[], frame: [] as number[] };
  let lastFrameTs = 0;
  const push = (a: number[], v: number) => { a.push(v); if (a.length > 600) a.shift(); };
  const quant = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
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
  const live = { requests: 0, cache: 0, fallbacks: 0, pii: 0, cost: 0, saved: newSavedAcc() };
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
    live.cost += event.costUsd ?? 0;
    accSaved(live.saved, event);
    if (o === 'cache') live.cache++;
    else if (o === 'fallback') live.fallbacks++;
    else if (o === 'pii') live.pii++;
  }

  (async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter || destroyed) return;
    tsq = wantPerf && adapter.features.has('timestamp-query');
    device = await adapter.requestDevice(tsq ? { requiredFeatures: ['timestamp-query' as GPUFeatureName] } : undefined);
    if (destroyed) { device.destroy(); return; }

    const info = adapter.info;
    const gpuLabel = [info?.description, info?.vendor, info?.architecture].filter(Boolean).join(' · ') || 'WebGPU';
    gpuName = gpuLabel;

    // Perf mode: 3 timestamp pairs — compute (0,1) · scene (2,3) · bloom (4,5) — resolved every
    // 4th frame into a map-read buffer (one in flight at a time).
    let qs: GPUQuerySet | null = null;
    let qResolve: GPUBuffer | null = null;
    let qRead: GPUBuffer | null = null;
    let qPending = false;
    if (tsq) {
      qs = device.createQuerySet({ type: 'timestamp', count: 6 });
      qResolve = device.createBuffer({ size: 6 * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      qRead = device.createBuffer({ size: 6 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }

    const ctx = canvas.getContext('webgpu')!;
    const format = navigator.gpu.getPreferredCanvasFormat();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // The bloom chain is recreated at FRAME START on this flag — never inside the
    // ResizeObserver callback (a resize mid-encode is the classic footgun).
    let sizeDirty = true;
    const resize = () => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      sizeDirty = true;
    };
    resize();
    ctx.configure({ device, format, alphaMode: 'opaque' });
    const bloom = createBloom(device, format);

    // ---- mode-specific particle buffer + stats ------------------------------
    let drawCount: number;
    let statsFn: (cycleT: number) => RiverStats;

    if (opts.mode === 'replay') {
      const built = buildParticles(opts.trace);
      const { data, particles, N, counters, tScaled } = built;
      const costs = built.heads.map((h) => h.event.costUsd ?? 0);   // per-event cost, index-aligned
      cycle = built.cycle;
      replayHeads = built.heads;   // static pick index for replay mode
      drawCount = particles;
      particleBuffer = device.createBuffer({ size: Math.max(PARTICLE_BYTES, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(particleBuffer, 0, data);
      statsFn = (cycleT) => {
        let requests = 0, cache = 0, fallbacks = 0, pii = 0, cost = 0;
        const saved = newSavedAcc();
        for (let i = 0; i < N; i++) {
          if (tScaled[i] > cycleT) break;
          requests++;
          cost += costs[i];
          accSaved(saved, built.heads[i].event);
          const c = counters[i];
          if (c === 'cache') cache++; else if (c === 'fallback') fallbacks++; else if (c === 'pii') pii++;
        }
        return { gpu: gpuLabel, live: false, requests, cacheRate: requests ? cache / requests : 0, fallbacks, pii, costUsd: cost, savedUsd: savedOf(saved), playFrac: cycleT / cycle };
      };
    } else {
      cycle = LIVE_CYCLE;
      drawCount = capacity;
      particleBuffer = device.createBuffer({ size: capacity * PARTICLE_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      statsFn = () => ({ gpu: gpuLabel, live: true, requests: live.requests, cacheRate: live.requests ? live.cache / live.requests : 0, fallbacks: live.fallbacks, pii: live.pii, costUsd: live.cost, savedUsd: savedOf(live.saved), playFrac: 0 });
    }

    // Uniform: (time f32, cycle f32, aspect f32, count u32) — one ArrayBuffer, two typed views,
    // so the u32 count slot is never clobbered by a float write (spike pattern).
    const uniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const uRaw = new ArrayBuffer(16);
    const uF32 = new Float32Array(uRaw);
    const uU32 = new Uint32Array(uRaw);
    uU32[3] = drawCount;

    // Per-particle sim output (x, y, size, alpha) written by the compute pass each frame.
    const posBuffer = device.createBuffer({ size: drawCount * 16, usage: GPUBufferUsage.STORAGE });

    // Compute: stateless motion sim (river-sim.wgsl; mirrored by motion.ts — see MIRROR blocks).
    const simModule = device.createShaderModule({ code: riverSimWGSL });
    const simBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const simPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [simBGL] }),
      compute: { module: simModule, entryPoint: 'cs' },
    });
    const simBindGroup = device.createBindGroup({
      layout: simBGL,
      entries: [
        { binding: 0, resource: { buffer: particleBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: { buffer: posBuffer } },
      ],
    });
    const simWorkgroups = Math.ceil(drawCount / 64);

    const module = device.createShaderModule({ code: riverWGSL });
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    // Two river pipelines from one module: bloom ON renders into the HDR scene target,
    // bloom OFF renders straight to the swapchain exactly as pre-M4 (also the graceful path).
    const makeRiverPipeline = (target: GPUTextureFormat) => device!.createRenderPipeline({
      layout: device!.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{ format: target, blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list' },
    });
    const pipeline = makeRiverPipeline(format);
    const pipelineHDR = makeRiverPipeline('rgba16float');
    const bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: posBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: { buffer: particleBuffer } },
      ],
    });

    t0 = performance.now();
    ready = true;
    for (const e of pending) writeComet(e);   // flush spawns that arrived before init finished
    pending.length = 0;

    let frameNo = 0;
    const frame = () => {
      if (destroyed) return;
      if (paused) { lastFrameTs = 0; raf = requestAnimationFrame(frame); return; }

      if (wantPerf) {
        const nowTs = performance.now();
        if (lastFrameTs) push(ring.frame, nowTs - lastFrameTs);
        lastFrameTs = nowTs;
      }

      const time = elapsed();
      renderTime = time;   // freeze-consistent: pick()/debugHeads() evaluate the drawn frame
      const cycleT = time % cycle;
      uF32[0] = time; uF32[1] = cycle; uF32[2] = canvas.width / canvas.height;
      device!.queue.writeBuffer(uniformBuffer, 0, uRaw);

      if (sizeDirty) { bloom.resize(canvas.width, canvas.height); sizeDirty = false; }

      const timing = !!qs && !qPending && (frameNo & 3) === 0;
      const bloomThisFrame = bloomOn;

      const enc = device!.createCommandEncoder();
      // Sim pass first: paused frames never reach here, so posBuffer stays frozen at renderTime —
      // exactly the state pick()/debugHeads() evaluate.
      const sim = enc.beginComputePass(
        timing ? { timestampWrites: { querySet: qs!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : undefined);
      sim.setPipeline(simPipeline);
      sim.setBindGroup(0, simBindGroup);
      sim.dispatchWorkgroups(simWorkgroups);
      sim.end();
      // Scene pass: into the HDR target when bloom is on (the clear ~0.04 lum stays far below the
      // bloom threshold, so the background never glows), else straight to the swapchain.
      const swapView = ctx.getCurrentTexture().createView();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: bloomThisFrame ? bloom.sceneView() : swapView, clearValue: { r: 0.016, g: 0.02, b: 0.043, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
        ...(timing ? { timestampWrites: { querySet: qs!, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } } : {}),
      });
      pass.setPipeline(bloomThisFrame ? pipelineHDR : pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(drawCount * 6);
      pass.end();
      if (bloomThisFrame) bloom.encode(enc, swapView, timing ? { querySet: qs!, begin: 4, end: 5 } : undefined);
      if (timing) {
        enc.resolveQuerySet(qs!, 0, 6, qResolve!, 0);
        enc.copyBufferToBuffer(qResolve!, 0, qRead!, 0, 48);
      }
      device!.queue.submit([enc.finish()]);
      if (timing) {
        qPending = true;
        qRead!.mapAsync(GPUMapMode.READ).then(() => {
          const t = new BigUint64Array(qRead!.getMappedRange().slice(0));
          qRead!.unmap();
          const ms = (a: bigint, b: bigint) => Math.max(0, Number(b - a) / 1e6);
          const computeMs = ms(t[0], t[1]);
          const sceneMs = ms(t[2], t[3]);
          const bloomMs = bloomThisFrame ? ms(t[4], t[5]) : 0;
          push(ring.compute, computeMs);
          push(ring.scene, sceneMs);
          push(ring.bloom, bloomMs);
          push(ring.total, computeMs + sceneMs + bloomMs);
          perfBloomFlag = bloomThisFrame;
          qPending = false;
        }).catch(() => { qPending = false; });
      }

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
    setBloom(on: boolean) { bloomOn = on; },
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
    perf(reset = false): RiverPerf | null {
      const has = ring.frame.length > 0 || ring.total.length > 0;
      const out: RiverPerf | null = !has ? null : {
        gpu: gpuName,
        timestampQuery: tsq,
        bloom: perfBloomFlag,
        samples: ring.total.length,
        computeMs: quant(ring.compute, 0.5),
        sceneMs: quant(ring.scene, 0.5),
        bloomMs: quant(ring.bloom, 0.5),
        totalGpuMs: quant(ring.total, 0.5),
        computeP95: quant(ring.compute, 0.95),
        sceneP95: quant(ring.scene, 0.95),
        bloomP95: quant(ring.bloom, 0.95),
        totalP95: quant(ring.total, 0.95),
        frames: ring.frame.length,
        frameAvgMs: mean(ring.frame),
        frameP95Ms: quant(ring.frame, 0.95),
      };
      if (reset) {
        ring.compute.length = 0; ring.scene.length = 0; ring.bloom.length = 0;
        ring.total.length = 0; ring.frame.length = 0; lastFrameTs = 0;
      }
      return out;
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

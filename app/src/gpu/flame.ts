import type { CostModel } from '../data/cost';
import { perspective, lookAt, multiply, transformPoint, normalize, cross, type Vec3 } from './mat4';
import { ndcToPixel } from './motion';
import { NO_ADAPTER_MSG } from './capabilities';
import flameWGSL from './shaders/flame.wgsl?raw';

/**
 * 3D cost flame graph (M3, Fable half) — imperative WebGPU controller mirroring `createRiver`.
 * Providers rise as glowing monoliths (height = spend share), model bars crown them, and closed-form
 * embers rise off the skyline with density ∝ share — no compute pass, the river's stateless trick in 3D.
 * Geometry comes verbatim from the CostModel's x0/x1 layout, so what you see IS the aggregation.
 */

export interface FlameAnchor {
  key: string; label: string;
  x: number; y: number;          // client CSS px
  visible: boolean;
  value: number; share: number;
}

export interface FlameHandle {
  destroy(): void;
  setPaused(p: boolean): void;
  setModel(model: CostModel): void;
  pick(clientX: number, clientY: number): string | null;
}

interface SlabRec {
  key: string; label: string; depth: 0 | 1;
  value: number; share: number;
  min: Vec3; max: Vec3;
}

const SLAB_FLOATS = 12, EMBER_FLOATS = 12;
const SLAB_CAP = 256, EMBER_CAP = 16_384, EMBER_TARGET = 1400;
const FOV = 0.61; // ~35°
const ORBIT_TARGET: Vec3 = [0, 0.52, 0];

// Deterministic per-bar RNG (xorshift32 seeded by key hash) — live polls that don't change a bar
// reproduce byte-identical embers, so the scene never "pops" on refresh.
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0 || 1;
}
function rng(seed: number): () => number {
  let x = seed;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    return x / 0xffffffff;
  };
}

export function createFlame(
  canvas: HTMLCanvasElement,
  callbacks: {
    onAnchors: (a: FlameAnchor[]) => void;
    onPick?: (key: string | null) => void;
    onHover?: (key: string | null) => void;   // fired only when the hovered bar changes
    onReady?: (gpuLabel: string) => void;
    onError?: (message: string) => void;      // adapter denied / init threw — surface, don't blank
  },
): FlameHandle {
  let destroyed = false;
  let paused = false;
  let ready = false;
  let raf = 0;
  let ro: ResizeObserver | null = null;
  let device: GPUDevice | null = null;
  let pendingModel: CostModel | null = null;

  // time (freeze-consistent while paused, like river)
  let t0 = 0, pauseAccum = 0, pauseStart = 0;
  const elapsed = () => {
    const now = performance.now();
    const pausedNow = pauseStart ? now - pauseStart : 0;
    return (now - t0 - pauseAccum - pausedNow) / 1000;
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // camera (damped orbit)
  const cam = {
    yaw: -0.38, pitch: 0.47, dist: 4.0,
    tYaw: -0.38, tPitch: 0.47, tDist: 4.0,
    lastInteract: 0,
  };
  let eye: Vec3 = [0, 0, 1], fwd: Vec3 = [0, 0, -1], right: Vec3 = [1, 0, 0], up: Vec3 = [0, 1, 0];

  // scene (CPU mirror for picking/labels)
  let slabRecs: SlabRec[] = [];
  let providerAnchors: { key: string; label: string; world: Vec3; value: number; share: number }[] = [];
  let slabCount = 0, emberCount = 0;
  let highlightKey: string | null = null;
  const mouse = { x: -1, y: -1, inside: false };
  let entranceT0 = performance.now();

  // ---- scene build: CostModel → slab + ember instance floats -------------------
  const slabData = new Float32Array(SLAB_CAP * SLAB_FLOATS);
  const emberData = new Float32Array(EMBER_CAP * EMBER_FLOATS);
  let slabBuffer: GPUBuffer | null = null;
  let emberBuffer: GPUBuffer | null = null;

  function buildScene(model: CostModel) {
    const recs: SlabRec[] = [];
    const anchors: typeof providerAnchors = [];
    let s = 0, e = 0;
    const total = model.total;
    const X = (t: number) => t * 1.9 - 0.95;

    for (const p of model.providers) {
      // the unpriced trap: share is 0 when cost=$0, but x-spans already encode the requests fallback
      const fracP = total > 0 ? p.share : (p.x1 - p.x0);
      const inset = Math.min(0.008, (p.x1 - p.x0) * 1.9 * 0.06);
      const wx0 = X(p.x0) + inset, wx1 = X(p.x1) - inset;
      if (wx1 <= wx0) continue;   // zero-share in this metric → honestly absent (a 0-width flame node)
      const hP = 0.06 + 1.0 * fracP;
      let towerTop = hP;

      if (s < SLAB_CAP) {
        const cx = (wx0 + wx1) / 2, hx = (wx1 - wx0) / 2;
        slabData.set([cx, 0.002 + hP / 2, 0, 0.34, hx, hP / 2, 0.20, 0, p.color[0], p.color[1], p.color[2], 0], s * SLAB_FLOATS);
        recs.push({ key: p.key, label: p.label, depth: 0, value: p.value, share: p.share, min: [wx0, 0, -0.20], max: [wx1, hP, 0.20] });
        s++;
      }

      for (const m of p.children) {
        const fracM = total > 0 ? m.share : (m.x1 - m.x0);
        const mInset = Math.min(0.007, (m.x1 - m.x0) * 1.9 * 0.08);
        const mx0 = X(m.x0) + mInset, mx1 = X(m.x1) - mInset;
        if (mx1 <= mx0) continue;
        const hM = 0.04 + 1.0 * fracM;
        const y0 = hP, y1 = hP + hM;
        towerTop = Math.max(towerTop, y1);

        if (s < SLAB_CAP) {
          const cx = (mx0 + mx1) / 2, hx = (mx1 - mx0) / 2;
          slabData.set([cx, y0 + hM / 2, 0, 0.6, hx, hM / 2, 0.15, 1, m.color[0], m.color[1], m.color[2], 0], s * SLAB_FLOATS);
          recs.push({ key: m.key, label: m.label, depth: 1, value: m.value, share: m.share, min: [mx0, y0, -0.15], max: [mx1, y1, 0.15] });
          s++;
        }

        // embers rise off this model bar's top — sparse colored sparks, count ∝ its (layout) share
        const rand = rng(hashSeed(m.key));
        const k = Math.min(Math.max(3, Math.round(EMBER_TARGET * fracM)), EMBER_CAP - e);
        for (let j = 0; j < k; j++) {
          const ex = mx0 + rand() * (mx1 - mx0);
          const ez = (rand() * 2 - 1) * 0.10;
          const size = 0.005 + rand() * 0.007;
          const phase = rand() * 6.2831;
          const life = 1.6 + rand() * 1.6;
          const offset = rand() * life;
          const speed = 0.10 + rand() * 0.12;
          const whiten = 0.12 + rand() * 0.18;
          emberData.set([
            ex, y1, ez, size,
            phase, offset, speed, life,
            m.color[0] + (1 - m.color[0]) * whiten, m.color[1] + (1 - m.color[1]) * whiten, m.color[2] + (1 - m.color[2]) * whiten,
            (0.3 + 0.6 * Math.min(1, fracM * 3)) * 0.6,
          ], e * EMBER_FLOATS);
          e++;
        }
      }

      anchors.push({ key: p.key, label: p.label, world: [(wx0 + wx1) / 2, towerTop + 0.08, 0], value: p.value, share: p.share });
    }

    slabRecs = recs;
    providerAnchors = anchors;
    slabCount = s;
    emberCount = e;
    if (device && slabBuffer && emberBuffer) {
      device.queue.writeBuffer(slabBuffer, 0, slabData, 0, Math.max(1, s) * SLAB_FLOATS);
      device.queue.writeBuffer(emberBuffer, 0, emberData, 0, Math.max(1, e) * EMBER_FLOATS);
    }
    // keep the highlight only if its key survived the rebuild (indices shift when values reorder)
    if (highlightKey && !recs.some((r) => r.key === highlightKey)) highlightKey = null;
  }

  // ---- camera + picking helpers -------------------------------------------------
  function updateCamera(dt: number) {
    if (!reducedMotion && !paused && performance.now() - cam.lastInteract > 3000) cam.tYaw += 0.12 * dt;
    const k = 1 - Math.exp(-dt * 8);
    cam.yaw += (cam.tYaw - cam.yaw) * k;
    cam.pitch += (cam.tPitch - cam.pitch) * k;
    cam.dist += (cam.tDist - cam.dist) * k;
    eye = [
      ORBIT_TARGET[0] + cam.dist * Math.sin(cam.yaw) * Math.cos(cam.pitch),
      ORBIT_TARGET[1] + cam.dist * Math.sin(cam.pitch),
      ORBIT_TARGET[2] + cam.dist * Math.cos(cam.yaw) * Math.cos(cam.pitch),
    ];
    fwd = normalize([ORBIT_TARGET[0] - eye[0], ORBIT_TARGET[1] - eye[1], ORBIT_TARGET[2] - eye[2]]);
    right = normalize(cross(fwd, [0, 1, 0]));
    up = cross(right, fwd);
  }

  /** Ray from a canvas-relative pixel through the current camera (no matrix inverse needed). */
  function rayAt(px: number, py: number, rect: DOMRect): { dir: Vec3 } {
    const ndcX = (px / rect.width) * 2 - 1;
    const ndcY = 1 - (py / rect.height) * 2;
    const tanY = Math.tan(FOV / 2);
    const aspect = canvas.width / Math.max(1, canvas.height);
    return {
      dir: normalize([
        fwd[0] + right[0] * ndcX * tanY * aspect + up[0] * ndcY * tanY,
        fwd[1] + right[1] * ndcX * tanY * aspect + up[1] * ndcY * tanY,
        fwd[2] + right[2] * ndcX * tanY * aspect + up[2] * ndcY * tanY,
      ]),
    };
  }

  function pickAt(px: number, py: number, rect: DOMRect): SlabRec | null {
    const { dir } = rayAt(px, py, rect);
    let best: SlabRec | null = null, bestT = Infinity;
    for (const r of slabRecs) {
      let lo = 0, hi = Infinity;
      for (let a = 0; a < 3; a++) {
        const inv = 1 / dir[a];
        let ta = (r.min[a] - eye[a]) * inv, tb = (r.max[a] - eye[a]) * inv;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        lo = Math.max(lo, ta); hi = Math.min(hi, tb);
      }
      if (hi >= lo && hi > 0 && !Number.isNaN(lo) && lo < bestT) { bestT = lo; best = r; }
    }
    return best;
  }

  // ---- pointer interaction -------------------------------------------------------
  let dragging = false, dragDist = 0, lastX = 0, lastY = 0;
  const onPointerDown = (ev: PointerEvent) => {
    dragging = true; dragDist = 0; lastX = ev.clientX; lastY = ev.clientY;
    cam.lastInteract = performance.now();
    canvas.setPointerCapture(ev.pointerId);
  };
  const onPointerMove = (ev: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ev.clientX - rect.left; mouse.y = ev.clientY - rect.top; mouse.inside = true;
    if (!dragging) return;
    const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
    dragDist += Math.abs(dx) + Math.abs(dy);
    lastX = ev.clientX; lastY = ev.clientY;
    cam.tYaw -= dx * 0.006;
    cam.tPitch = Math.min(1.35, Math.max(0.08, cam.tPitch + dy * 0.005));
    cam.lastInteract = performance.now();
  };
  const onPointerUp = (ev: PointerEvent) => {
    if (dragging && dragDist < 4) {
      const rect = canvas.getBoundingClientRect();
      const hit = pickAt(ev.clientX - rect.left, ev.clientY - rect.top, rect);
      callbacks.onPick?.(hit?.key ?? null);
    }
    dragging = false;
  };
  const onPointerLeave = () => { mouse.inside = false; };
  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    cam.tDist = Math.min(8, Math.max(1.6, cam.tDist * Math.exp(ev.deltaY * 0.0012)));
    cam.lastInteract = performance.now();
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // ---- GPU init -------------------------------------------------------------------
  (async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (destroyed) return;
    if (!adapter) { callbacks.onError?.(NO_ADAPTER_MSG); return; }   // else: silent blank canvas
    device = await adapter.requestDevice();
    if (destroyed) { device.destroy(); return; }

    const info = adapter.info;
    const gpuLabel = [info?.description, info?.vendor, info?.architecture].filter(Boolean).join(' · ') || 'WebGPU';
    callbacks.onReady?.(gpuLabel);

    const ctx = canvas.getContext('webgpu')!;
    const format = navigator.gpu.getPreferredCanvasFormat();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    };
    resize();
    ctx.configure({ device, format, alphaMode: 'opaque' });

    slabBuffer = device.createBuffer({ size: SLAB_CAP * SLAB_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    emberBuffer = device.createBuffer({ size: EMBER_CAP * EMBER_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const uniformBuffer = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const uArr = new Float32Array(32);

    const module = device.createShaderModule({ code: flameWGSL });
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: slabBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: { buffer: emberBuffer } },
      ],
    });

    const additive: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    const mkPipeline = (vs: string, fs: string, blend: GPUBlendState | undefined, depthWrite: boolean, depthCompare: GPUCompareFunction) =>
      device!.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: vs },
        fragment: { module, entryPoint: fs, targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: depthWrite, depthCompare },
        multisample: { count: 4 },
      });
    const floorPipe = mkPipeline('vsFloor', 'fsFloor', undefined, true, 'less');
    const slabPipe = mkPipeline('vsSlab', 'fsSlab', undefined, true, 'less');
    const auraPipe = mkPipeline('vsAura', 'fsAura', additive, false, 'less-equal');
    const emberPipe = mkPipeline('vsEmber', 'fsEmber', additive, false, 'less');

    let depthTex: GPUTexture | null = null;
    let msaaTex: GPUTexture | null = null;

    t0 = performance.now();
    entranceT0 = performance.now();
    ready = true;
    if (pendingModel) { buildScene(pendingModel); pendingModel = null; }

    let frameNo = 0;
    let lastFrame = performance.now();
    const scratch = new Float32Array(16);

    const frame = () => {
      if (destroyed) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;
      const time = elapsed();

      updateCamera(dt);

      // lazily (re)create depth + MSAA targets — race-proof vs ResizeObserver timing
      if (!depthTex || depthTex.width !== canvas.width || depthTex.height !== canvas.height) {
        depthTex?.destroy(); msaaTex?.destroy();
        depthTex = device!.createTexture({ size: [canvas.width, canvas.height], format: 'depth24plus', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        msaaTex = device!.createTexture({ size: [canvas.width, canvas.height], format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      }

      const aspect = canvas.width / Math.max(1, canvas.height);
      const viewProj = multiply(perspective(FOV, aspect, 0.1, 40), lookAt(eye, ORBIT_TARGET, [0, 1, 0]), scratch);

      // entrance fade (cubic ease-out over 700ms; instant under reduced motion)
      const fade = reducedMotion ? 1 : Math.min(1, (now - entranceT0) / 700);
      const eased = 1 - Math.pow(1 - fade, 3);

      // hover pick — resolved with the SAME camera used for this frame (freeze-consistent)
      let highlightIdx = -1;
      if (mouse.inside && !dragging) {
        const rect = canvas.getBoundingClientRect();
        const hit = pickAt(mouse.x, mouse.y, rect);
        if ((hit?.key ?? null) !== highlightKey) { highlightKey = hit?.key ?? null; callbacks.onHover?.(highlightKey); }
        if (hit) highlightIdx = slabRecs.indexOf(hit);
        canvas.style.cursor = hit ? 'pointer' : 'grab';
      } else if (highlightKey) {
        highlightIdx = slabRecs.findIndex((r) => r.key === highlightKey);
      }

      uArr.set(viewProj, 0);
      uArr.set([eye[0], eye[1], eye[2], time], 16);
      uArr.set([right[0], right[1], right[2], highlightIdx], 20);
      uArr.set([up[0], up[1], up[2], eased], 24);
      uArr.set([1.0, 0.55, 0, 0], 28);   // emberBoost, auraStrength
      device!.queue.writeBuffer(uniformBuffer, 0, uArr);

      const enc = device!.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: msaaTex!.createView(), resolveTarget: ctx.getCurrentTexture().createView(),
          clearValue: { r: 0.016, g: 0.02, b: 0.043, a: 1 }, loadOp: 'clear', storeOp: 'discard',
        }],
        depthStencilAttachment: { view: depthTex!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      pass.setBindGroup(0, bindGroup);
      pass.setPipeline(floorPipe); pass.draw(6);
      if (slabCount > 0) {
        pass.setPipeline(slabPipe); pass.draw(36, slabCount);
        pass.setPipeline(auraPipe); pass.draw(36, slabCount);
      }
      if (emberCount > 0) { pass.setPipeline(emberPipe); pass.draw(6, emberCount); }
      pass.end();
      device!.queue.submit([enc.finish()]);

      // DOM labels track the bars through 3D — every 4th frame
      if ((frameNo++ & 3) === 0) {
        const rect = canvas.getBoundingClientRect();
        callbacks.onAnchors(providerAnchors.map((a) => {
          const c = transformPoint(viewProj, a.world);
          if (c.w <= 0) return { key: a.key, label: a.label, x: 0, y: 0, visible: false, value: a.value, share: a.share };
          const ndcX = c.x / c.w, ndcY = c.y / c.w;
          const { px, py } = ndcToPixel(ndcX, ndcY, { width: rect.width, height: rect.height });
          return {
            key: a.key, label: a.label,
            x: rect.left + px, y: rect.top + py,
            visible: Math.abs(ndcX) < 1.05 && Math.abs(ndcY) < 1.05,
            value: a.value, share: a.share,
          };
        }));
      }
      raf = requestAnimationFrame(frame);
    };

    ro = new ResizeObserver(resize);
    ro.observe(canvas);
    canvas.style.cursor = 'grab';
    raf = requestAnimationFrame(frame);
    // eslint-disable-next-line no-console
    console.log('[fathom] flame mode ·', gpuLabel);
  })().catch((e) => {
    console.error('[fathom] flame init failed:', e);
    if (!destroyed) callbacks.onError?.(`WebGPU init failed — ${e instanceof Error ? e.message : String(e)}`);
  });

  return {
    destroy() {
      destroyed = true;
      ready = false;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.style.cursor = '';
      device?.destroy();
    },
    setPaused(p: boolean) {
      const now = performance.now();
      if (p && !paused) pauseStart = now;
      else if (!p && paused) { pauseAccum += now - pauseStart; pauseStart = 0; }
      paused = p;
    },
    setModel(model: CostModel) {
      if (!ready) { pendingModel = model; return; }
      buildScene(model);
    },
    pick(clientX: number, clientY: number): string | null {
      const rect = canvas.getBoundingClientRect();
      return pickAt(clientX - rect.left, clientY - rect.top, rect)?.key ?? null;
    },
  };
}

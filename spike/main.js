/*
 * Fathom — WebGPU span-river feasibility spike
 * ---------------------------------------------
 * Answers ONE question before any real build starts:
 *   Can WebGPU simulate + render ~1,000,000 "span" particles as a flowing river
 *   (with per-particle state: span / cache-hit fork / PII flare) at >=60fps?
 *
 * The compute shader does the genuinely hard part: a per-particle simulation over
 * the whole buffer every frame. The render pass draws them as additive points.
 * An auto-sweep measures sustained FPS *and* true GPU-time-per-frame (timestamp-query)
 * across 100k .. 2M particles, then prints a GO / GO-with-LOD / RETHINK verdict.
 *
 * No dependencies, no build step. Open in Chrome/Edge, or serve on localhost.
 */
(async function () {
  'use strict';

  // ---- Config: the sweep + the pre-registered pass/fail thresholds --------
  const MAX_PARTICLES = 2_000_000;            // 64 MB buffer (well under the 128 MB storage limit)
  const SWEEP = [100_000, 250_000, 500_000, 1_000_000, 2_000_000];
  const WARMUP_FRAMES = 40;                    // let each stage settle before sampling
  const SAMPLE_FRAMES = 100;                   // frames measured per stage
  const GO_BAR_COUNT = 1_000_000;              // the count that decides the thesis
  const FPS_OK = 58;                           // "sustains 60fps" with a hair of slack
  const GPU_BUDGET_MS = 16.7;                  // one 60fps frame

  const PARTICLE_FLOATS = 8;                   // p0=(x,y,vx,vy)  p1=(state,laneSeed,phase,_)
  const PARTICLE_BYTES = PARTICLE_FLOATS * 4;  // 32 bytes

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => n >= 1e6 ? (n / 1e6) + 'M' : (n / 1e3) + 'k';

  function fail(msg) {
    $('err').style.display = 'grid';
    $('err-msg').innerHTML = msg;
    if (window.__fathomBench) window.__fathomBench.status = 'error', window.__fathomBench.error = msg;
  }

  // ---- Bench handle the Playwright harness reads --------------------------
  window.__fathomBench = { status: 'init', adapter: null, results: [], verdict: null };

  // ------------------------------------------------------------------------
  if (!('gpu' in navigator)) {
    return fail('WebGPU is not available in this browser.<br>Use Chrome/Edge 113+ (or a Chromium with WebGPU enabled).');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return fail('No WebGPU adapter found (no compatible GPU exposed to the browser).');

  const info = (adapter.info) ? adapter.info : (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
  const gpuLabel = [info.description, info.vendor, info.architecture].filter(Boolean).join(' · ') || 'unknown GPU';

  const canTimestamp = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures: canTimestamp ? ['timestamp-query'] : [],
  });
  device.lost.then((e) => fail('GPU device lost: ' + e.message));
  device.addEventListener?.('uncapturederror', (e) => console.error('WebGPU error:', e.error?.message));

  window.__fathomBench.adapter = { label: gpuLabel, vendor: info.vendor || '', architecture: info.architecture || '',
    description: info.description || '', timestampQuery: canTimestamp };
  $('gpu-name').textContent = gpuLabel + (canTimestamp ? '' : '  (no timestamp-query)');

  // ---- Canvas / context --------------------------------------------------
  const canvas = $('gpu-canvas');
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  function resize() {
    canvas.width = Math.floor(canvas.clientWidth);
    canvas.height = Math.floor(canvas.clientHeight);
  }
  resize();
  window.addEventListener('resize', resize);
  ctx.configure({ device, format, alphaMode: 'opaque' });

  // ---- Particle buffer, seeded on the CPU --------------------------------
  const particleBuffer = device.createBuffer({
    size: MAX_PARTICLES * PARTICLE_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  {
    const data = new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const b = i * PARTICLE_FLOATS;
      const r = Math.random();
      const state = r < 0.75 ? 0 : (r < 0.95 ? 1 : 2);   // 75% span, 20% cache-hit, 5% PII
      const laneSeed = Math.random();
      const phase = Math.random();
      const targetY = state === 1 ? (0.16 + laneSeed * 0.36) : (-0.62 + laneSeed * 0.44);
      data[b + 0] = -1.08 + Math.random() * 2.16;         // x across the river
      data[b + 1] = targetY + (Math.random() - 0.5) * 0.05;
      data[b + 2] = 0.004 + Math.random() * 0.008;        // vx (per 60fps-frame)
      data[b + 3] = 0;
      data[b + 4] = state;
      data[b + 5] = laneSeed;
      data[b + 6] = phase;
      data[b + 7] = 0;
    }
    device.queue.writeBuffer(particleBuffer, 0, data);
  }

  // ---- Uniforms: time, dt, count, aspect ---------------------------------
  const uniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uniformArr = new ArrayBuffer(16);
  const uF = new Float32Array(uniformArr);
  const uU = new Uint32Array(uniformArr);

  // ---- Shaders -----------------------------------------------------------
  const HASH = `
    fn hashU(n0: u32) -> u32 {
      var x = n0; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u;
      x *= 0x846ca68bu; x ^= x >> 16u; return x;
    }
    fn rand01(n: u32) -> f32 { return f32(hashU(n) & 0x00ffffffu) / f32(0x01000000u); }`;

  const computeModule = device.createShaderModule({ code: `
    struct Particle { p0: vec4<f32>, p1: vec4<f32> };
    struct U { time: f32, dt: f32, count: u32, aspect: f32 };
    @group(0) @binding(0) var<storage, read_write> parts: array<Particle>;
    @group(0) @binding(1) var<uniform> u: U;
    ${HASH}
    @compute @workgroup_size(64)
    fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i = gid.x;
      if (i >= u.count) { return; }
      var p = parts[i];
      var pos = p.p0.xy;
      let vx = p.p0.z;
      let st = p.p1.x;
      let laneSeed = p.p1.y;
      let phase = p.p1.z;

      var targetY = mix(-0.62, -0.18, laneSeed);
      if (st > 0.5 && st < 1.5) { targetY = mix(0.16, 0.52, laneSeed); }  // cache-hit tributary

      pos.x += vx * (u.dt * 60.0);
      pos.y += sin(u.time * 1.7 + phase * 6.2831 + pos.x * 2.5) * 0.0009; // turbulence
      pos.y += (targetY - pos.y) * 0.06;                                   // ease into lane
      if (pos.x > 1.08) { pos.x = -1.08; }                                 // recycle

      p.p0 = vec4<f32>(pos.x, pos.y, vx, p.p0.w);
      parts[i] = p;
    }` });

  const renderModule = device.createShaderModule({ code: `
    struct Particle { p0: vec4<f32>, p1: vec4<f32> };
    @group(0) @binding(0) var<storage, read> parts: array<Particle>;
    struct VOut { @builtin(position) pos: vec4<f32>, @location(0) col: vec4<f32> };
    @vertex
    fn vs(@builtin(vertex_index) vi: u32) -> VOut {
      let p = parts[vi];
      var o: VOut;
      o.pos = vec4<f32>(p.p0.xy, 0.0, 1.0);
      let st = p.p1.x;
      var c = vec3<f32>(0.15, 0.42, 1.0); var a = 0.32;          // span (blue)
      if (st > 0.5 && st < 1.5) { c = vec3<f32>(0.10, 1.0, 0.70); a = 0.45; } // cache-hit (cyan)
      if (st > 1.5)            { c = vec3<f32>(1.0, 0.15, 0.20); a = 0.95; }  // PII (red)
      o.col = vec4<f32>(c, a);
      return o;
    }
    @fragment fn fs(i: VOut) -> @location(0) vec4<f32> { return i.col; }` });

  const computeBGL = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
  ] });
  const renderBGL = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
  ] });

  const computePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [computeBGL] }),
    compute: { module: computeModule, entryPoint: 'cs' },
  });
  const renderPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [renderBGL] }),
    vertex: { module: renderModule, entryPoint: 'vs' },
    fragment: { module: renderModule, entryPoint: 'fs', targets: [{
      format,
      blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      },
    }] },
    primitive: { topology: 'point-list' },
  });

  const computeBG = device.createBindGroup({ layout: computeBGL, entries: [
    { binding: 0, resource: { buffer: particleBuffer } },
    { binding: 1, resource: { buffer: uniformBuffer } },
  ] });
  const renderBG = device.createBindGroup({ layout: renderBGL, entries: [
    { binding: 0, resource: { buffer: particleBuffer } },
  ] });

  // ---- Timestamp-query plumbing (true GPU time), best-effort -------------
  let querySet = null, resolveBuf = null, readBuf = null, mapPending = false, lastGpuMs = 0;
  if (canTimestamp) {
    try {
      querySet = device.createQuerySet({ type: 'timestamp', count: 4 });
      resolveBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      readBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    } catch (e) { console.warn('timestamp-query disabled:', e); querySet = null; }
  }

  // ---- State -------------------------------------------------------------
  let count = 1_000_000;
  let time = 0;
  let frameNo = 0;
  let last = performance.now();
  let fpsEMA = 60, frameEMA = 16.7;

  const sweep = { active: false, idx: 0, phase: 'warmup', frames: 0, fpsS: [], frameS: [], gpuS: [], results: [] };
  const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

  function setCount(n) {
    count = Math.min(n, MAX_PARTICLES);
    document.querySelectorAll('#controls button[data-count]').forEach((b) =>
      b.classList.toggle('active', +b.dataset.count === count && !sweep.active));
  }
  window.__fathomSetCount = setCount; // for the harness / manual poking

  // ---- Controls ----------------------------------------------------------
  document.querySelectorAll('#controls button[data-count]').forEach((b) =>
    b.addEventListener('click', () => { if (!sweep.active) setCount(+b.dataset.count); }));
  $('sweep-btn').addEventListener('click', startSweep);

  function startSweep() {
    if (sweep.active) return;
    sweep.active = true; sweep.idx = 0; sweep.phase = 'warmup'; sweep.frames = 0;
    sweep.fpsS = []; sweep.frameS = []; sweep.gpuS = []; sweep.results = [];
    $('results').style.display = 'none'; $('verdict').style.display = 'none';
    $('sweep-btn').classList.add('active'); $('sweep-btn').textContent = '… sweeping';
    window.__fathomBench.status = 'running'; window.__fathomBench.results = [];
    setCount(SWEEP[0]);
  }

  function finishSweep() {
    sweep.active = false;
    $('sweep-btn').classList.remove('active'); $('sweep-btn').textContent = '▶ Auto-sweep';

    // Verdict: the count that decides the thesis is GO_BAR_COUNT (1M).
    const at1M = sweep.results.find((r) => r.count === GO_BAR_COUNT);
    const okFps = (r) => r && r.fps >= FPS_OK;
    const okGpu = (r) => r && (r.gpuMs <= 0 || r.gpuMs <= GPU_BUDGET_MS);
    let cls, text;
    if (okFps(at1M) && okGpu(at1M)) {
      cls = 'go'; text = 'GO — 1M spans sustain 60fps. The Fathom cinema is buildable.';
    } else {
      const best = sweep.results.filter((r) => okFps(r) && okGpu(r)).map((r) => r.count).sort((a, b) => b - a)[0] || 0;
      if (best >= 500_000) { cls = 'lod'; text = 'GO with LOD — sustains 60fps up to ' + fmt(best) + '; add GPU-side aggregation above that.'; }
      else { cls = 'rethink'; text = 'RETHINK — only ' + fmt(best) + ' sustained 60fps; revisit the render approach.'; }
    }
    const v = $('verdict'); v.className = cls; v.textContent = text;
    window.__fathomBench.verdict = { class: cls, text, results: sweep.results, gpuLabel };
    window.__fathomBench.results = sweep.results;
    window.__fathomBench.status = 'done';

    // Results table
    const tb = $('results').querySelector('tbody'); tb.innerHTML = '';
    for (const r of sweep.results) {
      const pass = r.fps >= FPS_OK && (r.gpuMs <= 0 || r.gpuMs <= GPU_BUDGET_MS);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${fmt(r.count)}</td>` +
        `<td class="${pass ? 'pass' : 'fail'}">${r.fps.toFixed(0)}</td>` +
        `<td>${r.frameMs.toFixed(2)}</td>` +
        `<td>${r.gpuMs > 0 ? r.gpuMs.toFixed(2) : '—'}</td>`;
      tb.appendChild(tr);
    }
    $('results').style.display = 'table';
  }

  // ---- Frame loop --------------------------------------------------------
  function frame(now) {
    const rafDelta = now - last; last = now;
    const dt = Math.min(rafDelta, 40) / 1000;
    time += dt;
    frameNo++;

    const instFps = rafDelta > 0 ? 1000 / rafDelta : 60;
    fpsEMA += (instFps - fpsEMA) * 0.1;
    frameEMA += (rafDelta - frameEMA) * 0.1;

    // uniforms
    uF[0] = time; uF[1] = dt; uU[2] = count; uF[3] = canvas.width / canvas.height;
    device.queue.writeBuffer(uniformBuffer, 0, uniformArr);

    const useTs = !!querySet;
    const encoder = device.createCommandEncoder();

    const cpass = encoder.beginComputePass(useTs ? {
      timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : undefined);
    cpass.setPipeline(computePipeline); cpass.setBindGroup(0, computeBG);
    cpass.dispatchWorkgroups(Math.ceil(count / 64));
    cpass.end();

    const rpass = encoder.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(),
        clearValue: { r: 0.02, g: 0.024, b: 0.05, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      ...(useTs ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } } : {}),
    });
    rpass.setPipeline(renderPipeline); rpass.setBindGroup(0, renderBG);
    rpass.draw(count);
    rpass.end();

    let didCopy = false;
    if (useTs) {
      encoder.resolveQuerySet(querySet, 0, 4, resolveBuf, 0);
      if (!mapPending && frameNo % 8 === 0) { encoder.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, 32); didCopy = true; }
    }
    device.queue.submit([encoder.finish()]);

    if (didCopy) {
      mapPending = true;
      readBuf.mapAsync(GPUMapMode.READ).then(() => {
        try {
          const q = new BigInt64Array(readBuf.getMappedRange());
          const g = Number(q[1] - q[0]) / 1e6 + Number(q[3] - q[2]) / 1e6;
          if (isFinite(g) && g >= 0 && g < 1000) lastGpuMs = g;
        } finally { readBuf.unmap(); mapPending = false; }
      });
    }

    // sweep sampling
    if (sweep.active) {
      if (sweep.phase === 'warmup') {
        if (++sweep.frames >= WARMUP_FRAMES) { sweep.phase = 'sample'; sweep.frames = 0; sweep.fpsS = []; sweep.frameS = []; sweep.gpuS = []; }
      } else {
        sweep.fpsS.push(instFps); sweep.frameS.push(rafDelta); if (lastGpuMs > 0) sweep.gpuS.push(lastGpuMs);
        if (++sweep.frames >= SAMPLE_FRAMES) {
          sweep.results.push({ count, fps: median(sweep.fpsS), frameMs: median(sweep.frameS), gpuMs: median(sweep.gpuS) });
          sweep.idx++;
          if (sweep.idx < SWEEP.length) { setCount(SWEEP[sweep.idx]); sweep.phase = 'warmup'; sweep.frames = 0; }
          else finishSweep();
        }
      }
    }

    // HUD
    $('m-count').textContent = fmt(count);
    $('m-fps').textContent = fpsEMA.toFixed(0);
    $('m-frame').textContent = frameEMA.toFixed(2) + ' ms';
    $('m-gpu').textContent = lastGpuMs > 0 ? lastGpuMs.toFixed(2) + ' ms' : (canTimestamp ? '…' : 'n/a');

    requestAnimationFrame(frame);
  }

  // ---- Boot --------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  if (params.has('count')) setCount(+params.get('count')); else setCount(count);
  window.__fathomBench.status = 'ready';
  requestAnimationFrame(frame);
  if (params.get('auto') === '1') setTimeout(startSweep, 300);
})();

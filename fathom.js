/*
 * Fathom — LLM-ops observability cinema (real-data renderer)
 * ----------------------------------------------------------
 * Reads a normalized trace (Fathom schema) and renders every request as a glowing
 * comet, spawned on the captured timeline, flowing into a lane by its REAL outcome:
 *   cache hit -> cyan tributary   429->fallback -> amber   PII block -> red flare   miss -> blue
 * Motion is closed-form in the vertex shader (stateless, loops seamlessly); particles
 * are soft additive sprites. Data source is swappable — this file never mentions sentinel.
 *
 * ?data=traces.json (default) | ?loop=16
 */
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const DATA_URL = params.get('data') || 'traces.json';
  const LOOP = +(params.get('loop') || 16);
  window.__fathomReady = false;

  function fail(m) { $('err').style.display = 'grid'; $('err-msg').innerHTML = m; window.__fathomError = m; }

  // ---- Load the normalized trace ----------------------------------------
  let trace;
  try { trace = await (await fetch(DATA_URL, { cache: 'no-store' })).json(); }
  catch (e) { return fail('Could not load ' + DATA_URL + '<br>' + e.message); }
  const events = (trace.events || []).slice();
  if (!events.length) return fail('No events in ' + DATA_URL);
  // The load-harness capture is ordered sequentially by scenario (all misses, then all hits,
  // then fallbacks, then PII) — not real arrival timing. Interleave the real spans into a mixed
  // stream so every outcome flows together, as it would under live traffic. Spans + proportions
  // are unchanged; only their replay position is shuffled.
  for (let i = events.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const tmp = events[i]; events[i] = events[j]; events[j] = tmp; }
  window.__fathomMeta = trace.meta || {};

  // Source badge + right-panel copy
  const isSynthetic = /synthetic|sample/i.test((trace.meta && trace.meta.source) || '');
  $('src').textContent = isSynthetic ? 'synthetic sample' : 'real capture';
  $('src').classList.toggle('synthetic', isSynthetic);

  // ---- Classify each event by its REAL outcome --------------------------
  // lanes in clip space (y): cyan top, amber mid, blue bottom, red = bottom w/ flare
  function classify(e) {
    const pii = e.pii || (e.guardrail === 'block') || /pii/.test((e.piiCategories || []).join(','));
    if (pii) return { kind: 'pii', col: [1.0, 0.19, 0.25], lane: [-0.5, -0.24], k: 90, life: 5.2, size: 0.020, alpha: 1.0, flare: 1 };
    if (e.cacheHit) return { kind: 'cache', col: [0.11, 1.0, 0.72], lane: [0.18, 0.5], k: 26, life: 3.4, size: 0.011, alpha: 0.75, flare: 0 };
    if (e.fallbackUsed) return { kind: 'fallback', col: [1.0, 0.68, 0.13], lane: [-0.07, 0.09], k: 74, life: 7.0, size: 0.013, alpha: 0.8, flare: 0 };
    return { kind: 'span', col: [0.22, 0.5, 1.0], lane: [-0.62, -0.28], k: 52, life: 6.0, size: 0.011, alpha: 0.55, flare: 0 };
  }

  // ---- Build the particle buffer (comet per request) --------------------
  // Even spacing across the loop preserves captured ORDER (which encodes the phases)
  // while guaranteeing a smooth, dense river regardless of the harness's clock.
  const N = events.length;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const P = []; // 12 floats/particle: [spawnT,vx,size,life] [x0,yStart,yTarget,phase] [r,g,b,alpha]
  const counters = new Array(N);
  for (let i = 0; i < N; i++) {
    const e = events[i];
    const c = classify(e);
    counters[i] = c.kind;
    const tS = (i / N) * (LOOP * 0.85) + rnd(-0.04, 0.04);
    const yT = rnd(c.lane[0], c.lane[1]);
    const yS = yT + rnd(-0.05, 0.05) + (c.flare ? rnd(0.05, 0.12) : 0);
    const cometLife = c.life * rnd(0.9, 1.1);
    const vx = 2.35 / cometLife;
    const K = Math.round(c.k * rnd(0.8, 1.15));
    for (let j = 0; j < K; j++) {
      const trail = j / K;
      const spawnT = tS + trail * (c.flare ? 0.25 : 0.5);
      const size = c.size * (1 - 0.6 * trail) * rnd(0.7, 1.25);
      const life = cometLife * rnd(0.55, 1.0);
      const alpha = c.alpha * (1 - 0.55 * trail);
      const jy = rnd(-0.03, 0.03);
      P.push(spawnT, vx, size, life, -1.14, yS + jy, yT + jy, rnd(0, 6.2831),
        c.col[0], c.col[1], c.col[2], alpha);
    }
  }
  const PARTICLES = P.length / 12;
  const particleData = new Float32Array(P);

  // ---- WebGPU ------------------------------------------------------------
  if (!('gpu' in navigator)) return fail('WebGPU not available — use Chrome/Edge 113+.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return fail('No WebGPU adapter.');
  const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
  $('gpu-name').textContent = [info.description, info.vendor, info.architecture].filter(Boolean).join(' · ') || 'WebGPU';
  const device = await adapter.requestDevice();
  device.lost.then((e) => fail('GPU device lost: ' + e.message));
  device.addEventListener && device.addEventListener('uncapturederror', (e) => console.log('[fathom] WGPU error:', e.error && e.error.message));

  const canvas = $('gpu-canvas');
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() { canvas.width = Math.floor(canvas.clientWidth * dpr); canvas.height = Math.floor(canvas.clientHeight * dpr); }
  resize(); window.addEventListener('resize', resize);
  ctx.configure({ device, format, alphaMode: 'opaque' });

  const particleBuffer = device.createBuffer({ size: particleData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(particleBuffer, 0, particleData);
  const uniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uBuf = new ArrayBuffer(16); const uF = new Float32Array(uBuf);

  const shader = device.createShaderModule({ code: `
    struct P { a: vec4<f32>, b: vec4<f32>, c: vec4<f32> };
    struct U { time: f32, cycle: f32, aspect: f32, _pad: f32 };
    @group(0) @binding(0) var<storage, read> parts: array<P>;
    @group(0) @binding(1) var<uniform> u: U;
    struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) col: vec4<f32> };
    fn corner(i: u32) -> vec2<f32> {
      var q = array<vec2<f32>, 6>(
        vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(-1.0,1.0),
        vec2<f32>(-1.0,1.0), vec2<f32>(1.0,-1.0), vec2<f32>(1.0,1.0));
      return q[i];
    }
    @vertex
    fn vs(@builtin(vertex_index) vi: u32) -> VOut {
      let pid = vi / 6u; let ci = vi % 6u;
      let p = parts[pid];
      var o: VOut;
      let spawnT = p.a.x; let vx = p.a.y; let size = p.a.z; let life = p.a.w;
      var tau = u.time - spawnT;
      tau = tau - floor(tau / u.cycle) * u.cycle;    // wrap into [0, cycle)
      if (tau > life) { o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0); o.col = vec4<f32>(0.0); o.uv = vec2<f32>(0.0); return o; }
      let x0 = p.b.x; let yStart = p.b.y; let yTarget = p.b.z; let phase = p.b.w;
      let x = x0 + vx * tau;
      let ease = yTarget + (yStart - yTarget) * exp(-3.0 * tau);
      let turb = 0.022 * sin(tau * 2.6 + phase) + 0.013 * sin(tau * 6.1 + phase * 1.7);
      let y = ease + turb;
      let fin = smoothstep(0.0, 0.12 * life, tau);
      let fout = 1.0 - smoothstep(0.5 * life, life, tau);
      let a = p.c.w * fin * fout;
      let cq = corner(ci);
      let off = vec2<f32>(cq.x * size, cq.y * size * u.aspect);
      o.pos = vec4<f32>(x + off.x, y + off.y, 0.0, 1.0);
      o.uv = cq;
      o.col = vec4<f32>(p.c.rgb, a);
      return o;
    }
    @fragment
    fn fs(i: VOut) -> @location(0) vec4<f32> {
      let d = length(i.uv);
      let g = pow(1.0 - smoothstep(0.0, 1.0, d), 2.2);   // soft radial falloff
      let aa = i.col.a * g;
      return vec4<f32>(i.col.rgb * aa, aa);              // premultiplied -> additive
    }` });

  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
  ] });
  device.pushErrorScope('validation');
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module: shader, entryPoint: 'vs' },
    fragment: { module: shader, entryPoint: 'fs', targets: [{ format, blend: {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }] },
    primitive: { topology: 'triangle-list' },
  });
  device.popErrorScope().then((err) => { if (err) console.log('[fathom] pipeline error:', err.message); });
  const bindGroup = device.createBindGroup({ layout: bgl, entries: [
    { binding: 0, resource: { buffer: particleBuffer } },
    { binding: 1, resource: { buffer: uniformBuffer } },
  ] });

  // ---- HUD: cumulative counters as the playhead advances ----------------
  const tScaled = events.map((_, i) => (i / N) * (LOOP * 0.85));
  function updateHUD(cycleT) {
    let req = 0, cache = 0, fb = 0, pii = 0;
    for (let i = 0; i < N; i++) {
      if (tScaled[i] > cycleT) break;
      req++;
      if (counters[i] === 'cache') cache++;
      else if (counters[i] === 'fallback') fb++;
      else if (counters[i] === 'pii') pii++;
    }
    $('m-req').textContent = req;
    $('m-cache').textContent = (req ? Math.round((cache / req) * 100) : 0) + '%';
    $('m-fb').textContent = fb;
    $('m-pii').textContent = pii;
    $('playhead').style.width = (100 * cycleT / LOOP).toFixed(1) + '%';
  }

  // ---- Frame loop --------------------------------------------------------
  let t0 = performance.now();
  function frame(now) {
    const time = (now - t0) / 1000;
    const cycleT = time % LOOP;
    uF[0] = time; uF[1] = LOOP; uF[2] = canvas.width / canvas.height; uF[3] = 0;
    device.queue.writeBuffer(uniformBuffer, 0, uBuf);

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{
      view: ctx.getCurrentTexture().createView(),
      clearValue: { r: 0.016, g: 0.02, b: 0.043, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
    pass.draw(PARTICLES * 6);
    pass.end();
    device.queue.submit([enc.finish()]);

    updateHUD(cycleT);
    window.__fathomReady = true;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  console.log('[fathom]', PARTICLES.toLocaleString(), 'particles from', N, 'spans ·', $('gpu-name').textContent);
})();

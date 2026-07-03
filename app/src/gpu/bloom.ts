// Bloom chain (M4) — owns the HDR scene target + the downsample/upsample mip chain and the four
// post pipelines (prefilter / down / up-additive / composite). The river renders into
// `sceneView()`; `encode()` appends the whole post graph to the frame's command encoder and ends
// on the swapchain. Self-contained so river.ts stays lean; recreate via `resize()` (frame-start
// only — never mid-encode), which destroys the old textures explicitly.
import bloomWGSL from './shaders/bloom.wgsl?raw';

const HDR: GPUTextureFormat = 'rgba16float';   // core-WebGPU renderable + blendable + filterable
const THRESHOLD = 0.55;   // only genuinely hot cores bloom (scene clear ~0.04 is far below);
const KNEE = 0.25;        // tuned on the real capture — 0.30/0.8 blew dense lanes out to white
const STRENGTH = 0.45;
const MIN_MIP = 8;        // stop the chain before mips degenerate
const MAX_LEVELS = 6;

interface Pass {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  view: GPUTextureView;     // destination
  loadOp: GPULoadOp;
}

export interface BloomChain {
  resize(w: number, h: number): void;
  sceneView(): GPUTextureView;
  /** Append prefilter → down → up → composite(→ swapchain) to `enc`. `ts` (perf mode) writes
   *  `begin` at the start of the first pass and `end` at the end of the composite. */
  encode(enc: GPUCommandEncoder, swapView: GPUTextureView, ts?: { querySet: GPUQuerySet; begin: number; end: number }): void;
  destroy(): void;
}

export function createBloom(device: GPUDevice, swapFormat: GPUTextureFormat): BloomChain {
  const module = device.createShaderModule({ code: bloomWGSL });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

  const filterBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const compositeBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ],
  });

  const makePipeline = (entry: string, bgl: GPUBindGroupLayout, format: GPUTextureFormat, additive: boolean) =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module, entryPoint: entry,
        targets: [{
          format,
          ...(additive ? { blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          } } : {}),
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

  const prefilterPipe = makePipeline('fs_prefilter', filterBGL, HDR, false);
  const downPipe = makePipeline('fs_down', filterBGL, HDR, false);
  const upPipe = makePipeline('fs_up', filterBGL, HDR, true);       // additive into the level above
  const compositePipe = makePipeline('fs_composite', compositeBGL, swapFormat, false);

  // (texel.xy, threshold, knee, strength, pad×3) — one 32-byte uniform per pass, baked at resize.
  const makeParams = (w: number, h: number) => {
    const buf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buf, 0, new Float32Array([1 / w, 1 / h, THRESHOLD, KNEE, STRENGTH, 0, 0, 0]));
    return buf;
  };

  let scene: GPUTexture | null = null;
  let sceneV: GPUTextureView | null = null;
  let mips: GPUTexture[] = [];
  let params: GPUBuffer[] = [];
  let passes: Pass[] = [];
  let compositeBG: GPUBindGroup | null = null;

  const dispose = () => {
    scene?.destroy();
    for (const t of mips) t.destroy();
    for (const b of params) b.destroy();
    scene = null; sceneV = null; mips = []; params = []; passes = []; compositeBG = null;
  };

  const mk = (w: number, h: number, label: string) => device.createTexture({
    label, size: { width: Math.max(1, w), height: Math.max(1, h) }, format: HDR,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const filterBG = (srcView: GPUTextureView, p: GPUBuffer) => device.createBindGroup({
    layout: filterBGL,
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: srcView },
      { binding: 2, resource: { buffer: p } },
    ],
  });

  return {
    resize(w: number, h: number) {
      dispose();
      scene = mk(w, h, 'bloom-scene-hdr');
      sceneV = scene.createView();

      // half-res chain: mip[0] = w/2 … halving until min-dim < MIN_MIP (or MAX_LEVELS)
      const dims: [number, number][] = [];
      let mw = w >> 1, mh = h >> 1;
      while (dims.length < MAX_LEVELS && Math.min(mw, mh) >= MIN_MIP) {
        dims.push([mw, mh]);
        mw >>= 1; mh >>= 1;
      }
      if (dims.length === 0) dims.push([Math.max(1, w >> 1), Math.max(1, h >> 1)]);
      mips = dims.map(([a, b], i) => mk(a, b, `bloom-mip${i}`));
      const views = mips.map((t) => t.createView());

      passes = [];
      // prefilter: scene → mip0 (params carry the SOURCE texel size)
      let p = makeParams(w, h);
      params.push(p);
      passes.push({ pipeline: prefilterPipe, bindGroup: filterBG(sceneV, p), view: views[0], loadOp: 'clear' });
      // down: mip[i-1] → mip[i]
      for (let i = 1; i < mips.length; i++) {
        p = makeParams(dims[i - 1][0], dims[i - 1][1]);
        params.push(p);
        passes.push({ pipeline: downPipe, bindGroup: filterBG(views[i - 1], p), view: views[i], loadOp: 'clear' });
      }
      // up: mip[i] +→ mip[i-1] (additive)
      for (let i = mips.length - 1; i >= 1; i--) {
        p = makeParams(dims[i][0], dims[i][1]);
        params.push(p);
        passes.push({ pipeline: upPipe, bindGroup: filterBG(views[i], p), view: views[i - 1], loadOp: 'load' });
      }
      // composite: scene + strength·mip0 → swapchain (bind group built here; view is per-frame)
      p = makeParams(w, h);
      params.push(p);
      compositeBG = device.createBindGroup({
        layout: compositeBGL,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: sceneV },
          { binding: 2, resource: { buffer: p } },
          { binding: 3, resource: views[0] },
        ],
      });
    },

    sceneView() {
      if (!sceneV) throw new Error('bloom: resize() before sceneView()');
      return sceneV;
    },

    encode(enc, swapView, ts) {
      passes.forEach((pass, i) => {
        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: pass.view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: pass.loadOp, storeOp: 'store' }],
          ...(ts && i === 0 ? { timestampWrites: { querySet: ts.querySet, beginningOfPassWriteIndex: ts.begin } } : {}),
        });
        rp.setPipeline(pass.pipeline);
        rp.setBindGroup(0, pass.bindGroup);
        rp.draw(3);
        rp.end();
      });
      const rp = enc.beginRenderPass({
        colorAttachments: [{ view: swapView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
        ...(ts ? { timestampWrites: { querySet: ts.querySet, endOfPassWriteIndex: ts.end } } : {}),
      });
      rp.setPipeline(compositePipe);
      rp.setBindGroup(0, compositeBG!);
      rp.draw(3);
      rp.end();
    },

    destroy: dispose,
  };
}

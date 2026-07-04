// Fathom bloom (M4) — classic threshold → downsample chain → tent upsample → composite.
// The river renders into an HDR scene target (rgba16float); dense additive comet clusters exceed
// 1.0 and are exactly what should glow. All passes are fullscreen triangles; per-pass params
// (source texel size, threshold/knee, strength) come in a small uniform baked at resize.

struct BP {
  texel: vec2<f32>,     // source texture texel size
  threshold: f32,       // luminance knee start (scene clear ~0.04 stays far below)
  knee: f32,
  strength: f32,        // composite: scene + strength * bloom
  _p0: f32, _p1: f32, _p2: f32,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> bp: BP;
// composite only:
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

struct FSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> FSOut {
  let xy = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));   // (0,0) (2,0) (0,2)
  var o: FSOut;
  o.pos = vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(xy.x, 1.0 - xy.y);
  return o;
}

// 4-tap box: the destination is half the source size, so sampling at ±half a source texel with
// bilinear filtering averages a clean 2×2 neighborhood per tap → smooth 4×4 footprint.
fn box4(uv: vec2<f32>) -> vec3<f32> {
  let o = bp.texel * 0.5;
  return 0.25 * (
    textureSampleLevel(src, samp, uv + vec2<f32>(-o.x, -o.y), 0.0).rgb +
    textureSampleLevel(src, samp, uv + vec2<f32>( o.x, -o.y), 0.0).rgb +
    textureSampleLevel(src, samp, uv + vec2<f32>(-o.x,  o.y), 0.0).rgb +
    textureSampleLevel(src, samp, uv + vec2<f32>( o.x,  o.y), 0.0).rgb);
}

// Soft-knee threshold (quadratic below threshold+knee, linear above) — no hard glow cutoffs.
fn prefilter(c: vec3<f32>) -> vec3<f32> {
  let br = max(c.r, max(c.g, c.b));
  var soft = clamp(br - bp.threshold + bp.knee, 0.0, 2.0 * bp.knee);
  soft = soft * soft / (4.0 * bp.knee + 1e-5);
  let contrib = max(soft, br - bp.threshold) / max(br, 1e-5);
  return c * max(contrib, 0.0);
}

@fragment
fn fs_prefilter(i: FSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(prefilter(box4(i.uv)), 1.0);
}

@fragment
fn fs_down(i: FSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(box4(i.uv), 1.0);
}

// 9-tap tent upsample, rendered additively (one/one) into the level above.
@fragment
fn fs_up(i: FSOut) -> @location(0) vec4<f32> {
  let o = bp.texel;
  var c = textureSampleLevel(src, samp, i.uv, 0.0).rgb * 4.0;
  c += textureSampleLevel(src, samp, i.uv + vec2<f32>(-o.x, 0.0), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, i.uv + vec2<f32>( o.x, 0.0), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, i.uv + vec2<f32>(0.0, -o.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, i.uv + vec2<f32>(0.0,  o.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, i.uv + vec2<f32>(-o.x, -o.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, i.uv + vec2<f32>( o.x, -o.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, i.uv + vec2<f32>(-o.x,  o.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, i.uv + vec2<f32>( o.x,  o.y), 0.0).rgb;
  return vec4<f32>(c / 16.0, 1.0);
}

@fragment
fn fs_composite(i: FSOut) -> @location(0) vec4<f32> {
  let scene = textureSampleLevel(src, samp, i.uv, 0.0).rgb;
  let bloom = textureSampleLevel(bloomTex, samp, i.uv, 0.0).rgb;
  let c = scene + bp.strength * bloom;
  // Hue-preserving soft clip: raw per-channel clamping bleaches over-bright cores to flat white;
  // mixing in the hue-normalized color keeps hot cores incandescent-in-their-lane-color instead.
  let m = max(c.r, max(c.g, c.b));
  if (m > 1.0) {
    let clamped = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(mix(clamped, c / m, 0.25), 1.0);
  }
  return vec4<f32>(c, 1.0);
}

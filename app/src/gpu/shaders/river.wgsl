// Fathom river — soft additive-sprite comets with closed-form (stateless) motion.
// One particle = 3 vec4:  a=(spawnT,vx,size,life)  b=(x0,yStart,yTarget,phase)  c=(r,g,b,alpha)
// NOTE: `cycle`, not `loop` — `loop` is a reserved WGSL keyword.

struct P { a: vec4<f32>, b: vec4<f32>, c: vec4<f32> };
struct U { time: f32, cycle: f32, aspect: f32, _pad: f32 };

@group(0) @binding(0) var<storage, read> parts: array<P>;
@group(0) @binding(1) var<uniform> u: U;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) col: vec4<f32>,
};

fn corner(i: u32) -> vec2<f32> {
  var q = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  return q[i];
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let pid = vi / 6u;
  let ci = vi % 6u;
  let p = parts[pid];
  var o: VOut;

  let spawnT = p.a.x; let vx = p.a.y; let size = p.a.z; let life = p.a.w;
  var tau = u.time - spawnT;
  tau = tau - floor(tau / u.cycle) * u.cycle;         // wrap into [0, cycle)
  if (tau > life) {                                    // cull inactive particles
    o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0);
    o.col = vec4<f32>(0.0);
    o.uv = vec2<f32>(0.0);
    return o;
  }

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
  let g = pow(1.0 - smoothstep(0.0, 1.0, d), 2.2);     // soft radial falloff
  let aa = i.col.a * g;
  return vec4<f32>(i.col.rgb * aa, aa);                 // premultiplied -> additive
}

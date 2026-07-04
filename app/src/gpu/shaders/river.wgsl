// Fathom river — soft additive-sprite comets. Since M4 the motion lives in the compute pass
// (`river-sim.wgsl`, mirrored by motion.ts for picks); this stage just fetches each particle's
// simulated (x, y, size, alpha) from `outp` and expands the quad. Color still comes from `parts`.
// One particle = 3 vec4:  a=(spawnT,vx,size,life)  b=(x0,yStart,yTarget,phase)  c=(r,g,b,alpha)

struct P { a: vec4<f32>, b: vec4<f32>, c: vec4<f32> };
struct U { time: f32, cycle: f32, aspect: f32, count: u32 };

@group(0) @binding(0) var<storage, read> outp: array<vec4<f32>>;
@group(0) @binding(1) var<uniform> u: U;
@group(0) @binding(2) var<storage, read> parts: array<P>;

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
  let o4 = outp[pid];
  var o: VOut;

  if (o4.w <= 0.0) {                                   // culled by the sim pass
    o.pos = vec4<f32>(0.0, 0.0, -2.0, 1.0);
    o.col = vec4<f32>(0.0);
    o.uv = vec2<f32>(0.0);
    return o;
  }

  let size = o4.z;
  let cq = corner(ci);
  let off = vec2<f32>(cq.x * size, cq.y * size * u.aspect);
  o.pos = vec4<f32>(o4.x + off.x, o4.y + off.y, 0.0, 1.0);
  o.uv = cq;
  o.col = vec4<f32>(parts[pid].c.rgb, o4.w);
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4<f32> {
  let d = length(i.uv);
  let g = pow(1.0 - smoothstep(0.0, 1.0, d), 2.2);     // soft radial falloff
  let aa = i.col.a * g;
  return vec4<f32>(i.col.rgb * aa, aa);                 // premultiplied -> additive
}

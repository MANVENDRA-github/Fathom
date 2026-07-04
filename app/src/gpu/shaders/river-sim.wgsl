// Fathom river sim (M4) — the comet motion as a STATELESS compute pass.
// One thread per particle evaluates position/fade as a *pure function* of the particle's stored
// floats + u.time (no integration, no read-back of prior state) and writes it to `outp`; the
// render vertex stage just fetches. Purity is load-bearing: the M2 pick math in
// `app/src/gpu/motion.ts` mirrors THIS function on the CPU — any change here MUST be mirrored
// there (see the MIRROR block), or picks drift. On-GPU parity is proven by server/tools/pick-e2e.mjs.
//
// One particle = 3 vec4:  a=(spawnT,vx,size,life)  b=(x0,yStart,yTarget,phase)  c=(r,g,b,alpha)
// Output = 1 vec4 per particle: (x, y, size, alpha); alpha<=0 means culled.
// NOTE: `cycle`, not `loop` — `loop` is a reserved WGSL keyword.

struct P { a: vec4<f32>, b: vec4<f32>, c: vec4<f32> };
struct U { time: f32, cycle: f32, aspect: f32, count: u32 };

@group(0) @binding(0) var<storage, read> parts: array<P>;
@group(0) @binding(1) var<uniform> u: U;
@group(0) @binding(2) var<storage, read_write> outp: array<vec4<f32>>;

// ---- MIRROR: curl-noise flow field — every constant matches motion.ts curl() exactly ----------
// Divergence-free displacement d = (dpsi/dy, -dpsi/dx) of an analytic 3-octave stream function
//   psi = SUM Ai * sin(ai*x + wi*t) * cos(bi*y + vi*t),
// sampled at the closed-form base position with GLOBAL time (neighbors swirl together).
// Amplitude bounds (worst case): |dx| <= 0.0189, |dy| <= 0.0149 — the lane-legibility budget
// (jitter 0.03 + turb 0.035 + curl 0.015 = 0.080 < the 0.09 cache-fallback gap). The products
// Ai*ai / Ai*bi are written as literals so both languages compute the identical expression.
fn curl(cx: f32, cy: f32, t: f32) -> vec2<f32> {
  let dx = -0.00736 * sin(1.7 * cx + 0.8 * t) * sin(2.3 * cy - 0.6 * t)
           -0.00611 * sin(3.9 * cx - 1.3 * t) * sin(4.7 * cy + 1.1 * t)
           -0.00546 * sin(7.3 * cx + 2.1 * t) * sin(9.1 * cy - 1.7 * t);
  let dy = -0.00544 * cos(1.7 * cx + 0.8 * t) * cos(2.3 * cy - 0.6 * t)
           -0.00507 * cos(3.9 * cx - 1.3 * t) * cos(4.7 * cy + 1.1 * t)
           -0.00438 * cos(7.3 * cx + 2.1 * t) * cos(9.1 * cy - 1.7 * t);
  return vec2<f32>(dx, dy);
}
// ---- /MIRROR -----------------------------------------------------------------------------------

@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.count) { return; }
  let p = parts[i];

  let spawnT = p.a.x; let vx = p.a.y; let size = p.a.z; let life = p.a.w;
  var tau = u.time - spawnT;
  tau = tau - floor(tau / u.cycle) * u.cycle;          // wrap into [0, cycle)
  if (tau > life) {                                     // cull inactive particles
    outp[i] = vec4<f32>(0.0);
    return;
  }

  // ---- MIRROR: motion.ts headPos() replicates everything below --------------------------------
  let x0 = p.b.x; let yStart = p.b.y; let yTarget = p.b.z; let phase = p.b.w;
  let x = x0 + vx * tau;
  let ease = yTarget + (yStart - yTarget) * exp(-3.0 * tau);
  let turb = 0.022 * sin(tau * 2.6 + phase) + 0.013 * sin(tau * 6.1 + phase * 1.7);
  let d = curl(x, ease, u.time);                        // curl flow, sampled at the base position
  let y = ease + turb + d.y;
  // ---- /MIRROR ---------------------------------------------------------------------------------

  let fin = smoothstep(0.0, 0.12 * life, tau);
  let fout = 1.0 - smoothstep(0.5 * life, life, tau);
  outp[i] = vec4<f32>(x + d.x, y, size, p.c.w * fin * fout);
}

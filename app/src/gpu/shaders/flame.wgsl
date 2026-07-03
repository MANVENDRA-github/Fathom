// Fathom cost flame graph (M3) — "money burning in the dark".
// One module, four pipelines drawn in order into one MSAA pass:
//   1 floor  (opaque, depth write)      — dark glass disc: radial glow + faint grid
//   2 slab   (opaque, depth write)      — provider/model monoliths: fresnel rim + emissive + top gradient
//   3 aura   (additive, depth read)     — the same cube inflated, a glow shell
//   4 ember  (additive, depth read)     — closed-form rising sparks, density ∝ spend share
// NOTE: `loop` and `filter` are reserved WGSL words — avoided throughout.
// Structs are pure vec4 packing (repo rule).

struct Slab {
  a: vec4<f32>,   // center.xyz, w = emissive base
  b: vec4<f32>,   // halfExtent.xyz, w = tier (0 provider, 1 model)
  c: vec4<f32>,   // color.rgb, w = reserved
};
struct Ember {
  a: vec4<f32>,   // spawn.xyz, w = size
  b: vec4<f32>,   // phase, cycleOffset, riseSpeed, life
  c: vec4<f32>,   // color.rgb, w = intensity
};
struct U {
  viewProj: mat4x4<f32>,
  eyeTime:  vec4<f32>,   // eye.xyz, w = time (s; frozen while paused)
  camRight: vec4<f32>,   // camera right.xyz, w = highlight slab index (-1 = none)
  camUp:    vec4<f32>,   // camera up.xyz,    w = entrance fade 0..1 (eased CPU-side)
  misc:     vec4<f32>,   // x = emberBoost, y = auraStrength, z/w reserved
};

@group(0) @binding(0) var<storage, read> slabs: array<Slab>;
@group(0) @binding(1) var<uniform> u: U;
@group(0) @binding(2) var<storage, read> embers: array<Ember>;

fn corner(i: u32) -> vec2<f32> {
  var q = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  return q[i];
}

// Procedural axis-aligned cube: 36 verts, per-face frames. Returns local pos (result[0]) + normal (result[1]).
fn cubeVert(vi: u32) -> array<vec3<f32>, 2> {
  let face = vi / 6u;
  let cq = corner(vi % 6u);
  var N = array<vec3<f32>, 6>(
    vec3<f32>( 1.0, 0.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0),
    vec3<f32>( 0.0, 1.0, 0.0), vec3<f32>( 0.0,-1.0, 0.0),
    vec3<f32>( 0.0, 0.0, 1.0), vec3<f32>( 0.0, 0.0,-1.0));
  var T = array<vec3<f32>, 6>(
    vec3<f32>(0.0, 0.0,-1.0), vec3<f32>(0.0, 0.0, 1.0),
    vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(1.0, 0.0, 0.0),
    vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0));
  var B = array<vec3<f32>, 6>(
    vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(0.0, 0.0,-1.0), vec3<f32>(0.0, 0.0, 1.0),
    vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 1.0, 0.0));
  return array<vec3<f32>, 2>(N[face] + T[face] * cq.x + B[face] * cq.y, N[face]);
}

// Entrance: bars grow out of the floor (world y scales by the eased fade).
fn entranceY(y: f32) -> f32 { return y * u.camUp.w; }

// ---------------------------------------------------------------- 1. floor
struct FloorOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wp: vec2<f32>,   // world xz
};

@vertex
fn vsFloor(@builtin(vertex_index) vi: u32) -> FloorOut {
  let cq = corner(vi);
  let world = vec3<f32>(cq.x * 3.6, 0.0, cq.y * 3.6);
  var o: FloorOut;
  o.pos = u.viewProj * vec4<f32>(world, 1.0);
  o.wp = world.xz;
  return o;
}

fn gridline(t: f32) -> f32 {
  let d = abs(fract(t * 2.4) - 0.5);
  return 1.0 - smoothstep(0.0, 0.035, d);
}

@fragment
fn fsFloor(i: FloorOut) -> @location(0) vec4<f32> {
  let base = vec3<f32>(0.016, 0.02, 0.043);                 // the clear color
  let r = length(i.wp) / 3.6;
  let glowc = vec3<f32>(0.05, 0.075, 0.16);
  var col = mix(base, glowc, exp(-r * r * 2.6) * u.camUp.w);
  let g = max(gridline(i.wp.x), gridline(i.wp.y)) * 0.05 * (1.0 - smoothstep(0.35, 1.0, r));
  col += vec3<f32>(0.35, 0.5, 1.0) * g * u.camUp.w;
  col = mix(col, base, smoothstep(0.72, 1.0, r));           // fade to clear at the rim
  return vec4<f32>(col, 1.0);
}

// ---------------------------------------------------------------- 2. slab core
struct SlabOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) col: vec3<f32>,
  @location(3) p: vec3<f32>,    // x = emissive, y = topGrad, z = highlight
};

fn slabParams(iid: u32) -> f32 {  // highlight factor for this instance
  return select(0.0, 1.0, abs(u.camRight.w - f32(iid)) < 0.5);
}

@vertex
fn vsSlab(@builtin(vertex_index) vi: u32, @builtin(instance_index) iid: u32) -> SlabOut {
  let s = slabs[iid];
  let pv = cubeVert(vi);
  var world = s.a.xyz + pv[0] * s.b.xyz;
  world.y = entranceY(world.y);
  var o: SlabOut;
  o.pos = u.viewProj * vec4<f32>(world, 1.0);
  o.world = world;
  o.normal = pv[1];
  o.col = s.c.rgb;
  o.p = vec3<f32>(s.a.w, pv[0].y * 0.5 + 0.5, slabParams(iid));
  return o;
}

@fragment
fn fsSlab(i: SlabOut) -> @location(0) vec4<f32> {
  let vdir = normalize(u.eyeTime.xyz - i.world);
  let fres = pow(1.0 - abs(dot(normalize(i.normal), vdir)), 3.0);
  let pulse = 1.0 + 0.06 * sin(u.eyeTime.w * 1.7 + i.world.x * 3.1);
  let hi = 1.0 + i.p.z * 0.9;
  let emissive = i.p.x * pulse * hi;
  var col = i.col * (0.05 + 0.10 * i.p.y);                   // dark body, lighter toward the top
  col += i.col * emissive * (0.22 + 0.60 * i.p.y);           // inner light rising to the crown
  col += i.col * fres * (0.90 * hi);                          // rim
  return vec4<f32>(col, 1.0);
}

// ---------------------------------------------------------------- 3. slab aura (glow shell)
@vertex
fn vsAura(@builtin(vertex_index) vi: u32, @builtin(instance_index) iid: u32) -> SlabOut {
  let s = slabs[iid];
  let pv = cubeVert(vi);
  var world = s.a.xyz + pv[0] * (s.b.xyz * 1.06 + vec3<f32>(0.006));
  world.y = entranceY(world.y);
  var o: SlabOut;
  o.pos = u.viewProj * vec4<f32>(world, 1.0);
  o.world = world;
  o.normal = pv[1];
  o.col = s.c.rgb;
  o.p = vec3<f32>(s.a.w, pv[0].y * 0.5 + 0.5, slabParams(iid));
  return o;
}

@fragment
fn fsAura(i: SlabOut) -> @location(0) vec4<f32> {
  let vdir = normalize(u.eyeTime.xyz - i.world);
  let fres = pow(1.0 - abs(dot(normalize(i.normal), vdir)), 2.5);
  let a = fres * u.misc.y * (0.35 + 0.5 * i.p.z) * u.camUp.w;
  return vec4<f32>(i.col * a, a);                             // premultiplied → additive
}

// ---------------------------------------------------------------- 4. embers
struct EmberOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) col: vec4<f32>,
};

@vertex
fn vsEmber(@builtin(vertex_index) vi: u32, @builtin(instance_index) iid: u32) -> EmberOut {
  let e = embers[iid];
  let phase = e.b.x;
  let flife = e.b.w;
  var tau = (u.eyeTime.w + e.b.y) / flife;
  tau = fract(tau) * flife;

  let rise = e.b.z * tau;
  let wobble = 0.020 * sin(tau * 2.2 + phase) + 0.011 * sin(tau * 5.3 + phase * 1.7);
  let wobz = 0.014 * sin(tau * 3.1 + phase * 2.3);
  var world = vec3<f32>(e.a.x + wobble, entranceY(e.a.y) + rise, e.a.z + wobz);

  let fin = smoothstep(0.0, 0.14 * flife, tau);
  let fout = 1.0 - smoothstep(0.45 * flife, flife, tau);
  let ignite = clamp(u.camUp.w * 1.5 - 0.5, 0.0, 1.0);        // embers ignite after the bars rise
  let a = e.c.w * fin * fout * ignite * u.misc.x;

  let cq = corner(vi);
  let size = e.a.w * (1.0 - 0.35 * (tau / flife));
  world += (u.camRight.xyz * cq.x + u.camUp.xyz * cq.y) * size;

  var o: EmberOut;
  o.pos = u.viewProj * vec4<f32>(world, 1.0);
  o.uv = cq;
  o.col = vec4<f32>(e.c.rgb, a);
  return o;
}

@fragment
fn fsEmber(i: EmberOut) -> @location(0) vec4<f32> {
  let d = length(i.uv);
  let g = pow(1.0 - smoothstep(0.0, 1.0, d), 2.2);            // river's soft radial falloff
  let aa = i.col.a * g;
  return vec4<f32>(i.col.rgb * aa, aa);                       // premultiplied → additive
}

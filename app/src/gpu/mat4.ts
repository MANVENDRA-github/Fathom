// Minimal column-major mat4 for the 3D flame graph (M3). No dependencies.
// Column-major throughout: m[col*4 + row] — matches WGSL `mat4x4<f32>` uniform memory layout
// exactly, so a Float32Array uploads verbatim (never transpose).

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

/**
 * Perspective projection mapping Z to WebGPU's [0, 1] clip range.
 * NOT the GL [-1, 1] form — using that here would silently halve depth precision
 * and break near-plane clipping.
 */
export function perspective(fovYRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRad / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Right-handed view matrix (gl-matrix convention). */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2]; m[12] = -dot(x, eye);
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2]; m[13] = -dot(y, eye);
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2]; m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}

/** out = a · b (b applied first). `out` must not alias `a` or `b`. */
export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Transform a point to clip space. Caller checks `w > 0`, divides, then maps NDC → pixels. */
export function transformPoint(m: Mat4, p: Vec3): { x: number; y: number; z: number; w: number } {
  return {
    x: m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    y: m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    z: m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    w: m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
  };
}

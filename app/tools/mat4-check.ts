/*
 * mat4 unit harness (run: node server/node_modules/tsx/dist/cli.mjs app/tools/mat4-check.ts).
 * Guards the 3D flame's math invariants — above all that `perspective` maps depth to WebGPU's
 * [0,1] clip range (the classic silent bug is shipping the GL [-1,1] form). Pure math, no GPU.
 */
import { perspective, lookAt, multiply, transformPoint, normalize, cross, type Vec3 } from '../src/gpu/mat4';

let failures = 0;
const check = (name: string, cond: boolean) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };
const near = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) <= eps;

// 1. Perspective maps near→0 and far→1 in NDC (WebGPU convention, NOT GL's [-1,1]).
const NEAR = 0.1, FAR = 100;
const proj = perspective(Math.PI / 4, 16 / 9, NEAR, FAR);
const atNear = transformPoint(proj, [0, 0, -NEAR]);   // view space looks down -Z
const atFar = transformPoint(proj, [0, 0, -FAR]);
check('near plane → ndc z = 0', near(atNear.z / atNear.w, 0));
check('far plane → ndc z = 1', near(atFar.z / atFar.w, 1));
check('w = -viewZ (perspective divide sane)', near(atNear.w, NEAR) && near(atFar.w, FAR));

// 2. lookAt: eye maps to origin; the target sits straight ahead on -Z at the right distance.
const eye: Vec3 = [3, 2, 5], target: Vec3 = [0, 0.45, 0];
const view = lookAt(eye, target, [0, 1, 0]);
const eyeV = transformPoint(view, eye);
check('lookAt maps eye → origin', near(eyeV.x, 0) && near(eyeV.y, 0) && near(eyeV.z, 0) && near(eyeV.w, 1));
const tV = transformPoint(view, target);
const dist = Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
check('lookAt puts target on -Z at |eye-target|', near(tV.x, 0) && near(tV.y, 0) && near(tV.z, -dist));

// 3. lookAt rotation is orthonormal (rows of the 3x3 have unit length, mutually orthogonal).
const rows: Vec3[] = [[view[0], view[4], view[8]], [view[1], view[5], view[9]], [view[2], view[6], view[10]]];
const dotv = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
check('rotation rows unit length', rows.every((r) => near(dotv(r, r), 1)));
check('rotation rows orthogonal', near(dotv(rows[0], rows[1]), 0) && near(dotv(rows[0], rows[2]), 0) && near(dotv(rows[1], rows[2]), 0));

// 4. multiply composes correctly: viewProj applied to the target === proj applied to view-space target.
const viewProj = multiply(proj, view);
const a = transformPoint(viewProj, target);
const tv: Vec3 = [tV.x, tV.y, tV.z];
const b = transformPoint(proj, tv);
check('multiply(proj, view) composes', near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z) && near(a.w, b.w));

// 5. A point between near and far lands inside ndc z (0,1) and in front (w > 0).
const mid = transformPoint(viewProj, [0.4, 0.7, 0.1]);
check('scene point: w > 0, 0 < ndcZ < 1', mid.w > 0 && mid.z / mid.w > 0 && mid.z / mid.w < 1);

// 6. Camera-basis ray reconstruction (the pick math) agrees with the projection:
//    project a point, rebuild the ray through that pixel, and the ray must pass through the point.
const f = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
const right = normalize(cross(f, [0, 1, 0]));
const up = cross(right, f);
const fovY = Math.PI / 4, aspect = 16 / 9, tanY = Math.tan(fovY / 2);
const P: Vec3 = [0.35, 0.8, -0.1];
const clip = transformPoint(viewProj, P);
const ndcX = clip.x / clip.w, ndcY = clip.y / clip.w;
const dir = normalize([
  f[0] + right[0] * ndcX * tanY * aspect + up[0] * ndcY * tanY,
  f[1] + right[1] * ndcX * tanY * aspect + up[1] * ndcY * tanY,
  f[2] + right[2] * ndcX * tanY * aspect + up[2] * ndcY * tanY,
]);
const toP = normalize([P[0] - eye[0], P[1] - eye[1], P[2] - eye[2]]);
check('pick ray through a projected point hits it', near(dir[0], toP[0], 1e-4) && near(dir[1], toP[1], 1e-4) && near(dir[2], toP[2], 1e-4));

console.log(`\n${failures === 0 ? 'OK' : failures + ' FAILURES'} — mat4 maps Z to [0,1] and the pick ray inverts the projection`);
process.exit(failures === 0 ? 0 : 1);

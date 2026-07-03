// Pick math — a CPU mirror of the head-particle motion in `shaders/river.wgsl` (`vs`).
// The renderer computes every particle's clip-space center as a *closed-form* function of its
// stored floats + `u.time` (no camera, no projection). To resolve a click back to a comet we
// evaluate the SAME function on the CPU for each comet's head and hit-test in pixel space.
//
// IMPORTANT: any change to the motion in `river.wgsl:31-53` MUST be mirrored here, or picks drift.
// Layout mirrored:  a = (spawnT, vx, size, life)   b = (x0, yStart, yTarget, phase)

/** GLSL/WGSL smoothstep. */
function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export interface HeadPos {
  x: number;      // clip-space (NDC) center, matches river.wgsl o.pos.xy
  y: number;
  size: number;   // sprite half-extent in NDC-x (a.z)
  fade: number;   // 0..1 alpha envelope (fin*fout) — a head at ~0 is invisible
}

/**
 * Clip-space center + fade of a head at `time`, or `null` if it is culled
 * (mirrors the `tau > life` discard at river.wgsl:34). `cycle` is the loop length
 * (replay) or an effectively-infinite value (live), exactly as passed to the shader uniform.
 */
export function headPos(
  a: ArrayLike<number>, b: ArrayLike<number>, time: number, cycle: number,
): HeadPos | null {
  const spawnT = a[0], vx = a[1], size = a[2], life = a[3];
  let tau = time - spawnT;
  tau = tau - Math.floor(tau / cycle) * cycle;          // wrap into [0, cycle)
  if (tau > life) return null;                           // culled (river.wgsl:34)

  const x0 = b[0], yStart = b[1], yTarget = b[2], phase = b[3];
  const x = x0 + vx * tau;
  const ease = yTarget + (yStart - yTarget) * Math.exp(-3 * tau);
  const turb = 0.022 * Math.sin(tau * 2.6 + phase) + 0.013 * Math.sin(tau * 6.1 + phase * 1.7);
  const y = ease + turb;

  const fin = smoothstep(0, 0.12 * life, tau);
  const fout = 1 - smoothstep(0.5 * life, life, tau);
  return { x, y, size, fade: fin * fout };
}

export interface Rect { width: number; height: number; }

/** NDC center → CSS-pixel position within a canvas of size `rect` (Y flipped, as in clip space). */
export function ndcToPixel(x: number, y: number, rect: Rect): { px: number; py: number } {
  return { px: (x + 1) / 2 * rect.width, py: (1 - y) / 2 * rect.height };
}

/** Small comets still need a clickable target even when their sprite is sub-pixel. */
export const MIN_HIT_PX = 10;

/**
 * On-screen hit radius (CSS px). The sprite quad is `off = (cq.x*size, cq.y*size*aspect)`
 * (river.wgsl:52), which is drawn ROUND in pixels — so its radius is `size * width/2` px and
 * the aspect term cancels. We therefore hit-test entirely in pixel space, no aspect needed.
 */
export function hitRadiusPx(size: number, rect: Rect): number {
  return Math.max(size * rect.width / 2, MIN_HIT_PX);
}

export interface HeadLike {
  a: ArrayLike<number>;   // (spawnT, vx, size, life)
  b: ArrayLike<number>;   // (x0, yStart, yTarget, phase)
}

/**
 * Nearest visible head whose sprite covers the click, in CSS-pixel space.
 * `clickX/clickY` are canvas-relative pixels. Returns the winning head or `null`.
 * Tie-break: closest center wins (front-most reads as "the one I clicked").
 */
export function pickHead<T extends HeadLike>(
  heads: Iterable<T>,
  clickX: number, clickY: number,
  time: number, cycle: number, rect: Rect,
  minFade = 0.03,
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const h of heads) {
    const pos = headPos(h.a, h.b, time, cycle);
    if (!pos || pos.fade < minFade) continue;
    const { px, py } = ndcToPixel(pos.x, pos.y, rect);
    const dist = Math.hypot(px - clickX, py - clickY);
    if (dist <= hitRadiusPx(pos.size, rect) && dist < bestDist) {
      best = h;
      bestDist = dist;
    }
  }
  return best;
}

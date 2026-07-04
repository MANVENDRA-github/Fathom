# Architecture

Two independent WebGPU programs share this repo: a **perf spike** (proves throughput) and a **cinema**
(proves the real-data look). They don't share code — the spike stresses raw compute+render at 1M+
particles; the cinema optimizes for a legible, striking replay of a few hundred real spans.

```
                         ┌──────────────────────────── perf spike ───────────────────────────┐
                         │  main.js:  seed 2M particles → compute sim (flow/fork/flare)        │
   bench.mjs ── drives ─▶│            → additive point render → timestamp-query benchmark      │
   (Playwright, real GPU)│            → sweep 100k..2M → GO / GO-with-LOD / RETHINK verdict     │
                         └────────────────────────────────────────────────────────────────────┘

                         ┌──────────────────────────── cinema ───────────────────────────────┐
 sentinel ─pnpm load─▶ raw TraceRecord[] ─ingest.mjs─▶ traces.json ─fathom.js─▶ comet river   │
 (real gateway,        (data/*.json)      (normalize)  (normalized)  (WebGPU, closed-form)     │
  mock upstreams)                                                                              │
   record.mjs ── drives (Playwright, real GPU) ─▶ fathom-river.png / .webm                     │
                         └────────────────────────────────────────────────────────────────────┘
```

---

## Component 1 — perf spike (`main.js`)

- **Data:** 2,000,000 particles seeded on the CPU (pos, vel, state, lane seed), packed 8 floats each into
  a 64 MB storage buffer (under the 128 MB `maxStorageBufferBindingSize` default).
- **Compute pass:** one `@workgroup_size(64)` dispatch/frame advances every particle (x-flow, sinusoidal
  turbulence, ease-to-lane so cache-hits fork into a tributary, recycle at the edge). This is the genuinely
  hard part — a full per-particle sim each frame.
- **Render pass:** `point-list`, vertex-pulling from the storage buffer, additive blend for glow.
- **Measurement:** `timestamp-query` wraps the compute and render passes → **true GPU ms/frame** (not just
  vsync-locked FPS). An auto-sweep measures 40 warmup + 100 sampled frames per count and reports the median.
- **Verdict thresholds (pre-registered):** 1M @ ≤16.7 ms GPU → **GO**; 500k–1M → **GO with LOD**;
  <500k → **RETHINK**. Results: [`PROOF.md`](./PROOF.md).

## Component 2 — cinema (`app/`, ported from `fathom.js` in M0)

> M0 ported this into a Vite + React + TypeScript app: the raw-WebGPU core lives in `app/src/gpu/`
> (`river.ts` controller, `shaders/river.wgsl`), the data layer in `app/src/data/` (`classify.ts`, `build.ts`),
> and a thin React shell in `app/src/ui/`. The rendering/motion design below is unchanged; `fathom.js` remains
> as the legacy standalone. The normalized schema now lives in `shared/schema.ts`.

- **Stateless compute pass (M4).** Motion runs in a compute pass (`shaders/river-sim.wgsl`, one thread per
  particle) that writes `(x, y, size, alpha)` to a storage buffer; the vertex stage just fetches. Crucially it
  is still **stateless**: given global `time` and a particle's static params, position/alpha are a pure
  function (no integration), the loop wraps seamlessly (`tau = (time - spawnT) mod cycle`), and the M2 pick
  mirror stays exact. On top of the closed-form base motion the sim adds an analytic **divergence-free
  curl-noise flow field** (3-octave stream function, sampled at the base position with global time so
  neighboring comets swirl together; |dy| ≤ 0.015 — inside the lane-legibility budget).
- **One comet per request.** Each event emits K trail particles (K by outcome: PII flare 90, fallback 74,
  span 52, cache 26). Head is brightest; the trail staggers spawn time and shrinks.
- **Lanes by real outcome** (clip-space y bands): cache-hit **cyan** top tributary; 429→fallback **amber**
  mid; span/miss **blue** bottom; PII **red** flare in the bottom band with an upward pop.
- **Model sub-streams within a lane (M4, `data/substream.ts`).** Each `provider/model` FNV-1a-hashes to a
  deterministic shade of the outcome color + a y sub-band inside the lane — the lane hue stays the outcome
  signal; the shade is the model. Hash-based (not arrival-ordered) so a model keeps its identity across
  live/replay and across sessions; the sub-band + scatter stays strictly inside the lane (pick-check enforced).
- **Soft additive sprites.** Each particle is a 6-vertex quad; the fragment applies a radial falloff and
  outputs **premultiplied** color; blend is `one/one` (additive) over a near-black clear → the glow.
- **Cull:** the sim writes `alpha = 0` for inactive particles (`tau > life`); the vertex stage emits a
  degenerate clipped vertex (`z = -2`) for them.
- **Bloom post pass (M4, `gpu/bloom.ts` + `shaders/bloom.wgsl`).** With bloom on, the river renders into an
  **rgba16float** scene target (dense additive clusters exceed 1.0 — exactly what should glow), then:
  soft-knee threshold (T 0.55 / knee 0.25) + 4-tap box downsample → half-res mip chain (min-dim ≥ 8, ≤6
  levels) → 9-tap tent **additive** upsample → composite to the swapchain (`scene + 0.45·bloom`) with a
  hue-preserving soft clip so over-bright cores stay incandescent-in-lane-color instead of bleaching white.
  Bloom off = the exact pre-M4 path (straight to swapchain). UI toggle (default on); chain rebuilt at frame
  start on a resize-dirty flag, old textures destroyed.

---

## Data model

### sentinel span → TraceRecord (source, for reference)
sentinel emits **one** span, `chat.completion`, whose attributes are flattened into a `TraceRecord`
(`packages/gateway/src/telemetry/trace.ts`). Keys that matter here:

| Concept | span attribute | TraceRecord field |
|---|---|---|
| cache hit | `sentinel.cache_hit` (bool) | `cacheHit` |
| guardrail outcome | `sentinel.guardrail_status` (`pass`\|`flag`\|`block`) | `guardrailStatus` |
| PII/violations | `sentinel.guardrail_violations` (`pii.email,…`) | `guardrailViolations` |
| fallback | `sentinel.fallback_used` (bool) | `fallbackUsed` |
| cost | `sentinel.cost_usd` (num\|null) | `costUsd` |
| model | `gen_ai.request.model` / `sentinel.routed_model` | `model` / `routedModel` |
| tokens | `gen_ai.usage.*_tokens` | `promptTokens`/`completionTokens`/`totalTokens` |
| status | `http.response.status_code` | `status` |
| latency | span duration | `durationMs` |

### Normalized schema (the ingestion contract — `ingest.mjs` output)
This is the **boundary**. The renderer only knows this shape; swap the source by writing a new mapper to it.

```jsonc
{
  "meta": { "source", "count", "durationMs", "cacheHitRate", "fallbacks", "piiBlocked", "models": [] },
  "events": [{
    "t":            0,          // ms from first event
    "model":        "std",
    "provider":     "…",
    "status":       200,        // 200 ok, 422 PII-blocked, 429, …
    "latencyMs":    3.1,
    "tokens":       12,
    "costUsd":      0,          // or null when unpriced
    "cacheHit":     false,
    "fallbackUsed": false,
    "guardrail":    "pass",     // pass | flag | block | null
    "pii":          false,
    "piiCategories":[]          // e.g. ["pii.email"]
  }]
}
```

The renderer classifies each event → `{pii → cache → fallback → span}` (first match wins) for color+lane.

---

## Capture (real spans, offline, no keys)

sentinel's `pnpm load` drives the real gateway against **in-process mock upstreams** (deterministic mock
embeddings → real cache hits; an always-429 upstream → real fallback; an injected-PII response → real 422
block). It only writes a metrics summary, not raw records — so we use a **temporary** dumper:

1. Copy `tools/sentinel-dump.ts` → `<sentinel>/load/run.dump.ts` (imports resolve from `load/`).
2. Run `<sentinel>/node_modules/.bin/tsx <sentinel>/load/run.dump.ts` → writes
   `data/sentinel-traces-raw.json` (it does **not** touch `load/RESULTS.md`).
3. **Delete** `run.dump.ts` — sentinel must stay pristine (`git -C <sentinel> status` clean).
4. `npm run ingest` → `traces.json`.

The captured run: 460 records — 140 cache hits, 95 fallbacks, 85 PII blocks (422).

---

## Live ingestion (M1 — `server/`)
A generic path so **any** OTel gateway feeds Fathom, not just sentinel:
`gateway --OTLP/HTTP JSON--> POST /v1/traces` → `otlp.ts` maps span attributes (`sentinel.*`/`gen_ai.*`) to the
normalized schema → `hub.ts` ring buffer → **SSE `/stream`** (`snapshot` on connect, then `span`/`judge`).
The client's live mode (`gpu/river.ts`) keeps a recycling particle pool and `spawn()`s a comet per span as it
arrives (closed-form motion, `cycle` set large so there's no loop). Optional `poller.ts` pulls sentinel
`/traces?since=` for LLM-judge scores (never on the OTLP span). Proven end-to-end incl. the real gateway
(`PROOF.md` §4). Full design: `SPEC.md` §3–4.

Endpoints: `POST /v1/traces`, `GET /stream`, `GET /traces/:id` (M2), `GET /debug/recent?n=`, `GET /health`.

## Drill-down (M2 — pick math + `/traces/:id`)
Clicking a comet resolves it to its source span, entirely from the shape the renderer already computes.

- **Pick math (`gpu/motion.ts`).** Because comet motion is *stateless* (a particle's clip-space center is a
  pure function of its stored floats + `time`, no camera/projection — since M4 evaluated in the
  `river-sim.wgsl` compute pass), a screen click inverts back to a comet on the CPU. `motion.ts` mirrors
  `river-sim.wgsl` exactly — the `tau = (time-spawnT) mod cycle` wrap, the `tau > life` cull, the eased-lane +
  turbulence `y`, **and the curl-noise displacement** (identical constants, marked by MIRROR blocks in both
  files) — and hit-tests in **pixel space**: the sprite is drawn
  round in pixels (`off = (size, size*aspect)`), so its hit radius is `size*width/2` px and aspect cancels.
  `pick()` nearest-wins over the visible **heads** (one per comet); it uses the last *rendered* `time`, so a
  click on a paused (frozen) river lands on the still comet.
- **Head index.** Replay builds a static `heads[]` (one head + source event per comet, `data/build.ts`); live
  keeps heads in a ring parallel to the particle pool, evicted in lock-step as slots are overwritten
  (`gpu/river.ts`). No per-particle id is stored in the GPU buffer — identity lives only in this CPU index.
- **Detail path.** The SSE stream carries the lean `TraceEvent` (no raw attributes). On click the client shows
  the normalized fields immediately, then (live only) fetches `GET /traces/:id` (`lib/detail.ts`) for the raw
  `gen_ai.*`/`sentinel.*` attributes the server retained in its by-id map (`hub.ts`). Static replay data has no
  ids/attributes, so it shows normalized fields only (labeled). Proven on the real GPU: `PROOF.md` §5.
- **Callout UI (`ui/SpanDetail.tsx`).** The card is a callout, not a modal: a reticle marks the caught comet, a
  leader line ties it to a card parked on the *opposite* side (never hiding its subject), and the card is lit by
  the outcome's lane color (`--accent`, the exact classify/legend hues) — top glow, chip, hot values. Sections
  (route / outcome / usage / raw attributes) mirror the normalized-vs-raw contract; raw keys dim their
  namespace (`sentinel.`/`gen_ai.`). Escape closes; animations respect `prefers-reduced-motion`.

## Cost flame graph (M3 — cost aggregation + view toggle)
A `river`↔`$ flame` toggle (`ui/Controls.tsx`) switches the whole view. The flame graph is cost-by-model.

- **Aggregation (`data/cost.ts`).** `aggregateCost(events, metric)` reduces spans to a two-level flame tree
  (provider → model), summing **cost / tokens / requests** per node and laying out a normalized `x0/x1` span per
  row — this object is the contract the Fable 3D WGSL pass will consume. Pure + CPU-side, so its totals reconcile
  with the HUD **by construction**: `summarize(events)` (same file, reusing `outcomeOf`) drives the HUD in flame
  view and equals `aggregateCost().totals`. A new HUD `spend` metric (`RiverStats.costUsd`, summed in `river.ts`)
  is the on-screen anchor. Verified: `app/tools/cost-check.ts` + `PROOF.md` §6.
- **Data source.** Replay/sample aggregate the loaded `trace.events`; **live** aggregates the server's live ring
  buffer via `GET /debug/recent?n=` (polled), i.e. "cost from the live buffer".
- **Metric toggle + honesty.** The real capture has `costUsd` null everywhere → the cost total is `$0`
  (`unpriced`), so the flame lays out by request volume and prompts the **tokens** toggle; only
  `traces.sample.json` carries real cost (3 providers / 3 models). Tokens/requests are populated on every source.
- **3D renderer (`gpu/flame.ts` + `shaders/flame.wgsl` + `gpu/mat4.ts`).** The scene is extruded verbatim from
  the aggregation's `x0/x1` layout: provider **monoliths** (height = share) with model bars stacked as an inset
  crown, on a dark glass floor. One MSAA(4×)+depth pass, four pipelines in order — floor (opaque) → slab cores
  (**opaque**, so the depth buffer resolves all overlap with zero sorting) → slab **aura** (additive fresnel
  shell, depth read-only) → **embers** (additive billboards, depth read-only). Embers are *closed-form* like the
  river — no compute pass: per-ember floats baked CPU-side at `setModel` (count ∝ share, per-bar RNG seeded by
  key hash so live polls don't pop), position a pure function of time. Camera: damped orbit (drag/wheel,
  auto-orbit after idle, `prefers-reduced-motion` respected); `mat4.ts` is minimal column-major math with a
  **WebGPU [0,1] clip-Z** perspective (unit-tested in `app/tools/mat4-check.ts`). Hover/click picking is CPU
  ray-vs-AABB reconstructed from the camera basis (no matrix inverse), resolved freeze-consistently in the frame
  loop; DOM labels track the bars via projected anchors (`transformPoint` → `ndcToPixel`). The right-docked
  legend (`ui/FlameView.tsx`) stays the numeric truth (hover lights its row; click scrolls to it). Same
  Opus-data → Fable-visual handoff as M2.

## Richness pass (M4 — curl flow, bloom, sub-streams, $ saved; measured)
The Fable aesthetic milestone, with the perf numbers kept honest (`PROOF.md` §7).

- **Curl-noise via a *stateless* compute pass.** SPEC called for a compute pass; M2's pick system demands
  motion stay a pure function the CPU can mirror. The resolution: the compute pass (`river-sim.wgsl`) evaluates
  the same closed-form base motion + an analytic curl field (no integration) and writes positions to a storage
  buffer the vertex stage fetches. Deterministic → `motion.ts` mirrors it and picks stay exact
  (pick-check 21/21, pick-e2e 8/8). The curl field is the curl of a 3-octave stream function — divergence-free
  by construction, amplitude-bounded (|dy| ≤ 0.015) so the tightest lane gap (0.09 NDC) survives worst-case
  jitter+turb+curl (0.080). It samples **global time** for cross-comet coherence, so replay loops drift
  subtly within the bounds (data + lanes repeat exactly; documented in PROOF's caveats).
- **Bloom + HDR** — see the Component-2 bullets: rgba16float scene, threshold→mip chain→tent-up→composite,
  hue-preserving soft clip, UI toggle (off = pre-M4 path).
- **`est. $ saved (cache)` (`data/cost.ts`).** Σ over cache hits of the mean priced cost of the *same
  provider/model's non-cache* spans in the same event set — no external price table, so it's derived from the
  data or it's `null` (HUD `—`, "no priced spans in this data"). One accumulator (`accSaved`/`savedOf`) is
  shared by the river statsFns and `summarize()`, so river HUD, flame HUD, and `estimateSaved()` agree by
  construction (cost-check 50/50; sample estimate $0.0468 vs the generator's own $0.0437).
- **Perf instrumentation.** Under `?debug=1` the river requests `timestamp-query` (when the adapter has it)
  and query-pairs compute / scene / bloom every 4th frame; `window.__fathom.perf()` returns medians/p95 +
  rAF pacing. `app/perf.mjs` drives it on the real GPU (bloom on/off) and prints the PROOF §7 table.

## Decisions & gotchas
- **Closed-form vs compute for the cinema.** M0–M3 stayed closed-form in the vertex shader for simplicity +
  seamless looping. M4 moved motion into a compute pass for the curl-noise flow — but kept it **stateless**
  (see above) so the pick mirror survived. True stateful advection remains a non-goal while picks are CPU math.
- **Interleave.** The load harness order is sequential-by-scenario, not real timing — so the cinema shuffles
  replay position to show a mixed stream. Honest because spans/proportions are unchanged and it's labeled a replay.
- **GPU selection.** On Windows `powerPreference` is ignored (crbug/369219127); Chrome flag
  `--force_high_performance_gpu` selects the discrete GPU. Both harnesses pass it; the HUD shows `adapter.info`.
- **WGSL `loop` is reserved** — using it as a struct field silently invalidated the pipeline (black screen).
  Renamed to `cycle`. Storage structs use 16-byte-aligned `vec4` packing.
- **Premultiplied additive** (`one/one`) over a dark clear gives the base glow; since M4 a real bloom post
  pass (HDR scene → mip chain → composite) sits on top of it — and the additive-only look remains exactly
  what the bloom-off toggle renders.

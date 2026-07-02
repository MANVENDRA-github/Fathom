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

- **No compute pass.** Motion is **closed-form in the vertex shader**: given global `time` and a particle's
  static params, position/alpha are a pure function → stateless, and the loop wraps seamlessly
  (`tau = (time - spawnT) mod cycle`). Simpler and ample-fast at these counts (~25k particles).
- **One comet per request.** Each event emits K trail particles (K by outcome: PII flare 90, fallback 74,
  span 52, cache 26). Head is brightest; the trail staggers spawn time and shrinks.
- **Lanes by real outcome** (clip-space y bands): cache-hit **cyan** top tributary; 429→fallback **amber**
  mid; span/miss **blue** bottom; PII **red** flare in the bottom band with an upward pop.
- **Soft additive sprites.** Each particle is a 6-vertex quad; the fragment applies a radial falloff and
  outputs **premultiplied** color; blend is `one/one` (additive) over a near-black clear → the glow.
- **Cull:** inactive particles (`tau > life`) emit a degenerate clipped vertex (`z = -2`).

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

## Decisions & gotchas
- **Closed-form vs compute for the cinema.** Chosen for simplicity + seamless looping; compute was already
  proven in the spike, so the cinema didn't need it. Curl-noise flow would need compute (a v1 option).
- **Interleave.** The load harness order is sequential-by-scenario, not real timing — so the cinema shuffles
  replay position to show a mixed stream. Honest because spans/proportions are unchanged and it's labeled a replay.
- **GPU selection.** On Windows `powerPreference` is ignored (crbug/369219127); Chrome flag
  `--force_high_performance_gpu` selects the discrete GPU. Both harnesses pass it; the HUD shows `adapter.info`.
- **WGSL `loop` is reserved** — using it as a struct field silently invalidated the pipeline (black screen).
  Renamed to `cycle`. Storage structs use 16-byte-aligned `vec4` packing.
- **Premultiplied additive** (`one/one`) over a dark clear gives the bloom-like glow without a post pass.

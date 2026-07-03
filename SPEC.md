# Fathom — v1 Build Spec

> Status: **spec** (v1 not yet implemented). The perf spike + real-data proof this builds on are **done** — see
> [`PROOF.md`](./PROOF.md). This document is the plan to take Fathom from a proven foundation to a rich, shippable v1.

## 1. Vision & the one bet
**Fathom is a real-time, GPU-rendered "observability cinema" for LLM-ops telemetry.** Every LLM-gateway span
becomes a glowing comet flowing into a lane by its real outcome — cache hits fork off as a cyan tributary,
429s retry and fail over in amber, PII is caught and blocked as red flares, plain spans run as the blue river.
It plugs onto **any** OpenTelemetry-emitting gateway and turns the flat 2D dashboards everyone stares at
(Langfuse, Phoenix, Helicone, LiteLLM) into something you can *see* — and *use*.

**The dual goal:** a recruiter/interview showpiece **and** a star-magnet OSS repo. **The one bet that decides
success:** it must be *a tool people use, not a screensaver.* Everything below prioritizes the interaction
(**drill-down**) and honesty (**real spans, labeled replay-vs-live**) that separate Fathom from cinematic-log
gimmicks.

**Already proven (don't re-litigate):** 1M span-particles at **0.60 ms GPU/frame** on an RTX 4070 (~28×
headroom) and **3.47 ms** on integrated Intel UHD; 460 real `sentinel` spans render legibly with all four
outcomes visible at once. Perf and the look are not v1 risks — *ingestion, interaction, and distribution* are.

## 2. Locked decisions
| Decision | Choice | Why |
|---|---|---|
| **Rendering** | Raw WebGPU/WGSL core (evolve the spike) + thin **React** DOM shell | Keeps the proven 0.60 ms pipeline + max systems-depth; three.js WebGPU would abstract the core and is immature |
| **Build** | **Vite + TypeScript** (strict, ES2022/Bundler) | Standard, fast, matches lifted configs |
| **Ingestion** | **Generic OTLP/HTTP receiver** (primary) **+** sentinel `/traces?since=` poller (enrichment) | OTLP = works with *any* gateway (distribution); poller adds LLM-judge scores that never hit the OTLP span |
| **v1 scope** | Live streaming · drill-down · 3D cost flame graph · hosted demo · richness pass | The "rich" v1 the flagship needs |

## 3. Architecture

```
  any OTel gateway ─┐  OTLP/HTTP JSON (push, ~s)
  (sentinel, …)     ├──────────────▶ ┌───────────────── Fathom server (Node + TS) ─────────────────┐
                    │  OTEL_EXPORTER_ │  POST /v1/traces  → span→normalized mapper → ring buffer     │
  sentinel /traces ─┘  OTLP_ENDPOINT  │  GET  /stream     → SSE push (snapshot + live spans + judge) │
     ?since= (pull, judge scores) ───▶│  poller adapter   → dedupe by id, trail cursor, enrich judge │
                                       │  GET  /  (static) → serves the client; replay mode from file │
                                       └───────────────────────────┬──────────────────────────────────┘
                                                    SSE (EventSource)│  normalized spans
                                       ┌───────────────────────────▼──────────────── Fathom client ───┐
                                       │  React shell: HUD · legend · controls · DRILL-DOWN panel      │
                                       │  Raw WebGPU core: spawn queue → particle sim → additive render │
                                       │  navigator.gpu capability gate · design tokens                │
                                       └───────────────────────────────────────────────────────────────┘
```

### Server (`server/`, Node + TypeScript)
- **OTLP receiver** — `POST /v1/traces` accepting OTLP/HTTP **JSON** (`ExportTraceServiceRequest`;
  `Content-Type: application/json`). Walk `resourceSpans[].scopeSpans[].spans[]`; extract the typed attribute
  union (`stringValue|boolValue|intValue|doubleValue`) into the normalized schema. This is the format sentinel's
  `@opentelemetry/exporter-trace-otlp-http` emits (see Reuse map) — and any OTel source speaks it.
- **span→normalized mapper** — port `ingest.mjs` to TS; the OTLP attribute keys (`sentinel.cache_hit`,
  `sentinel.guardrail_status`, `sentinel.guardrail_violations`, `sentinel.fallback_used`, `sentinel.cost_usd`,
  `gen_ai.request.model`, `gen_ai.usage.*`, `http.response.status_code`) map to the same fields `ingest.mjs`
  already produces. **One normalizer, two front-doors** (OTLP push + poller pull).
- **ring buffer** — bounded in-memory store of the last N normalized spans (no DB in v1). New connections get a
  `snapshot`, then live deltas.
- **push channel** — `GET /stream` Server-Sent Events (`text/event-stream`). Envelope:
  `{type:'snapshot', events:[…]} | {type:'span', event:{…}} | {type:'judge', id, judgeScore}`. WebSocket is a
  later option; SSE is enough (one-way, auto-reconnect, trivial to host).
- **sentinel poller adapter** (optional, per-source) — polls `GET {gateway}/traces?since=<cursor>` with the admin
  bearer; **dedupe by `id`**, advance the cursor to `max(timestamp)` **trailed by a safety window** (span
  `timestamp` is start-time), and emit `judge` enrichment events for spans already streamed. This is the *only*
  way to surface LLM-judge scores (they never hit the OTLP span).
- **replay mode** — `--replay traces.json` feeds a captured file through the exact same mapper→buffer→SSE path
  at a configurable rate, for the offline demo and CI. The client can't tell replay from live except by the label.

### Client (`app/`, Vite + TS + React)
- **Raw WebGPU core** — port `fathom.js`/`main.js` to TS modules: `gpu/device.ts` (adapter/device, capability
  gate), `gpu/particles.ts` (buffers, pipelines), `gpu/shaders/*.wgsl`, `render/loop.ts`. A **spawn queue**
  turns incoming spans into comets in a **recycling pool** (fixed capacity; oldest recycled) so live traffic of
  any rate stays bounded and 60fps. Keep the proven additive-sprite + closed-form motion; the **richness pass**
  reintroduces a compute pass for curl-noise flow.
- **React shell** — DOM only (canvas stays raw WGSL): HUD (live counters), legend, controls
  (live/replay toggle, pause, lane filters), and the **drill-down panel**. React never touches the render loop.
- **Capability gate** — `navigator.gpu` probe (adapted from Portfolio's `capabilities.ts`) with a graceful
  fallback message; tab-visibility pause (from Portfolio's `SceneCanvas`).

### Data contract (the boundary — source-agnostic by construction)
The renderer consumes only the **normalized schema** from [`ARCHITECTURE.md`](./ARCHITECTURE.md#normalized-schema-the-ingestion-contract--ingestmjs-output)
(`events[] = {t, model, provider, status, latencyMs, tokens, costUsd, cacheHit, fallbackUsed, guardrail, pii,
piiCategories}`), wrapped in the SSE envelope above. Any source that produces this shape works — the OTLP
receiver and the poller are just two mappers to it.

## 4. v1 features (rich)
1. **Live streaming** — spans render as they arrive over SSE; a live/replay toggle in the HUD. Bursts show as
   real density waves. Honest label in the panel: *live* vs *replay*.
2. **Drill-down (the daily-use hook)** — click a comet → a detail panel shows that span's real attributes
   (model/provider, status, latency, cost, tokens, cache/fallback, guardrail violations, judge score if enriched).
   **Hit-testing:** primary = CPU spatial hash over the sparse **comet heads** (hundreds of live click targets,
   cheap, exact); scalable option = a GPU **ID-buffer** pick pass (render comet id to an `r32uint` target, read
   back the pixel under the cursor). Ship the spatial hash; document the ID-buffer path for scale.
3. **3D cost flame graph** — a second mode aggregating token/$ cost by `provider → model → outcome` as a rotating
   3D flame/treemap (WebGPU instanced boxes), reading the same ring buffer. Answers "where does the money go."
4. **Hosted public demo** — deploy the static client + the Node server (SSE needs a live process):
   **Fly.io or Render** for server+SSE (Cloudflare Pages is static-only; a Worker+Durable Object is the advanced
   alt). Demo runs **replay** of a captured trace (clearly labeled) or a sandboxed demo gateway. A clickable live
   link is the retention hook the research calls out.
5. **Richness pass** — bloom (downsample→blur→add post pass), curl-noise flow (compute pass — reuse the spike's
   proven compute path), model-colored sub-streams within a lane, and live counters ($ saved, cache-hit %,
   PII caught) driven by the ring buffer.

## 5. Target repo layout (when built)
```
app/       Vite + React client (raw-WebGPU core under app/gpu, shaders app/gpu/shaders/*.wgsl)
server/    Node + TS: OTLP receiver, mapper, ring buffer, SSE, poller adapter, replay
shared/    the normalized schema + envelope types (imported by both app/ and server/)
spike/     the current perf spike moved here (index.html, main.js, bench.mjs) — kept runnable
tools/     sentinel-dump.ts and other reproducibility scripts
docs/       CLAUDE.md, README.md, ARCHITECTURE.md, PROOF.md, SPEC.md (or keep at root)
```
Restructuring is **M0 work**, not done in this spec turn.

## 6. Milestones & exit criteria
| # | Milestone | Exit criterion (pass/fail) | Model |
|---|---|---|---|
| **M0 ✅ done** | Scaffold: Vite+TS+React, raw-WebGPU core ported to TS modules, spike moved to `spike/` (still runs) | ✅ `npm run build` green + app renders 24.9k particles from `traces.json`; `spike/bench.mjs` prints GO (see `PROOF.md` §3) | — |
| **M1 ✅ done** | Live OTLP end-to-end | ✅ real sentinel gateway → OTLP → Fathom (144 real spans, cache/fallback/pii mapped); live SSE → browser comets (see `PROOF.md` §4) | — |
| **M2 ✅ done** | Drill-down | ✅ clicking a comet opens the correct span's real attributes, reconciled against `GET /traces/:id` on the real GPU (see `PROOF.md` §5); pick is CPU math mirroring the shader (`app/src/gpu/motion.ts`) | **Opus** (pick math, `/traces/:id`, wiring) ✅; **Fable** (attribute-panel UI — outcome-lit callout card: reticle + leader line, card parked opposite the comet) ✅ |
| **M3** ◑ | 3D cost flame graph | ◑ toggle + cost-by-model/provider from the live buffer, reconciles with the HUD on screen (`PROOF.md` §6) | **Opus** (cost aggregation + toggle + reconciliation, plain DOM seam) ✅; **Fable** for the 3D viz/WGSL look (pending) |
| **M4** | Richness pass | Bloom + curl-noise + sub-streams land with frame time still under the 60fps budget (measured, like `PROOF.md`) | **Fable** (aesthetic-craft milestone); **Opus** to keep the perf-budget measurement honest |
| **M5** | Hosted demo + launch | Public URL runs labeled replay at 60fps; README autoplay GIF + honest headline number; ready for HN/X | **Fable** for the README hero + public-demo polish; **Opus** for deploy/CI config + GIF capture |

**Model policy** (Opus + Fable only): **Fable** for anything people *look at* (shaders, viz, UI polish, launch surface); **Opus** for anything that must be *provably correct* (pick math, cost reconciliation, OTLP mapping) and all plumbing/tests/doc-sync. Highest-value Fable milestone: **M4**. Don't drop below Opus on **M3's aggregation** — a wrong cost number undercuts the "money deserves to be seen" pitch.

## 7. Distribution / launch plan (from the research)
- **README** = autoplay hero GIF in the first viewport → a **live hosted demo** link → one honest headline number
  → a short "why this exists" (LLM-ops dashboards are flat; money and PII deserve to be *seen*). Long, substantive.
- **Launch** X first (WebGPU clips are the proven viral vector), then HN in the **12–17 UTC** window, then
  r/LocalLLaMA / r/programming / r/webgpu. Title in the ChartGPU shape: *"I made LLM-gateway telemetry run at
  60fps on the GPU."*
- **Generic OTLP** so any team points one env var at Fathom and their data flows — every adopter is a channel.
- **Honesty is the moat:** label replay vs live; state real numbers; never fake the headline.

## 8. Risks & de-risks / non-goals
- **Screensaver risk** → drill-down is M2, not deferred; positioned as an incident/cost tool that happens to be gorgeous.
- **OTLP batching latency** (~seconds via `BatchSpanProcessor`) → label it "near-real-time"; don't claim instant.
- **Pick perf at scale** → spatial-hash heads for v1; ID-buffer pass documented for when comet counts explode.
- **WebGPU/three pitfalls** → avoided by staying raw (no three.js dependency risk).
- **Non-goals (v1):** auth / multi-tenant, durable storage beyond the ring buffer, non-OTel sources, mobile.

## 9. Reuse map (concrete lifts)
**Jolt-UI** (`D:\Jolt-UI`)
- `packages/core/src/webgl/aurora.ts` — the imperative controller lifecycle: capability probe (`:92-94`),
  DPR clamp (`:129`), RAF loop (`:158-164`), `ResizeObserver` (`:166-172`), full dispose incl.
  `forceContextLoss()` (`:143-151`), reduced-motion branch (`:153-156`). Swap `WebGLRenderer` → raw WebGPU.
- `packages/tokens/src/theme.css` (`:1-125`) — adopt the `@theme` + `[data-theme]` semantic token system.
- `tsconfig.base.json` — ES2022 / Bundler / strict base for the Vite config.

**Portfolio** (`D:\Portfolio`)
- `src/lib/capabilities.ts` (`:1-56`) — `useSyncExternalStore` gate; swap the WebGL probe for `navigator.gpu`/`requestAdapter()`.
- `src/components/ui/Hud.tsx` (`:1-14`) + HUD CSS in `src/app/globals.css` (`:200-223`) — the telemetry HUD chrome.
- `src/lib/utils.ts` `cn()` (`:1-8`) and the tab-visibility pause in `src/components/three/SceneCanvas.tsx` (`:128-132`).

**sentinel** (`D:\sentinel`)
- OTLP env `OTEL_EXPORTER_OTLP_ENDPOINT` (`packages/gateway/src/main.ts:22`, `.env.example:26`) — must include `/v1/traces`.
- Read API `GET /traces?since=<epochMs>&limit=<=500` (`packages/gateway/src/routes.traces.ts`), admin bearer
  (`auth.ts:28-35`), cap 500 (`routes.traces.ts:81`); `TraceRecord` shape (`telemetry/trace.ts:5-43`).
- **From this repo:** `ingest.mjs` (mapper to port) and `tools/sentinel-dump.ts` (capture) already exist.
```

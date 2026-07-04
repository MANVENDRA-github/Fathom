# Proof

Measured evidence for the two de-risking questions, with the exact commands that produced it. Numbers
here come from real runs on the dev machine (Intel UHD + NVIDIA RTX 4070 Laptop, Chrome/WebGPU). Re-run
any of them to reproduce; update this file whenever the numbers change.

---

## 1. Perf — can WebGPU sim+render ~1M span-particles at 60fps?

**Pre-registered thresholds:** 1M @ ≤16.7 ms GPU → GO · 500k–1M → GO-with-LOD · <500k → RETHINK.

```bash
npm install
npm run bench           # = node bench.mjs   (drives system Chrome on the real GPU)
```

`timestamp-query` gives **true GPU ms/frame** (the headroom metric — FPS is vsync-capped at the 240 Hz display).

**RTX 4070 Laptop (nvidia · lovelace)** — `--force_high_performance_gpu`
| particles | fps | frame ms | **GPU ms** | 60fps budget |
|---:|---:|---:|---:|---:|
| 100k | 238 | 4.20 | 0.09 | 16.7 |
| 250k | 238 | 4.20 | 0.18 | 16.7 |
| 500k | 238 | 4.20 | 0.31 | 16.7 |
| **1M** | **238** | 4.20 | **0.60** | 16.7 |
| 2M | 238 | 4.20 | 1.19 | 16.7 |

**Intel UHD integrated (intel · gen-12lp)** — default adapter
| particles | fps | frame ms | **GPU ms** | 60fps budget |
|---:|---:|---:|---:|---:|
| 500k | 238 | 4.20 | 1.31 | 16.7 |
| **1M** | 233 | 4.30 | **3.47** | 16.7 |
| 2M | 81 | 12.40 | 8.06 | 16.7 |

**Verdict: GO.** 1M spans render in **0.60 ms** on the 4070 (~28× headroom) and **3.47 ms** on the
*integrated* GPU (4.8× headroom) — so even worst-case hardware clears the bar comfortably. Artifact: `river-1M.png`.

---

## 2. Real-data — do real `sentinel` spans render as a legible, striking river?

**Capture** (offline, no API keys — sentinel's mock upstreams; temp dumper, deleted after):
```bash
# copy tools/sentinel-dump.ts -> <sentinel>/load/run.dump.ts, then:
<sentinel>/node_modules/.bin/tsx <sentinel>/load/run.dump.ts
#   -> wrote 460 trace records -> data/sentinel-traces-raw.json
#      cache hits: 140 · fallbacks: 95 · blocked(422): 85
# delete run.dump.ts ; git -C <sentinel> status  -> clean (zero residue)
```

**Ingest:**
```bash
npm run ingest          # = node ingest.mjs data/sentinel-traces-raw.json traces.json
#   -> ingested 460 real spans -> traces.json
#      cache-hit 30% · fallbacks 95 · PII blocked 85 · models: std, pii
```

**Render + capture:**
```bash
npm run record          # = node record.mjs traces.json fathom-river 18
#   -> [fathom] 24,632 particles from 460 spans · nvidia · lovelace
#   -> fathom-river.png , fathom-river.webm
```

**Result:** 460 real spans → **24,632 additive-glow particles** at 240 fps on the 4070, all four outcomes
(cache-hit tributary · fallback lane · span river · PII flares) legible simultaneously. Artifacts:
`fathom-river.png`, `fathom-river.webm`.

---

## 3. M0 — app scaffold renders (on `main`)

The cinema, ported to a Vite + React + TypeScript app with the raw-WebGPU core in TS modules, builds clean and
renders the real trace; the relocated perf spike still passes.

```bash
npm run app:install
npm run build           # tsc -b && vite build
#   -> ✓ 37 modules transformed · dist/assets/index-*.js 204 kB · built in ~0.85s   (TS typecheck green)
node app/shot.mjs       # serves app/dist, screenshots on the real GPU
#   -> [fathom] 24,920 particles from 460 spans · nvidia · lovelace   (identical cinema, now app-driven)
npm run bench           # relocated spike
#   -> 1M  238fps  0.60 ms GPU  PASS  ·  VERDICT: GO
```

**M0 exit criteria met:** `npm run dev`/`build` renders the cinema from `traces.json`, and `spike/bench.mjs`
still prints GO. The React shell adds real/sample + pause controls; the WGSL core and normalized schema are unchanged.

---

## 4. M1 — live OTLP end-to-end (on `main`)

A generic OTLP/HTTP receiver + SSE server (`server/`) + a client live spawn queue. Proven at three levels.

**(a) In-process — OTLP → map → Hub → SSE** (deterministic, real captured spans):
```bash
npm --prefix server install
npm --prefix server run e2e
#   PASS parsed all 460 spans · cache_hit(140)/pii(85)/fallback(95) preserved · model+status round-tripped
#   PASS snapshot on connect · 460 live span messages · ring buffer · late-client backlog
#   OK — 460 real spans through OTLP→map→Hub→SSE
```

**(b) Live browser — OTLP over the network → SSE → comets:**
```bash
npm run build                              # build the client
node server/tools/live-demo.mjs            # spawns server, opens ?source=live, streams real spans as OTLP
#   -> 92 spans streamed live · cache-hit 36% · fallbacks 21 · PII 16 · app/m1-live.png (all 4 lanes)
```

**(c) Real sentinel gateway → OTLP → Fathom** (the literal exit criterion, keyless/offline):
```bash
node server/tools/sentinel-otlp-check.mjs  # runs the REAL gateway with OTEL export → Fathom; temp harness deleted after
#   [otlp] +144 span(s)
#   [check] Fathom received 144 REAL spans via OTLP: cache=40 fallback=30 pii=30
#   [check] PASS — real sentinel spans rendered-ready in Fathom     (git -C <sentinel> status: clean)
```

**M1 exit criterion met:** sentinel's real OTLP export lands in Fathom, is normalized correctly, and streams to
the browser as live comets within the window. `server` typecheck green; `app` build green.

**Hardening (adversarial review):** an adversarial code review of the M1 diff found and fixed four real issues
before sign-off — (1) *critical:* SSE reconnect re-sent the snapshot and the client re-spawned + re-counted it,
silently inflating the HUD's headline metrics → now deduped by span id in `river.ts`; (2) spans arriving mid-pause
unspooled with a delay → `elapsed()` now freezes during pause; (3) the poller's `seen` set grew unbounded → pruned
to the trailing window; (4) leaked snapshot timers on unmount → removed. All proofs still green after the fixes.

---

## 5. M2 — drill-down (click a comet → its real span, verified against `/traces/:id`)

Clicking a comet resolves it to the correct span and shows that span's **real attributes**. The pick is
pure CPU math (`app/src/gpu/motion.ts`) that mirrors the shader's closed-form motion (`shaders/river.wgsl`)
and inverts a screen click back to the nearest comet head; the server now retains each span's raw
attributes and serves them at `GET /traces/:id` (the SSE stream stays lean — attributes are fetched on
demand, not streamed).

**(a) Pick math inverts the shader** (deterministic unit harness, no GPU):
```bash
node server/node_modules/tsx/dist/cli.mjs app/tools/pick-check.ts
#   PASS round-trip (project head → click that px → same head) · tau>life cull · cycle wrap
#   PASS nearest-wins · min-radius floor · build.ts emits one head/comet in its outcome lane
#   OK — pick math mirrors the shader (motion.ts) + build.ts heads   (12/12)
```

**(b) Server retains attributes + `/traces/:id`** (in-process, real captured spans):
```bash
npm --prefix server run e2e
#   PASS getById returns the span · retained attributes non-empty · status code preserved · span name retained
#   PASS unknown id → undefined (endpoint 404s) · SSE span frames omit raw attributes (lean stream)
#   OK — 460 real spans through OTLP→map→Hub→SSE (+/traces/:id retention)   (15/15)
```

**(c) Full loop on the real GPU** — click a live comet → correct span → `/traces/:id`:
```bash
npm run build
node server/tools/pick-e2e.mjs             # spawns server, ?source=live&debug=1, streams real spans as OTLP
#   [e2e] streamed 81 OTLP spans; 48 comet heads visible after freeze
#   PASS click resolved the clicked comet (id 000000000span-53)
#   PASS drill-down rendered raw attributes · GET /traces/:id → 200 · DOM id === server id
#   GPU: nvidia · lovelace · clicked (766,582)px · /traces/:id → 7 raw attributes · app/m2-drill.png
#   OK — click → correct span → /traces/:id on the real GPU   (8/8)
```

**M2 exit criterion met:** a click on the GPU canvas opens the correct span's real attributes, and the
DOM readout's id reconciles with the independently-fetched `GET /traces/:id`. Artifact: `app/m2-drill.png`
(the drill-down panel shows both normalized fields and the raw `gen_ai.*`/`sentinel.*` attributes, with
the pick marker on the clicked comet). The harness supplies the click coordinate programmatically via a
`?debug=1` hook, but through the **same** `pick()` path a human click uses — the coordinate is chosen, the
math is not. `server` typecheck green; `app` build green.

---

## 6. M3 — cost flame graph, Opus half (aggregation reconciles with the HUD)

A `river`↔`$ flame` view toggle renders cost-by-provider→model; the aggregation is pure/CPU-side so its
totals reconcile with the HUD. (The 3D WGSL flame itself is the Fable half — pending. This half proves the
data + toggle + reconciliation via a plain DOM breakdown.)

**(a) Aggregation reconciles** (deterministic unit harness, both real datasets):
```bash
node server/node_modules/tsx/dist/cli.mjs app/tools/cost-check.ts
#   PASS Σ providers.cost === totals.cost === raw Σ costUsd (and tokens) · provider === Σ children · rows tile [0,1]
#   PASS real traces.json → unpriced (cost $0), tokens > 0 · sample → 3 providers / 3 models, cost > 0
#   PASS summarize() === aggregateCost().totals  (the HUD invariant)
#   OK — cost aggregation reconciles (real + sample, all metrics)   (43/43)
```

**(b) Reconciles on screen** (flame view, real GPU, sample dataset):
```bash
npm run build
# load ?source=sample&view=flame :
#   PASS 3 provider segments · 3 model segments
#   PASS HUD spend "$0.1120" === flame total "$0.1120"   (reconciled on screen)
#   sample cost total = $0.111993  →  groq 64% ($0.0714) · openai 36% ($0.0406) · ollama $0 (unpriced)
# load ?source=real&view=flame :
#   PASS real capture shows the unpriced note · cost total $0 · renders non-empty on the tokens toggle
#   OK — flame reconciles with the HUD (sample) + honest unpriced state (real)   (8/8)
```
Artifact: `app/m3-cost.png` (the flame breakdown + HUD `spend` matching the flame total).

**(c) The 3D WGSL flame** (Fable half — real GPU, monoliths + embers + orbit + labels):
```bash
node server/node_modules/tsx/dist/cli.mjs app/tools/mat4-check.ts
#   PASS near→0 / far→1 (WebGPU clip-Z, not GL) · lookAt orthonormal · pick ray inverts the projection
#   OK — mat4 maps Z to [0,1] and the pick ray inverts the projection   (10/10)
npm run build
# load ?source=sample&view=flame (nvidia · lovelace):
#   PASS 2 priced provider labels on cost (ollama = $0 → a zero-width flame node, honestly absent)
#   PASS 3 provider labels on requests · HUD spend "$0.1120" === legend total "$0.1120"
#   PASS frame pacing avg 4.48 ms / p95 4.90 ms  (16.7 ms budget)  · hover lights the legend row
# load ?source=real&view=flame:
#   PASS unpriced note shown · tokens toggle renders a labeled skyline (5,520 tokens, 2 providers)
#   OK — 3D flame renders, reconciles, and holds 60fps   (7/7)
node server/tools/pick-e2e.mjs   # river regression after the App changes
#   OK — click → correct span → /traces/:id on the real GPU   (8/8, unchanged)
```
Artifacts: `app/m3-flame.png` (sample, cost — blue/teal monoliths + embers + tracked labels),
`app/m3-flame-real.png` (real capture on the tokens metric).

**M3 exit criterion met (both halves):** the toggle renders cost-by-model/provider (from the loaded trace, or
the live buffer via `GET /debug/recent`), the numbers reconcile with the HUD on screen, and the scene is a
rotating 3D WGSL flame graph — provider monoliths + stacked model bars extruded from the aggregation's layout,
closed-form embers (no compute pass), orbit camera, ray-picked hover, DOM labels tracking bars in 3D — at
~4.5 ms/frame on the 4070 (3.7× headroom). Real capture is `costUsd`-null (honest `unpriced` state — the
sample carries real cost). `app` build green.

---

## 7. M4 — richness pass (curl-noise compute + bloom + sub-streams + $ saved, measured)

The river's motion moved into a **stateless compute pass** (`shaders/river-sim.wgsl`) that adds an analytic
divergence-free **curl-noise flow field** — still a pure function of (stored floats, time), so the M2 CPU
pick mirror stays exact. **Bloom** is a real post chain (rgba16float scene → threshold/downsample →
tent upsample → hue-preserving composite; UI toggle, default on). **Sub-streams**: each provider/model
hashes to a deterministic shade + y sub-band within its outcome lane. New HUD counter **est. $ saved
(cache)** — estimated from the data's own priced cache misses, honestly `—` on the unpriced real capture.

**(a) Pick math still mirrors the shader — now curl-aware** (deterministic, no GPU):
```bash
node server/node_modules/tsx/dist/cli.mjs app/tools/pick-check.ts
#   PASS headPos = base + curl(base) (composition, this loop · 3 loops later)
#   PASS curl |dx| bounded (0.0178 < 0.0190) · |dy| bounded (0.0149 < 0.0150) — lanes stay legible
#   PASS curl field is divergence-free (max |div| 2.3e-9 < 1e-3)
#   PASS modelHash deterministic · sub-band + scatter strictly inside every lane · tints valid
#   OK — pick math mirrors the shader (motion.ts) + build.ts heads   (21/21)
```

**(b) $ saved estimator is honest** (both datasets):
```bash
node server/node_modules/tsx/dist/cli.mjs app/tools/cost-check.ts
#   PASS [real] $ saved is null (costUsd-null capture → HUD "—")
#   PASS [sample] estimate ≈ generator's dollarsSaved (0.0468 vs 0.0437, within 2×)
#   PASS summarize.savedUsd === estimateSaved  (real + sample — HUD === flame by construction)
#   OK — cost aggregation reconciles (real + sample, all metrics)   (50/50)
```

**(c) Full pick loop on the real GPU, with curl + bloom active** (regression of §5c):
```bash
npm run build
node server/tools/pick-e2e.mjs
#   [e2e] streamed 81 OTLP spans; 54 comet heads visible after freeze
#   PASS click resolved the clicked comet · DOM id === server id (full loop consistent)
#   OK — click → correct span → /traces/:id on the real GPU   (8/8)
```

**(d) Measured perf — the exit criterion** (`timestamp-query` on the real pipeline, real capture ~25k particles):
```bash
node app/perf.mjs        # 1600×900, ?source=real&debug=1 · --force_high_performance_gpu
#   GPU: nvidia · lovelace   timestamp-query: yes   (359–361 GPU samples · 600 frame samples per config)
#   config     | compute | scene   | bloom   | totalGPU | GPU p95 | frame avg | frame p95
#   bloom on   |  0.004  |  0.044  |  0.058  |  0.106   |  0.113  |  4.195    |  4.700
#   bloom off  |  0.003  |  0.029  |  0.000  |  0.032   |  0.035  |  4.174    |  4.600
#   budget: 16.7 ms/frame (60fps) — PASS with bloom on (156.8× headroom)
```
(GPU columns are medians in ms; `frame avg` is vsync-capped at the 240 Hz display — GPU ms is the signal.
Spike regression after the refactor: `npm run bench` → 1M @ 0.61 ms GPU, still **GO**.)

**M4 exit criterion met:** bloom + curl-noise + sub-streams land with the whole richness pipeline at
**0.106 ms median GPU/frame** (157× under the 16.7 ms budget) on the 4070, measured per-pass with
`timestamp-query` on the shipping renderer. Artifact: `app/m4-richness.png` (real capture, bloom on —
curl flow, model sub-streams, `est. $ saved (cache) —` honest unpriced state).

---

## Claim → evidence
| Claim | Evidence |
|---|---|
| 1M particles @ 60fps is feasible | `npm run bench` → 0.60 ms GPU (4070), 3.47 ms (Intel) — tables above |
| Works on weak hardware too | Intel UHD integrated clears 1M at 4.8× headroom |
| Renders **real** gateway spans | 460 `sentinel` `chat.completion` spans captured via `pnpm load` (no keys) |
| Cache / fallback / PII all real | 140 / 95 / 85 from the capture; rendered as cyan / amber / red |
| sentinel left pristine | temp dumper deleted; `git -C <sentinel> status` clean |
| Ingestion is source-agnostic | renderer consumes only the normalized schema (`ARCHITECTURE.md`) |
| Richness pass holds 60fps | `node app/perf.mjs` → 0.106 ms median GPU with bloom on (157× headroom, §7) |
| Picks survive curl-noise motion | pick-check 21/21 (curl bounds + divergence) + pick-e2e 8/8 on the real GPU |

## Honest caveats
- Benchmark FPS is vsync-capped (240 Hz) — the **GPU ms** column is the real headroom signal, not FPS.
- Real spans are **replayed and interleaved**, not live/streamed (labeled in-app as "replayed as a live stream").
- Capture particles are per-request comets with fixed density-by-outcome (mock upstream returns uniform
  12-token usage, so density is not token-mapped for this dataset).
- Model names are sentinel's load-config ids (`std`/`pii`), not real provider models.
- `est. $ saved (cache)` is an **estimate** (mean priced cost of the same model's non-cache spans, summed over
  cache hits) — it needs priced data; the real capture is `costUsd`-null so the HUD shows `—`, never a fake $0.
- Because the curl field samples global time, replay loops are not pixel-identical across cycles (positions
  drift within the field's ±0.02 NDC bounds); the data and lane structure repeat exactly.

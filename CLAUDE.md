# Fathom — Operating guide (read this first)

This repo is **Fathom**: a WebGPU "observability cinema" for LLM-ops telemetry (chosen as the
flagship in a 2026 deep-research pass). It began as a feasibility spike to de-risk the two unknowns
before committing to a v1 build — **both are now proven** — and has since become the seed of that
v1 build (M0–M2 done; see `SPEC.md`):

1. **Perf** — can WebGPU sim+render ~1M span-particles at 60fps? → **proven GO** (see `PROOF.md`).
2. **Real-data look** — do real `sentinel` spans render as a legible, striking river? → **yes** (see `fathom-river.png`).

## The pieces
- **Cinema** (`app/`) — a Vite + React + TypeScript app (M0): a thin React shell (HUD/legend/controls) over a
  **raw-WebGPU core** (`app/src/gpu/*`; WGSL in `app/src/gpu/shaders/`). Two modes: **live** (SSE spawn queue,
  one comet per span as it arrives) and **replay** (loops a captured trace). Primary artifact + seed of v1 (`SPEC.md`).
- **Server** (`server/`, M1) — Node + TS: generic **OTLP/HTTP receiver** `POST /v1/traces` → normalized mapper
  → ring buffer → **SSE `/stream`** + **`GET /traces/:id`** (M2 drill-down: full span incl. raw attributes);
  optional sentinel `/traces?since=` poller (judge scores) + file replay. Any OTel gateway feeds it; sentinel via `OTEL_EXPORTER_OTLP_ENDPOINT`.
- **Perf spike** (`spike/`) — `index.html` + `main.js` + `bench.mjs`: compute-shader particle sim + a
  `timestamp-query` benchmark sweeping 100k→2M particles → GO/LOD/RETHINK.
- **Data pipeline** — `ingest.mjs` (sentinel `TraceRecord[]` → normalized), `synth-traces.mjs` (synthetic sample),
  `record.mjs` (video capture), `tools/sentinel-dump.ts` (offline real-span capture). `shared/schema.ts` is the
  normalized contract that `app/` and `server/` both import.

## Layout
| Path | Role |
|---|---|
| `app/` | **cinema** — Vite + React + TS; raw-WebGPU core `app/src/gpu/` (incl. `motion.ts` = pick math, M2), SSE client `app/src/lib/stream.ts`, shell `app/src/ui/` (incl. `SpanDetail.tsx`) |
| `app/public/traces.json` · `.sample.json` | trace data the app fetches in replay mode (copy of the root files) |
| `server/` | **live server** (M1/M2) — OTLP receiver + SSE + `/traces/:id` (`src/otlp.ts`, `src/hub.ts`, `src/index.ts`); `tools/` = emit/live-demo/sentinel-otlp/pick-e2e checks; `e2e.ts` |
| `app/tools/pick-check.ts` | M2 pick-math unit harness (mirrors the shader; no GPU) |
| `shared/schema.ts` | the normalized ingestion contract (imported by `app/` and `server/`) |
| `spike/` | perf spike + benchmark (`index.html`, `main.js`, `bench.mjs`, `river-1M.png`) |
| `ingest.mjs` | sentinel `TraceRecord[]` → normalized schema (the mapper to port into `server/`) |
| `synth-traces.mjs` | schema-faithful *synthetic* sample (dev only; clearly labeled in-app) |
| `record.mjs` | Playwright capture → hero `.png` + `.webm` (+ `.mp4`/`.gif` if ffmpeg) |
| `tools/sentinel-dump.ts` | reference capture script (copy into `<sentinel>/load/`, run, delete) |
| `data/` | captured raw trace records (gitignored) |
| `fathom.html` · `fathom.js` | **legacy** standalone cinema (superseded by `app/`; kept for `record.mjs`) |
| `README.md` · `ARCHITECTURE.md` · `PROOF.md` · `SPEC.md` | docs (keep in sync — see below) |

## How to run
```bash
# cinema (the app)
npm run app:install           # once — installs app/ deps (vite, react, ts)
npm run dev                   # http://localhost:5173  (Vite dev; ?source=live|real|sample)
npm run build                 # tsc -b + vite build -> app/dist
node app/shot.mjs             # build first; screenshots the running app on the real GPU

# live server (M1)  — point any OTel gateway's OTEL_EXPORTER_OTLP_ENDPOINT at http://localhost:4319/v1/traces
npm run server:install        # once
npm run server                # OTLP POST /v1/traces · SSE /stream  (env: REPLAY_FILE, SENTINEL_TRACES_URL+SENTINEL_ADMIN_KEY)
npm --prefix server run e2e   # in-process OTLP→map→Hub→SSE + /traces/:id retention proof (real captured spans)
node server/tools/live-demo.mjs           # server + browser(live) + real spans as OTLP -> app/m1-live.png
node server/tools/sentinel-otlp-check.mjs # REAL sentinel gateway -> OTLP -> Fathom (temp harness, deleted after)

# drill-down (M2)  — click a comet -> its span -> GET /traces/:id
node server/node_modules/tsx/dist/cli.mjs app/tools/pick-check.ts  # pick-math unit harness (mirrors the shader; no GPU)
node server/tools/pick-e2e.mjs            # build first; click a live comet on the real GPU -> app/m2-drill.png

# perf spike
npm run bench                 # real-GPU benchmark (node spike/bench.mjs) -> GO/LOD/RETHINK + spike/river-1M.png
npm run serve:spike           # http://localhost:8971/  interactive perf spike

# data pipeline
npm run sample                # regenerate traces.sample.json
npm run record                # capture fathom-river.png/.webm from the legacy standalone cinema
#
# capture real sentinel spans (offline, no keys) — see ARCHITECTURE.md "Capture"
#   1) copy tools/sentinel-dump.ts -> <sentinel>/load/run.dump.ts
#   2) <sentinel>/node_modules/.bin/tsx <sentinel>/load/run.dump.ts   -> data/sentinel-traces-raw.json
#   3) delete the temp file (keep sentinel pristine)
npm run ingest                # -> traces.json ; then copy to app/public/ to refresh the app's data
```

## Conventions & rules (follow these)
- **Documentation is load-bearing — keep it in sync.** `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`,
  `PROOF.md`, and `SPEC.md` must track the code. In the **same change** that alters behavior, a file's role,
  the data schema, run commands, or any measured number, **update the affected doc(s)**. Never let a doc
  claim something the code no longer does. `PROOF.md` numbers must come from a real run you actually ran.
- **Honesty over polish.** Anything synthetic is labeled synthetic in-app and in docs. Real spans are
  real; the only manipulation is *interleaving* replay order (documented). Benchmark headline numbers
  state replayed-vs-live and which GPU produced them.
- **Keyless & offline.** Real span capture uses `sentinel`'s `pnpm load` mock upstreams — no API keys,
  no network. Never add secrets. Leave `sentinel` pristine (the dumper is temporary; delete it).
- **Perf/GPU notes.** On Windows `powerPreference` is ignored (crbug/369219127) — pass Chrome
  `--force_high_performance_gpu` to select the discrete GPU (see `bench.mjs`/`record.mjs`). Report which
  adapter ran (`adapter.info`).
- **WGSL gotchas.** `loop` is a reserved word — don't use it as an identifier (bit us once). Storage
  structs use 16-byte-aligned `vec4` packing.

## Environment
node ≥ 20 · python 3 (static serve) · system Chrome/Edge with WebGPU · Playwright via `playwright-core`
(uses installed Chrome, no browser download). Dev machine has an Intel UHD + NVIDIA RTX 4070.

## Status & next
Perf: **GO**. Cinema: **working**. **M0–M2 done** (all on `main`; M2 drill-down merged via PR #5):
cinema is a Vite+React+TS app (`app/`, raw-WebGPU core in modules); perf spike in `spike/` (still GO);
**live server (`server/`) shipped** — generic OTLP receiver + SSE + `/traces/:id`, proven end-to-end incl. the
real sentinel gateway exporting OTLP (`PROOF.md` §3–5). **M2**: click a comet → correct span → its real
attributes via `/traces/:id`; the pick is CPU math mirroring the shader (`app/src/gpu/motion.ts`); the detail
UI (`SpanDetail.tsx`, Fable pass) is an outcome-lit callout — reticle on the comet, leader line to a card
parked opposite it, lit in the outcome's lane color; sections mirror normalized-vs-raw (`SPEC.md` model policy).
Still missing (v1): M3 3D cost flame graph, M4 richness (bloom/curl-noise), M5 hosted demo.
**The v1 build plan is in [`SPEC.md`](./SPEC.md)** (milestones M0–M5). **Next: M3 (3D cost flame graph).**
Decision context: vault note `next-flagship-project-research.md`.

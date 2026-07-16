# Brief: in-engine ML denoise (denoise v2)

Status: **STAGE 1 LANDED 2026-07-16** (a5ca998 node/runtime/tiling/cache/
consent + ade0562 EP default): real-model E2E measured ~10s for a full
2560 preview on CPU EP; **CoreML EP crashes the Electron main process
mid-run on the real model** (fine on the tiny fixture — model-scale-
dependent, quarantined behind SILVERBOX_DENOISE_EP=coreml, see
denoiseInfer.ts). fp16 measured visually identical to fp32 (max diff
0.06/255). REMAINING: publish the model release asset (user decision
pending), then hand-test. Earlier: RESEARCHED (sources fetched
2026-07-16); **STAGE 0 SPIKE PASSED
same day** — NAFNet-SIDD-width32 exports cleanly to ONNX and runs under
onnxruntime with dynamic H/W (see docs/research/nafnet-spike/ for the
full report + the export/fp16 scripts). Load-bearing facts for the
implementation: opset **17**, legacy tracer (`dynamo=False` — torch
2.13's default dynamo path can't do dynamic_axes); LayerNorm2d decomposed
to plain ops (bit-exact, diff 0.0); the model's self-pad was removed at
export so **input H/W must be divisible by 16** (the tiler owns padding);
torch↔ORT max diff 1.16e-05 fp32; 512² CPU-EP inference ~0.31 s;
checkpoint from the HF mirror, sha256
89c70e808d1783b6c07911306e106aaf0d4f7f3da8c61078b99ff7f8929a26f4,
29.2M params; fp32 ONNX ~112 MB → fp16 ~56 MB (max diff 8.9e-03 vs fp32 —
eyeball fp16 on a real photo before making it the shipped default).
Still UNVERIFIED: CoreML EP numerics/speed under onnxruntime-node,
memory peak at 512² tiles, an explicit weights-license statement.
DRUNet fallback NOT needed. Ready to stage after the open user
decisions below. v2 endorsed as NEEDED (user, 2026-07-14): v1's
8-bit + [0,1]-clamp round trip caps it at downstream finishing; rivaling
LR's AI Denoise means denoising EARLY — in-engine, at the INPUT stage, on
post-demosaic linear Rec.2020 rgba16float, no external round trip, no
quantization anywhere. Prereq reading: docs/research/denoise.md,
docs/brief-bank/denoise-hook-node.md (contract to reuse), DESIGN.md §6/§10.

## Recommended stack (research compressed — relitigate only on spike failure)

- **Model: NAFNet-SIDD-width32** (megvii-research, MIT code license
  [[license]](https://github.com/megvii-research/NAFNet/blob/main/LICENSE);
  no separate weights license published — MIT presumed, UNVERIFIED as an
  explicit statement). 39.97 dB PSNR on SIDD real sensor noise vs width64's
  40.30 [[repo]](https://github.com/megvii-research/NAFNet) — but the
  checkpoints' actual sizes flip the v1 lean toward width64: SIDD-width64
  is **443 MB** fp32 (~116M params — v1's "67.9M" was the GoPro variant's
  count), SIDD-width32 is **112 MB** fp32 / ~56 MB fp16
  [[HF mirror w/ sizes]](https://huggingface.co/api/models/nyanko7/nafnet-models?blobs=true).
  0.33 dB is not worth 4× the download. Architecture is conv + LayerNorm +
  elementwise gates (no attention, "no nonlinear activation") — the most
  ONNX-export-friendly of the candidates, but the SIDD checkpoint's clean
  export is still **UNVERIFIED**: a `torch.onnx.export` spike is stage 0.
  Trained on 256×256 sRGB crops
  [[train config]](https://github.com/megvii-research/NAFNet/blob/main/options/train/SIDD/NAFNet-width64.yml),
  3-channel, blind (no noise-level input).
  Alternatives (v1 survey re-checked 2026-07): Restormer — MIT, ~26M,
  +0.05 dB, attention = export risk, no ONNX artifact anywhere; SCUNet —
  Apache-2.0, synthetic-only training (not real-noise-benched); DRUNet —
  MIT, conv-only, σ-map conditioned (option c below), the fallback if
  NAFNet export fails; 2024–26 leaderboard models (MDDA-former etc.) — no
  stable licensed repos, not shippable. Nothing displaces NAFNet.
- **Runtime: onnxruntime-node** (MIT, v1.27.0 current) in a main-process-side
  Node worker (`utilityProcess` or `worker_threads`) — NOT onnxruntime-web
  in the renderer. Primary source: the node binding officially supports
  **CoreML on darwin arm64** (plus CPU everywhere; WebGPU EP experimental)
  and Electron v15+
  [[node README]](https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md).
  (The CoreML EP doc page's language list omits Node.js — the node README
  is newer and explicit; trust it, confirm in the spike.) onnxruntime-web's
  WebGPU EP would sit in the renderer beside the engine's own device;
  external-device injection (`env.webgpu.device`) has an open bug where the
  provided device is ignored
  [[#26107]](https://github.com/microsoft/onnxruntime/issues/26107), and
  its wasm/jsep artifacts bloat the renderer. The render worker owns the
  GPU and the UI thread is sacred (DESIGN §10) — inference goes off both.
  npm unpacked size ~258 MB multi-platform
  [[registry]](https://registry.npmjs.org/onnxruntime-node/latest); the
  packaged darwin-arm64 slice is much smaller — add a prune step, exact
  packaged delta UNVERIFIED until measured (budget: ≤60 MB app growth).
- **Integration point**: v2 is a first-party "built-in" behind the SAME
  node contract as v1's external node — pixels already travel render worker
  → main for v1; the built-in path routes them to the ORT worker instead of
  a spawned command. Same cache shape (userData disk LRU + in-memory LRU),
  key = hash(input-pixels-hash, model-hash, params, tile-geometry).

## Pipeline placement contract

Runs at the input stage on post-demosaic LINEAR Rec.2020 rgba16float.
Weights are trained on display-encoded sRGB noise. Honest options:
- (a) **Encode → denoise → decode inside the stage, all float32** (no 8-bit
  anywhere, unlike v1): apply the sRGB transfer channel-wise on
  working-space values (mirrored for negatives), infer, invert. Primaries
  stay Rec.2020 — a deliberate approximation vs full sRGB conversion;
  hand-test decides if primary rotation is also needed. Supported by
  research: restoration nets on linear data underperform display-encoded
  by 2–9 dB [[SIGGRAPH Asia 2024]](https://arxiv.org/html/2312.03640v2).
- (b) Linear-domain weights: none published for post-demosaic linear
  photographic noise (found nothing; raw-Bayer models like PMRID/ELD are a
  different, pre-demosaic stage and camera-specific). Fine-tuning our own
  is a v2.x research project, not v2.0.
- (c) Noise-map conditioning (DRUNet/FFDNet σ-map): a real strength knob
  and ISO awareness, but a different model. Deferred.
**Recommendation: (a)**, with strength as an output blend (mix denoised
over input by `amount` — the standard trick for blind denoisers).

## Implementation stages

- **Stage 0 — export spike (gate)**: `torch.onnx.export` the SIDD-width32
  checkpoint (dynamic H/W or fixed-tile), run under onnxruntime-node CPU
  and CoreML EPs on a 256px crop, compare to PyTorch reference. Fail ⇒
  fall back to DRUNet and re-cost.
- **Stage 1 — v2.0 minimal**: one model (width32, fp16 ONNX if CoreML-clean,
  else fp32); ORT worker owned by main; encode/denoise/decode per (a);
  tiling (below) at preview (~2560 long edge) and export (~9504) scales;
  node params `{ amount }`; cache keyed as above; v1's spinner badge;
  passthrough-on-any-failure exactly like v1.
- **Stage 2 — v2.1+ (deferred)**: width64 as an optional "high quality"
  download; Windows EP story (DirectML per the node README); σ-map model
  for ISO-aware strength; linear fine-tune experiment.

## Tiling

Train crop is 256; convention for NAFNet-class inference is tiles ≥ train
crop with overlap + feathered blend — hard seams are a known failure mode
that chaiNNer fixed by overlap blending
[[chaiNNer v0.21 notes]](https://github.com/chaiNNer-org/chaiNNer/discussions/2451).
Use **512px tiles, 64px overlap, linear cross-fade in the overlap**, stride
448. Preview 2560×1707 ≈ 24 tiles; export 9504×6336 ≈ 330 tiles (minutes
on CoreML — progress UI required; export-time denoise renders at export
resolution, never upscales the preview result). Width32 model + 512²
activations fit easily in 16 GB unified memory (exact peak UNVERIFIED —
measure in the spike; if tight, drop to 256px tiles).

## Weights distribution

**First-use download** (recommended over bundling): ~56–112 MB keeps the
installer lean; field precedent is fetching weights on demand (G'MIC's
`denoise_cnn` ships weights outside the binary via its data mechanism —
first-use-download specifics UNVERIFIED
[[ref]](https://gmic.eu/reference/denoise_cnn.html)). Host on our own
GitHub release / HF repo (upstream links are Google Drive — unstable), pin
sha256, store under userData/models, verify hash before first load.
Offline: node renders passthrough + badge "model not downloaded" with a
download button; never blocks open/edit. Budget: ≤120 MB per model.

## Determinism + verify

CPU EP is bitwise run-to-run deterministic on one machine; GPU/ANE EPs are
not [[ORT #4611]](https://github.com/microsoft/onnxruntime/issues/4611),
and cross-machine/cross-EP outputs differ. So: never golden-compare CoreML
output bitwise; the reproducibility stamp (sidecar/export metadata) records
**model sha256, ORT version, EP name, tile geometry, encode mode** — enough
to explain any pixel diff. Verify sketch (verify-denoise2.mjs):
1. Machinery with a TINY fixture ONNX model checked into scripts/fixtures
   (a fixed small conv, few KB — no download in CI): tiling reassembly ==
   untiled result within 1e-5; encode/decode round-trip identity when the
   fixture is identity; amount=0 ⇒ byte-identical passthrough.
2. Cache: second render, unchanged upstream ⇒ zero ORT runs (run-counter
   debug hook, spawn-count style like verify-external); upstream edit
   re-runs; cache key changes with model hash.
3. Failure paths: missing model file ⇒ passthrough + badge; ORT init error
   ⇒ passthrough; doc stays loadable.
4. Seams: noisy gradient fixture through the tiler ⇒ no discontinuity at
   stride boundaries (compare column/row deltas at 448 px vs neighbors).
5. Real-model golden (manual/optional, not CI): ISO 5000 ARW crop, CPU EP,
   mean-abs-diff vs a banked golden < 1e-3 in encoded domain.

## Open questions needing a user decision

1. **Bundle vs first-use download** of the ~56 MB fp16 default model —
   recommend download; bundling is defensible if offline-first outweighs
   installer size.
2. Offer **width64 (+0.33 dB, ~4× size)** as a quality tier in v2.0, or
   hold for v2.1? (Recommend: hold.)

## Explicitly deferred

Windows EP wiring (DirectML), σ-map/ISO-conditioned model, linear-domain
fine-tuning, Bayer-domain (pre-demosaic) denoise, onnxruntime-web/WebGPU
EP revisit once upstream device sharing is fixed, 100%-view on-demand
tile inference.

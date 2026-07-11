# High-ISO denoise: candidate survey (task #41)

Research only — no code changes. Written against ROADMAP's decided shape:
**external-tool hook node first** (pipe pixels through a user-configured
command, cache keyed by input hash, sidecar stays intent-data), bundled
in-app inference only if that proves insufficient. Test case: ISO 5000 Sony
ARW. Sources fetched 2026-07-11; flagged `UNVERIFIED` where a claim could
not be confirmed from a primary source (license file, README, paper) in the
time available.

Note on prior art already in the engine: Silverbox's **Detail** module
already ships a classical denoiser — bilateral luminance NR + chroma NR in
`src/renderer/engine/graph/developNode.ts` (Y/Cb/Cr space, spatial × range
gaussian, WGSL+CPU mirrored per the engine's invariants). This report is
about whether/how to go further for ISO 5000+, not about greenfield-ing
noise reduction.

## TL;DR

| Candidate | License (code) | Weights license | Quality tier (real sRGB noise) | Runtime options | Integration effort | Verdict |
|---|---|---|---|---|---|---|
| **NAFNet** (megvii-research) | MIT (+ Apache-2.0 for vendored BasicSR bits) [[license]](https://github.com/megvii-research/NAFNet/blob/main/LICENSE) | Same repo, no separate weights license found | Top tier — 40.30 dB PSNR / SIDD (width64), 39.97 dB (width32) [[repo]](https://github.com/megvii-research/NAFNet) | PyTorch only in official repo; no official ONNX; 3rd-party ONNX exports exist (e.g. ailia/HF) but for deblur, not confirmed for the SIDD-denoise checkpoint | Medium-high (need to produce+trust an ONNX export, tiling for 24MP) | **Best v2 bundled candidate** |
| **Restormer** (swz30) | MIT [[repo]](https://github.com/swz30/Restormer) | Not separately licensed (best known) | Top tier — 40.02 dB PSNR / SIDD, transformer-based, ~26.1M params | PyTorch only; no ONNX in repo; transformer ops (attention) historically harder for onnxruntime-web/WebGPU EP than pure conv nets | Medium-high, more export risk than NAFNet (attention layers) | Backup to NAFNet |
| **SCUNet** (cszn) | Apache-2.0 [[license]](https://raw.githubusercontent.com/cszn/SCUNet/main/LICENSE) | Same repo, no separate license | Good, but trained **purely on synthetic degraded data** — authors explicitly did not use SIDD/DND paired data [[repo]](https://github.com/cszn/SCUNet) [[paper]](https://ar5iv.labs.arxiv.org/html/2203.13278) | PyTorch; swin-conv hybrid, same export risk as Restormer | Medium-high | Reasonable but not first pick — SIDD-trained nets score higher on real-noise benchmarks used here |
| **DRUNet / DPIR** (cszn) | MIT [[repo]](https://github.com/cszn/DPIR) | Not separately licensed | Good, general-purpose, one model spans noise σ∈[0,50] via a noise-level input channel; not SIDD-real-noise specialized — designed as a plug-and-play prior, not a photo-denoise leader | Pure CNN/UNet (64→512 ch, 4 scales) → easiest of the four to export/run; 3rd-party ncnn port exists [[hf]](https://huggingface.co/mlc911/drunet-ncnn) | **Lowest** of the ML candidates (simple conv graph, ONNX-friendly) | Good "safe" v2 fallback if NAFNet export proves hard |
| Newer 2024-2026 SOTA (MDDA-former, InstructIR, MambaIR, etc.) | Mixed / mostly research-only | — | NTIRE 2026 denoising challenge names MDDA-former as a leaderboard leader [[paper]](https://arxiv.org/html/2606.16031) — **no public, licensed, stable repo found** (UNVERIFIED — may not exist yet); InstructIR (2024, MIT-ish, ECCV) built on NAFNet backbone, all-in-one restoration, not denoise-specialized, +1dB over prior all-in-one methods [[repo]](https://github.com/mv-lab/InstructIR) | n/a | n/a | Nothing found here is *clearly* better AND shippable — NAFNet remains the practical SOTA pick |
| **darktable-cli** (profiled denoise) | GPL-3.0 (darktable project) | n/a (classical, no weights) | Solid, camera-noise-profiled NLM/wavelet; well regarded, but a generation behind ML denoisers on heavy ISO 5000+ chroma noise [[manual]](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/denoise-profiled/) [[discussion]](https://darktable-users.narkive.com/TN5r3CkN/denoise-comparison-of-darktable-rawtherapee-and-lightroom) | CLI, single-image, XMP-driven; float TIFF/EXR export confirmed [[exr.cc]](https://github.com/darktable-org/darktable/blob/master/src/imageio/format/exr.cc) | Medium — XMP is history-stack shaped, awkward for pipe-in/pipe-out of an *already-rendered* tile | Good "instant v1" if user already has darktable installed, but shape mismatch with hook-node contract (see below) |
| **G'MIC** (`gmic` CLI) | CeCILL (GPL-compatible) [[docs]](https://gmic.eu/reference/denoise.html) | n/a for `nlmeans`/`denoise`/`denoise_patchpca`; `denoise_cnn` weights UNVERIFIED | `nlmeans`/`denoise_patchpca`/`denoise_haar` = classical, competent; `denoise_cnn` = a bundled small CNN, architecture/training UNVERIFIED (no primary doc found) | All-float internal pipeline, native BigTIFF + 64-bit-float TIFF I/O, reads (not writes) OpenEXR [[docs]](https://gmic.eu/reference/gmic_reference.pdf) | **Lowest of the external-tool options** — single static binary, true CLI, float TIFF round-trip is exactly the hook-node shape | **Best v1 external-tool default** |
| **RawTherapee CLI** | GPL-3.0 | n/a | Comparable to darktable, profile-driven | CLI limited to 8/16-bit TIFF output — **no 32-bit float from the CLI** (GUI-only) [[issue]](https://github.com/Beep6581/RawTherapee/issues/4641) | Medium; 16-bit-only output is a real precision constraint for a linear-light pipe | Usable but inferior to G'MIC/darktable for this contract |
| **chaiNNer** (headless) | GPL-3.0 [[repo]](https://github.com/chaiNNer-org/chaiNNer) | Bundles/loads 3rd-party model weights (NAFNet, SCUNet, etc. via spandrel) — inherits *their* licenses per model | Whatever model you load — effectively a GUI/CLI wrapper around the ML candidates above | Has a documented CLI usage page (Electron+Python app) but true "headless, no window" operation is UNVERIFIED for automated single-shot pipe use | Higher effort — heavier dependency (Electron+Python+torch) to shell out to from another Electron app | Interesting distribution vehicle for v2 bundling reference, not a good v1 hook target |
| **BM3D** | Mixed (`bm3d-gpu` CUDA, `BM3D_cpp`, `VapourSynth-BM3DCUDA` — none confirmed WebGPU-portable or uniformly permissive; original Lebrun/CFA implementation is research-license) | n/a | Historically the classical-denoise quality ceiling, still competitive at moderate ISO, clearly behind NAFNet/Restormer at ISO 5000+ | CUDA/CPU implementations only; no WebGPU port found [[search]](https://github.com/DawyD/bm3d-gpu) | High to port to WGSL (block-matching + 3D collaborative filtering doesn't map cleanly to the compute-shader model Silverbox already uses) | Not worth building in-engine; use via external tool (`vkdt`, `VapourSynth`) if ever wanted |

## Per-candidate notes

### NAFNet
MIT-licensed (code), MEGVII Research. SIDD (real smartphone-sensor sRGB
noise) denoising checkpoints at width32 (39.97 dB PSNR) and width64
(40.30 dB PSNR), the latter ~67.9M parameters [[repo]](https://github.com/megvii-research/NAFNet). No official ONNX
export or inference-speed numbers are published in the repo; a third-party
ONNX conversion exists for the *deblur* checkpoint via ailia [[article]](https://medium.com/axinc-ai/nafnet-a-machine-learning-model-to-deblur-images-a0a03e94feae) but the
SIDD-denoise checkpoint's ONNX-exportability is **UNVERIFIED** — it's a
pure conv/attention-free architecture (that's the paper's whole point, "no
nonlinear activation function"), which historically exports cleanly to ONNX
and runs well on both onnxruntime CPU and GPU EPs, but this needs a
throwaway `torch.onnx.export` spike to confirm before committing to it for
v2. No tiling guidance ships with the repo — a 24MP frame (6000×4000) would
need to be tiled with overlap for both memory and to match the training
crop size, standard practice but extra engineering.

### Restormer
MIT-licensed, from the same lineage (BasicSR/HINet-based) [[repo]](https://github.com/swz30/Restormer). Slightly
higher PSNR than NAFNet on SIDD (40.02 dB) at less than half NAFNet-width64's
parameter count (~26.1M), but it's a transformer (windowed/channel
attention) — ONNX export of attention blocks is historically more failure
prone (dynamic shapes, unsupported ops) than NAFNet's conv-only path, and no
ONNX artifact is mentioned anywhere in the repo or its ecosystem. Good
backup, not the first thing to spike.

### SCUNet
Apache-2.0 confirmed via the raw LICENSE file [[license]](https://raw.githubusercontent.com/cszn/SCUNet/main/LICENSE) — full commercial
use, attribution only. Real-image results are shown in the README but the
model is trained purely on synthetic degradations (noise→JPEG→blur→resize→
Poisson→camera-sensor pipeline), explicitly *not* on SIDD/DND paired data
[[paper]](https://ar5iv.labs.arxiv.org/html/2203.13278). That's a meaningfully different quality claim from
NAFNet/Restormer, which train directly on SIDD's real sensor noise — for a
"denoise my actual ISO 5000 Sony frame" use case, real-noise-trained nets
are the safer quality bet. Swin-conv hybrid architecture, same
export-risk profile as Restormer.

### DRUNet / DPIR
MIT [[repo]](https://github.com/cszn/DPIR). Pure CNN U-Net, 4 scales, channel counts
64/128/256/512, noise level fed as an extra input channel so one checkpoint
covers σ∈[0,50] (and reportedly holds up to unseen σ=200) [[searches, DPIR docs]](https://deepinv.github.io/deepinv/api/stubs/deepinv.models.DRUNet.html). Exact parameter
count is **UNVERIFIED** (sources disagree: a "DRUnet-lite" variant is cited
at ~4.2M; the full color DRUNet used in DPIR is commonly cited elsewhere as
~32M but no primary source confirmed this during research). It's designed
as a Plug-and-Play *prior* for inverse problems (deblur/SR/inpaint), not
specifically tuned as a photographic-noise leader the way SIDD-trained
NAFNet/Restormer are — expect it to be "good, safe, a bit behind" on ISO
5000+ chroma noise. Its architectural simplicity (no attention, no
swin-blocks) makes it the easiest of the four to trust through ONNX export
and to run fast (a community ncnn port already exists [[hf]](https://huggingface.co/mlc911/drunet-ncnn), implying the
graph is portable).

### Newer 2024-2026 models
NTIRE runs an annual real-world denoising challenge; the 2026 edition's
paper names "MDDA-former" as a leaderboard leader (best PSNR on DND, third
on SIDD, fewer FLOPs than Restormer/MambaIR) [[paper]](https://arxiv.org/html/2606.16031), but no stable,
licensed, public repository for it was found — challenge-winner code
frequently stays unpublished or research-only. **UNVERIFIED / likely not
shippable today.** InstructIR (ECCV 2024, MIT-style repo license,
NAFNet-derived backbone) targets *all-in-one* restoration (denoise + derain
+ deblur + dehaze + low-light) via text instructions, gaining "+1dB over
previous all-in-one methods" [[repo]](https://github.com/mv-lab/InstructIR) — interesting shape but not
denoise-specialized, and doesn't clearly beat plain NAFNet-SIDD on pure
denoising. Conclusion: nothing found in the 2024-2026 window is *clearly
better and cleanly shippable* enough to displace NAFNet as the v2 pick.

## External-tool paths (the v1 shape)

**darktable-cli**: `darktable-cli <input> [<xmp>] <output> --out-ext exr`
exports through the full pipeline honoring an XMP history stack, including
denoise (profiled); float TIFF and OpenEXR output both confirmed
[[manual]](https://docs.darktable.org/usermanual/development/en/special-topics/program-invocation/darktable-cli/) [[exr.cc]](https://github.com/darktable-org/darktable/blob/master/src/imageio/format/exr.cc). Quality is well regarded (camera-noise-profiled NLM or
wavelet) but a generation behind ML denoisers at heavy ISO, and users report
"raw denoise" sometimes beats "denoise (profiled)" for artifacts [[thread]](https://discuss.pixls.us/t/raw-denoise-has-less-artifacts-then-denoise-profiled/32706).
**Shape mismatch**: darktable-cli's whole design center is "RAW file +
history-stack XMP → final export," not "take this already-demosaiced,
already-graded linear tile and denoise it in isolation." Wiring the
hook-node contract through it means either (a) writing a synthetic XMP that
disables every module except denoise (profiled), fragile against darktable
version drift, or (b) accepting that darktable becomes an alternative
*whole* raw path rather than a mid-graph node. Workable for a user who
already lives in darktable, not the cleanest first integration target.

**G'MIC (`gmic`)**: single static CLI binary, CeCILL license, stores every
image as 32-bit float internally regardless of input format, native
BigTIFF + 64-bit-float TIFF read/write, reads (not writes) OpenEXR
[[handbook]](https://gmic.eu/reference/gmic_reference.pdf). Ships several denoise filters directly invocable from the
command line: `nlmeans` (classic Buades non-local-means) [[docs]](https://gmic.eu/reference/nlmeans.html), `denoise`
(patch-averaging) [[docs]](https://gmic.eu/reference/denoise.html), `denoise_patchpca`, `denoise_haar` (wavelet), and
`denoise_cnn` (a bundled small neural denoiser — architecture, training
data and license terms for its weights are **UNVERIFIED**, the reference
page gives only the calling convention and default `patch_size=64`). A
one-line invocation like `gmic input.tiff -denoise_cnn 0,64 -o output.tiff`
maps almost exactly onto the intended hook-node contract (file in, file
out, float-preserving). **This is the strongest v1 default** — it needs no
sidecar-format gymnastics, and gives the user a choice between an
instant classical mode and its bundled CNN, with the door open to point the
same hook at literally any other command (including a user's own Python
+ NAFNet script) later.

**RawTherapee CLI**: PP3-profile-driven denoise, but the CLI is capped at
8/16-bit TIFF/PNG output — 32-bit float TIFF export exists only in the GUI
[[issue]](https://github.com/Beep6581/RawTherapee/issues/4641). 16-bit integer is usable for a linear-light pipe only if the hook
node applies its own encoding before quantizing (see recommendation below);
otherwise shadow precision suffers exactly where ISO 5000+ noise lives.

**chaiNNer**: GPL-3.0, Electron+Python, a node graph for chaining ML image
models (spandrel-backed, includes both NAFNet and SCUNet as loadable
architectures per its GitHub issues) [[repo]](https://github.com/chaiNNer-org/chaiNNer) [[issue]](https://github.com/chaiNNer-org/chaiNNer/issues/2269). A documented CLI-usage page
exists, but whether it truly runs "headless, no window, one input → one
output" in a scriptable way suitable for a per-tile subprocess call is
**UNVERIFIED** from the docs fetched. Given it's already a full Electron app
wrapping PyTorch, using it as the *hook command* is a heavier dependency
than needed for v1 (the user would need to install a second Electron app to
denoise inside the first); more interesting as prior art for how to
distribute an ONNX/PyTorch pipeline than as the recommended external tool.

**libvips / ImageMagick**: vips is LGPL, fully float-capable, reads (not
writes) OpenEXR, added 32-bit-float TIFF support in 8.15 [[issue]](https://github.com/libvips/libvips/issues/3144), but has
**no NLM/denoise filter** of its own — useful only as a format-conversion
shim, not a denoiser. Not a candidate on its own.

## Classical fallback: is a great non-ML op "enough" at ISO 5000-12800?

Honest answer: **not for the top end.** darktable's own docs describe
non-local-means as "very computationally intensive... but often delivers
even smoother results" for tackling luma noise [[manual]](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/denoise-profiled/) — i.e. even the best
classical tool trades speed for smoothness, and users still report visible
tradeoffs (banding/artifacts) at strong settings [[thread]](https://discuss.pixls.us/t/raw-denoise-has-less-artifacts-then-denoise-profiled/32706). NAFNet/Restormer's
reported SIDD PSNR gains (~40 dB vs. non-local-means baselines typically in
the low-to-mid 30s dB on the same benchmark, per the SCUNet/Restormer
papers' comparison tables) represent a real, visible quality gap at heavy
noise — the ML models preserve fine detail and color while suppressing
noise in a way patch-based classical methods can't match once chroma noise
gets aggressive, which is exactly the ISO 5000-12800 regime the user cares
about. Silverbox's existing bilateral NR (a cheaper, faster classical op
than NLM or BM3D) is good general-purpose noise control at low-to-moderate
ISO but was never meant to be the ceiling — it's a per-pixel op with no
spatial search window, so it can't do patch-level noise/detail separation
at all. BM3D sits between bilateral and the ML models in quality but has no
WebGPU-portable implementation and its collaborative block-matching
doesn't map cleanly onto Silverbox's per-pixel WGSL-pass architecture — not
worth building in-engine; if ever wanted, reach it the same way as
everything else in this report, through an external CLI (e.g. VapourSynth's
BM3DCUDA) via the hook node, not as a bundled spatial op.

**Verdict**: ship the external-tool hook node for v1 (matches ROADMAP's
stated preference exactly, and G'MIC or a user's own NAFNet script both
satisfy it immediately), and treat "good classical spatial op in-engine" as
not worth building — it would land between the existing bilateral NR and
the external ML path in both quality and effort, satisfying neither the
"good enough" nor the "cheap to build" argument well.

## Recommendation

**v1 — external-tool hook node** (matches decided architecture):

- **New node type** `externalTool`, alongside `passes`/`blend` in
  `graphDoc.ts`'s node-type union. Sidecar stores only the command line
  template and any user-declared parameters (`P.<name>` style, consistent
  with `customShaderNode.ts`'s convention) — never the output pixels.
- **Pipe format**: write the node's *input* texture to a 32-bit-float TIFF
  tile using the readback path that already exists for export
  (`copyTextureToBuffer` + `mapAsync` in `graphRenderer.ts`), invoke the
  user's command (`{{in}}`/`{{out}}` path substitution, like a Makefile
  rule), read the float TIFF back in as the node's output texture. TIFF
  over EXR for v1 because more of the survey's CLI targets (G'MIC,
  darktable-cli, RawTherapee) round-trip 32-bit-float TIFF cleanly; EXR
  read/write support is spottier (vips can't write it, RawTherapee CLI
  can't do float TIFF *or* EXR).
- **Color space boundary**: the engine's internal state is linear Rec.2020
  the whole way through (per DESIGN.md's "linear chain" invariant) — the
  hook node should hand the external tool **linear Rec.2020 float**, not
  sRGB-encoded output, and read the result back as linear Rec.2020 float
  too, so the node is a genuine graph citizen composable before/after any
  other node (crop, grade, etc.) rather than a special "final export only"
  step. This does mean the user's external command must itself be
  colorspace-aware (most ML denoise nets were trained in encoded sRGB, not
  scene-linear light) — document clearly in the node's UI that a
  gamma/sRGB-encode-then-decode wrapper is the user's responsibility unless
  Silverbox offers a node-level "encode before / decode after" toggle
  (recommended: ship that toggle in v1, defaulting to on, since virtually
  every external denoiser expects encoded input).
- **Tiling for 24MP+**: v1 can punt — pipe the whole frame through in one
  shot (G'MIC, darktable-cli, and most CLI tools handle 24MP fine on CPU in
  seconds-to-tens-of-seconds, acceptable for a non-realtime node); revisit
  only if a specific tool needs tiling (e.g. a bundled ONNX model with a
  fixed receptive/training crop size in v2).
- **Cache key**: hash of (input pixel buffer content hash, the command
  template string, and the declared parameter values) — not the file path
  or mtime, so the cache survives file moves and is portable across
  machines if the sidecar + cache dir travel together. Store as
  `<cacheDir>/<hash>.tiff` next to the sidecar (or under Electron's
  `userData`, consistent with wherever `settings.ts` already keeps
  machine-local state) — this is exactly the "cache keyed by input hash"
  ROADMAP already commits to.

**v2 — bundled inference, only if v1 proves insufficient** (e.g. users
without a CLI denoiser installed, or wanting one-click quality without
config):

- **Model + runtime pick: NAFNet-SIDD-width64, exported to ONNX, run via
  `onnxruntime-node`** in the Electron **main process** (not
  `onnxruntime-web` in the renderer) — Electron's main process is plain
  Node.js, so `onnxruntime-node`'s native bindings give CoreML (macOS) /
  DirectML (Windows) / CUDA (Linux) execution providers for free, sidestepping
  the browser-sandbox constraints and WASM-only fallback that
  `onnxruntime-web` would impose inside the renderer [[onnxruntime-node]](https://www.npmjs.com/package/onnxruntime-node). MIT license
  end to end (NAFNet code + weights, onnxruntime itself). Fallback if the
  SIDD-denoise checkpoint doesn't export cleanly to ONNX (needs a spike —
  UNVERIFIED today): DRUNet (also MIT, simpler conv-only graph, known
  ncnn-portable, at some cost in peak quality vs. NAFNet).
- Reuse the **same hook-node contract** for the bundled path — v2 is just a
  first-party "built-in" entry in the same `externalTool` node's command
  picker (a virtual command that calls the bundled ONNX model in-process
  instead of shelling out), so the cache key, color-space boundary and
  tiling logic built for v1 aren't thrown away.
- Tile at v2 time: NAFNet's training crops are much smaller than a 24MP
  frame, so bundled inference needs an overlap-tiled pass (e.g. 512px tiles
  with ~32px overlap, cross-fade blend) — this is standard practice but is
  new engineering, unlike v1 where the external tool owns its own tiling.

## What to verify before committing to v2 (flagged UNVERIFIED here)

- Does `torch.onnx.export` on the official NAFNet-SIDD-width64 checkpoint
  produce a working ONNX graph, and does `onnxruntime-node` run it
  correctly and at acceptable latency for a 24MP frame (tiled)? No primary
  source confirms this either way.
- Exact DRUNet parameter count and CPU/GPU latency numbers.
- G'MIC's `denoise_cnn` model provenance and license terms for its weights
  (separate from G'MIC's own CeCILL license).
- Whether chaiNNer has a genuinely headless (no-window) single-shot CLI
  mode suitable for shelling out to per-tile, vs. requiring the full app
  running.

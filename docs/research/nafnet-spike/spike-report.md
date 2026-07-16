# Stage 0 spike report: NAFNet-SIDD-width32 → ONNX → onnxruntime

Date: 2026-07-16. Gate question: does NAFNet-SIDD-width32 export cleanly to
ONNX and run under onnxruntime with dynamic spatial dims? **Answer: YES.**
DRUNet fallback not needed.

## Environment

- macOS darwin arm64, Python 3.12.11 (venv in this dir)
- torch 2.13.0 (CPU wheels), onnx 1.22.0, onnxruntime 1.27.0, numpy 2.5.1
- No network/sandbox blocks encountered.

## Checkpoint source

- Official README links are Google Drive / Baidu only — skipped (headless).
- Used HuggingFace mirror: `https://huggingface.co/nyanko7/nafnet-models/resolve/main/NAFNet-SIDD-width32.pth`
- Size: **116,861,841 bytes** (~111.5 MB)
- sha256: `89c70e808d1783b6c07911306e106aaf0d4f7f3da8c61078b99ff7f8929a26f4`
- state_dict layout: top-level key `params` wraps the weights (664 tensors);
  `model.load_state_dict(ckpt['params'], strict=True)` loads clean.
- Param count: **29,159,715** (~29.2M) — the brief's "~56M" width32 estimate
  was high; actual is 29.2M fp32 ≙ the 112 MB file.

## Architecture config (options/test/SIDD/NAFNet-width32.yml)

- `NAFNet(img_channel=3, width=32, enc_blk_nums=[2,2,4,8], middle_blk_num=12, dec_blk_nums=[2,2,2,2])`

## Export details

- **Opset 17**, legacy TorchScript tracer (`dynamo=False`; torch 2.13 defaults
  to the dynamo exporter — legacy path still present, used deliberately so
  `dynamic_axes` works as specified). `onnx.checker` passes, ir_version 8.
- **LayerNorm2d trap**: NAFNet's LayerNorm2d wraps a custom
  `autograd.Function`. Replaced its forward with the mathematically identical
  plain-op decomposition before export (mean/var/sqrt/scale-shift); verified
  max abs diff vs the original autograd path = **0.0** (exact).
- **Pad/crop trap**: `NAFNet.forward` self-pads to a multiple of
  `padder_size` and crops back; under tracing those become baked constants,
  breaking dynamic dims. Exported a wrapper forward WITHOUT pad/crop —
  the ONNX model requires **H and W divisible by 16** (`padder_size = 2 **
  len(enc_blk_nums) = 16`). **The app-side tiler must feed %16 tiles** (512
  and 256 tiles both qualify). Confirmed a 250×250 input fails at runtime
  (broadcast error in a skip-connection Add), as expected.
- PixelShuffle exported without issue (DepthToSpace).

## Validation (onnxruntime CPU EP)

- 256×256, fixed seed, fp32: torch vs ORT max abs diff **1.156e-05**
  (within the <1e-4 expectation).
- **Dynamic dims proven**: same ONNX session ran 192×320 → output
  (1,3,192,320), torch vs ORT max abs diff **9.894e-06**.
- Timing, 512×512 single inference, CPU EP, this machine (arm64):
  **~0.31 s** (min of 3 after warmup; 0.31/0.35/0.35). Ballpark for the
  brief: preview 2560×1707 ≈ 24 tiles ≈ ~8 s CPU-only; CoreML EP expected
  to improve this (not tested here — onnxruntime Python wheel on macOS is
  CPU EP; CoreML check belongs to the onnxruntime-node stage-1 spike).

## fp16 conversion

- `onnxruntime.transformers.float16.convert_float_to_float16` with
  `keep_io_types=True` (fp32 I/O, fp16 weights): straightforward, no fights.
- Sizes: fp32 ONNX **117,089,598 bytes** (~111.7 MB) → fp16 ONNX
  **58,961,563 bytes** (~56.2 MB). Matches the brief's ~56 MB estimate.
- fp16 vs fp32 on random [0,1) input (CPU EP): max abs diff **8.9e-03**,
  mean abs diff **1.3e-03** — i.e. ~0.9% of range at the worst pixel.
  Typical for fp16 through 36 NAFBlocks; visually judge in stage 1
  before choosing fp16 as the shipped default. Dynamic dims work on the
  fp16 model too (192×320 verified).

## Deliverables in this directory

- `nafnet-sidd-width32.fp32.onnx` (117,089,598 B)
- `nafnet-sidd-width32.fp16.onnx` (58,961,563 B)
- `export_nafnet.py` (build/load/export/validate), `fp16_convert.py`
- `NAFNet-SIDD-width32.pth` (checkpoint), `NAFNet/` (repo clone), `venv/`

## Facts NOT established here (UNVERIFIED)

- CoreML EP behavior (numerics, speed) — needs onnxruntime-node on darwin
  arm64, out of scope for this Python spike.
- Memory peak at 512² tiles — not measured.
- Weights license as an explicit statement (still MIT-presumed only).

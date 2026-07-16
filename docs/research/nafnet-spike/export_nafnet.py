# NAFNet-SIDD-width32 -> ONNX export spike (stage 0 of denoise-v2 brief)
import sys, types, importlib.util, os, json, hashlib, time

SPIKE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(SPIKE, "NAFNet")
CKPT = os.path.join(SPIKE, "NAFNet-SIDD-width32.pth")

import torch
import numpy as np

print("torch", torch.__version__)

# ---- load NAFNet arch modules without triggering basicsr/__init__ heavy deps ----
def _stub(name, attrs=None):
    m = types.ModuleType(name)
    for k, v in (attrs or {}).items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m

import logging
_stub("basicsr")
_stub("basicsr.utils", {"get_root_logger": lambda *a, **k: logging.getLogger("nafnet")})
_stub("basicsr.models")
_stub("basicsr.models.archs")

def _load(modname, path):
    spec = importlib.util.spec_from_file_location(modname, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[modname] = mod
    spec.loader.exec_module(mod)
    return mod

arch_util = _load("basicsr.models.archs.arch_util",
                  os.path.join(REPO, "basicsr/models/archs/arch_util.py"))
local_arch = _load("basicsr.models.archs.local_arch",
                   os.path.join(REPO, "basicsr/models/archs/local_arch.py"))
nafnet_arch = _load("basicsr.models.archs.NAFNet_arch",
                    os.path.join(REPO, "basicsr/models/archs/NAFNet_arch.py"))
NAFNet = nafnet_arch.NAFNet
print("arch loaded OK")

# ---- build model per options/test/SIDD/NAFNet-width32.yml ----
model = NAFNet(img_channel=3, width=32,
               enc_blk_nums=[2, 2, 4, 8], middle_blk_num=12,
               dec_blk_nums=[2, 2, 2, 2])
print("padder_size (H/W divisibility factor):", model.padder_size)

ckpt = torch.load(CKPT, map_location="cpu", weights_only=True)
print("checkpoint top-level keys:", list(ckpt.keys()))
state = ckpt["params"] if "params" in ckpt else ckpt
missing, unexpected = model.load_state_dict(state, strict=True), None
print("state_dict loaded strict=True OK; num tensors:", len(state))
model.eval()
n_params = sum(p.numel() for p in model.parameters())
print(f"param count: {n_params:,}")

# ---- export-safe forward: no traced pad/crop (input must be % padder_size) ----
# Also decompose LayerNormFunction (custom autograd.Function) into plain ops,
# mathematically identical to its forward().
class LayerNorm2dPlain(torch.nn.Module):
    def __init__(self, src):
        super().__init__()
        self.weight = src.weight
        self.bias = src.bias
        self.eps = src.eps
    def forward(self, x):
        mu = x.mean(1, keepdim=True)
        var = (x - mu).pow(2).mean(1, keepdim=True)
        y = (x - mu) / (var + self.eps).sqrt()
        C = self.weight.shape[0]
        return self.weight.view(1, C, 1, 1) * y + self.bias.view(1, C, 1, 1)

class ExportWrapper(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net
    def forward(self, inp):
        x = self.net.intro(inp)
        encs = []
        for encoder, down in zip(self.net.encoders, self.net.downs):
            x = encoder(x)
            encs.append(x)
            x = down(x)
        x = self.net.middle_blks(x)
        for decoder, up, enc_skip in zip(self.net.decoders, self.net.ups, encs[::-1]):
            x = up(x)
            x = x + enc_skip
            x = decoder(x)
        x = self.net.ending(x)
        return x + inp

# reference output with ORIGINAL modules (autograd LayerNormFunction), on %16 input
torch.manual_seed(1234)
x256 = torch.rand(1, 3, 256, 256, dtype=torch.float32)
with torch.no_grad():
    ref_orig = model(x256)   # original forward (pad/crop are no-ops at 256)

# swap LayerNorm2d -> plain decomposition, verify equivalence
def swap_ln(mod):
    for name, child in mod.named_children():
        if isinstance(child, arch_util.LayerNorm2d):
            setattr(mod, name, LayerNorm2dPlain(child))
        else:
            swap_ln(child)
swap_ln(model)
export_model = ExportWrapper(model).eval()
with torch.no_grad():
    ref_plain = export_model(x256)
d = (ref_orig - ref_plain).abs().max().item()
print(f"LayerNorm decomposition max abs diff vs original: {d:.3e}")
assert d < 1e-5, "LayerNorm decomposition not equivalent"

# ---- ONNX export, opset 17, dynamic H/W ----
onnx_path = os.path.join(SPIKE, "nafnet-sidd-width32.fp32.onnx")
export_err = None
try:
    torch.onnx.export(
        export_model, (x256,), onnx_path,
        input_names=["input"], output_names=["output"],
        opset_version=17,
        dynamic_axes={"input": {2: "H", 3: "W"}, "output": {2: "H", 3: "W"}},
        dynamo=False,
    )
    print("export OK (legacy tracer, dynamo=False, opset 17)")
except TypeError as e:
    # dynamo kwarg may not exist / legacy path removed
    export_err = e
    print("legacy export path failed:", e)
    torch.onnx.export(
        export_model, (x256,), onnx_path,
        input_names=["input"], output_names=["output"],
        opset_version=17,
        dynamic_shapes={"inp": {2: "H", 3: "W"}},
    )
    print("export OK (dynamo path)")

import onnx
m = onnx.load(onnx_path)
onnx.checker.check_model(m)
print("onnx.checker OK; ir_version", m.ir_version,
      "opset", [f"{o.domain or 'ai.onnx'}:{o.version}" for o in m.opset_import])
print("onnx file size:", os.path.getsize(onnx_path))

# ---- validate with onnxruntime CPU EP ----
import onnxruntime as ort
print("onnxruntime", ort.__version__)
sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])

def run_ort(x):
    return sess.run(None, {"input": x.numpy()})[0]

y_ort = run_ort(x256)
diff = np.abs(y_ort - ref_plain.numpy()).max()
print(f"[256x256] torch vs ORT max abs diff: {diff:.3e}")

# dynamic dims proof: second size through the SAME session
torch.manual_seed(4321)
x2 = torch.rand(1, 3, 192, 320, dtype=torch.float32)
with torch.no_grad():
    ref2 = export_model(x2)
y2 = run_ort(x2)
diff2 = np.abs(y2 - ref2.numpy()).max()
print(f"[192x320 same session] torch vs ORT max abs diff: {diff2:.3e}  out shape {y2.shape}")

# non-%16 input should fail (documenting the contract)
try:
    bad = np.random.rand(1, 3, 250, 250).astype(np.float32)
    sess.run(None, {"input": bad})
    print("[250x250] unexpectedly SUCCEEDED (pad not needed?)")
except Exception as e:
    print("[250x250] fails as expected (input must be %16):", str(e).splitlines()[0][:120])

# ---- timing: 512x512 single inference, CPU EP ----
x512 = np.random.rand(1, 3, 512, 512).astype(np.float32)
sess.run(None, {"input": x512})  # warmup
ts = []
for _ in range(3):
    t0 = time.perf_counter()
    sess.run(None, {"input": x512})
    ts.append(time.perf_counter() - t0)
print(f"512x512 CPU EP inference: min {min(ts):.2f}s  runs {['%.2f' % t for t in ts]}")

print("DONE")

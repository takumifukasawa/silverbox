# fp16 conversion of the exported NAFNet ONNX
import os, numpy as np, onnx

SPIKE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(SPIKE, "nafnet-sidd-width32.fp32.onnx")
DST = os.path.join(SPIKE, "nafnet-sidd-width32.fp16.onnx")

try:
    from onnxruntime.transformers.float16 import convert_float_to_float16
    src_name = "onnxruntime.transformers.float16"
except ImportError:
    from onnxconverter_common import float16
    convert_float_to_float16 = float16.convert_float_to_float16
    src_name = "onnxconverter_common"
print("using", src_name)

m = onnx.load(SRC)
m16 = convert_float_to_float16(m, keep_io_types=True)  # fp32 I/O, fp16 weights/compute
onnx.save(m16, DST)
print("fp32 size:", os.path.getsize(SRC))
print("fp16 size:", os.path.getsize(DST))

import onnxruntime as ort
s32 = ort.InferenceSession(SRC, providers=["CPUExecutionProvider"])
s16 = ort.InferenceSession(DST, providers=["CPUExecutionProvider"])
rng = np.random.default_rng(1234)
x = rng.random((1, 3, 256, 256), dtype=np.float32)
y32 = s32.run(None, {"input": x})[0]
y16 = s16.run(None, {"input": x})[0]
d = np.abs(y32 - y16)
print(f"fp16 vs fp32 max abs diff: {d.max():.3e}  mean abs diff: {d.mean():.3e}")
# dynamic-dims sanity on fp16 too
x2 = rng.random((1, 3, 192, 320), dtype=np.float32)
print("fp16 192x320 out shape:", s16.run(None, {"input": x2})[0].shape)
print("DONE")

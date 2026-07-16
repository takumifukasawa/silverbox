#!/usr/bin/env node
/**
 * Generator for scripts/fixtures/denoise-identity.onnx (denoise v2 stage 1's
 * verify fixture — scripts/verify-denoise.mjs): a hand-rolled ONNX protobuf,
 * NOT produced via Python/onnx (no such dependency in this repo, and the
 * brief explicitly wants no network/heavy toolchain in CI) — the same
 * "hand-roll the exact bytes, no library" precedent as
 * scripts/fixtures/external-transform.mjs's writeMinimalUint16Tiff.
 *
 * The model: a single 1×1 Conv, weight = identity 3×3 (so each output
 * channel equals its matching input channel, i.e. no cross-channel mixing)
 * plus a per-channel bias of DENOISE_FIXTURE_OFFSET — so the WHOLE model
 * computes `output = input + DENOISE_FIXTURE_OFFSET` elementwise, in NCHW,
 * dynamic H/W (`dim_param`, matching the real NAFNet export's dynamic-axes
 * shape — see docs/research/nafnet-spike/spike-report.md). A 1×1 kernel has
 * no spatial receptive field (same as the real per-pixel constant-offset
 * intent, see externalTransform.mjs's own "+offset" fixture), which is
 * exactly what makes the known-transform assertion in verify-denoise.mjs
 * possible (`encodedOut = encodedIn + OFFSET` everywhere, tile-seam-blind by
 * construction) while still being a genuine Conv node (the brief's own
 * suggested minimal fixture shape), not just an Add.
 *
 * Written directly against the wire format of onnx.proto3 (the upstream
 * schema's field numbers are a stable public contract — see
 * https://github.com/onnx/onnx/blob/main/onnx/onnx.proto): each message
 * below hand-encodes only the fields this fixture actually needs. Repeated
 * SCALAR fields (TensorProto.dims/float_data, AttributeProto.ints) are
 * emitted as repeated UNPACKED entries (one tag+value per element) rather
 * than proto3's packed default — the protobuf wire spec guarantees every
 * conformant parser (including the C++ impl onnxruntime links) accepts
 * unpacked repeated scalars for backward compatibility, so this is legal
 * wire format, just not the most compact one; simplicity here matters more
 * than a few dozen bytes.
 *
 * Verified (manually, once, not part of this script) against the spike's
 * own Python venv: `onnx.checker.check_model` passes and
 * `onnxruntime.InferenceSession(...).run(...)` on a random [1,3,48,64] input
 * reproduces `input + OFFSET` to float32 precision.
 *
 * Usage: node scripts/fixtures/generate-denoise-fixture.mjs [outPath]
 *   outPath defaults to scripts/fixtures/denoise-identity.onnx (the file
 *   actually checked into the repo — regenerate it with this script if the
 *   fixture's shape/offset ever needs to change, rather than hand-editing
 *   the binary).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Per-channel bias the fixture model adds — see this file's doc comment. Exported so verify-denoise.mjs can assert the exact expected transform without duplicating the literal. */
export const DENOISE_FIXTURE_OFFSET = 0.08;

// --- Minimal hand-rolled protobuf writer (varint + length-delimited only —
// this fixture needs nothing else: no zigzag/signed varints, no fixed64). ---

function varint(n) {
  const bytes = [];
  let v = n >>> 0 === n && n >= 0 ? n : n; // n is always a small non-negative integer here
  if (v === 0) return Buffer.from([0]);
  while (v > 0) {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** wire type 0 (varint) field: tag + value. */
function fVarint(fieldNo, value) {
  return Buffer.concat([varint((fieldNo << 3) | 0), varint(value)]);
}

/** wire type 5 (fixed32 / IEEE-754 float) field. */
function fFloat(fieldNo, value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(value, 0);
  return Buffer.concat([varint((fieldNo << 3) | 5), buf]);
}

/** wire type 2 (length-delimited: string/bytes/embedded message) field. */
function fBytes(fieldNo, buf) {
  return Buffer.concat([varint((fieldNo << 3) | 2), varint(buf.length), buf]);
}

function fString(fieldNo, str) {
  return fBytes(fieldNo, Buffer.from(str, 'utf8'));
}

function concatAll(bufs) {
  return Buffer.concat(bufs);
}

// --- onnx.proto3 message builders (only the fields this fixture uses) ------

/** TensorShapeProto.Dimension: dim_param (field 2, string) — every axis here is dynamic (matches the real model's dynamic_axes export). */
function dimParam(name) {
  return fString(2, name);
}
/** TensorShapeProto.Dimension: dim_value (field 1, int64) — fixed axis (N=1, C=3). */
function dimValue(n) {
  return fVarint(1, n);
}
/** TensorShapeProto: repeated Dimension (field 1). */
function tensorShape(dims) {
  return concatAll(dims.map((d) => fBytes(1, d)));
}
/** TypeProto.Tensor: elem_type (field 1, int32 — TensorProto.DataType; 1 = FLOAT), shape (field 2). */
function typeProtoTensor(elemType, shape) {
  return concatAll([fVarint(1, elemType), fBytes(2, shape)]);
}
/** TypeProto: tensor_type (field 1, oneof). */
function typeProto(tensorType) {
  return fBytes(1, tensorType);
}
/** ValueInfoProto: name (1), type (2). */
function valueInfo(name, type) {
  return concatAll([fString(1, name), fBytes(2, type)]);
}

const FLOAT = 1; // TensorProto.DataType.FLOAT

/** ValueInfoProto for a [1,3,H,W] float tensor with dynamic H/W dim_params. */
function nchwValueInfo(name, hParam, wParam) {
  const shape = tensorShape([dimValue(1), dimValue(3), dimParam(hParam), dimParam(wParam)]);
  return valueInfo(name, typeProto(typeProtoTensor(FLOAT, shape)));
}

/** TensorProto: dims (1, repeated int64), data_type (2), float_data (4, repeated float, unpacked), name (8). */
function tensorProto(name, dims, floats) {
  const parts = [];
  for (const d of dims) parts.push(fVarint(1, d));
  parts.push(fVarint(2, FLOAT));
  for (const f of floats) parts.push(fFloat(4, f));
  parts.push(fString(8, name));
  return concatAll(parts);
}

/** AttributeProto.AttributeType enum values actually used here. */
const ATTR_INT = 2;
const ATTR_INTS = 7;

/** AttributeProto: name (1), type (20), ints (8, repeated int64, unpacked) — NOT field 7 (that's `floats`); onnx.proto3's AttributeProto numbers name=1, f=2, i=3, s=4, t=5, g=6, floats=7, ints=8, strings=9, tensors=10, graphs=11, type=20. */
function attrInts(name, ints) {
  const parts = [fString(1, name), ...ints.map((v) => fVarint(8, v)), fVarint(20, ATTR_INTS)];
  return concatAll(parts);
}
/** AttributeProto: name (1), type (20), i (3, int64). */
function attrInt(name, value) {
  return concatAll([fString(1, name), fVarint(3, value), fVarint(20, ATTR_INT)]);
}

/** NodeProto: input (1, repeated string), output (2, repeated string), name (3), op_type (4), attribute (5, repeated AttributeProto). */
function nodeProto({ inputs, outputs, name, opType, attributes }) {
  const parts = [];
  for (const i of inputs) parts.push(fString(1, i));
  for (const o of outputs) parts.push(fString(2, o));
  parts.push(fString(3, name));
  parts.push(fString(4, opType));
  for (const a of attributes) parts.push(fBytes(5, a));
  return concatAll(parts);
}

/** GraphProto: node (1, repeated), name (2), initializer (5, repeated TensorProto), input (11, repeated ValueInfoProto), output (12, repeated ValueInfoProto). */
function graphProto({ nodes, name, initializers, inputs, outputs }) {
  const parts = [];
  for (const n of nodes) parts.push(fBytes(1, n));
  parts.push(fString(2, name));
  for (const t of initializers) parts.push(fBytes(5, t));
  for (const vi of inputs) parts.push(fBytes(11, vi));
  for (const vi of outputs) parts.push(fBytes(12, vi));
  return concatAll(parts);
}

/** OperatorSetIdProto: domain (1), version (2, int64). */
function opsetId(domain, version) {
  return concatAll([fString(1, domain), fVarint(2, version)]);
}

/** ModelProto: ir_version (1), producer_name (2), opset_import (8, repeated), graph (7). */
function modelProto({ irVersion, producerName, opsetImports, graph }) {
  const parts = [fVarint(1, irVersion), fString(2, producerName)];
  for (const o of opsetImports) parts.push(fBytes(8, o));
  parts.push(fBytes(7, graph));
  return concatAll(parts);
}

// --- Build the fixture: Conv(identity 3×3 weight, per-channel bias) --------

function buildFixtureOnnx(offset) {
  const weightIdentity = [
    1, 0, 0, // out-channel 0 reads only in-channel 0
    0, 1, 0, // out-channel 1 reads only in-channel 1
    0, 0, 1, // out-channel 2 reads only in-channel 2
  ];
  const weight = tensorProto('conv.weight', [3, 3, 1, 1], weightIdentity);
  const bias = tensorProto('conv.bias', [3], [offset, offset, offset]);

  const conv = nodeProto({
    inputs: ['input', 'conv.weight', 'conv.bias'],
    outputs: ['output'],
    name: 'identity_plus_offset',
    opType: 'Conv',
    attributes: [
      attrInts('kernel_shape', [1, 1]),
      attrInts('strides', [1, 1]),
      attrInts('pads', [0, 0, 0, 0]),
      attrInts('dilations', [1, 1]),
      attrInt('group', 1),
    ],
  });

  const graph = graphProto({
    nodes: [conv],
    name: 'denoise-fixture',
    initializers: [weight, bias],
    inputs: [nchwValueInfo('input', 'height', 'width')],
    outputs: [nchwValueInfo('output', 'height', 'width')],
  });

  const model = modelProto({
    irVersion: 8,
    producerName: 'silverbox-verify-fixture',
    opsetImports: [opsetId('', 13)],
    graph,
  });

  return model;
}

const outPath =
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'denoise-identity.onnx');
writeFileSync(outPath, buildFixtureOnnx(DENOISE_FIXTURE_OFFSET));
console.log(`wrote ${outPath} (${buildFixtureOnnx(DENOISE_FIXTURE_OFFSET).length} bytes)`);

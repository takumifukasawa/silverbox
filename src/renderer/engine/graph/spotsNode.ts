/**
 * Spot removal (task #50): a chain op (one image in, one image out) whose
 * params are a non-destructive LIST of manual clone circles — v1 is manual
 * source selection only (no auto-heal): the user drags from a blemish (dst)
 * to a clean source area (src).
 *
 * Coordinates mirror maskNode.ts's convention exactly (read its file doc
 * comment first): dx/dy/sx/sy are normalized 0..1 against the node's INPUT
 * FRAME, per-axis (dx against width, dy against height — same convention the
 * linear mask's x0/y0/x1/y1 use), so a later crop change can strand a spot —
 * same accepted tradeoff as masks. `radius` is normalized against
 * max(width, height), like the radial mask, so it stays a true circle on any
 * aspect ratio. `feather` defaults to 0.3 and is a per-spot field from day
 * one (no UI slider in v1 — the brief's call).
 *
 * Cap: 32 spots per node — SPOTS_WGSL packs a fixed-size `array<Spot, 32>`
 * into the pass's uniform. The interactive add path (appStore.ts's
 * commitSpot/setSpots) refuses adds past the cap with a toolbar notice
 * rather than silently dropping; sanitizeSpotsParams (sidecar load) instead
 * silently truncates to the first 32 — a hand-edited/foreign file with more
 * shouldn't lose the whole node, just the overflow.
 *
 * This is a SPATIAL op: for a given output pixel it reads a DIFFERENT pixel
 * of the same input texture (offset by src-dst), so — like Detail/fx-spatial
 * and custom WGSL nodes — it has NO CPU mirror. See graphDoc.ts's buildPlan
 * (cpu: null whenever any spot is present) and planHasCpuReference, which
 * flips to false automatically via that null (no extra wiring needed).
 */
import { nodePassWgsl } from './wgslCommon';

export const SPOTS_KIND = 'spots';

/** WGSL uniform sizing cap — see the file doc comment. */
export const SPOTS_CAP = 32;

/** Fixed per-spot feather (no UI slider in v1 — see the file doc comment). */
export const DEFAULT_SPOT_FEATHER = 0.3;

export interface Spot {
  /** Destination (blemish) center, normalized against (width, height) respectively. */
  dx: number;
  dy: number;
  /** Source (clean) center, same convention as dx/dy. */
  sx: number;
  sy: number;
  /** Normalized against max(width, height) — a true circle on any aspect ratio. */
  radius: number;
  /** 0..1 — feather band width as a fraction of radius (radial-mask falloff shape). */
  feather: number;
}

export interface SpotsParams {
  spots: Spot[];
}

export function defaultSpotsParams(): SpotsParams {
  return { spots: [] };
}

/** `spots: []` (or missing) ⇒ IDENTITY — buildPlan skips emitting the pass entirely (bit-exact pass-through). */
export function isIdentitySpots(p: SpotsParams): boolean {
  return p.spots.length === 0;
}

/**
 * Clamp an already-typed spot into valid ranges. dst/src centers pass
 * through UNCLAMPED (off-canvas placement is allowed, same as the linear
 * mask's endpoints — see maskNode.ts's clampMaskShape); only radius/feather
 * are range-clamped. Non-finite inputs fall back to sane defaults so a
 * dragged-off-screen NaN (e.g. a div-by-zero mid-gesture) can never wedge
 * the doc.
 */
export function clampSpot(s: Spot): Spot {
  const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
  return {
    dx: finite(s.dx, 0.5),
    dy: finite(s.dy, 0.5),
    sx: finite(s.sx, 0.5),
    sy: finite(s.sy, 0.5),
    radius: Math.min(4, Math.max(0.001, finite(s.radius, 0.05))),
    feather: Math.min(1, Math.max(0, finite(s.feather, DEFAULT_SPOT_FEATHER))),
  };
}

/** Build+clamp a fresh spot from raw numbers (appStore.ts's commitSpot convenience). */
export function makeSpot(dx: number, dy: number, sx: number, sy: number, radius: number): Spot {
  return clampSpot({ dx, dy, sx, sy, radius, feather: DEFAULT_SPOT_FEATHER });
}

/** Normalize an untrusted spot; throws on non-finite numbers (maskNode.ts's sanitizeMaskShape convention). */
function sanitizeSpot(raw: unknown, path: string): Spot {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path} must be an object`);
  const src = raw as Record<string, unknown>;
  const num = (v: unknown, fieldPath: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${fieldPath} must be a finite number`);
    return v;
  };
  return clampSpot({
    dx: num(src.dx, `${path}.dx`),
    dy: num(src.dy, `${path}.dy`),
    sx: num(src.sx, `${path}.sx`),
    sy: num(src.sy, `${path}.sy`),
    radius: num(src.radius, `${path}.radius`),
    feather: num(src.feather ?? DEFAULT_SPOT_FEATHER, `${path}.feather`),
  });
}

/**
 * Normalize an untrusted spots payload; missing/non-array `spots` ⇒ the
 * empty list (identity — accepts nodes with no `spots` field at all, same as
 * every other sanitizer in this codebase). A list longer than SPOTS_CAP is
 * silently truncated to the first 32 (see the file doc comment) rather than
 * thrown away or rejected wholesale.
 */
export function sanitizeSpotsParams(raw: unknown, nodeId: string): SpotsParams {
  if (typeof raw !== 'object' || raw === null) return defaultSpotsParams();
  const src = raw as { spots?: unknown };
  if (!Array.isArray(src.spots)) return defaultSpotsParams();
  return { spots: src.spots.slice(0, SPOTS_CAP).map((s, i) => sanitizeSpot(s, `${nodeId}.spots[${i}]`)) };
}

/**
 * Pack up to SPOTS_CAP spots into the uniform SPOTS_WGSL consumes: a leading
 * `count` (spot count as f32; the shader loop runs `i < count`) followed by
 * SPOTS_CAP fixed slots of 2 vec4f each — p0 = (dx, dy, sx, sy), p1 =
 * (radius, feather, 0, 0). Slots beyond `count` are left zeroed; the shader
 * never reads past `count` so their content never matters.
 */
export function packSpotsUniform(spots: Spot[]): Float32Array {
  const count = Math.min(spots.length, SPOTS_CAP);
  const f = new Float32Array(4 + SPOTS_CAP * 8);
  f[0] = count;
  for (let i = 0; i < count; i++) {
    const s = spots[i]!;
    const base = 4 + i * 8;
    f[base + 0] = s.dx;
    f[base + 1] = s.dy;
    f[base + 2] = s.sx;
    f[base + 3] = s.sy;
    f[base + 4] = s.radius;
    f[base + 5] = s.feather;
  }
  return f;
}

/**
 * Clone-circle pass (spatial — see the file doc comment). For each spot IN
 * LIST ORDER: dist(p, dst) determines a hard-center/soft-rim weight `t`
 * (e0 = radius*(1-feather), e1 = max(radius, e0+eps), t = 1 -
 * smoothstep(e0, e1, dist) — EXACTLY the radial mask's falloff shape/
 * direction, see maskNode.ts's MASK_WGSL), then `result = mix(result,
 * cloned, t)` — later spots layer on top of the running result. No explicit
 * "if inside radius" branch is needed: t is already 0 outside the radius, so
 * an out-of-range spot's mix is a no-op.
 *
 * `cloned` samples the INPUT texture (this pass's own `src` binding — the
 * SAME single texture for every spot and every output pixel, never the
 * in-progress `result`) at `p + (src - dst)`. Because every read is always
 * from that one unmodified input, "later spots apply on top" reduces exactly
 * to sequential `mix()` in list order (see the file doc comment) — no
 * separate bookkeeping needed.
 *
 * Source reads use textureLoad — this pass has no bound sampler, same as
 * every other node pass (see wgslCommon.ts's nodePassWgsl); the sample
 * position is CLAMPED to the texture bounds instead: sampling outside [0,1]
 * clamps (acceptable — the user placed the source; the black-cut rule
 * belongs only to the resample/geometry pass and does NOT apply here).
 */
export const SPOTS_WGSL = nodePassWgsl({
  uniformDecl: /* wgsl */ `
struct Spot {
  // dst/src centers, normalized 0..1 against (width, height) respectively
  p0: vec4f, // x=dx, y=dy, z=sx, w=sy
  p1: vec4f, // x=radius (normalized by max(width,height)), y=feather, zw unused
}
struct SpotsParams {
  count: vec4f, // x = spot count (as f32; truncated to i32 below), yzw unused
  spots: array<Spot, ${SPOTS_CAP}>,
}
@group(0) @binding(1) var<uniform> u: SpotsParams;
`,
  body: /* wgsl */ `
  {
    let dims = vec2f(textureDimensions(src));
    let maxDim = max(dims.x, dims.y);
    let count = i32(u.count.x);
    var result = c;
    for (var i = 0; i < count; i = i + 1) {
      let spot = u.spots[i];
      let dstPx = vec2f(spot.p0.x, spot.p0.y) * dims;
      let srcPx = vec2f(spot.p0.z, spot.p0.w) * dims;
      let radius = spot.p1.x * maxDim;
      let feather = spot.p1.y;
      let dist = length(in.pos.xy - dstPx);
      let e0 = radius * (1.0 - feather);
      let e1 = max(radius, e0 + 0.0001);
      let t = 1.0 - smoothstep(e0, e1, dist);
      let samplePos = vec2i(clamp(in.pos.xy + (srcPx - dstPx), vec2f(0.0), dims - vec2f(1.0)));
      let cloned = textureLoad(src, samplePos, 0).rgb;
      result = mix(result, cloned, t);
    }
    c = result;
  }
`,
});

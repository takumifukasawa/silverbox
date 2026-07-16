/**
 * Profile fitter (`npm run fit:profile`).
 *
 * Fits the residual color TRANSFORM that gives Silverbox Adobe-Color's
 * hue-dependent character (docs/brief-bank/profile-fit.md). After the base
 * curve, our default look matches LR's LUMINANCE within a couple of 1/255 but
 * NOT its per-hue chroma shaping (cleaner neutrals, boosted mids). No global
 * slider expresses that; a fitted per-camera residual lattice does.
 *
 * What is fitted: T : working-space linear Rec.2020 → working-space linear,
 * stored as a 17³ RESIDUAL lattice (delta = target − nodePos, so the identity
 * transform is all-zero and unseen colors extrapolate to IDENTITY, never a
 * lattice-edge clamp). Applied as develop.profile FIRST in the Develop chain,
 * amount 0..100 blending identity→T.
 *
 * Method (per docs/brief-bank/profile-fit.md):
 *   1. Render ours at the CURRENT default look (base curve + baseline EV;
 *      sharpen/NR OFF — spatial ops corrupt per-pixel pairing; lens OFF so the
 *      plan keeps a CPU reference AND we never introduce a geometry difference
 *      relative to whatever LR did). Read the developed working-linear buffer
 *      via the developedForFit debug hook. Decode the LR export the SAME way:
 *      open it (identity develop) and read its working-linear buffer — the
 *      JPEG loader already ingests sRGB → working space.
 *   2. ALIGN: both open at the same preview long edge / 3:2, so their
 *      nearest-downsampled buffers share dims; a size mismatch is bilinear-
 *      resized. Pair only the CENTER crop (distortion/vignette are ~0 there,
 *      robust to any LR lens-correction framing difference) and reject grid
 *      tiles whose local NCC is below threshold (motion / demosaic edges).
 *   3. Splat each accepted pair's residual (lr − ours) into the 17³ lattice by
 *      trilinear weights on ours' cell, count-weighted.
 *   4. Regularize: node delta = conf · (Σw·residual / Σw), conf =
 *      Σw/(Σw+λ) → low-support nodes decay toward identity; then weighted
 *      diffusion so sparse interior inherits neighbours while the hull stays 0.
 *   5. Emit the lattice + a fit report: per-cell support, held-out ΔE2000 mean
 *      / p95 BEFORE (no transform) vs AFTER, and per-hue support sectors.
 *
 * Usage:
 *   npm run fit:profile                         # round-3 default: 11 ref-green + 3 calibration pairs
 *   node scripts/fit-profile.mjs <arw> <lr.jpg> [<arw2> <lr2.jpg> ...]
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

process.env.SILVERBOX_TEST = '1'; // windowless / userData isolation
process.env.SILVERBOX_TEST_BASE_CURVE_DEFAULT = '1'; // seed the base curve on fresh ARW opens
// NB: lens auto-default is left OFF (no SILVERBOX_TEST_LENS_PROFILE_DEFAULT) so
// the plan keeps a CPU reference and we don't bake a geometry difference in.

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

// --- config ------------------------------------------------------------------
const LATTICE_N = 17; // grid nodes per axis
const MAX_DIM = 1024; // long-edge cap for the paired buffers
const CENTER_FRAC = 0.6; // inner box (of each axis) used for pairing
const NCC_TILES = 12; // NxN tile grid over the center box for the NCC gate
const NCC_MIN = 0.5; // reject tiles below this local NCC
const SUPPORT_LAMBDA = 40; // conf = Σw / (Σw + λ)
const DIFFUSION_ITERS = 24; // weighted Laplacian smoothing passes
const HELDOUT_FRAC = 0.2; // fraction of accepted pairs reserved for ΔE

// --- default calibration pairs ----------------------------------------------
// Round 3 (docs/brief-bank/lr-calibration-session.md, lightroom-reference
// memory): greens were support-starved in the round-1 lattice (near-zero
// pairs in the 60-180deg sectors) and stayed identity there. Adding the 11
// green-heavy ref-green pairs alongside the 3 original calibration pairs
// (same provenance rule as fit-base-curve.mjs's defaultPairs — LR imported
// with DEFAULT settings) gives the green sectors real support.
const DEFAULT_LR_CALIB_PAIRS = [
  ['test-assets/test.ARW', 'test-assets/lr-calib/DSC02993.jpg'],
  ['test-assets/italy/DSC07349.ARW', 'test-assets/lr-calib/DSC07349.jpg'],
  ['test-assets/italy/DSC03298.ARW', 'test-assets/lr-calib/DSC03298.jpg'],
];
function defaultPairs() {
  const greenDir = join(projectRoot, 'test-assets', 'ref-green');
  const bases = [...new Set(readdirSync(greenDir).filter((f) => f.endsWith('.ARW')).map((f) => f.replace(/\.ARW$/, '')))].sort();
  const greenPairs = bases.map((b) => [join('test-assets', 'ref-green', `${b}.ARW`), join('test-assets', 'ref-green', `${b}.jpg`)]);
  return [...greenPairs, ...DEFAULT_LR_CALIB_PAIRS];
}

function parsePairs() {
  const args = process.argv.slice(2);
  if (args.length === 0) return defaultPairs();
  if (args.length % 2 !== 0) throw new Error('pass pairs: <arw> <lr.jpg> [<arw2> <lr2.jpg> ...]');
  const pairs = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  return pairs;
}

// --- color math (mirrors engine constants) -----------------------------------
// working-linear Rec.2020 → sRGB-linear (workingSpace.WORK_TO_SRGB)
const WORK_TO_SRGB = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
];
const WORKING_LUMA = [0.2126, 0.7152, 0.0722];
// sRGB-linear → XYZ (D65)
const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const Xn = 0.95047;
const Yn = 1.0;
const Zn = 1.08883;

const mul3 = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

function workToLab(rgb) {
  const s = mul3(WORK_TO_SRGB, rgb);
  const xyz = mul3(SRGB_TO_XYZ, [Math.max(s[0], 0), Math.max(s[1], 0), Math.max(s[2], 0)]);
  const fx = labF(xyz[0] / Xn);
  const fy = labF(xyz[1] / Yn);
  const fz = labF(xyz[2] / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labF(t) {
  return t > 0.008856451679 ? Math.cbrt(t) : 7.787037037 * t + 16 / 116;
}

/** CIEDE2000 between two Lab triples. */
function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const avgLp = (L1 + L2) / 2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const avgC = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(avgC, 7) / (Math.pow(avgC, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const avgCp = (C1p + C2p) / 2;
  const h1p = hp(b1, a1p);
  const h2p = hp(b2, a2p);
  let deltahp;
  if (C1p * C2p === 0) deltahp = 0;
  else if (Math.abs(h2p - h1p) <= 180) deltahp = h2p - h1p;
  else if (h2p - h1p > 180) deltahp = h2p - h1p - 360;
  else deltahp = h2p - h1p + 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((deltahp * Math.PI) / 360);
  let avghp;
  if (C1p * C2p === 0) avghp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) avghp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) avghp = (h1p + h2p + 360) / 2;
  else avghp = (h1p + h2p - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos(rad(avghp - 30)) +
    0.24 * Math.cos(rad(2 * avghp)) +
    0.32 * Math.cos(rad(3 * avghp + 6)) -
    0.2 * Math.cos(rad(4 * avghp - 63));
  const Sl = 1 + (0.015 * Math.pow(avgLp - 50, 2)) / Math.sqrt(20 + Math.pow(avgLp - 50, 2));
  const Sc = 1 + 0.045 * avgCp;
  const Sh = 1 + 0.015 * avgCp * T;
  const dTheta = 30 * Math.exp(-Math.pow((avghp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(avgCp, 7) / (Math.pow(avgCp, 7) + Math.pow(25, 7)));
  const Rt = -Rc * Math.sin(rad(2 * dTheta));
  return Math.sqrt(
    Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh)
  );
}
const rad = (d) => (d * Math.PI) / 180;
function hp(b, ap) {
  if (b === 0 && ap === 0) return 0;
  let h = (Math.atan2(b, ap) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

// --- base curve (master rgb PCHIP over 0..255 in sRGB-encoded space) ---------
// The profile is applied FIRST, BEFORE the base curve, so the lattice is fit in
// the pre-base-curve domain: neutral = baseCurve⁻¹(ours_developed),
// target = baseCurve⁻¹(lr). baseCurve(x) mirrors toneCurve.ts exactly:
//   work → srgbEncode(clamp) → master PCHIP(·255)/255 → srgbDecode → work.
const srgbEnc = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const srgbDec = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

function pchipEval(points) {
  const n = points.length;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  }
  const m = new Array(n);
  if (n === 2) {
    m[0] = d[0];
    m[1] = d[0];
  } else {
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const y = h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1];
    return Math.min(255, Math.max(0, y));
  };
}

/** Build forward/inverse per-channel base-curve transforms from 0..255 points. */
function makeBaseCurve(points) {
  if (!points || points.length < 2) {
    const id = (v) => v;
    return { forward: id, inverse: id };
  }
  const master = pchipEval(points);
  // dense inverse table over the encoded 0..1 domain (master is monotone)
  const S = 4096;
  const invX = new Float64Array(S + 1);
  const invY = new Float64Array(S + 1);
  for (let i = 0; i <= S; i++) {
    const xEnc = i / S; // input encoded value
    invX[i] = master(xEnc * 255) / 255; // output encoded value
    invY[i] = xEnc;
  }
  const inverseEnc = (yEnc) => {
    if (yEnc <= invX[0]) return invY[0];
    if (yEnc >= invX[S]) return invY[S];
    // binary search on the monotone invX
    let lo = 0;
    let hi = S;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (invX[mid] <= yEnc) lo = mid;
      else hi = mid;
    }
    const t = (yEnc - invX[lo]) / (invX[hi] - invX[lo] || 1);
    return invY[lo] + t * (invY[hi] - invY[lo]);
  };
  const forwardCh = (w) => srgbDec(Math.min(1, Math.max(0, master(srgbEnc(Math.min(1, Math.max(0, w))) * 255) / 255)));
  const inverseCh = (w) => srgbDec(Math.min(1, Math.max(0, inverseEnc(srgbEnc(Math.min(1, Math.max(0, w)))))));
  return {
    forward: (rgb) => [forwardCh(rgb[0]), forwardCh(rgb[1]), forwardCh(rgb[2])],
    inverse: (rgb) => [inverseCh(rgb[0]), inverseCh(rgb[1]), inverseCh(rgb[2])],
  };
}

// --- lattice trilinear (residual delta; identity extrapolation) --------------
// Flat Float64Array of N*N*N*3 residual deltas, node (ix,iy,iz) channel c at
// ((ix*N+iy)*N+iz)*3+c. Node ix corresponds to working-linear coord ix/(N-1).
function latIdx(ix, iy, iz) {
  return ((ix * LATTICE_N + iy) * LATTICE_N + iz) * 3;
}

/** Trilinear residual at working-linear p; clamps the lookup to [0,1] (the
 *  regularized hull is ~0, so outside-gamut inputs read ~identity). */
function latEval(delta, p) {
  const out = [0, 0, 0];
  const g = [0, 0, 0];
  const i0 = [0, 0, 0];
  const f = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const c = Math.min(1, Math.max(0, p[k])) * (LATTICE_N - 1);
    i0[k] = Math.min(LATTICE_N - 2, Math.floor(c));
    f[k] = c - i0[k];
  }
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++) {
        const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
        const b = latIdx(i0[0] + dx, i0[1] + dy, i0[2] + dz);
        out[0] += w * delta[b];
        out[1] += w * delta[b + 1];
        out[2] += w * delta[b + 2];
      }
  void g;
  return out;
}

/** Apply T at `amount` (0..100): p + (amount/100)·residual(p). */
function applyProfile(delta, p, amount) {
  const r = latEval(delta, p);
  const a = amount / 100;
  return [p[0] + a * r[0], p[1] + a * r[1], p[2] + a * r[2]];
}

// --- image helpers -----------------------------------------------------------
function toEncodedLuma(rgb) {
  // working-linear → sRGB-linear → Rec.709 luma of the (clamped) linear signal
  const s = mul3(WORK_TO_SRGB, rgb);
  return WORKING_LUMA[0] * clamp01(s[0]) + WORKING_LUMA[1] * clamp01(s[1]) + WORKING_LUMA[2] * clamp01(s[2]);
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Bilinear-resize a {rgb,width,height} buffer to dims (dw,dh). */
function resizeTo(buf, dw, dh) {
  if (buf.width === dw && buf.height === dh) return buf;
  const { rgb, width, height } = buf;
  const out = new Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const sy = ((y + 0.5) * height) / dh - 0.5;
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(sy)));
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = ((x + 0.5) * width) / dw - 0.5;
      const x0 = Math.max(0, Math.min(width - 1, Math.floor(sx)));
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const o = (y * dw + x) * 3;
      for (let c = 0; c < 3; c++) {
        const a = rgb[(y0 * width + x0) * 3 + c] * (1 - fx) + rgb[(y0 * width + x1) * 3 + c] * fx;
        const b = rgb[(y1 * width + x0) * 3 + c] * (1 - fx) + rgb[(y1 * width + x1) * 3 + c] * fx;
        out[o + c] = a * (1 - fy) + b * fy;
      }
    }
  }
  return { rgb: out, width: dw, height: dh };
}

/** NCC of two equal-length arrays. */
function ncc(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den < 1e-9 ? 0 : num / den;
}

// --- build ------------------------------------------------------------------
if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

const pairs = parsePairs();

const app = await electron.launch({ args: [projectRoot] });
const acceptedPairs = []; // {ours:[r,g,b] developed, lr:[r,g,b] developed, hue}
let cameraModel = null;
let baseCurvePoints = null;
const perScene = [];

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  await page.waitForFunction(() => window.__debug?.imageState() != null, { timeout: 15_000 });

  const openDeveloped = async (path, { zeroDetail }) => {
    await page.evaluate((p) => window.__openImageByPath(p), path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    if (zeroDetail) {
      // zero the seeded default sharpen/NR so the plan keeps a CPU reference
      await page.evaluate(() => {
        const g = window.__debug.graphState();
        const dev = g.nodes.find((n) => n.kind === 'Develop');
        if (dev) {
          window.__debug.updateNodeParam(dev.id, 'detail.sharpen.amount', 0);
          window.__debug.updateNodeParam(dev.id, 'detail.noiseLuminance.amount', 0);
          window.__debug.updateNodeParam(dev.id, 'detail.noiseColor.amount', 0);
        }
      });
    }
    return page.evaluate((md) => window.__debug.developedForFit(md), MAX_DIM);
  };

  for (const [arw, lrjpg] of pairs) {
    console.log(`\n=== pair: ${arw.split('/').pop()} ↔ ${lrjpg.split('/').pop()} ===`);
    const ours = await openDeveloped(arw, { zeroDetail: true });
    if (!ours) throw new Error(`developedForFit returned null (no CPU reference) for ${arw}`);
    cameraModel = cameraModel ?? (await page.evaluate(() => window.__debug.captureInfo()?.cameraModel ?? null));
    // capture the seeded base curve (master rgb) once — the profile is applied
    // FIRST (before it), so we fit in the pre-base-curve domain by inverting it.
    if (!baseCurvePoints) {
      baseCurvePoints = await page.evaluate(() => {
        const dev = window.__debug.graphState().nodes.find((n) => n.kind === 'Develop');
        return dev?.develop?.toneCurve?.rgb ?? null;
      });
    }
    let lr = await openDeveloped(lrjpg, { zeroDetail: false });
    if (!lr) throw new Error(`developedForFit returned null for ${lrjpg}`);
    console.log(`  ours ${ours.width}×${ours.height}, lr ${lr.width}×${lr.height}`);
    lr = resizeTo(lr, ours.width, ours.height);

    // center crop box
    const W = ours.width;
    const H = ours.height;
    const cx0 = Math.floor((W * (1 - CENTER_FRAC)) / 2);
    const cy0 = Math.floor((H * (1 - CENTER_FRAC)) / 2);
    const cw = Math.floor(W * CENTER_FRAC);
    const ch = Math.floor(H * CENTER_FRAC);

    // NCC gate per tile
    const tileW = Math.floor(cw / NCC_TILES);
    const tileH = Math.floor(ch / NCC_TILES);
    let acceptedTiles = 0;
    let sceneAccepted = 0;
    for (let ty = 0; ty < NCC_TILES; ty++) {
      for (let tx = 0; tx < NCC_TILES; tx++) {
        const oxs = cx0 + tx * tileW;
        const oys = cy0 + ty * tileH;
        const la = [];
        const lb = [];
        for (let y = 0; y < tileH; y++)
          for (let x = 0; x < tileW; x++) {
            const gx = oxs + x;
            const gy = oys + y;
            const i = (gy * W + gx) * 3;
            la.push(toEncodedLuma([ours.rgb[i], ours.rgb[i + 1], ours.rgb[i + 2]]));
            lb.push(toEncodedLuma([lr.rgb[i], lr.rgb[i + 1], lr.rgb[i + 2]]));
          }
        if (ncc(la, lb) < NCC_MIN) continue;
        acceptedTiles++;
        for (let y = 0; y < tileH; y++)
          for (let x = 0; x < tileW; x++) {
            const gx = oxs + x;
            const gy = oys + y;
            const i = (gy * W + gx) * 3;
            const o = [ours.rgb[i], ours.rgb[i + 1], ours.rgb[i + 2]];
            const l = [lr.rgb[i], lr.rgb[i + 1], lr.rgb[i + 2]];
            // hue sector from the ours pixel (for coverage reporting)
            const s = mul3(WORK_TO_SRGB, o);
            const hue = hueOf(clamp01(s[0]), clamp01(s[1]), clamp01(s[2]));
            acceptedPairs.push({ ours: o, lr: l, hue });
            sceneAccepted++;
          }
      }
    }
    perScene.push({ scene: arw.split('/').pop(), acceptedTiles, tiles: NCC_TILES * NCC_TILES, pairs: sceneAccepted });
    console.log(`  NCC tiles accepted ${acceptedTiles}/${NCC_TILES * NCC_TILES}, pairs ${sceneAccepted}`);
  }
} finally {
  await app.close();
}

function hueOf(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return -1; // achromatic
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

if (acceptedPairs.length === 0) throw new Error('no accepted pairs — alignment/NCC rejected everything');

// --- move into the pre-base-curve (first-position) domain --------------------
// The profile applies FIRST (before the base curve), so the lattice maps the
// NEUTRAL decode → the target that, AFTER the base curve, lands on LR:
//   neutral = baseCurve⁻¹(ours_developed),  target = baseCurve⁻¹(lr).
const baseCurve = makeBaseCurve(baseCurvePoints);
console.log(`\nbase curve points: ${JSON.stringify(baseCurvePoints)}`);
// The profile carries Adobe Color's hue-dependent CHROMA character ONLY —
// luminance is the base curve's / exposure's job (profile-fit.md: "luminance
// matches LR ±2/255, but the HUE-DEPENDENT character remains"). So we make the
// residual LUMA-PRESERVING: scale the target so luma(target) == luma(neutral)
// (luma is linear in working space, so a scalar gain preserves it exactly while
// keeping hue/chroma ratios). This stops the fit from absorbing per-scene
// exposure mismatch between our base-curve default and LR into the profile.
// Working-space luma weights = WORK_TO_SRGBᵀ · WORKING_LUMA (≈ Rec.2020 luma,
// since the working space IS Rec.2020). Used to make the residual LUMA-NEUTRAL.
const WORK_LUMA_W = [0, 1, 2].map((j) => WORKING_LUMA[0] * WORK_TO_SRGB[0][j] + WORKING_LUMA[1] * WORK_TO_SRGB[1][j] + WORKING_LUMA[2] * WORK_TO_SRGB[2][j]);
const workLuma = (rgb) => WORK_LUMA_W[0] * rgb[0] + WORK_LUMA_W[1] * rgb[1] + WORK_LUMA_W[2] * rgb[2];
const oneLuma = WORK_LUMA_W[0] + WORK_LUMA_W[1] + WORK_LUMA_W[2];
// Remove the luma component of the residual by projecting out the gray axis
// [1,1,1] (an ADDITIVE offset — no chroma-magnitude distortion, unlike a
// multiplicative luma match). Result: luma(target') == luma(neutral), so the
// profile carries hue/chroma ONLY and the base curve/exposure owns luminance.
const lumaNeutralTarget = (target, neutral) => {
  const d = [target[0] - neutral[0], target[1] - neutral[1], target[2] - neutral[2]];
  const g = workLuma(d) / oneLuma;
  return [neutral[0] + d[0] - g, neutral[1] + d[1] - g, neutral[2] + d[2] - g];
};
for (const p of acceptedPairs) {
  p.neutral = baseCurve.inverse(p.ours);
  p.target = lumaNeutralTarget(baseCurve.inverse(p.lr), p.neutral);
}

/** Chroma-only ΔE (ΔEab = hypot(Δa*, Δb*)) — isolates hue/chroma from luma. */
function deltaEab(lab1, lab2) {
  return Math.hypot(lab1[1] - lab2[1], lab1[2] - lab2[2]);
}

// --- split held-out ---------------------------------------------------------
// deterministic shuffle (mulberry32)
let seed = 0x9e3779b9;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const idx = acceptedPairs.map((_, i) => i);
for (let i = idx.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [idx[i], idx[j]] = [idx[j], idx[i]];
}
const nHold = Math.floor(acceptedPairs.length * HELDOUT_FRAC);
const heldout = idx.slice(0, nHold).map((i) => acceptedPairs[i]);
const train = idx.slice(nHold).map((i) => acceptedPairs[i]);

// --- splat ------------------------------------------------------------------
const num = new Float64Array(LATTICE_N ** 3 * 3);
const den = new Float64Array(LATTICE_N ** 3);
for (const { neutral, target } of train) {
  const i0 = [0, 0, 0];
  const f = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const c = Math.min(1, Math.max(0, neutral[k])) * (LATTICE_N - 1);
    i0[k] = Math.min(LATTICE_N - 2, Math.floor(c));
    f[k] = c - i0[k];
  }
  const res = [target[0] - neutral[0], target[1] - neutral[1], target[2] - neutral[2]];
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++) {
        const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
        const nb = (i0[0] + dx) * LATTICE_N * LATTICE_N + (i0[1] + dy) * LATTICE_N + (i0[2] + dz);
        num[nb * 3] += w * res[0];
        num[nb * 3 + 1] += w * res[1];
        num[nb * 3 + 2] += w * res[2];
        den[nb] += w;
      }
}

// --- regularize: conf-weighted mean, then weighted diffusion ----------------
const delta = new Float64Array(LATTICE_N ** 3 * 3);
const conf = new Float64Array(LATTICE_N ** 3);
for (let n = 0; n < LATTICE_N ** 3; n++) {
  conf[n] = den[n] / (den[n] + SUPPORT_LAMBDA);
  if (den[n] > 0) {
    delta[n * 3] = conf[n] * (num[n * 3] / den[n]);
    delta[n * 3 + 1] = conf[n] * (num[n * 3 + 1] / den[n]);
    delta[n * 3 + 2] = conf[n] * (num[n * 3 + 2] / den[n]);
  }
}
// weighted Laplacian: each node relaxes toward the mean of its 6 neighbours,
// scaled by (1-conf) so high-support nodes hold and the hull (conf≈0) is pulled
// toward its neighbours — which themselves decay to 0 (identity) outward.
const at = (ix, iy, iz) => (ix * LATTICE_N + iy) * LATTICE_N + iz;
for (let it = 0; it < DIFFUSION_ITERS; it++) {
  const next = delta.slice();
  for (let ix = 0; ix < LATTICE_N; ix++)
    for (let iy = 0; iy < LATTICE_N; iy++)
      for (let iz = 0; iz < LATTICE_N; iz++) {
        const n = at(ix, iy, iz);
        const relax = 1 - conf[n];
        if (relax <= 0) continue;
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          let cnt = 0;
          if (ix > 0) (sum += delta[at(ix - 1, iy, iz) * 3 + c]), cnt++;
          if (ix < LATTICE_N - 1) (sum += delta[at(ix + 1, iy, iz) * 3 + c]), cnt++;
          if (iy > 0) (sum += delta[at(ix, iy - 1, iz) * 3 + c]), cnt++;
          if (iy < LATTICE_N - 1) (sum += delta[at(ix, iy + 1, iz) * 3 + c]), cnt++;
          if (iz > 0) (sum += delta[at(ix, iy, iz - 1) * 3 + c]), cnt++;
          if (iz < LATTICE_N - 1) (sum += delta[at(ix, iy, iz + 1) * 3 + c]), cnt++;
          const neigh = sum / cnt;
          next[n * 3 + c] = delta[n * 3 + c] + relax * 0.9 * (neigh - delta[n * 3 + c]);
        }
      }
  delta.set(next);
}

// --- held-out ΔE (END-TO-END: profile FIRST, then the base curve) -----------
// before = our current default (ours_developed) vs LR; after = the profile
// applied in the neutral domain, THEN the base curve, vs LR — exactly the
// shipped pipeline at `amount`.
function dEStats(pairsSet, amount) {
  const full = [];
  const chroma = [];
  for (const { ours, neutral, lr } of pairsSet) {
    const t = amount === 0 ? ours : baseCurve.forward(applyProfile(delta, neutral, amount));
    const labT = workToLab(t);
    const labL = workToLab(lr);
    full.push(deltaE2000(labT, labL));
    chroma.push(deltaEab(labT, labL));
  }
  full.sort((a, b) => a - b);
  const mean = full.reduce((s, v) => s + v, 0) / full.length;
  const p95 = full[Math.min(full.length - 1, Math.floor(full.length * 0.95))];
  const chromaMean = chroma.reduce((s, v) => s + v, 0) / chroma.length;
  return { mean, p95, chromaMean, n: full.length };
}

const before = dEStats(heldout, 0);
const after100 = dEStats(heldout, 100);
const after50 = dEStats(heldout, 50);
const trainBefore = dEStats(train, 0);
const trainAfter = dEStats(train, 100);

// GREEN hue region (60-180deg: yellow-green through green-cyan, sectors 2-5)
// — the round-1/2 lattice left this identity for lack of support; report it
// separately so the ref-green pairs' actual effect is visible.
const isGreen = (p) => p.hue >= 0 && p.hue >= 60 && p.hue < 180;
const heldoutGreen = heldout.filter(isGreen);
const beforeGreen = heldoutGreen.length ? dEStats(heldoutGreen, 0) : null;
const afterGreen = heldoutGreen.length ? dEStats(heldoutGreen, 100) : null;

// per-hue support (12 sectors of 30°) over the training set
const hueSectors = new Array(12).fill(0);
let achromatic = 0;
for (const { hue } of train) {
  if (hue < 0) achromatic++;
  else hueSectors[Math.floor(hue / 30) % 12]++;
}

// lattice occupancy
let occupied = 0;
for (let n = 0; n < LATTICE_N ** 3; n++) if (den[n] > 0) occupied++;

const report = {
  fittedAt: new Date().toISOString(),
  cameraModel,
  latticeN: LATTICE_N,
  pairs: pairs.map((p) => ({ arw: p[0], lr: p[1] })),
  perScene,
  totalPairs: acceptedPairs.length,
  train: train.length,
  heldout: heldout.length,
  latticeOccupancy: { occupied, total: LATTICE_N ** 3 },
  heldoutDeltaE: {
    before: { mean: +before.mean.toFixed(3), p95: +before.p95.toFixed(3) },
    after100: { mean: +after100.mean.toFixed(3), p95: +after100.p95.toFixed(3) },
    after50: { mean: +after50.mean.toFixed(3), p95: +after50.p95.toFixed(3) },
  },
  trainDeltaE: {
    before: { mean: +trainBefore.mean.toFixed(3), p95: +trainBefore.p95.toFixed(3) },
    after100: { mean: +trainAfter.mean.toFixed(3), p95: +trainAfter.p95.toFixed(3) },
  },
  greenRegion: {
    n: heldoutGreen.length,
    heldoutChromaDEab: beforeGreen
      ? { before: +beforeGreen.chromaMean.toFixed(3), after100: +afterGreen.chromaMean.toFixed(3) }
      : null,
    heldoutDeltaE2000: beforeGreen
      ? {
          before: { mean: +beforeGreen.mean.toFixed(3), p95: +beforeGreen.p95.toFixed(3) },
          after100: { mean: +afterGreen.mean.toFixed(3), p95: +afterGreen.p95.toFixed(3) },
        }
      : null,
  },
  hueSupport: { sectors30deg: hueSectors, achromatic },
};

console.log('\n===== FIT REPORT =====');
console.log(JSON.stringify(report, null, 2));
console.log(
  `\nheld-out ΔE2000 mean: ${before.mean.toFixed(2)} → ${after100.mean.toFixed(2)} (amount 100), ${after50.mean.toFixed(2)} (amount 50)`
);
console.log(`held-out ΔE2000 p95:  ${before.p95.toFixed(2)} → ${after100.p95.toFixed(2)} (amount 100)`);
console.log(
  `held-out CHROMA ΔEab mean: ${before.chromaMean.toFixed(2)} → ${after100.chromaMean.toFixed(2)} (amount 100) — the profile's actual job (luma is the base curve's)`
);
if (beforeGreen) {
  console.log(
    `held-out GREEN-region (n=${heldoutGreen.length}) CHROMA ΔEab mean: ${beforeGreen.chromaMean.toFixed(2)} → ${afterGreen.chromaMean.toFixed(2)} (amount 100)`
  );
  console.log(
    `held-out GREEN-region ΔE2000 mean: ${beforeGreen.mean.toFixed(2)} → ${afterGreen.mean.toFixed(2)}, p95: ${beforeGreen.p95.toFixed(2)} → ${afterGreen.p95.toFixed(2)}`
  );
} else {
  console.log('held-out GREEN-region: no held-out pairs in the 60-180deg sector');
}

// --- emit lattice ------------------------------------------------------------
// round to a compact fixed precision; store as a flat residual array
const flat = Array.from(delta, (v) => +v.toFixed(6));
const out = {
  fittedAt: report.fittedAt,
  cameraModel,
  latticeN: LATTICE_N,
  report: report.heldoutDeltaE,
  hueSupport: report.hueSupport,
  residual: flat,
};
const outPath = join(projectRoot, 'scripts', 'profile-fit.json');
writeFileSync(outPath, JSON.stringify(out) + '\n');
console.log(`\nwrote ${outPath}`);

/**
 * Base-curve fitter (`npm run fit:basecurve`).
 *
 * A neutral scene-referred RAW decode carries no display intent, so a fresh
 * ARW open renders darker than the camera's own JPEG. Lightroom ships a
 * 2-stage default look: a linear baseline exposure + a display tone curve.
 * We already have the baseline exposure (settings.baselineExposureEV); this
 * script fits the SECOND stage — a DEFAULT TONE CURVE — from an ARW and its
 * in-camera JPEG, so a fresh open lands near the camera JPEG's tonality while
 * staying transparent/editable (the fitted points seed the Develop node's
 * toneCurve.rgb exactly as if a user had placed them).
 *
 * Method (percentile matching — no pixel alignment; the ARW preview and the
 * JPEG have different dimensions):
 *   1. Open the ARW neutral at the CURRENT default baselineExposureEV.
 *   2. Sample the decoded linear buffer (imageForVerify) through the EXIT
 *      transform (WORK_TO_SRGB → sRGB encode), the same math CanvasView's
 *      cpuReferenceMean and verify-cst use — giving our display-encoded luma.
 *   3. Same for the camera JPEG (or LR export — whatever reference the curve
 *      should match).
 *   4. For dense quantiles q (dropping the clipped top/bottom 0.5%), pair
 *      x_q = our encoded luma at q with y_q = the reference's encoded luma at
 *      q. This is the target transfer x→y in the tone editor's 0..255 point
 *      space, PER SCENE.
 *   5. MULTI-SCENE (round 3): with more than one pair, a fixed set of
 *      quantiles (CTRL_Q) is evaluated independently in EVERY scene, then the
 *      x and y at each CTRL_Q index are averaged ACROSS SCENES (one x,y pair
 *      per scene per index — equal weight per scene, regardless of a scene's
 *      pixel count or how many scenes are big/bright/dark, so one large or
 *      extreme scene can't dominate the fit). Interior control points sit at
 *      these per-index scene-averaged (x,y) pairs; pin (0,0)+(255,255),
 *      enforce monotonicity, and measure the RMS with which the existing
 *      PCHIP evaluator (engine/color/toneCurve.ts) reproduces each scene's
 *      dense transfer (reported per scene AND pooled).
 *   6. SUBJECT-AREA WEIGHTING (round 4): round 3's CTRL_Q quantiles (step 5)
 *      were computed over the WHOLE-FRAME luma population, unweighted — every
 *      pixel votes equally regardless of where it sits in the frame or the
 *      tonal range. That won the whole-frame p50 metric (9.3→2.95/255) but
 *      the user's eye REJECTED it: it lost on subject crops (a flat sky, an
 *      out-of-focus background, or a shadowed doorway can easily outnumber
 *      the pixels that make up the actual subject, so the fit drifts toward
 *      what fills the frame rather than what a viewer looks at). Round 4
 *      keeps step 5's per-scene-equal-weight AVERAGING unchanged, but
 *      replaces each scene's CTRL_Q quantile with a WEIGHTED quantile (see
 *      `sampleWeight` below) before averaging — a simple, explainable
 *      saliency proxy, not a learned model:
 *        - CENTER weight: gaussian falloff from the frame center (subjects
 *          are typically framed centrally; corners/edges are disproportionately
 *          sky/background/vignette).
 *        - MIDTONE weight: gaussian centered at encoded luma 128/255 (a
 *          proxy for "subject tonal range" — faces/skin/primary subjects
 *          usually sit mid-range; blown skies and crushed shadows, which
 *          round 3 over-fit to, sit at the extremes).
 *      A floor keeps every sample contributing SOME weight (extremes still
 *      inform the pinned 0/255 endpoints and the reported RMS/bands, which
 *      stay UNWEIGHTED — see BAND_Q below). Reported alongside the existing
 *      whole-frame percentile bands: a per-scene SUBJECT-CROP ΔL* (CIE L*)
 *      table, reusing the exact crop centers the user visually judged in the
 *      round-3 comparison page (scratchpad round3curve-render-crops-v4.mjs's
 *      PHOTOS table — see SUBJECT_CROPS below) — so the two rounds' verdicts
 *      are comparable on the same regions.
 *
 * Output: the fitted points + per-scene RMS/percentile-band/subject-crop
 * report printed as JSON, and written to scripts/base-curve.fit.json (a
 * fixture for reference / diffing).
 *
 * Usage:
 *   npm run fit:basecurve                       # round-4 default (14 scenes, joint, subject-weighted)
 *   node scripts/fit-base-curve.mjs <arw> <jpg>
 *   node scripts/fit-base-curve.mjs <arw1> <jpg1> <arw2> <jpg2> ...   # custom joint set
 *
 * ROUND 4 NOTE on lens correction: unlike fit-profile.mjs (which pixel-pairs
 * a full develop-graph render against the LR export and so directly benefits
 * from turning the embedded lens profile ON now that the geometry fixes have
 * landed — accee3f's decode-crop fix + f9616e2's distortion-constant fix),
 * this script's sampling (imageForVerify) reads the DECODED buffer BEFORE the
 * develop graph runs — lens distortion/CA/vignette correction is a GPU
 * resample pass applied LATER, inside the graph (graphRenderer.ts), so it has
 * no effect on the population this script measures either way. No fixture
 * change was needed here for that reason; this script's round-4 improvement
 * comes automatically from accee3f's decode-crop fix (correct decode framing,
 * no script change required) plus the subject weighting above.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

process.env.SILVERBOX_TEST = '1'; // windowless; also suppresses the base-curve default so we sample the NEUTRAL decode

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Round-3 default pair set: every ref-green ARW+JPG pair (11, green-heavy
 * scenes — the previous fit/lattice had almost no green support) plus the 3
 * documented LR-Classic-default-export calibration pairs from rounds 1-2
 * (docs/brief-bank/lr-calibration-session.md "Preparation" — DSC02993 test
 * ARW, DSC07349 Italy sunset, DSC03298 Italy architecture; all confirmed
 * "user imports into LR with DEFAULT settings, Adobe Color"). A 4th lr-calib
 * scene, DSC09305, has a plain LR export too, but its provenance in the docs
 * is as an EFFECTS-calibration scene (dehaze/clarity/texture/sharpen sweeps,
 * "09305 was the trusted scene" for CLARITY, per the lightroom-reference
 * memory) — not documented as a plain Adobe-Color-defaults capture for base
 * curve / profile fitting, so it is deliberately left out here.
 */
function defaultPairs() {
  const greenDir = join(projectRoot, 'test-assets', 'ref-green');
  const bases = [...new Set(readdirSync(greenDir).filter((f) => f.endsWith('.ARW')).map((f) => f.replace(/\.ARW$/, '')))].sort();
  const greenPairs = bases.map((b) => [join('test-assets', 'ref-green', `${b}.ARW`), join('test-assets', 'ref-green', `${b}.jpg`)]);
  const lrCalibPairs = [
    ['test-assets/test.ARW', 'test-assets/lr-calib/DSC02993.jpg'],
    ['test-assets/italy/DSC07349.ARW', 'test-assets/lr-calib/DSC07349.jpg'],
    ['test-assets/italy/DSC03298.ARW', 'test-assets/lr-calib/DSC03298.jpg'],
  ];
  return [...greenPairs, ...lrCalibPairs];
}

function parsePairs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const arw = process.env.SILVERBOX_TEST_ARW;
    const jpg = process.env.SILVERBOX_TEST_JPG;
    if (arw && jpg) return [[arw, jpg]];
    return defaultPairs();
  }
  if (args.length % 2 !== 0) throw new Error('pass pairs: <arw> <jpg> [<arw2> <jpg2> ...]');
  const pairs = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  return pairs;
}
const PAIRS = parsePairs();

// --- exit transform + luma (mirrors workingSpace.ts / srgb.ts EXACTLY) -------
const WORK_TO_SRGB = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
];
const WORKING_LUMA = [0.2126, 0.7152, 0.0722];
const srgbEncode = (v) => {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
};
/** decoded linear Rec.2020 pixel → display-encoded luma in 0..255. */
function encodedLuma255(r, g, b) {
  const sr = WORK_TO_SRGB[0][0] * r + WORK_TO_SRGB[0][1] * g + WORK_TO_SRGB[0][2] * b;
  const sg = WORK_TO_SRGB[1][0] * r + WORK_TO_SRGB[1][1] * g + WORK_TO_SRGB[1][2] * b;
  const sb = WORK_TO_SRGB[2][0] * r + WORK_TO_SRGB[2][1] * g + WORK_TO_SRGB[2][2] * b;
  const e = WORKING_LUMA[0] * srgbEncode(sr) + WORKING_LUMA[1] * srgbEncode(sg) + WORKING_LUMA[2] * srgbEncode(sb);
  return e * 255;
}
const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

// --- Lab (for the subject-crop ΔL* metric) — sRGB-linear → XYZ (D65), same
// constants fit-profile.mjs uses for its held-out ΔE2000 report. -------------
const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const Yn = 1.0;
const labF = (t) => (t > 0.008856451679 ? Math.cbrt(t) : 7.787037037 * t + 16 / 116);
/** decoded linear Rec.2020 pixel, AFTER applying `curveFn` (0..255 in, 0..255
 *  out, identically per channel — a master RGB tone curve) → CIE L*. */
function lStarAfterCurve(r, g, b, curveFn) {
  const sr = WORK_TO_SRGB[0][0] * r + WORK_TO_SRGB[0][1] * g + WORK_TO_SRGB[0][2] * b;
  const sg = WORK_TO_SRGB[1][0] * r + WORK_TO_SRGB[1][1] * g + WORK_TO_SRGB[1][2] * b;
  const sb = WORK_TO_SRGB[2][0] * r + WORK_TO_SRGB[2][1] * g + WORK_TO_SRGB[2][2] * b;
  const encR = srgbEncode(Math.min(1, Math.max(0, sr))) * 255;
  const encG = srgbEncode(Math.min(1, Math.max(0, sg))) * 255;
  const encB = srgbEncode(Math.min(1, Math.max(0, sb))) * 255;
  const outR = srgbDecode(Math.min(255, Math.max(0, curveFn(encR))) / 255);
  const outG = srgbDecode(Math.min(255, Math.max(0, curveFn(encG))) / 255);
  const outB = srgbDecode(Math.min(255, Math.max(0, curveFn(encB))) / 255);
  const y = SRGB_TO_XYZ[1][0] * outR + SRGB_TO_XYZ[1][1] * outG + SRGB_TO_XYZ[1][2] * outB;
  return 116 * labF(y / Yn) - 16;
}

// --- SUBJECT-AREA saliency proxy (round 4) ----------------------------------
// See the file header's "SUBJECT-AREA WEIGHTING" note. Both factors are
// gaussians in [0,1]-normalized coordinates/luma; a floor keeps every sample
// contributing SOME weight so extremes still inform the pinned endpoints.
const CENTER_SIGMA = 0.35; // of the normalized (-0.5..0.5) frame half-extent
const MIDTONE_CENTER = 128; // encoded 0..255
const MIDTONE_SIGMA = 55;
const WEIGHT_FLOOR = 0.15;
function sampleWeight(x, y, width, height, lum) {
  const dx = x / width - 0.5;
  const dy = y / height - 0.5;
  const centerW = Math.exp(-(dx * dx + dy * dy) / (2 * CENTER_SIGMA * CENTER_SIGMA));
  const dl = lum - MIDTONE_CENTER;
  const midW = Math.exp(-(dl * dl) / (2 * MIDTONE_SIGMA * MIDTONE_SIGMA));
  return WEIGHT_FLOOR + (1 - WEIGHT_FLOOR) * centerW * midW;
}

// The exact 5 crop centers the user visually judged in the round-3 comparison
// page (scratchpad round3curve-render-crops-v4.mjs's PHOTOS table) — fractions
// of that scene's OWN (width, height), copied verbatim so this round's
// subject-crop numbers are comparable to what was judged then. CROP_HALF_FRAC
// approximates that page's fixed 560px-at-native-res window as a FRACTION of
// each scene's own dims (the visual page needed a literal pixel count for a
// consistent on-screen zoom level across a wipe-slider UI; this script only
// needs a stable MEAN L*, which a proportional window gives just as well).
const SUBJECT_CROPS = [
  { arw: 'test-assets/ref-green/DSC00174.ARW', jpg: 'test-assets/ref-green/DSC00174.jpg', cxFrac: 3270 / 7008, cyFrac: 1947 / 4672 },
  { arw: 'test-assets/ref-green/DSC00184.ARW', jpg: 'test-assets/ref-green/DSC00184.jpg', cxFrac: 3582 / 7008, cyFrac: 2025 / 4672 },
  { arw: 'test-assets/ref-green/DSC00139.ARW', jpg: 'test-assets/ref-green/DSC00139.jpg', cxFrac: 3115 / 4672, cyFrac: 4100 / 7008 },
  { arw: 'test-assets/italy/DSC03298.ARW', jpg: 'test-assets/lr-calib/DSC03298.jpg', cxFrac: 2570 / 4672, cyFrac: 4750 / 7008 },
  { arw: 'test-assets/test.ARW', jpg: 'test-assets/lr-calib/DSC02993.jpg', cxFrac: 2300 / 4608, cyFrac: 1536 / 3072 },
];
const CROP_HALF_FRAC = 0.04; // ± 4% of width/height (~8% window), per axis

// --- PCHIP evaluator (mirrors engine/color/toneCurve.ts curveEvaluator) ------
function curveEvaluator(points) {
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

/** q-quantile of a pre-sorted Float64Array (linear interpolation). */
function quantile(sorted, q) {
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Build a weighted distribution (values sorted ascending + normalized cumulative weight) for weightedQuantile(). */
function weightedDistribution(values, weights) {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const sortedVals = new Float64Array(n);
  const cum = new Float64Array(n);
  let acc = 0;
  for (let k = 0; k < n; k++) {
    sortedVals[k] = values[order[k]];
    acc += weights[order[k]];
    cum[k] = acc;
  }
  for (let k = 0; k < n; k++) cum[k] /= acc || 1;
  return { sortedVals, cum };
}

/** q-quantile (0..1) of a weightedDistribution() — linear interpolation, mirrors quantile()'s shape. */
function weightedQuantile(dist, q) {
  const { sortedVals, cum } = dist;
  const n = sortedVals.length;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < q) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return sortedVals[0];
  const c0 = cum[lo - 1];
  const c1 = cum[lo];
  const t = c1 > c0 ? (q - c0) / (c1 - c0) : 0;
  return sortedVals[lo - 1] + t * (sortedVals[lo] - sortedVals[lo - 1]);
}

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

// The shipped default baselineExposureEV (from shared/ipc.ts DEFAULT_SETTINGS)
// is the EV the base curve must be fitted at — a fresh install / every verify
// script gets it. Read it from source so this never drifts from the default,
// and pin it before the first decode so a stale persisted settings.json (a dev
// machine may hold a different value) can't skew the fit.
const ipcSrc = readFileSync(join(projectRoot, 'shared', 'ipc.ts'), 'utf8');
const evMatch = ipcSrc.match(/baselineExposureEV:\s*([\d.]+)/);
const DEFAULT_EV = evMatch ? Number(evMatch[1]) : 0.5;

// Old (pre-refit) shipped curve, for BEFORE/AFTER percentile-band reporting
// only — read straight from source so this never has to be hand-maintained.
const baseCurveSrc = readFileSync(join(projectRoot, 'src', 'renderer', 'engine', 'color', 'baseCurve.ts'), 'utf8');
const oldCurveMatch = baseCurveSrc.match(/A7C2_BASE_CURVE[^=]*=\s*(\[[\s\S]*?\]);/);
const OLD_POINTS = oldCurveMatch ? JSON.parse(oldCurveMatch[1].replace(/,(\s*[\]])/g, '$1')) : null;

const CTRL_Q = [0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
const BAND_Q = [0.1, 0.25, 0.5, 0.75, 0.9]; // report bands (round-1 style)

const app = await electron.launch({ args: [projectRoot] });
const scenes = []; // { pair, ours(sorted), jpg(sorted), ctrl: [{x,y}], dense: [{x,y}] }
let cameraModel = null;
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  await page.waitForFunction(() => window.__debug?.settingsState() != null, { timeout: 15_000 });
  await page.evaluate((ev) => window.__debug.updateSettings({ baselineExposureEV: ev }), DEFAULT_EV);

  const openAndSample = async (path) => {
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    // pull the decoded linear buffer out as a plain array (stride-capped).
    // `idx` parallels `rgb` (one entry per triple) with the ORIGINAL flat
    // pixel index, so the node side can recover (x, y) = (idx%width,
    // idx/width|0) for the subject-area weight (round 4) and the subject-crop
    // window filter, without paying to serialize the full raster.
    return page.evaluate(() => {
      const img = window.__debug.imageForVerify();
      if (!img) return null;
      const { data, width, height } = img;
      // cap the sample count for a fast sort; stride keeps a representative spread
      const target = 1_000_000;
      const total = width * height;
      const stride = Math.max(1, Math.floor(total / target));
      const out = [];
      const idx = [];
      for (let i = 0; i < total; i += stride) {
        out.push(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
        idx.push(i);
      }
      return { rgb: out, idx, width, height };
    });
  };

  /** Unweighted sorted luma distribution — whole-frame percentile reporting (BAND_Q/dense), unchanged from round 3. */
  const distribution = (sample) => {
    const { rgb } = sample;
    const lum = new Float64Array(rgb.length / 3);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j++) lum[j] = encodedLuma255(rgb[i], rgb[i + 1], rgb[i + 2]);
    lum.sort();
    return lum;
  };

  /** SUBJECT-AREA-weighted luma distribution (round 4) — feeds CTRL_Q only (see sampleWeight's doc comment). */
  const weightedLumaDistribution = (sample) => {
    const { rgb, idx, width, height } = sample;
    const n = rgb.length / 3;
    const lum = new Float64Array(n);
    const weight = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const l = encodedLuma255(rgb[j * 3], rgb[j * 3 + 1], rgb[j * 3 + 2]);
      lum[j] = l;
      const i = idx[j];
      weight[j] = sampleWeight(i % width, Math.floor(i / width), width, height, l);
    }
    return weightedDistribution(lum, weight);
  };

  /** RGB triples (working-linear) whose (x, y) falls inside the named subject crop window — for the ΔL* report. */
  const cropRgb = (sample, cxFrac, cyFrac) => {
    const { rgb, idx, width, height } = sample;
    const halfW = CROP_HALF_FRAC * width;
    const halfH = CROP_HALF_FRAC * height;
    const cx = cxFrac * width;
    const cy = cyFrac * height;
    const out = [];
    for (let j = 0; j < idx.length; j++) {
      const i = idx[j];
      const x = i % width;
      const y = Math.floor(i / width);
      if (Math.abs(x - cx) <= halfW && Math.abs(y - cy) <= halfH) out.push([rgb[j * 3], rgb[j * 3 + 1], rgb[j * 3 + 2]]);
    }
    return out;
  };

  for (const [arwPath, jpgPath] of PAIRS) {
    console.log(`\n=== scene: ${arwPath.split('/').pop()} ↔ ${jpgPath.split('/').pop()} ===`);
    const arwSample = await openAndSample(arwPath);
    cameraModel = cameraModel ?? (await page.evaluate(() => window.__debug.captureInfo()?.cameraModel ?? null));
    const jpgSample = await openAndSample(jpgPath);
    console.log(`  ARW preview ${arwSample.width}×${arwSample.height}, JPEG ${jpgSample.width}×${jpgSample.height}`);
    const ours = distribution(arwSample);
    const jpg = distribution(jpgSample);
    const oursW = weightedLumaDistribution(arwSample);
    const jpgW = weightedLumaDistribution(jpgSample);
    const dense = [];
    for (let q = 0.005; q <= 0.995 + 1e-9; q += 0.005) dense.push({ x: quantile(ours, q), y: quantile(jpg, q) });
    // CTRL_Q (the actual fit) uses the SUBJECT-weighted quantiles (round 4);
    // dense/bands (reporting only) stay unweighted, whole-frame.
    const ctrl = CTRL_Q.map((q) => ({ x: weightedQuantile(oursW, q), y: weightedQuantile(jpgW, q) }));
    const bands = BAND_Q.map((q) => ({ q, ours: quantile(ours, q), jpg: quantile(jpg, q) }));
    // subject-crop pixels, only for the 5 named scenes (SUBJECT_CROPS) —
    // kept as raw working-linear RGB triples so the OLD/NEW curve can each be
    // applied to them AFTER the fit (see the post-loop ΔL* report below).
    const subject = SUBJECT_CROPS.find((s) => s.arw === arwPath);
    const subjectCrop = subject ? { name: arwPath, ours: cropRgb(arwSample, subject.cxFrac, subject.cyFrac), jpg: cropRgb(jpgSample, subject.cxFrac, subject.cyFrac) } : null;
    scenes.push({ arw: arwPath, jpg: jpgPath, ours, jpg_: jpg, ctrl, dense, bands, subjectCrop });
  }
} finally {
  await app.close();
}

// --- MULTI-SCENE aggregation: average each CTRL_Q index's (x,y) ACROSS
// SCENES (one value per scene per index — equal per-scene weight, immune to
// scene pixel count / how many scenes happen to be bright or dark) ----------
const interior = CTRL_Q.map((_, i) => {
  const xs = scenes.map((s) => s.ctrl[i].x);
  const ys = scenes.map((s) => s.ctrl[i].y);
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  return [Math.round(meanX), Math.round(meanY)];
});
// assemble: pinned endpoints + interior, strictly increasing x, monotone y
const raw = [[0, 0], ...interior, [255, 255]];
const points = [];
for (const [x, y] of raw) {
  const px = Math.min(255, Math.max(0, x));
  const py = Math.min(255, Math.max(0, y));
  if (points.length > 0) {
    const prev = points[points.length - 1];
    if (px <= prev[0]) continue; // drop a non-increasing x (collapsed quantile)
    if (py < prev[1]) {
      points.push([px, prev[1]]); // clamp to keep the curve monotone
      continue;
    }
  }
  points.push([px, py]);
}

const newCurve = curveEvaluator(points);
const oldCurve = OLD_POINTS ? curveEvaluator(OLD_POINTS) : null;

// per-scene RMS (new curve vs this scene's own dense transfer) + before/after
// percentile bands (old curve vs new curve, both vs the reference's actual
// percentile — the "round-1 style bands").
let pooledSe = 0;
let pooledN = 0;
const perScene = scenes.map((s) => {
  let se = 0;
  for (const d of s.dense) {
    const e = newCurve(d.x) - d.y;
    se += e * e;
  }
  pooledSe += se;
  pooledN += s.dense.length;
  const rms = Math.sqrt(se / s.dense.length);
  const bands = s.bands.map((b) => {
    const beforeVal = oldCurve ? oldCurve(b.ours) : b.ours;
    const afterVal = newCurve(b.ours);
    return {
      q: b.q,
      jpgTarget: Number(b.jpg.toFixed(1)),
      before: oldCurve ? Number(beforeVal.toFixed(1)) : null,
      after: Number(afterVal.toFixed(1)),
      beforeDelta: oldCurve ? Number((beforeVal - b.jpg).toFixed(1)) : null,
      afterDelta: Number((afterVal - b.jpg).toFixed(1)),
    };
  });
  return {
    arw: s.arw,
    jpg: s.jpg,
    p50: { ours: Number(s.ours[Math.floor(s.ours.length / 2)].toFixed(1)), jpeg: Number(s.jpg_[Math.floor(s.jpg_.length / 2)].toFixed(1)) },
    rms: Number(rms.toFixed(3)),
    bands,
  };
});
const pooledRms = Math.sqrt(pooledSe / pooledN);

console.log('\n===== PER-SCENE BEFORE/AFTER (luma percentile bands, encoded 0..255) =====');
for (const s of perScene) {
  console.log(`\n${s.arw.split('/').pop()}  (p50 ours ${s.p50.ours} → jpeg ${s.p50.jpeg}, new-curve RMS ${s.rms})`);
  for (const b of s.bands) {
    console.log(
      `  q${b.q}: target ${b.jpgTarget}  before ${b.before ?? 'n/a'} (Δ${b.beforeDelta ?? 'n/a'})  after ${b.after} (Δ${b.afterDelta})`
    );
  }
}
console.log(`\npooled RMS across ${scenes.length} scene(s): ${pooledRms.toFixed(3)}`);

// --- SUBJECT-CROP ΔL* (round 4 ship gate) — the exact crop centers the user
// visually judged in round 3 (SUBJECT_CROPS); compares OLD curve vs NEW curve
// against the reference JPEG's own crop, both as mean CIE L* over the window.
const identityCurveFn = (v) => v;
const meanLStar = (rgbList, curveFn) => {
  if (rgbList.length === 0) return null;
  let sum = 0;
  for (const [r, g, b] of rgbList) sum += lStarAfterCurve(r, g, b, curveFn);
  return sum / rgbList.length;
};
const subjectCropReport = scenes
  .filter((s) => s.subjectCrop)
  .map((s) => {
    const { ours, jpg } = s.subjectCrop;
    const jpgL = meanLStar(jpg, identityCurveFn);
    const beforeL = oldCurve ? meanLStar(ours, oldCurve) : meanLStar(ours, identityCurveFn);
    const afterL = meanLStar(ours, newCurve);
    const beforeDelta = beforeL - jpgL;
    const afterDelta = afterL - jpgL;
    return {
      arw: s.arw,
      n: ours.length,
      jpgL: Number(jpgL.toFixed(2)),
      beforeL: Number(beforeL.toFixed(2)),
      afterL: Number(afterL.toFixed(2)),
      beforeDeltaL: Number(beforeDelta.toFixed(2)),
      afterDeltaL: Number(afterDelta.toFixed(2)),
      improved: Math.abs(afterDelta) <= Math.abs(beforeDelta),
    };
  });
const subjectCropImprovedCount = subjectCropReport.filter((r) => r.improved).length;

console.log('\n===== SUBJECT-CROP ΔL* (round-3 comparison-page crop centers, CIE L*) =====');
for (const r of subjectCropReport) {
  console.log(
    `${r.arw.split('/').pop()}  (n=${r.n})  jpg L*=${r.jpgL}  before ${r.beforeL} (ΔL* ${r.beforeDeltaL})  after ${r.afterL} (ΔL* ${r.afterDeltaL})  ${r.improved ? 'IMPROVED/HELD' : 'WORSE'}`
  );
}
console.log(`\nsubject-crop verdict: ${subjectCropImprovedCount}/${subjectCropReport.length} scenes improved or held ΔL*`);

const result = {
  fittedAt: new Date().toISOString(),
  baselineExposureEV: DEFAULT_EV,
  cameraModel,
  sceneCount: scenes.length,
  weighting: 'equal-per-scene (CTRL_Q quantile pairs averaged across scenes, SUBJECT-weighted per scene — round 4, see file header)',
  pooledRms: Number(pooledRms.toFixed(3)),
  points,
  perScene,
  subjectCropReport,
  subjectCropVerdict: `${subjectCropImprovedCount}/${subjectCropReport.length} scenes improved or held ΔL* vs the shipped curve`,
};

console.log('\nfitted base curve (points):');
console.log(JSON.stringify(points));
const outPath = join(projectRoot, 'scripts', 'base-curve.fit.json');
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
console.log(`\nwrote ${outPath}`);

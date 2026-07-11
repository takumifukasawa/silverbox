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
 *   3. Same for the camera JPEG.
 *   4. For dense quantiles q (dropping the clipped top/bottom 0.5%), pair
 *      x_q = our encoded luma at q with y_q = JPEG encoded luma at q. This is
 *      the target transfer x→y in the tone editor's 0..255 point space.
 *   5. Place interior control points AT percentile-matched pairs (so they lie
 *      exactly on the transfer), pin (0,0)+(255,255), enforce monotonicity,
 *      and measure the RMS with which the existing PCHIP evaluator
 *      (engine/color/toneCurve.ts) reproduces the dense transfer.
 *
 * Output: the fitted points + RMS printed as JSON, and written to
 * scripts/base-curve.fit.json (a fixture for reference / diffing).
 *
 * Usage:
 *   npm run fit:basecurve                       # default DSC02993 pair
 *   node scripts/fit-base-curve.mjs <arw> <jpg>
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

process.env.SILVERBOX_TEST = '1'; // windowless; also suppresses the base-curve default so we sample the NEUTRAL decode

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.argv[2] ?? process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.argv[3] ?? process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';

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

const app = await electron.launch({ args: [projectRoot] });
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
    // pull the decoded linear buffer out as a plain array (stride-capped)
    return page.evaluate(() => {
      const img = window.__debug.imageForVerify();
      if (!img) return null;
      const { data, width, height } = img;
      // cap the sample count for a fast sort; stride keeps a representative spread
      const target = 1_000_000;
      const total = width * height;
      const stride = Math.max(1, Math.floor(total / target));
      const out = [];
      for (let i = 0; i < total; i += stride) {
        out.push(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      }
      return { rgb: out, width, height };
    });
  };

  const distribution = (sample) => {
    const { rgb } = sample;
    const lum = new Float64Array(rgb.length / 3);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j++) lum[j] = encodedLuma255(rgb[i], rgb[i + 1], rgb[i + 2]);
    lum.sort();
    return lum;
  };

  const arwSample = await openAndSample(ARW_PATH);
  const cameraModel = await page.evaluate(() => window.__debug.captureInfo()?.cameraModel ?? null);
  const jpgSample = await openAndSample(JPG_PATH);
  console.log(`ARW preview ${arwSample.width}×${arwSample.height}, JPEG ${jpgSample.width}×${jpgSample.height}`);
  const ours = distribution(arwSample);
  const jpg = distribution(jpgSample);

  // dense transfer, dropping the clipped top/bottom 0.5%
  const dense = [];
  for (let q = 0.005; q <= 0.995 + 1e-9; q += 0.005) {
    dense.push({ q, x: quantile(ours, q), y: quantile(jpg, q) });
  }
  const p50x = quantile(ours, 0.5);
  const p50y = quantile(jpg, 0.5);
  console.log(`p50: ours ${p50x.toFixed(1)} → jpeg ${p50y.toFixed(1)} (Δ ${(p50y - p50x).toFixed(1)} / 255)`);

  // interior control points AT percentile-matched pairs (they lie on the transfer)
  const CTRL_Q = [0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
  const interior = CTRL_Q.map((q) => [Math.round(quantile(ours, q)), Math.round(quantile(jpg, q))]);
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

  // RMS of the PCHIP curve vs the dense transfer
  const evalCurve = curveEvaluator(points);
  let se = 0;
  for (const s of dense) {
    const d = evalCurve(s.x) - s.y;
    se += d * d;
  }
  const rms = Math.sqrt(se / dense.length);

  const result = {
    arw: ARW_PATH,
    jpg: JPG_PATH,
    fittedAt: new Date().toISOString(),
    baselineExposureEV: await page.evaluate(() => window.__debug.settingsState().baselineExposureEV),
    cameraModel,
    p50: { ours: Number(p50x.toFixed(2)), jpeg: Number(p50y.toFixed(2)) },
    rms: Number(rms.toFixed(3)),
    points,
  };

  console.log('\nfitted base curve:');
  console.log(JSON.stringify(result, null, 2));
  const outPath = join(projectRoot, 'scripts', 'base-curve.fit.json');
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`\nwrote ${outPath}`);
} finally {
  await app.close();
}

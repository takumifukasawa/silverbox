/**
 * Empirical determination of the Sony vignetting-knot scale DIVISOR (task #34,
 * step 4) — a scratch analysis, NOT a gated verify. The camera JPEG has
 * vignetting corrected; the neutral ARW render (profile distortion+CA on,
 * vignetting off) does not. In LINEAR light the per-radius ratio JPEG/ARW is
 * proportional to the vignette gain the camera applied; normalizing by the
 * center ratio cancels exposure/WB, leaving vig(rn) = 1 + f(rn)/D. We fit D.
 *
 * Ring-averaged over 8 angular directions per radius to beat down scene-content
 * variance (the two decodes are aligned by the distortion correction — NCC
 * ~0.67 in verify-lensprofile). Run: node scripts/analyze-vignette-divisor.mjs
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

process.env.SILVERBOX_TEST = '1';
process.env.SILVERBOX_TEST_LENS_PROFILE_DEFAULT = '1'; // ARW opens with distortion+CA on, vignette off

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

const srgbToLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const evalSpline = (knots, x) => {
  const n = knots.length;
  if (x <= 0) return knots[0];
  if (x >= n - 1) return knots[n - 1];
  const i = Math.floor(x);
  const f = x - i;
  return knots[i] * (1 - f) + knots[i + 1] * f;
};

const RADII = [0.0, 0.15, 0.3, 0.45, 0.6, 0.72, 0.84, 0.93];
const DIRS = 8;
const PATCH = 20;

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const open = async (p) => {
    await page.evaluate((path) => void window.__openImageByPath(path), p);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  };

  // Ring-averaged linear luma at each normalized radius rn (0..1 of the
  // half-diagonal), sampled at DIRS angles, PATCH×PATCH each.
  const radialLuma = async () => {
    const dims = await page.evaluate(() => window.__debug.outputDims());
    const cx = dims.width / 2;
    const cy = dims.height / 2;
    const corner = Math.hypot(cx, cy);
    const out = [];
    for (const rn of RADII) {
      let sum = 0;
      let count = 0;
      for (let d = 0; d < DIRS; d++) {
        const ang = (d / DIRS) * 2 * Math.PI;
        const px = cx + Math.cos(ang) * rn * corner;
        const py = cy + Math.sin(ang) * rn * corner;
        const x0 = Math.round(px - PATCH / 2);
        const y0 = Math.round(py - PATCH / 2);
        if (x0 < 0 || y0 < 0 || x0 + PATCH > dims.width || y0 + PATCH > dims.height) continue;
        const bytes = await page.evaluate(
          ([x, y, w, h]) => window.__debug.encodedCropForVerify(x, y, w, h),
          [x0, y0, PATCH, PATCH]
        );
        if (!bytes) continue;
        let l = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          l += 0.2126 * srgbToLinear(bytes[i]) + 0.7152 * srgbToLinear(bytes[i + 1]) + 0.0722 * srgbToLinear(bytes[i + 2]);
        }
        sum += l / (bytes.length / 4);
        count++;
      }
      out.push(count > 0 ? sum / count : NaN);
    }
    return out;
  };

  await open(ARW_PATH);
  const vignetteKnots = (await page.evaluate(() => window.__debug.lensProfileState())).vignette;
  const arw = await radialLuma();
  await open(JPG_PATH);
  const jpg = await radialLuma();

  // g_rel(rn) = (jpg/arw)(rn) / (jpg/arw)(0) ≈ 1 + f(rn)/D
  const ratio0 = jpg[0] / arw[0];
  const n = vignetteKnots.length;
  const samples = RADII.map((rn, i) => ({
    rn,
    gRel: jpg[i] / arw[i] / ratio0,
    f: evalSpline(vignetteKnots, (n - 1) * rn),
  })).filter((s) => Number.isFinite(s.gRel) && s.f > 0);

  // Least-squares D: minimize Σ((gRel-1) - f/D)² ⇒ 1/D = Σ(f·(gRel-1))/Σ(f²)
  let sfg = 0;
  let sff = 0;
  for (const s of samples) {
    sfg += s.f * (s.gRel - 1);
    sff += s.f * s.f;
  }
  const bestD = sff / sfg;
  const residual = (D) => {
    let e = 0;
    for (const s of samples) e += (s.gRel - 1 - s.f / D) ** 2;
    return Math.sqrt(e / samples.length);
  };

  console.log('\nvignetting divisor analysis');
  console.log('rn      f(rn)     g_rel(measured)   1+f/bestD');
  for (const s of samples) {
    console.log(
      `${s.rn.toFixed(2)}   ${String(s.f).padStart(6)}    ${s.gRel.toFixed(4)}           ${(1 + s.f / bestD).toFixed(4)}`
    );
  }
  console.log(`\nbest-fit D (continuous) = ${bestD.toFixed(1)}   residual RMS = ${residual(bestD).toFixed(4)}`);
  console.log('candidate powers of two:');
  for (let p = 11; p <= 16; p++) {
    const D = 2 ** p;
    console.log(`  2^${p} = ${D}\tresidual RMS = ${residual(D).toFixed(4)}`);
  }
} finally {
  await app.close();
}

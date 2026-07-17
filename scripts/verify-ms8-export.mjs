/**
 * Milestone 8 verify: full-resolution export. Opens the ARW, applies an
 * exposure edit, exports to JPEG and PNG, and checks each file on disk:
 * full 4580×3050 dimensions (round-11 decode-frame fix — see
 * librawDecoder.ts's computeCropbox doc comment) and channel means matching
 * the (identically edited) preview readback.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, rmLook } from './lib/testProject.mjs';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
ensureTestProjectEnv();
rmLook(ARW_PATH);
const OUT_JPG = join(projectRoot, 'test-artifacts', 'ms8-export.jpg');
const OUT_PNG = join(projectRoot, 'test-artifacts', 'ms8-export.png');
// JPEG quantization + preview-vs-full-res sampling differences
const MEAN_TOLERANCE = 0.02;

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

const meansMatch = (a, b, tol = MEAN_TOLERANCE) =>
  a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;

for (const p of [OUT_JPG, OUT_PNG]) if (existsSync(p)) unlinkSync(p);
mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.5));
  const previewMean = await page.evaluate(() => window.__debug.readbackMean());

  const exportAndWait = async (outPath) => {
    await page.evaluate((p) => window.__debug.exportImageTo(p), outPath);
    await page.waitForFunction(() => window.__debug.exportState().status !== 'working', { timeout: 300_000 });
    return page.evaluate(() => window.__debug.exportState());
  };

  // measure an exported file by decoding it inside the page
  const measureExport = (path) =>
    page.evaluate(async (p) => {
      const bytes = await window.silverbox.readFile(p);
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const { width, height } = bitmap;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const px = ctx.getImageData(0, 0, width, height).data;
      let r = 0;
      let g = 0;
      let b = 0;
      const n = width * height;
      for (let i = 0; i < n; i++) {
        r += px[i * 4];
        g += px[i * 4 + 1];
        b += px[i * 4 + 2];
      }
      return { width, height, mean: { r: r / n / 255, g: g / n / 255, b: b / n / 255 } };
    }, path);

  console.log('verify-ms8 (JPEG export):');
  const jpgState = await exportAndWait(OUT_JPG);
  check('export completes without error', jpgState.status === 'idle', jpgState);
  check('JPEG file exists and is >1MB', existsSync(OUT_JPG) && statSync(OUT_JPG).size > 1_000_000,
    existsSync(OUT_JPG) ? statSync(OUT_JPG).size : 'missing');
  const jpg = await measureExport(OUT_JPG);
  check('JPEG is full resolution 4580×3050', jpg.width === 4580 && jpg.height === 3050, {
    w: jpg.width,
    h: jpg.height,
  });
  check('JPEG means match the edited preview (within 0.02)', meansMatch(jpg.mean, previewMean), {
    exported: jpg.mean,
    previewMean,
  });
  const jpgBytes = readFileSync(OUT_JPG);
  check(
    'JPEG carries EXIF camera model and an ICC profile',
    jpgBytes.includes('ILCE-7CM2') && jpgBytes.includes('ICC_PROFILE'),
    { exif: jpgBytes.includes('ILCE-7CM2'), icc: jpgBytes.includes('ICC_PROFILE') }
  );

  console.log('verify-ms8 (PNG export):');
  const pngState = await exportAndWait(OUT_PNG);
  check('PNG export completes without error', pngState.status === 'idle', pngState);
  const png = await measureExport(OUT_PNG);
  check('PNG is full resolution 4580×3050', png.width === 4580 && png.height === 3050, {
    w: png.width,
    h: png.height,
  });
  check('PNG means match the edited preview (within 0.02)', meansMatch(png.mean, previewMean), {
    exported: png.mean,
    previewMean,
  });

  console.log(`exports: ${OUT_JPG}, ${OUT_PNG}`);
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

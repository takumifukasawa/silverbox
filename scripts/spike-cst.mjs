/**
 * SPIKE (throwaway): prove libraw-wasm can decode an ARW straight to LINEAR
 * Rec.2020, and quantify what the current linear-sRGB decode throws away.
 *
 * NOT registered in package.json. NOT part of the verify chain. Do not wire
 * this into the app — it is a standalone investigation script.
 *
 * Usage: node scripts/spike-cst.mjs
 * Env:   SILVERBOX_TEST_ARW=/path/to/file.ARW (optional override)
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const RAW_PATH =
  process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const ARTIFACT_DIR = join(projectRoot, 'test-artifacts');
const PORT = 8935;

// --- Rec.2020 (linear) -> sRGB (linear) matrix, as specified by the task ---
const M = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
];

await mkdir(ARTIFACT_DIR, { recursive: true });

// --- browser-side entry, plain ESM (no bundling needed: only imports 'libraw-wasm' which
// stays external and resolves via the importmap below, same pattern as verify-ms0-decode.mjs) ---
const entryJs = `
import LibRaw from 'libraw-wasm';

const M = ${JSON.stringify(M)};

function applyMatrix(r, g, b) {
  return [
    M[0][0] * r + M[0][1] * g + M[0][2] * b,
    M[1][0] * r + M[1][1] * g + M[1][2] * b,
    M[2][0] * r + M[2][1] * g + M[2][2] * b,
  ];
}

// simple x^(1/2.2) view transform for visualization only, identical for both PNGs
function toneMap8(v) {
  const c = Math.max(0, Math.min(1, v));
  return Math.round(Math.pow(c, 1 / 2.2) * 255);
}

async function decodeWith(outputColor) {
  const res = await fetch('/raw.arw');
  if (!res.ok) throw new Error('fetch raw.arw: ' + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const raw = new LibRaw();
  // noAutoBright is required for a fair sRGB-vs-Rec.2020 comparison: LibRaw's default
  // auto-bright scan computes its gain from a histogram of the *already color-converted*
  // output, so with it left on the two decodes pick independent scalars and end up at
  // different overall brightness even with otherwise-identical settings. This was
  // discovered empirically: leaving it on gave a non-OOG cross-check residual of ~4.3%
  // (mean abs diff, normalized 0..1); disabling it drops the residual to ~0.36%, an
  // order of magnitude smaller and consistent with pure matrix-precision noise.
  const settings = { useCameraWb: true, outputBps: 16, outputColor, gamm: [1, 1], noAutoBright: true };
  const t0 = performance.now();
  await raw.open(bytes, settings);
  const meta = await raw.metadata(true);
  const img = await raw.imageData();
  const decodeMs = Math.round(performance.now() - t0);
  raw.dispose();

  if (!img) throw new Error('libraw: no image data for outputColor=' + outputColor);
  return { img, meta, decodeMs, settings };
}

function samplePixels(img, coords) {
  const { width, height, data } = img;
  return coords.map(([fx, fy]) => {
    const x = Math.min(width - 1, Math.round(fx * width));
    const y = Math.min(height - 1, Math.round(fy * height));
    const idx = (y * width + x) * 3;
    return { x, y, r: data[idx], g: data[idx + 1], b: data[idx + 2] };
  });
}

async function upload(name, buf, width, height) {
  const res = await fetch(\`/upload/\${name}?w=\${width}&h=\${height}\`, {
    method: 'POST',
    body: buf,
  });
  if (!res.ok) throw new Error('upload ' + name + ' failed: ' + res.status);
}

async function main() {
  const srgb = await decodeWith(1); // -o 1
  const rec2020 = await decodeWith(8); // -o 8

  if (srgb.img.width !== rec2020.img.width || srgb.img.height !== rec2020.img.height) {
    throw new Error(
      \`dimension mismatch: srgb \${srgb.img.width}x\${srgb.img.height} vs rec2020 \${rec2020.img.width}x\${rec2020.img.height}\`
    );
  }

  const width = srgb.img.width;
  const height = srgb.img.height;
  const n = width * height;
  const dataSrgb = srgb.img.data;
  const data2020 = rec2020.img.data;

  const sampleCoords = [
    [0.1, 0.1],
    [0.5, 0.5],
    [0.9, 0.1],
    [0.1, 0.9],
    [0.9, 0.9],
  ];

  // --- single pass: OOG stats + cross-check + visualization buffers ---
  const rgbaSrgb = new Uint8Array(n * 4);
  const rgbaRec2020 = new Uint8Array(n * 4);
  const rgbaHeat = new Uint8Array(n * 4);

  let oogCount = 0;
  let worst = 0; // most negative channel value seen (unclamped)
  let sumSatLoss = 0; // sum over OOG pixels of L1(unclamped, clamped-to-[0,inf))
  let nonOogCount = 0;
  let sumAbsDiff = 0; // sum over non-OOG pixels, over 3 channels, of |clamped - direct|
  let maxSatLossForHeat = 0;

  // temp arrays to avoid recomputation for the heatmap pass (need max first) -> two-pass:
  // pass 1: compute per-pixel converted values + stats + satLoss magnitude, stash satLoss array
  const satLossPerPixel = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const idx = i * 3;
    const r2020 = data2020[idx] / 65535;
    const g2020 = data2020[idx + 1] / 65535;
    const b2020 = data2020[idx + 2] / 65535;
    const [rs, gs, bs] = applyMatrix(r2020, g2020, b2020);

    const isOOG = rs < -0.001 || gs < -0.001 || bs < -0.001;
    const negR = Math.max(-rs, 0);
    const negG = Math.max(-gs, 0);
    const negB = Math.max(-bs, 0);
    const satLoss = negR + negG + negB;

    if (isOOG) {
      oogCount++;
      sumSatLoss += satLoss;
      satLossPerPixel[i] = satLoss;
      if (satLoss > maxSatLossForHeat) maxSatLossForHeat = satLoss;
      if (rs < worst) worst = rs;
      if (gs < worst) worst = gs;
      if (bs < worst) worst = bs;
    } else {
      nonOogCount++;
      const rDirect = dataSrgb[idx] / 65535;
      const gDirect = dataSrgb[idx + 1] / 65535;
      const bDirect = dataSrgb[idx + 2] / 65535;
      const rc = Math.max(rs, 0);
      const gc = Math.max(gs, 0);
      const bc = Math.max(bs, 0);
      sumAbsDiff += Math.abs(rc - rDirect) + Math.abs(gc - gDirect) + Math.abs(bc - bDirect);
    }

    // visualization buffers (RGBA8)
    const o = i * 4;
    const vSrgb = toneMap8(dataSrgb[idx] / 65535);
    const vSrgbG = toneMap8(dataSrgb[idx + 1] / 65535);
    const vSrgbB = toneMap8(dataSrgb[idx + 2] / 65535);
    rgbaSrgb[o] = vSrgb;
    rgbaSrgb[o + 1] = vSrgbG;
    rgbaSrgb[o + 2] = vSrgbB;
    rgbaSrgb[o + 3] = 255;

    rgbaRec2020[o] = toneMap8(rs);
    rgbaRec2020[o + 1] = toneMap8(gs);
    rgbaRec2020[o + 2] = toneMap8(bs);
    rgbaRec2020[o + 3] = 255;
  }

  const heatCap = maxSatLossForHeat > 0 ? maxSatLossForHeat : 1;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const mag = satLossPerPixel[i] / heatCap; // 0..1
    rgbaHeat[o] = Math.round(mag * 255); // red channel = OOG magnitude
    rgbaHeat[o + 1] = 0;
    rgbaHeat[o + 2] = 0;
    rgbaHeat[o + 3] = 255;
  }

  await upload('srgb', rgbaSrgb, width, height);
  await upload('rec2020', rgbaRec2020, width, height);
  await upload('heatmap', rgbaHeat, width, height);

  window.__result = {
    width,
    height,
    totalPixels: n,
    srgb: {
      decodeMs: srgb.decodeMs,
      colors: srgb.img.colors,
      bits: srgb.img.bits,
      dataCtor: srgb.img.data.constructor.name,
      profilePresent: !!(srgb.meta && srgb.meta.color_data && srgb.meta.color_data.profile),
      profileLength: srgb.meta && srgb.meta.color_data ? srgb.meta.color_data.profile_length : null,
      samples: samplePixels(srgb.img, sampleCoords),
    },
    rec2020: {
      decodeMs: rec2020.decodeMs,
      colors: rec2020.img.colors,
      bits: rec2020.img.bits,
      dataCtor: rec2020.img.data.constructor.name,
      profilePresent: !!(rec2020.meta && rec2020.meta.color_data && rec2020.meta.color_data.profile),
      profileLength: rec2020.meta && rec2020.meta.color_data ? rec2020.meta.color_data.profile_length : null,
      samples: samplePixels(rec2020.img, sampleCoords),
    },
    oog: {
      oogCount,
      oogFraction: oogCount / n,
      worstNegative: worst,
      meanSatLossOverOOG: oogCount > 0 ? sumSatLoss / oogCount : 0,
    },
    crossCheck: {
      nonOogCount,
      meanAbsDiffOverNonOOG: nonOogCount > 0 ? sumAbsDiff / (nonOogCount * 3) : null,
    },
  };
  document.title = 'DONE';
}

main().catch((err) => {
  window.__error = { message: err.message, stack: err.stack };
  document.title = 'ERROR';
});
`;

const indexHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>spike-cst</title>
<script type="importmap">{"imports":{"libraw-wasm":"/node_modules/libraw-wasm/dist/index.js"}}</script>
</head>
<body><script type="module" src="/entry.js"></script></body>
</html>`;

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

// --- uploaded raw RGBA8 buffers, collected server-side from the page ---
const uploads = {}; // name -> { width, height, buffer }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(indexHtml);
      return;
    }
    if (p === '/entry.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(entryJs);
      return;
    }
    if (p === '/raw.arw') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(await readFile(RAW_PATH));
      return;
    }
    if (p.startsWith('/upload/') && req.method === 'POST') {
      const name = p.slice('/upload/'.length);
      const width = Number(url.searchParams.get('w'));
      const height = Number(url.searchParams.get('h'));
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      uploads[name] = { width, height, buffer: Buffer.concat(chunks) };
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (p.startsWith('/node_modules/')) {
      const full = normalize(join(projectRoot, p));
      if (!full.startsWith(join(projectRoot, 'node_modules'))) throw new Error('path escape');
      res.writeHead(200, { 'content-type': mime[extname(full)] ?? 'application/octet-stream' });
      res.end(await readFile(full));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    res.writeHead(500);
    res.end(String(err?.message ?? err));
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console.error]', msg.text());
  });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => document.title === 'DONE' || document.title === 'ERROR', {
    timeout: 180_000,
  });

  const error = await page.evaluate(() => window.__error);
  if (error) {
    console.error('spike-cst decode failed:', error.message, '\n', error.stack ?? '');
    process.exit(1);
  }

  const r = await page.evaluate(() => window.__result);

  console.log('spike-cst: wide-gamut (Rec.2020) decode feasibility');
  console.log('===================================================');
  console.log(`dims: ${r.width}x${r.height} (${r.totalPixels.toLocaleString()} px)`);
  console.log('');
  console.log(`sRGB decode   (outputColor=1): ${r.srgb.decodeMs} ms, colors=${r.srgb.colors}, bits=${r.srgb.bits}, ctor=${r.srgb.dataCtor}`);
  console.log(`  embedded profile present: ${r.srgb.profilePresent} (length=${r.srgb.profileLength})`);
  console.log(`  samples:`, r.srgb.samples);
  console.log('');
  console.log(`Rec.2020 decode (outputColor=8): ${r.rec2020.decodeMs} ms, colors=${r.rec2020.colors}, bits=${r.rec2020.bits}, ctor=${r.rec2020.dataCtor}`);
  console.log(`  embedded profile present: ${r.rec2020.profilePresent} (length=${r.rec2020.profileLength})`);
  console.log(`  samples:`, r.rec2020.samples);
  console.log('');
  console.log('Out-of-gamut analysis (Rec.2020 -> linear sRGB via given 3x3 matrix):');
  console.log(`  OOG pixels: ${r.oog.oogCount.toLocaleString()} / ${r.totalPixels.toLocaleString()} = ${(r.oog.oogFraction * 100).toFixed(4)}%`);
  console.log(`  worst (most negative) channel value: ${r.oog.worstNegative.toFixed(6)}`);
  console.log(`  mean saturation loss (L1, over OOG pixels): ${r.oog.meanSatLossOverOOG.toFixed(6)}`);
  console.log('');
  console.log('Sanity cross-check (clamped Rec.2020->sRGB vs direct sRGB decode, non-OOG pixels):');
  console.log(`  non-OOG pixels: ${r.crossCheck.nonOogCount.toLocaleString()}`);
  console.log(`  mean abs diff (per channel, normalized 0..1): ${r.crossCheck.meanAbsDiffOverNonOOG?.toFixed(6)}`);
  console.log('');

  check('srgb decode succeeded (colors=3)', r.srgb.colors === 3, r.srgb.colors);
  check('srgb decode is 16-bit', r.srgb.bits === 16, r.srgb.bits);
  check('rec2020 decode succeeded (colors=3)', r.rec2020.colors === 3, r.rec2020.colors);
  check('rec2020 decode is 16-bit', r.rec2020.bits === 16, r.rec2020.bits);
  check('dims match between decodes', r.width > 0 && r.height > 0, { width: r.width, height: r.height });
  check('uploads received: srgb', !!uploads.srgb, Object.keys(uploads));
  check('uploads received: rec2020', !!uploads.rec2020, Object.keys(uploads));
  check('uploads received: heatmap', !!uploads.heatmap, Object.keys(uploads));

  // --- encode visual artifacts with sharp, downscaled to ~1600px long edge ---
  for (const [name, outFile] of [
    ['srgb', 'spike-cst-srgb.png'],
    ['rec2020', 'spike-cst-rec2020.png'],
    ['heatmap', 'spike-cst-oog-heatmap.png'],
  ]) {
    const u = uploads[name];
    if (!u) continue;
    const outPath = join(ARTIFACT_DIR, outFile);
    await sharp(u.buffer, { raw: { width: u.width, height: u.height, channels: 4 }, limitInputPixels: false })
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(outPath);
    console.log(`wrote ${outPath}`);
  }
} finally {
  await browser.close();
  server.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

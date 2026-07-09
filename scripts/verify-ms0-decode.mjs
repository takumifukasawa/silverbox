/**
 * Milestone 0 verify: decode the test ARW through LibrawDecoder in Chromium
 * (libraw-wasm needs Web Workers, so this cannot run in plain Node).
 *
 * Checks: 16-bit RGB output, correct dimensions, cam_mul/cam_xyz present.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const RAW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const PORT = 8934;

// --- bundle the browser entry (libraw-wasm stays external; resolved via importmap) ---
const bundle = await build({
  entryPoints: [join(projectRoot, 'scripts/verify-ms0.entry.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  external: ['libraw-wasm'],
});
const entryJs = bundle.outputFiles[0].text;

const indexHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>verify-ms0</title>
<script type="importmap">{"imports":{"libraw-wasm":"/node_modules/libraw-wasm/dist/index.js"}}</script>
</head>
<body><script type="module" src="/entry.js"></script></body>
</html>`;

// --- static server ---
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split('?')[0]);
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
    res.writeHead(404);
    res.end(String(err?.message ?? err));
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));

// --- drive Chromium ---
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

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => document.title === 'DONE' || document.title === 'ERROR', {
    timeout: 120_000,
  });

  const error = await page.evaluate(() => window.__error);
  if (error) {
    console.error('decode failed:', error.message, '\n', error.stack ?? '');
    process.exit(1);
  }

  const r = await page.evaluate(() => window.__result);
  console.log(`decoded in ${r.decodeMs} ms`);
  console.log('verify-ms0-decode:');

  check('width is 4624', r.width === 4624, r.width);
  check('height is 3080', r.height === 3080, r.height);
  check('colors is 3 (RGB)', r.colors === 3, r.colors);
  check('bits is 16', r.bits === 16, r.bits);
  check('data is Uint16Array', r.dataCtor === 'Uint16Array', r.dataCtor);
  check('data length is W*H*3', r.dataLength === 4624 * 3080 * 3, r.dataLength);
  check('pixel samples span a real range', r.sample.min < r.sample.max && r.sample.max > 0, r.sample);
  check(
    'camMul has 4 finite entries',
    Array.isArray(r.color?.camMul) && r.color.camMul.length === 4 && r.color.camMul.every(Number.isFinite),
    r.color?.camMul
  );
  check(
    'camXyz top 3x3 is finite',
    Array.isArray(r.color?.camXyz) &&
      r.color.camXyz.length >= 3 &&
      r.color.camXyz.slice(0, 3).every((row) => Array.isArray(row) && row.length >= 3 && row.slice(0, 3).every(Number.isFinite)),
    r.color?.camXyz
  );
  check('black/maximum present', r.color?.black === 512 && r.color?.maximum === 16383, {
    black: r.color?.black,
    maximum: r.color?.maximum,
  });
  check('camera model is ILCE-7CM2', r.capture?.cameraModel === 'ILCE-7CM2', r.capture?.cameraModel);
  check('flip is 0 for this shot', r.flip === 0, r.flip);
} finally {
  await browser.close();
  server.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

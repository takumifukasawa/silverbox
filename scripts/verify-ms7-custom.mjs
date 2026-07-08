/**
 * Milestone 7 verify: custom WGSL look node. Adds a custom node via the UI
 * (identity by default), applies a known shader through the real textarea and
 * checks the GPU against a hand-computed expectation, exercises the p0..p3
 * uniforms, confirms bad code reports an error and falls back to identity,
 * and round-trips the code through the sidecar.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = 'test-assets/test.ARW';
const SIDECAR = ARW_PATH + '.silverbox.json';
const GPU_CPU_TOLERANCE = 1 / 255;

// the known look: cool teal grade with a p0-controlled red gain
const LOOK_CODE = `fn applyOp(c: vec4f, p: vec4f) -> vec4f {
  return vec4f(c.r * (0.5 + p.x), c.g, c.b * 2.0, c.a);
}`;

console.log('building…');
execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

const meansMatch = (a, b, tol = GPU_CPU_TOLERANCE) =>
  a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  const openAndWait = async (path) => {
    // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  };

  // srgbEncode-mean of the linear preview after the given per-channel gains,
  // computed in the page from the store's pixels — the hand-written reference
  // for the custom shader (all other nodes stay neutral).
  const expectedMean = (gains) =>
    page.evaluate(([gr, gg, gb]) => {
      const encode = (v) => {
        const c = Math.min(Math.max(v, 0), 1);
        return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      };
      const { data, width, height } = window.__debug.imageForVerify();
      const n = width * height;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < n; i++) {
        r += encode(data[i * 4] * gr);
        g += encode(data[i * 4 + 1] * gg);
        b += encode(data[i * 4 + 2] * gb);
      }
      return { r: r / n, g: g / n, b: b / n };
    }, gains);

  await openAndWait(ARW_PATH);
  const neutralGpu = await page.evaluate(() => window.__debug.readbackMean());

  console.log('verify-ms7 (add custom node, identity by default):');
  await page.locator('.node-editor-toolbar select').selectOption('custom');
  await page.locator('.node-editor-toolbar button').click();
  check(
    'custom node lands in the chain with the WGSL editor open',
    (await page.locator('.inspector-title').textContent()) === 'Custom (WGSL)' &&
      (await page.locator('.inspector-code').count()) === 1,
    await page.locator('.inspector-title').textContent()
  );
  const identityGpu = await page.evaluate(() => window.__debug.readbackMean());
  check('default custom code is identity', meansMatch(identityGpu, neutralGpu), { neutralGpu, identityGpu });

  console.log('verify-ms7 (known look through the textarea):');
  await page.locator('.inspector-code').fill(LOOK_CODE);
  await page.locator('.inspector-code-actions button').click();
  const lookGpu = await page.evaluate(() => window.__debug.readbackMean());
  const lookExpected = await expectedMean([0.5, 1, 2]);
  check('look render matches the hand-computed reference (within 1/255)', meansMatch(lookGpu, lookExpected), {
    lookGpu,
    lookExpected,
  });

  console.log('verify-ms7 (p0 uniform drives the shader):');
  const customId = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.kind === 'custom')?.id
  );
  await page.evaluate((id) => window.__debug.updateNodeParam(id, 'p0', 0.5), customId);
  const p0Gpu = await page.evaluate(() => window.__debug.readbackMean());
  const p0Expected = await expectedMean([1, 1, 2]);
  check('p0=0.5 render matches the reference (within 1/255)', meansMatch(p0Gpu, p0Expected), {
    p0Gpu,
    p0Expected,
  });
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms7-look.png') });

  console.log('verify-ms7 (bad code falls back to identity with an error):');
  await page.locator('.inspector-code').fill('fn applyOp( broken');
  await page.locator('.inspector-code-actions button').click();
  await page.waitForSelector('[data-testid="shader-error"]', { timeout: 10_000 });
  check('inspector shows the compile error', true, true);
  const brokenGpu = await page.evaluate(() => window.__debug.readbackMean());
  check('broken shader renders identity', meansMatch(brokenGpu, neutralGpu), { neutralGpu, brokenGpu });

  console.log('verify-ms7 (code persists through the sidecar):');
  await page.locator('.inspector-code').fill(LOOK_CODE);
  await page.locator('.inspector-code-actions button').click();
  await page.waitForFunction(
    () => Object.keys(window.__debug.shaderErrors()).length === 0,
    { timeout: 10_000 }
  );
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await openAndWait(ARW_PATH); // reopen (restores from sidecar)
  const restoredCode = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.kind === 'custom')?.code
  );
  check('reopened image restores the custom code', restoredCode === LOOK_CODE, restoredCode);
  const restoredGpu = await page.evaluate(() => window.__debug.readbackMean());
  const restoredExpected = await expectedMean([1, 1, 2]); // p0 was saved at 0.5
  check('restored look renders like before the save (within 1/255)', meansMatch(restoredGpu, restoredExpected), {
    restoredGpu,
    restoredExpected,
  });

  console.log('screenshot: test-artifacts/ms7-look.png');
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

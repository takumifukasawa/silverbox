/**
 * customShader verify (REBUILD-SPEC MS5, spec-aligned rework). The node uses
 * the shade(color, uv) body-only API with Monaco + GUI-declared params:
 * identity by default, a known desaturation body matches the hand-computed
 * expectation, a broken edit shows a line-numbered error while the LAST
 * VALID shader keeps rendering, GUI params drive the uniform (P.<name>),
 * typing in Monaco auto-applies after the debounce, and the payload
 * round-trips through the sidecar.
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

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const neutral = await page.evaluate(() => window.__debug.readbackMean());

  const shaderState = () =>
    page.evaluate(() => window.__debug.graphState().nodes.find((n) => n.kind === 'custom')?.shader);
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  // hand-computed reference: per-channel means after mapping each linear
  // pixel through `fn` (JS mirror of the shader body), then sRGB-encoding
  const expected = (fnBody) =>
    page.evaluate((body) => {
      const encode = (v) => {
        const c = Math.min(Math.max(v, 0), 1);
        return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      };
      const fn = new Function('r', 'g', 'b', body);
      const { data, width, height } = window.__debug.imageForVerify();
      const n = width * height;
      let r = 0;
      let gg = 0;
      let bb = 0;
      for (let i = 0; i < n; i++) {
        const [x, y, z] = fn(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
        r += encode(x);
        gg += encode(y);
        bb += encode(z);
      }
      return { r: r / n, g: gg / n, b: bb / n };
    }, fnBody);

  console.log('verify-ms7 (identity default):');
  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-custom"]').click();
  const customId = await page.evaluate(
    () => window.__debug.graphState().nodes.find((n) => n.kind === 'custom')?.id
  );
  check(
    'custom node lands with the Monaco editor and compiled status',
    (await page.locator('[data-testid="shader-editor"]').count()) === 1 &&
      (await page.locator('[data-testid="shader-status-ok"]').count()) === 1,
    customId
  );
  const identity = await gpuMean();
  check('default shade body is identity', meansMatch(identity, neutral), { neutral, identity });

  console.log('verify-ms7 (known shader vs hand-computed reference):');
  await page.evaluate((id) => window.__debug.applyShaderSource(id, 'return vec3f(luma(color));'), customId);
  await page.waitForFunction(
    (id) =>
      window.__debug.graphState().nodes.find((n) => n.id === id)?.shader?.code?.lastValidSrc ===
      'return vec3f(luma(color));',
    customId,
    { timeout: 10_000 }
  );
  const desat = await gpuMean();
  const desatExpected = await expected(
    'const l = 0.2126*r + 0.7152*g + 0.0722*b; return [l, l, l];'
  );
  check('luma desaturation matches the reference (within 1/255)', meansMatch(desat, desatExpected), {
    desat,
    desatExpected,
  });

  console.log('verify-ms7 (broken edit keeps the last valid shader):');
  await page.evaluate((id) => window.__debug.applyShaderSource(id, 'return oops;'), customId);
  await page.waitForSelector('[data-testid="shader-error"]', { timeout: 10_000 });
  const errorText = await page.locator('[data-testid="shader-error"]').textContent();
  check('error is line-numbered against the user body', /line 1/.test(errorText ?? ''), errorText);
  const afterBroken = await gpuMean();
  check('render still shows the last valid shader (desaturation)', meansMatch(afterBroken, desat), {
    desat,
    afterBroken,
  });

  console.log('verify-ms7 (GUI params drive P.<name>):');
  const addError = await page.evaluate(
    (id) => window.__debug.addShaderParam(id, { name: 'gain', min: 0, max: 4, default: 1 }),
    customId
  );
  check('param declaration succeeds', addError === null, addError);
  await page.evaluate((id) => window.__debug.applyShaderSource(id, 'return color * P.gain;'), customId);
  await page.waitForFunction(
    (id) => !window.__debug.shaderErrors()[id],
    customId,
    { timeout: 10_000 }
  );
  await page.evaluate((id) => window.__debug.updateShaderParam(id, 'gain', 2), customId);
  const gained = await gpuMean();
  const gainedExpected = await expected('return [2 * r, 2 * g, 2 * b];');
  check('P.gain = 2 matches the reference (within 1/255)', meansMatch(gained, gainedExpected), {
    gained,
    gainedExpected,
  });

  console.log('verify-ms7 (editing in Monaco auto-applies after 400ms):');
  // drive the editor model directly (same onDidChangeModelContent → debounce
  // path as typing; raw synthetic keystrokes are flaky against Monaco)
  await page.evaluate(() => {
    const model = window.__monaco.editor.getModels()[0];
    model.setValue('return color * 0.5;');
  });
  let typedState = null;
  for (let i = 0; i < 40; i++) {
    typedState = await page.evaluate(
      (id) => {
        const shader = window.__debug.graphState().nodes.find((n) => n.id === id)?.shader;
        return {
          code: shader?.code,
          error: window.__debug.shaderErrors()[id] ?? null,
          editor: document.querySelector('[data-testid="shader-editor"] .view-lines')?.textContent ?? null,
        };
      },
      customId
    );
    if (typedState.code?.lastValidSrc === 'return color * 0.5;') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check(
    'debounced edit landed as src + lastValidSrc',
    typedState?.code?.lastValidSrc === 'return color * 0.5;',
    typedState
  );
  const halved = await gpuMean();
  const halvedExpected = await expected('return [0.5 * r, 0.5 * g, 0.5 * b];');
  check('typed shader renders (within 1/255)', meansMatch(halved, halvedExpected), { halved, halvedExpected });

  console.log('verify-ms7 (sidecar round-trip):');
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const restoredShader = await shaderState();
  check(
    'reopen restores code and params',
    restoredShader?.code?.lastValidSrc === 'return color * 0.5;' &&
      restoredShader?.params?.[0]?.name === 'gain' &&
      restoredShader?.params?.[0]?.value === 2,
    restoredShader
  );
  // load-time revalidation is async — poll until the render reflects the shader
  let restored = null;
  for (let i = 0; i < 40; i++) {
    restored = await gpuMean();
    if (meansMatch(restored, halvedExpected)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check('restored shader renders like before the save', meansMatch(restored, halvedExpected), {
    restored,
    halvedExpected,
  });

  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms7-customshader.png') });
  console.log('screenshot: test-artifacts/ms7-customshader.png');
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

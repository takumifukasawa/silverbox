/**
 * Viewer toggles: Before/After shows the unedited decode (\ key + A/B
 * button, badge, readbacks follow so the histogram matches the screen), and
 * the grayscale check view desaturates the CANVAS ONLY — readbacks and
 * therefore exports keep their color.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, rmLook } from './lib/testProject.mjs';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
// A second, visually distinct fixture for the A→B switch-flicker check below
// (same portrait fixture verify-preview.mjs's overlay-orientation section
// uses) — needs to be a genuinely different photo from ARW_PATH, not just a
// different path, so a switch is actually observable.
const SWITCH_B_PATH = process.env.SILVERBOX_TEST_PORTRAIT_ARW ?? 'test-assets/italy/DSC06787.ARW';

// autosave (default on) persists sidecars across suite scripts — isolate
ensureTestProjectEnv();
rmLook(ARW_PATH);
rmLook(SWITCH_B_PATH);
const GPU_CPU_TOLERANCE = 1 / 255;

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

const meansMatch = (a, b, tol = GPU_CPU_TOLERANCE) =>
  a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  const neutral = await page.evaluate(() => window.__debug.readbackMean());
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());

  // channel means of the on-screen canvas, via a screenshot decoded by sharp
  const canvasChannelMeans = async () => {
    const buf = await page.locator('.canvas-view-canvas').screenshot();
    const stats = await sharp(buf).stats();
    return { r: stats.channels[0].mean / 255, g: stats.channels[1].mean / 255, b: stats.channels[2].mean / 255 };
  };

  console.log('verify-view (before/after):');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 2));
  const edited = await gpuMean();
  check('exposure edit brightens first', edited.g > neutral.g + 0.1, { neutral, edited });

  await page.keyboard.press('\\');
  await page.waitForSelector('[data-testid="before-badge"]', { timeout: 5_000 });
  check('\\ shows the Before badge', true, true);
  const before = await gpuMean();
  check('before view shows the unedited decode', meansMatch(before, neutral), { neutral, before });

  await page.keyboard.press('\\');
  await page.waitForSelector('[data-testid="before-badge"]', { state: 'detached', timeout: 5_000 });
  const after = await gpuMean();
  check('toggling back restores the edit', meansMatch(after, edited), { edited, after });
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0));

  console.log('verify-view (grayscale check view):');
  const colorCanvas = await canvasChannelMeans();
  check(
    'color view shows a colorful canvas (r ≠ b)',
    Math.abs(colorCanvas.r - colorCanvas.b) > 0.02,
    colorCanvas
  );
  await page.locator('[data-testid="view-grayscale"]').click();
  // the render effect is synchronous with the state change; give one frame
  await page.waitForTimeout(300);
  const grayCanvas = await canvasChannelMeans();
  check(
    'grayscale view renders r ≈ g ≈ b on screen',
    Math.abs(grayCanvas.r - grayCanvas.g) < 0.01 && Math.abs(grayCanvas.b - grayCanvas.g) < 0.01,
    grayCanvas
  );
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'view-grayscale.png') });
  const readbackInGray = await gpuMean();
  check('readbacks (and exports) keep their color in grayscale view', meansMatch(readbackInGray, neutral), {
    neutral,
    readbackInGray,
  });
  await page.keyboard.press('g');
  await page.waitForTimeout(300);
  const backToColor = await canvasChannelMeans();
  check('G toggles back to the color view', Math.abs(backToColor.r - backToColor.b) > 0.02, backToColor);

  // === A→B switch flicker fix (NG investigation, "B briefly → A flashes
  // back → B settles" hand-test report) ===
  //
  // Root cause: openImageByPath's final `set()` flips imageStatus to 'ready'
  // (with the NEW image) the instant its own async work resolves — a single
  // synchronous store commit. CanvasView's `.canvas-viewport` used to reveal
  // on imageStatus alone, but the transferred <canvas>'s backing store is
  // updated by the render WORKER on its own async schedule (postMessage hop
  // + setImage's texture upload + setGraph + render()'s device.queue.submit)
  // — a real gap (tens of ms on this fixture, confirmed with timestamped
  // instrumentation while investigating) during which the canvas still shows
  // whatever it drew for the OLD photo. Revealing the container the instant
  // 'ready' lands re-presented that stale frame for the length of the gap.
  //
  // Fix: CanvasView.tsx now gates the reveal on renderProtocol.ts's new
  // 'framePresented' ack (posted by the worker right after the MAIN
  // surface's render() call actually submits) instead of imageStatus alone
  // — see its revealGenRef/presentedGen doc comments.
  //
  // Why this check asserts on the MECHANISM rather than sampling
  // readbackMean(): readbackMean() re-executes the WHOLE plan fresh into a
  // scratch target on every call (graphRenderer.ts's own doc comment) — it
  // reflects whatever image/plan the renderer currently holds, never what is
  // actually sitting in the presented canvas backing store at that instant,
  // so it cannot see this gap at all (confirmed while investigating: it
  // stayed correct throughout the buggy old build too). A screenshot-based
  // poll could in principle catch it, but the flicker window is a handful of
  // frames — not reliably one 2ms polling tick could land on inside a
  // screenshot's own encode latency. Polling the reveal gate's own state
  // (__debug.flickerGateState()) alongside the container's actual computed
  // `visibility` is deterministic instead: it directly proves the invariant
  // ("the container is never visible while a newer gen's frame hasn't been
  // confirmed presented") and that the gate genuinely engaged at least once
  // (`suppressedRevealCount` — a regression here would mean a future change
  // reintroduced the instant-reveal-on-ready bug even if the invariant
  // trivially held because the race never actually got exercised).
  if (!existsSync(SWITCH_B_PATH)) {
    console.log(`  SKIP  verify-view (A→B switch flicker fix) — fixture missing: ${SWITCH_B_PATH}`);
  } else {
    console.log('verify-view (A→B switch never re-presents a stale frame):');
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, ARW_PATH);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });

    // Arm a fast in-page poller BEFORE firing the switch: samples
    // imageState().status, flickerGateState(), and the container's actual
    // computed visibility every 2ms, self-stopping once B settles.
    await page.evaluate(() => {
      window.__switchLog = [];
      const iv = setInterval(() => {
        const s = window.__debug?.imageState();
        const gate = window.__debug?.flickerGateState();
        const container = document.querySelector('.canvas-viewport');
        const visible = container ? getComputedStyle(container).visibility === 'visible' : false;
        window.__switchLog.push({ status: s?.status, visible, pendingSwitch: gate?.pendingSwitch });
      }, 2);
      window.__switchLogStop = () => clearInterval(iv);
    });

    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, SWITCH_B_PATH);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    // Wait for the gate to ACTUALLY settle (pendingSwitch false) and the
    // container to ACTUALLY become visible, rather than a fixed sleep — a
    // fixed wait races pool contention (this exact check FAILED with a
    // too-short fixed wait under concurrent pool load while developing this
    // fix: the gate had genuinely settled by the time it was queried, but the
    // poller's own window had already been cut short before sampling a
    // visible container even once). 20s is generous; the ordinary case
    // settles in well under 100ms.
    await page.waitForFunction(
      () => {
        const container = document.querySelector('.canvas-viewport');
        const visible = container ? getComputedStyle(container).visibility === 'visible' : false;
        return visible && window.__debug?.flickerGateState().pendingSwitch === false;
      },
      { timeout: 20_000 }
    );
    // Confirmed directly (not via the 2ms interval log): under heavy pool
    // contention Chromium can throttle/delay a page's OWN setInterval enough
    // that it never gets another tick between waitForFunction's poll
    // resolving true and the `__switchLogStop()` call right after it — this
    // check must not depend on that timer's granularity.
    const settledVisible = await page.evaluate(() => {
      const container = document.querySelector('.canvas-viewport');
      return container ? getComputedStyle(container).visibility === 'visible' : false;
    });
    await page.evaluate(() => window.__switchLogStop());
    const switchLog = await page.evaluate(() => window.__switchLog);
    const switchState = await page.evaluate(() => window.__debug.imageState());

    check('switch reaches ready on the new (portrait) photo', switchState.status === 'ready', switchState);
    check(
      'switch actually landed on a different photo (portrait dims)',
      switchState.fullHeight > switchState.fullWidth,
      switchState
    );
    check('the container is visible once the switch has settled', settledVisible, { settledVisible });

    const visibleSamples = switchLog.filter((e) => e.visible);
    const staleReveal = visibleSamples.find((e) => e.pendingSwitch === true);
    check(
      'invariant: the container was NEVER visible while a switch was still pending (no confirmed frame for the new photo yet)',
      staleReveal === undefined,
      { staleReveal, visibleSamples: visibleSamples.slice(0, 5) }
    );
    const finalGate = await page.evaluate(() => window.__debug.flickerGateState());
    check(
      'reveal gate actually engaged at least once (proves this run exercised the race, not just trivially passed)',
      finalGate.suppressedRevealCount > 0,
      finalGate
    );
    check('reveal gate is settled (no switch pending once B has settled)', finalGate.pendingSwitch === false, finalGate);
  }
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

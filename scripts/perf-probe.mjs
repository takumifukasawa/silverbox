/**
 * Standalone perf/leak diagnostic — NOT part of the verify chain (see
 * package.json's "perf:probe" script, deliberately absent from "verify").
 *
 * Repro under investigation: the UI gets progressively slower with use, via
 * (a) plain slider drags and (b) node-editor edge disconnect/reconnect —
 * NO custom-shader (Monaco) edits. "Progressively slower" implies some
 * resource ACCUMULATES per interaction rather than staying flat, so this
 * script drives both interaction kinds for many repetitions and samples
 * GraphRenderer's live-resource counters (window.__debug.rendererStats(),
 * see src/renderer/engine/gpu/graphRenderer.ts's RendererStats) plus the JS
 * heap (window.__debug.perfProbe()) every N interactions, then prints a
 * table and a LEAK VERDICT line naming any metric that grew monotonically
 * across the run.
 *
 * Always exits 0 — this is a diagnostic, not a pass/fail gate.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// never steal focus while the probe runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';

const SLIDER_EDITS = 300;
const SLIDER_BATCH = 25;
const EDGE_CYCLES = 60;
const EDGE_BATCH = 10;

console.log('building…');
execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });

const fmtMB = (bytes) => (bytes === null || bytes === undefined ? null : Math.round((bytes / (1024 * 1024)) * 10) / 10);

/** True when `values` has a net increase and never decreases step to step. */
function grewMonotonically(values, minNetGrowth = 1) {
  const nums = values.filter((v) => typeof v === 'number');
  if (nums.length < 2) return false;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] < nums[i - 1]) return false;
  }
  return nums[nums.length - 1] - nums[0] >= minNetGrowth;
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  console.log(
    ['batch', 'meanMs', 'heapMB', 'liveBuf', 'liveTex', 'passPipe', 'exportPipe', 'steps', 'stepTex']
      .map((h) => h.padStart(9))
      .join(' ')
  );
  for (const r of rows) {
    console.log(
      [
        r.batch,
        r.meanMs?.toFixed(2) ?? 'n/a',
        r.heapMB ?? 'n/a',
        r.liveBuffers ?? 'n/a',
        r.liveTextures ?? 'n/a',
        r.passPipelineCacheSize ?? 'n/a',
        r.exportEncodePipelineCacheSize ?? 'n/a',
        r.execStepCount ?? 'n/a',
        r.stepTextureCount ?? 'n/a',
      ]
        .map((v) => String(v).padStart(9))
        .join(' ')
    );
  }
}

function verdict(label, rows) {
  const metrics = {
    heapMB: rows.map((r) => r.heapMB),
    liveBuffers: rows.map((r) => r.liveBuffers),
    liveTextures: rows.map((r) => r.liveTextures),
    passPipelineCacheSize: rows.map((r) => r.passPipelineCacheSize),
    exportEncodePipelineCacheSize: rows.map((r) => r.exportEncodePipelineCacheSize),
    execStepCount: rows.map((r) => r.execStepCount),
    stepTextureCount: rows.map((r) => r.stepTextureCount),
  };
  const grown = Object.entries(metrics)
    .filter(([name, values]) => grewMonotonically(values, name === 'heapMB' ? 5 : 1))
    .map(([name]) => name);
  const firstMs = rows[0]?.meanMs ?? null;
  const lastMs = rows[rows.length - 1]?.meanMs ?? null;
  const ratio = firstMs && lastMs ? lastMs / firstMs : null;
  console.log(
    `\nLEAK VERDICT (${label}): ${grown.length === 0 ? 'no metric grew monotonically' : `GREW: ${grown.join(', ')}`}` +
      ` | per-edit latency last/first = ${ratio !== null ? ratio.toFixed(2) + 'x' : 'n/a'}` +
      ` (first ${firstMs?.toFixed(2)}ms, last ${lastMs?.toFixed(2)}ms)`
  );
  return { grown, ratio };
}

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  // fire-and-forget so no evaluate stays in flight across the decode (see ms2)
  await page.evaluate((p) => {
    void window.__openImageByPath(p);
  }, ARW_PATH);
  await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
  await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });

  const probe = () => page.evaluate(() => window.__debug.perfProbe());
  const sampleRow = async (batch, meanMs) => {
    const p = await probe();
    return {
      batch,
      meanMs,
      heapMB: fmtMB(p.heapUsed),
      liveBuffers: p.rendererStats?.liveBuffers ?? null,
      liveTextures: p.rendererStats?.liveTextures ?? null,
      passPipelineCacheSize: p.rendererStats?.passPipelineCacheSize ?? null,
      exportEncodePipelineCacheSize: p.rendererStats?.exportEncodePipelineCacheSize ?? null,
      execStepCount: p.rendererStats?.execStepCount ?? null,
      stepTextureCount: p.rendererStats?.stepTextureCount ?? null,
    };
  };

  // ---------------------------------------------------------------------
  console.log(`\nperf-probe (1. ${SLIDER_EDITS} slider edits on basic.ev, sampled every ${SLIDER_BATCH}):`);
  const sliderRows = [];
  for (let b = 0; b * SLIDER_BATCH < SLIDER_EDITS; b++) {
    const t0 = Date.now();
    for (let i = 0; i < SLIDER_BATCH; i++) {
      const idx = b * SLIDER_BATCH + i;
      const ev = (((idx % 41) - 20) / 20) * 2; // sweeps -2..2 EV, never the same value twice in a row
      await page.evaluate((v) => window.__debug.updateNodeParam('dev', 'basic.ev', v), ev);
    }
    // readback settle: force the batch's last edit through a full GPU
    // round-trip (render + offscreen encode + CPU-mapped readback) so the
    // timing reflects real settle cost, not just enqueuing store mutations.
    await page.evaluate(() => window.__debug.readbackMean());
    const dt = Date.now() - t0;
    sliderRows.push(await sampleRow(b, dt / SLIDER_BATCH));
  }
  printTable('slider-drag batches (basic.ev)', sliderRows);
  const sliderVerdict = verdict('sliders', sliderRows);

  // ---------------------------------------------------------------------
  console.log(`\nperf-probe (2. ${EDGE_CYCLES} edge disconnect/reconnect cycles on dev->out, sampled every ${EDGE_BATCH}):`);
  const findEdgeId = (source, target) =>
    page.evaluate(
      ([s, t]) => window.__debug.graphState().edges.find((e) => e.source === s && e.target === t)?.id ?? null,
      [source, target]
    );
  const disconnectReconnect = async () => {
    const edgeId = await findEdgeId('dev', 'out');
    if (edgeId) {
      // The default graph's dev/out nodes sit at the same y, so this edge is
      // a perfectly horizontal path — Chromium's content-quad computation
      // (which Playwright's locator actionability checks use) reports zero
      // AREA for a zero-height quad regardless of stroke-width, so
      // locator.click() rejects it as "outside of the viewport" even though
      // it renders and hit-tests fine at runtime. Dispatch a raw mouse click
      // at the interaction path's bounding-box center instead — real click
      // hit-testing (unlike the content-quad heuristic) honors stroke-width.
      const box = await page
        .locator(`[data-testid="rf__edge-${edgeId}"] .react-flow__edge-interaction`)
        .boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.keyboard.press('Backspace');
      }
    }
    const srcHandle = page.locator('.react-flow__node[data-id="dev"] .react-flow__handle.source');
    const dstHandle = page.locator('.react-flow__node[data-id="out"] .react-flow__handle.target');
    const src = await srcHandle.boundingBox();
    const dst = await dstHandle.boundingBox();
    if (!src || !dst) return;
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 6 });
    await page.mouse.up();
  };
  const edgeRows = [];
  for (let b = 0; b * EDGE_BATCH < EDGE_CYCLES; b++) {
    const t0 = Date.now();
    for (let i = 0; i < EDGE_BATCH; i++) await disconnectReconnect();
    await page.evaluate(() => window.__debug.readbackMean());
    const dt = Date.now() - t0;
    edgeRows.push(await sampleRow(b, dt / EDGE_BATCH));
  }
  printTable('edge disconnect/reconnect batches (dev->out)', edgeRows);
  const edgeVerdict = verdict('edges', edgeRows);

  console.log(
    `\noverall: sliders ${sliderVerdict.grown.length ? 'LEAKING' : 'flat'}, edges ${edgeVerdict.grown.length ? 'LEAKING' : 'flat'}`
  );
} catch (err) {
  console.error('perf-probe error (diagnostic only, still exiting 0):', err);
} finally {
  await app.close();
}

// diagnostic script — never fails the run
process.exit(0);

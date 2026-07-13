/**
 * Image node verify (composite/mask-by-another-file feature): a zero-input
 * SOURCE node referencing a SECOND file, decoded through the same ingest as
 * the main image, cover-fit into whatever consumes it.
 *  1. Add an image node + a blend node; wire the image node's output into
 *     the blend's 'b' port (composite) at amount 0.5 ⇒ once the referenced
 *     file decodes, the render changes and the compiled plan has no CPU
 *     reference (spatial-like — see graphDoc.ts's planHasCpuReference).
 *  2. ALSO wire the same image node into the blend's 'mask' port ⇒ the
 *     render changes again (the mask now modulates the blend per-pixel
 *     instead of a flat amount everywhere) — proves the mask port actually
 *     reads the referenced image's pixels, not just its presence.
 *  3. An unreadable/missing path ⇒ solid-gray-influenced output (render
 *     changes back from the real-file composite) + a node-editor badge; the
 *     doc still saves and reloads (not a hard error).
 *  4. Sidecar round-trip preserves the path; a bare filename (no leading
 *     '/') resolves as RELATIVE against the sidecar's own directory.
 *  5. LUT export with an image-node blend still succeeds and reports the
 *     image node (and the blend compositing it) in `skipped`.
 *  6. Render-worker cache: two consecutive renders of the same doc don't
 *     re-decode the referenced file (imageNodeDecodeCount() debug hook).
 *  7. PNG reference (round-9 fix pack item 4, "maskはpngも許容でいい気がする"):
 *     a PNG fixture (generated in-script via sharp, no committed binary)
 *     decodes and renders through the SAME 'jpg'-kind ingest path JPEG uses
 *     (decodeWorker.ts's prepareJpeg / createImageBitmap already handles PNG
 *     natively) — the image node reports it as non-missing and the render
 *     changes to reflect its content, exactly like the JPG case in section 1.
 *  8. Unconnected image node still shows a node-editor thumbnail (round-11
 *     fix pack item 4, "PNGを選んだIMAGEノードにサムネイルが出ない"): an image node
 *     wired to NOTHING never gets a nodeSteps entry, so the plan-derived
 *     nodeThumbs batch (per-node-preview pack) never covers it — CanvasView's
 *     imageNodeSourceThumbs fallback (thumbnailCache.ts's own decode
 *     machinery, keyed by the node's own path) is what fills the gap.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';

// never steal focus while the suite runs (see testMode in src/main/index.ts)
process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
const SIDECAR = ARW_PATH + '.silverbox.json';
const TIGHT_TOLERANCE = 1e-6;
// PNG fixture (section 7) — generated fresh each run, never committed: a
// small solid-gradient raster (distinct from the JPG fixture's content) is
// plenty to prove the decode path, no need for a real photograph.
const PNG_PATH = join(projectRoot, 'test-artifacts', 'imagenode-fixture.png');

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

const meansMatch = (a, b, tol) => a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;

if (existsSync(SIDECAR)) unlinkSync(SIDECAR);

mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });
// A tiny solid-gradient PNG (128x96, RGB ramp) — real PNG bytes/signature,
// not a renamed JPEG, so this genuinely exercises the PNG magic-byte sniff
// (decodeWorker.ts's sniffMimeType) rather than the browser's own leniency.
const gradient = Buffer.alloc(128 * 96 * 3);
for (let y = 0; y < 96; y++) {
  for (let x = 0; x < 128; x++) {
    const i = (y * 128 + x) * 3;
    gradient[i] = Math.round((x / 127) * 255); // R ramps left->right
    gradient[i + 1] = Math.round((y / 95) * 255); // G ramps top->bottom
    gradient[i + 2] = 128;
  }
}
await sharp(gradient, { raw: { width: 128, height: 96, channels: 3 } }).png().toFile(PNG_PATH);

const app = await electron.launch({ args: [projectRoot] });
const pageErrors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const openAndWait = async (path) => {
    await page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);
    await page.waitForFunction(() => window.__debug?.imageState().status === 'ready', { timeout: 120_000 });
    await page.waitForFunction(() => window.__debug.histogramState() !== null, { timeout: 15_000 });
  };
  const gpuMean = () => page.evaluate(() => window.__debug.readbackMean());
  const cpuMean = () => page.evaluate(() => window.__debug.cpuReferenceMean());
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const historyPast = () => page.evaluate(() => window.__debug.historyState().past);
  const imageNodeState = (nodeId) => page.evaluate((n) => window.__debug.imageNodeState(n), nodeId ?? null);
  const setImagePath = (nodeId, path) => page.evaluate(([n, p]) => window.__debug.setImagePath(n, p), [nodeId, path]);
  const connectEdge = (source, target, handle) =>
    page.evaluate(([s, t, h]) => window.__debug.connectEdge(s, t, h), [source, target, handle]);
  const decodeCount = () => page.evaluate(() => window.__debug.imageNodeDecodeCount());
  const edgeList = (g) => g.edges.map((e) => `${e.source}->${e.target}${e.targetHandle ? ':' + e.targetHandle : ''}`).sort();

  const addNode = async (kind) => {
    await page.locator('[data-testid="add-node-button"]').click();
    await page.locator(`[data-testid="add-node-${kind}"]`).click();
    return (await graphState()).nodes.at(-1);
  };

  // ---------------------------------------------------------------------
  console.log('verify-imagenode (1. composite via blend "b": render changes once decoded, plan has no CPU reference):');
  await openAndWait(ARW_PATH);
  const baselineMean = await gpuMean();
  check('a fresh open has a CPU reference (sanity baseline)', (await cpuMean()) !== null, await cpuMean());

  const blendNode = await addNode('blend');
  check('blend node added', blendNode?.kind === 'blend', blendNode);
  const imageNode = await addNode('image');
  check('image node added with kind "image" and an empty default path', imageNode?.kind === 'image' && imageNode?.image?.path === '', imageNode);
  const imageNodeId = imageNode.id;
  const blendNodeId = blendNode.id;

  check('a freshly added, unconnected image node reports no missing-file badge (empty path is not "missing")', (await imageNodeState(imageNodeId))?.missing === false, await imageNodeState(imageNodeId));

  const countBeforeFirstDecode = await decodeCount();
  await setImagePath(imageNodeId, JPG_PATH);
  check('setImagePath wrote the absolute path', (await imageNodeState(imageNodeId))?.path === JPG_PATH, await imageNodeState(imageNodeId));

  await connectEdge(imageNodeId, blendNodeId, 'b');
  const gAfterWireB = await graphState();
  check("image node wired into the blend's 'b' port", edgeList(gAfterWireB).includes(`${imageNodeId}->${blendNodeId}:b`), edgeList(gAfterWireB));

  // Referenced-file decode is async (main-thread readFile+imageLoader,
  // posted to the render worker) — poll the decode counter STRICTLY past its
  // pre-edit value (never just ">= 1" — the counter is monotonic across the
  // whole session, so a bare ">= 1" can resolve before THIS decode even
  // starts once earlier sections have already caused one).
  await page.waitForFunction((n) => window.__debug.imageNodeDecodeCount() > n, countBeforeFirstDecode, { timeout: 30_000 });
  await page.waitForTimeout(300); // let the freshly-uploaded texture's re-render land
  check('the referenced file decoded without becoming "missing"', (await imageNodeState(imageNodeId))?.missing === false, await imageNodeState(imageNodeId));

  const meanAfterCompositeB = await gpuMean();
  check("compositing with the referenced JPG via blend 'b' changes the render", !meansMatch(meanAfterCompositeB, baselineMean, TIGHT_TOLERANCE), {
    baselineMean,
    meanAfterCompositeB,
  });
  check('the compiled plan has NO CPU reference (image node is spatial-like, no CPU mirror)', (await cpuMean()) === null, await cpuMean());

  // ---------------------------------------------------------------------
  console.log('verify-imagenode (2. also wiring the image node into the blend\'s "mask" port changes the render again):');
  await connectEdge(imageNodeId, blendNodeId, 'mask');
  const gAfterWireMask = await graphState();
  check("image node ALSO wired into the blend's 'mask' port", edgeList(gAfterWireMask).includes(`${imageNodeId}->${blendNodeId}:mask`), edgeList(gAfterWireMask));
  await page.waitForTimeout(200);
  const meanAfterMask = await gpuMean();
  check(
    "adding the image node as the blend's mask (modulating amount per-pixel instead of flat) changes the render vs the unmasked composite",
    !meansMatch(meanAfterMask, meanAfterCompositeB, TIGHT_TOLERANCE),
    { meanAfterCompositeB, meanAfterMask }
  );

  // ---------------------------------------------------------------------
  console.log('verify-imagenode (3. missing/unreadable path: gray-influenced output + node-editor badge, doc still saves/reloads):');
  const decodeCountBeforeMissing = await decodeCount();
  await setImagePath(imageNodeId, '/nonexistent/path/does-not-exist-imagenode-verify.jpg');
  await page.waitForFunction(
    (n) => window.__debug.imageNodeState(n)?.missing === true,
    imageNodeId,
    { timeout: 15_000 }
  );
  check('missing path reports missing:true', (await imageNodeState(imageNodeId)).missing, await imageNodeState(imageNodeId));
  const missingBadge = page.locator(`[data-testid="image-node-missing-${imageNodeId}"]`);
  await missingBadge.scrollIntoViewIfNeeded();
  check('the node-editor shows the missing-file badge', await missingBadge.isVisible(), await missingBadge.isVisible());
  check('a missing path does not increment the decode counter (no repeated failed-decode churn)', (await decodeCount()) === decodeCountBeforeMissing, {
    before: decodeCountBeforeMissing,
    after: await decodeCount(),
  });
  const meanWithMissing = await gpuMean();
  check('render changed back once the reference became unreadable (no longer the real JPG content)', !meansMatch(meanWithMissing, meanAfterMask, TIGHT_TOLERANCE), {
    meanAfterMask,
    meanWithMissing,
  });

  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  check('doc with a missing image-node reference still saved (not a hard error)', existsSync(SIDECAR), SIDECAR);
  const savedJson = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  check('saved sidecar is schemaVersion 4', savedJson.schemaVersion === 4, savedJson.schemaVersion);
  const savedImageNode = savedJson.graph.nodes.find((n) => n.id === imageNodeId);
  check('saved sidecar carries the image node\'s type and (missing) path', savedImageNode?.type === 'image' && typeof savedImageNode?.image?.path === 'string', savedImageNode);

  await openAndWait(ARW_PATH);
  const reloadedGraph = await graphState();
  const reloadedImageNode = reloadedGraph.nodes.find((n) => n.id === imageNodeId);
  check('reloaded doc still has the image node, missing path preserved', reloadedImageNode?.image?.path?.includes('does-not-exist-imagenode-verify'), reloadedImageNode);
  check('a reload with a missing image-node reference reports the graph as loadable (no sidecarUnreadable)', (await page.evaluate(() => window.__debug.sidecarState().unreadable)) === false, await page.evaluate(() => window.__debug.sidecarState()));

  // ---------------------------------------------------------------------
  console.log('verify-imagenode (4. sidecar round-trip preserves the path; a relative path resolves against the sidecar dir):');
  const jpgBaseName = JPG_PATH.split('/').pop();
  // The decode counter is monotonic across the WHOLE session (several
  // decodes already happened above) — every wait below must check it
  // STRICTLY increased past a captured baseline, never just ">= 1", or a
  // stale already-true condition resolves before the decode this step
  // actually cares about has even started.
  const countBeforeRel = await decodeCount();
  await setImagePath(imageNodeId, jpgBaseName); // bare filename — no leading '/' ⇒ relative
  await page.waitForFunction((n) => window.__debug.imageNodeDecodeCount() > n, countBeforeRel, { timeout: 30_000 });
  await page.waitForTimeout(300);
  check(
    "a relative (bare-filename) path resolves against the sidecar's directory and decodes successfully (ARW/JPG fixtures share a directory)",
    (await imageNodeState(imageNodeId))?.missing === false,
    await imageNodeState(imageNodeId)
  );
  const meanBeforeRTSave = await gpuMean();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  const savedRelJson = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  const savedRelImageNode = savedRelJson.graph.nodes.find((n) => n.id === imageNodeId);
  check('saved sidecar preserves the RELATIVE path verbatim (not resolved to absolute)', savedRelImageNode?.image?.path === jpgBaseName, savedRelImageNode);

  const countBeforeReload = await decodeCount();
  await openAndWait(ARW_PATH);
  const reloadedRelGraph = await graphState();
  const reloadedRelImageNode = reloadedRelGraph.nodes.find((n) => n.id === imageNodeId);
  check('reloaded image node path is byte-equal to the saved relative path', reloadedRelImageNode?.image?.path === jpgBaseName, reloadedRelImageNode);
  await page.waitForFunction((n) => window.__debug.imageNodeDecodeCount() > n, countBeforeReload, { timeout: 30_000 });
  await page.waitForTimeout(300);
  const meanAfterRTReload = await gpuMean();
  check('reloaded render mean matches the pre-save mean (relative path resolved identically both times)', meansMatch(meanAfterRTReload, meanBeforeRTSave, TIGHT_TOLERANCE), {
    meanBeforeRTSave,
    meanAfterRTReload,
  });

  // ---------------------------------------------------------------------
  console.log('verify-imagenode (5. LUT export with an image-node blend still succeeds and reports it skipped):');
  await page.evaluate((p) => window.__debug.exportLutTo(p), '/tmp/silverbox-verify-imagenode-lut');
  await page.waitForFunction(() => window.__debug.exportState().status === 'idle', { timeout: 30_000 });
  check('LUT export finished without error', (await page.evaluate(() => window.__debug.exportState())).error === null, await page.evaluate(() => window.__debug.exportState()));
  const lutInfo = await page.evaluate(() => window.__debug.exportLutState());
  check('LUT export still produced files despite the unrepresentable image-node blend', lutInfo !== null && lutInfo.count > 0, lutInfo);
  check(
    'LUT export reports the image node (or the blend compositing it) as skipped',
    lutInfo !== null && lutInfo.skipped.some((s) => s.includes('image node') || s.toLowerCase().includes('image')),
    lutInfo?.skipped
  );

  // ---------------------------------------------------------------------
  console.log('verify-imagenode (6. render-worker cache: two consecutive renders do not re-decode):');
  const decodeCountBeforeExtraRenders = await decodeCount();
  // Two no-op edits that each trigger a fresh 'render' post without touching
  // the image node's own path at all — a real re-decode would show up as the
  // counter climbing past its current value.
  await page.evaluate((id) => window.__debug.updateNodeParam(id, 'amount', 0.51), blendNodeId);
  await page.waitForTimeout(150);
  await page.evaluate((id) => window.__debug.updateNodeParam(id, 'amount', 0.5), blendNodeId);
  await page.waitForTimeout(150);
  check('re-rendering the SAME doc twice does not re-decode the referenced file', (await decodeCount()) === decodeCountBeforeExtraRenders, {
    before: decodeCountBeforeExtraRenders,
    after: await decodeCount(),
  });

  // ---------------------------------------------------------------------
  console.log('verify-imagenode (7. PNG reference decodes and renders through the same ingest as JPEG):');
  const meanBeforePng = await gpuMean();
  const countBeforePng = await decodeCount();
  await setImagePath(imageNodeId, PNG_PATH);
  check('setImagePath wrote the PNG fixture\'s absolute path', (await imageNodeState(imageNodeId))?.path === PNG_PATH, await imageNodeState(imageNodeId));
  await page.waitForFunction((n) => window.__debug.imageNodeDecodeCount() > n, countBeforePng, { timeout: 30_000 });
  await page.waitForTimeout(300);
  check('the PNG fixture decoded without becoming "missing"', (await imageNodeState(imageNodeId))?.missing === false, await imageNodeState(imageNodeId));
  const meanWithPng = await gpuMean();
  check("compositing with the PNG reference changes the render (its gradient content actually reads back)", !meansMatch(meanWithPng, meanBeforePng, TIGHT_TOLERANCE), {
    meanBeforePng,
    meanWithPng,
  });

  // ---------------------------------------------------------------------
  console.log('verify-imagenode (8. an unconnected image node still gets a node-editor thumbnail — round-11 fix pack item 4):');
  const unconnectedImageNode = await addNode('image');
  const unconnectedId = unconnectedImageNode.id;
  const unconnectedThumb = page.locator(`[data-testid="node-thumb-${unconnectedId}"]`);
  await unconnectedThumb.scrollIntoViewIfNeeded();
  check(
    'a freshly added, pathless image node shows the empty "=" placeholder (nothing to preview yet)',
    await unconnectedThumb.evaluate((el) => el.classList.contains('op-node-thumb--empty')),
    await unconnectedThumb.evaluate((el) => el.className)
  );
  const nodeThumbsBefore = await page.evaluate(() => window.__debug.nodeThumbsState());
  check(
    "an unconnected node never earns a plan-derived nodeThumbs entry (buildPlan's nodeSteps never reaches it)",
    !(unconnectedId in nodeThumbsBefore),
    nodeThumbsBefore
  );

  await setImagePath(unconnectedId, PNG_PATH);
  // The source-file fallback (CanvasView.tsx's imageNodeSourceThumbs effect)
  // decodes through thumbnailCache.ts directly — a separate path from
  // imageNodeSource.ts's render-worker decode (which also runs here, since
  // syncImageNodeSources scans every image node with a path regardless of
  // wiring, same as every other section above), so this waits on the actual
  // DOM rather than imageNodeDecodeCount().
  await page.waitForFunction(
    (id) => {
      const el = document.querySelector(`[data-testid="node-thumb-${id}"]`);
      return !!el && el.style.backgroundImage !== '';
    },
    unconnectedId,
    { timeout: 15_000 }
  );
  check(
    'the unconnected image node now shows a non-empty thumbnail (source-file fallback)',
    !(await unconnectedThumb.evaluate((el) => el.classList.contains('op-node-thumb--empty'))),
    await unconnectedThumb.evaluate((el) => ({ className: el.className, backgroundImage: el.style.backgroundImage }))
  );
  const nodeThumbsAfter = await page.evaluate(() => window.__debug.nodeThumbsState());
  check(
    'still no plan-derived nodeThumbs entry for it (the fallback is separate from the render-worker thumbnail batch)',
    !(unconnectedId in nodeThumbsAfter),
    nodeThumbsAfter
  );
  const sourceThumbUrl = await page.evaluate((id) => window.__debug.imageNodeSourceThumbsState()[id], unconnectedId);
  check(
    'the fallback thumbnail is tracked in imageNodeSourceThumbsState(), keyed by this node id',
    typeof sourceThumbUrl === 'string' && sourceThumbUrl.length > 0,
    await page.evaluate(() => window.__debug.imageNodeSourceThumbsState())
  );

  check('no page errors across the image-node verify checks', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
  if (existsSync(SIDECAR)) unlinkSync(SIDECAR);
  if (existsSync(PNG_PATH)) unlinkSync(PNG_PATH);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

/**
 * Virtual copies (named output nodes) verify (docs/brief-bank/virtual-copy.md).
 *
 * The mechanism itself ("2+ `kind: 'output'` nodes = a virtual copy") already
 * existed and is exercised elsewhere (verify-compare.mjs, verify-
 * exportsettings.mjs); this script covers what's NEW in this brief — the
 * "Duplicate output" creation gesture, the filmstrip count badge, and —
 * the sharp part — the preset/paste/sync scoping fixes that stop a 2+-output
 * doc from silently losing or cross-contaminating a virtual copy.
 *
 * Checks (brief's own numbering):
 *  (1) Duplicate output on a fresh doc produces 2 outputs; the clone's
 *      Develop node has its own id, and editing one copy's params leaves the
 *      other's compiled plan/render untouched (readback mean differs only
 *      for the edited copy).
 *  (2) Export target selection resolves the two copies to two distinct
 *      files, and the SECOND file's pixels differ once its Develop diverges
 *      — a regression guard on TOP of verify-exportsettings.mjs/verify-
 *      cli.mjs (not a re-test of already-covered plumbing).
 *  (3) paste-develop-settings (whole-look) onto a 2-output doc replaces ONLY
 *      the ACTIVE chain — the OTHER output's node ids/params are byte-
 *      identical before/after.
 *  (4) A scoped preset apply onto a 2-output doc updates only the Develop
 *      node reachable from the active output, leaving the INACTIVE copy's
 *      Develop params untouched even when its id would have matched the
 *      preset's own captured id (the brief's documented "wrong copy by id"
 *      hazard) — the exact bug CONFIRMED REAL against this repo's modules
 *      before this fix.
 *  (5) resetAllEdits on a 2-output doc collapses to 1 output (the brief's
 *      decided/documented behavior, not a regression) and is exactly one
 *      ⌘Z away.
 *  (6) The filmstrip count badge appears once a look's on-disk graph gains a
 *      2nd output (hover/click popover lists both names) and disappears
 *      once pruned back to 1.
 *  (7) Sidecar round-trip (no Electron — same esbuild-bundle-and-dynamic-
 *      import trick as verify-sidecar-spec.mjs): a 2-named-output look
 *      re-parses byte-stable; a legacy 1-output look is unaffected.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import sharp from 'sharp';
import { ensureTestProjectEnv } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
ensureTestProjectEnv();

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

const meansMatch = (a, b, tol = 1 / 255) =>
  a && b && Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;
const meansDiffer = (a, b, minDelta = 0.05) =>
  a && b && (Math.abs(a.r - b.r) > minDelta || Math.abs(a.g - b.g) > minDelta || Math.abs(a.b - b.b) > minDelta);

// =====================================================================
// (7) Sidecar round-trip — no Electron (verify-sidecar-spec.mjs's own
// esbuild-bundle-and-dynamic-import trick: parseGraphDoc/serializeGraphDoc
// are pure, dependency-free functions).
// =====================================================================
console.log('verify-virtualcopy (7. sidecar round-trip — 2-output and legacy 1-output looks):');

async function bundleToTempModule(relSrcPath) {
  const result = await build({
    entryPoints: [join(projectRoot, relSrcPath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
  });
  return result.outputFiles[0].text;
}

const bundleWorkDir = mkdtempSync(join(tmpdir(), 'silverbox-virtualcopy-bundle-'));
let graphDocMod;
try {
  const graphDocJs = await bundleToTempModule('src/renderer/engine/graph/graphDoc.ts');
  const graphDocPath = join(bundleWorkDir, 'graphDoc.bundle.mjs');
  writeFileSync(graphDocPath, graphDocJs, 'utf8');
  graphDocMod = await import(pathToFileURL(graphDocPath).href);
  check('bundled graphDoc.ts via esbuild and imported it under plain Node', true, null);
} catch (err) {
  check('bundled graphDoc.ts via esbuild and imported it under plain Node', false, String(err));
}

if (graphDocMod) {
  const { defaultGraphDoc, serializeGraphDoc, parseGraphDoc, DEVELOP_KIND } = graphDocMod;

  const roundTrip = (doc, source) => {
    const src1 = serializeGraphDoc(doc, source, '2026-01-01T00:00:00.000Z');
    const parsed1 = parseGraphDoc(src1);
    const src2 = serializeGraphDoc(
      parsed1.graph,
      parsed1.source ?? null,
      parsed1.createdAt ?? null,
      parsed1.unknown,
      parsed1.rating,
      parsed1.photo,
      parsed1.fingerprint,
      parsed1.flag
    );
    const parsed2 = parseGraphDoc(src2);
    return { parsed1, parsed2 };
  };

  // Hand-built 2-output doc: the default chain (in/dev/out) plus a second,
  // independently-named "bw-crop" chain sharing the same input node — the
  // exact shape "Duplicate output" produces, minus needing the app open.
  const base = defaultGraphDoc();
  const devTemplate = base.nodes.find((n) => n.kind === DEVELOP_KIND).develop;
  const twoOutputDoc = {
    version: 1,
    nodes: [
      ...base.nodes,
      { id: 'dev-1', kind: DEVELOP_KIND, position: { x: 220, y: 200 }, develop: structuredClone(devTemplate) },
      { id: 'out-1', kind: 'output', position: { x: 420, y: 200 }, name: 'bw-crop' },
    ],
    edges: [
      ...base.edges,
      { id: 'e2', source: 'in', target: 'dev-1' },
      { id: 'e3', source: 'dev-1', target: 'out-1' },
    ],
  };
  const { parsed1: twoOutParsed1, parsed2: twoOutParsed2 } = roundTrip(twoOutputDoc, { fileName: 'x.ARW', kind: 'raw' });
  check(
    '2-output look round-trips byte-stable (parse→serialize→parse produces identical graph content)',
    JSON.stringify(twoOutParsed1.graph) === JSON.stringify(twoOutParsed2.graph),
    { a: twoOutParsed1.graph, b: twoOutParsed2.graph }
  );
  const twoOutOutputs = twoOutParsed2.graph.nodes.filter((n) => n.kind === 'output');
  check(
    'both named outputs (main + bw-crop) survive with their own names',
    twoOutOutputs.length === 2 && twoOutOutputs.some((n) => n.name === 'bw-crop') && twoOutOutputs.some((n) => n.name === undefined),
    twoOutOutputs
  );

  // Legacy 1-output doc — unaffected by this feature.
  const oneOutputDoc = defaultGraphDoc();
  const { parsed1: oneOutParsed1, parsed2: oneOutParsed2 } = roundTrip(oneOutputDoc, { fileName: 'y.ARW', kind: 'raw' });
  check(
    'a legacy 1-output look round-trips unaffected (byte-stable graph content, still exactly 1 output)',
    JSON.stringify(oneOutParsed1.graph) === JSON.stringify(oneOutParsed2.graph) &&
      oneOutParsed2.graph.nodes.filter((n) => n.kind === 'output').length === 1,
    oneOutParsed2.graph.nodes.map((n) => n.kind)
  );
}
rmSync(bundleWorkDir, { recursive: true, force: true });

// =====================================================================
// (1)-(6): Electron + Playwright
// =====================================================================
const workDir = mkdtempSync(join(tmpdir(), 'silverbox-virtualcopy-'));
function fixture(name) {
  const dst = join(workDir, name);
  linkSync(ARW_PATH, dst);
  return dst;
}
const PRIMARY = fixture('a_primary.ARW');

const ownUserData = !process.env.SILVERBOX_USER_DATA;
const userDataDir = process.env.SILVERBOX_USER_DATA ?? mkdtempSync(join(tmpdir(), 'silverbox-virtualcopy-userdata-'));

const app = await electron.launch({ args: [projectRoot], env: { ...process.env, SILVERBOX_USER_DATA: userDataDir } });
try {
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });

  const openFolderFireAndForget = (dir) => page.evaluate((d) => void window.__openFolderByPath(d), dir);
  const graphState = () => page.evaluate(() => window.__debug.graphState());
  const activeOutputIdState = () => page.evaluate(() => window.__debug.activeOutputIdState());
  const readbackMean = () => page.evaluate(() => window.__debug.readbackMean());

  // Every node id reachable by walking edges BACKWARD from `outputId` — a
  // plain reimplementation of appStore.ts's own (unexported) reachableToOutput,
  // same spirit as this suite's other scripts re-deriving small pieces of
  // engine logic (e.g. verify-exportsettings.mjs's rawMeanAndSample) rather
  // than reaching into store internals.
  const reachableIds = (graph, outputId) => {
    const seen = new Set();
    const stack = [outputId];
    while (stack.length > 0) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of graph.edges) if (e.target === id) stack.push(e.source);
    }
    return seen;
  };
  const chainSnapshot = (graph, outputId) => {
    const ids = reachableIds(graph, outputId);
    return {
      nodes: graph.nodes.filter((n) => ids.has(n.id)).sort((a, b) => a.id.localeCompare(b.id)),
      edges: graph.edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({ source: e.source, target: e.target, targetHandle: e.targetHandle ?? null }))
        .sort((a, b) => `${a.source}>${a.target}`.localeCompare(`${b.source}>${b.target}`)),
    };
  };
  const develNodeIdFeeding = (graph, outputId) => graph.edges.find((e) => e.target === outputId)?.source;

  await openFolderFireAndForget(workDir);
  await page.waitForFunction(
    (p) => window.__debug.folderState().currentPath === p && window.__debug.imageState().status === 'ready',
    PRIMARY,
    { timeout: 120_000 }
  );

  // === (1) Duplicate output — 2 outputs, independent Develop, isolated renders ===
  console.log('verify-virtualcopy (1. Duplicate output — 2 outputs, independent Develop, isolated renders):');
  const g0 = await graphState();
  check('starts with exactly 1 output (fresh doc)', g0.nodes.filter((n) => n.kind === 'output').length === 1, g0.nodes.map((n) => n.kind));

  await page.locator('[data-testid="add-node-button"]').click();
  await page.locator('[data-testid="add-node-duplicate-output"]').click();
  const g1 = await graphState();
  const outputs1 = g1.nodes.filter((n) => n.kind === 'output');
  check('now has 2 outputs', outputs1.length === 2, outputs1.map((n) => n.id));
  const originalOutId = outputs1.find((n) => n.id === 'out')?.id;
  const cloneOut = outputs1.find((n) => n.id !== 'out');
  check("the clone is named '<original> copy'", cloneOut?.name === 'main copy', cloneOut?.name);
  check('the new output is selected + made active (addOpNode-style convention)', (await activeOutputIdState()) === cloneOut.id, await activeOutputIdState());

  const cloneDevId0 = develNodeIdFeeding(g1, cloneOut.id);
  check("the clone's Develop node has its own fresh id, distinct from 'dev'", !!cloneDevId0 && cloneDevId0 !== 'dev', cloneDevId0);

  await page.locator('[data-testid="output-selector"]').selectOption(originalOutId);
  await page.waitForTimeout(250);
  const originalMean0 = await readbackMean();
  await page.locator('[data-testid="output-selector"]').selectOption(cloneOut.id);
  await page.waitForTimeout(250);
  const cloneMean0 = await readbackMean();
  check('both chains render identically right after duplicating (exact clone)', meansMatch(originalMean0, cloneMean0), { originalMean0, cloneMean0 });

  await page.evaluate((id) => window.__debug.updateNodeParam(id, 'basic.ev', 0.8), cloneDevId0);
  await page.waitForTimeout(250);
  const cloneMean1 = await readbackMean();
  await page.locator('[data-testid="output-selector"]').selectOption(originalOutId);
  await page.waitForTimeout(250);
  const originalMean1 = await readbackMean();
  check(
    "editing the clone's Develop node changes ONLY the clone's compiled plan/render",
    meansMatch(originalMean1, originalMean0) && meansDiffer(cloneMean1, cloneMean0),
    { originalMean0, originalMean1, cloneMean0, cloneMean1 }
  );

  // === (2) Export target selection — two distinct files, second's pixels differ ===
  console.log("verify-virtualcopy (2. export target selection regression guard — two distinct files, second output's pixels differ):");
  const outArtifacts = join(projectRoot, 'test-artifacts');
  const OUT_BASE = join(outArtifacts, 'virtualcopy-alloutputs.jpg');
  const OUT_MAIN = join(outArtifacts, 'virtualcopy-alloutputs-main.jpg');
  const OUT_COPY = join(outArtifacts, 'virtualcopy-alloutputs-main-copy.jpg');
  for (const p of [OUT_BASE, OUT_MAIN, OUT_COPY]) if (existsSync(p)) unlinkSync(p);
  await page.evaluate(([base]) => window.__debug.exportOutputsTo('all', base), [OUT_BASE]);
  await page.waitForFunction(() => window.__debug.exportState().status !== 'working', { timeout: 300_000 });
  check('All-outputs export completes without error', (await page.evaluate(() => window.__debug.exportState())).status === 'idle', await page.evaluate(() => window.__debug.exportState()));
  check('both output files exist, suffixed by name (main / main-copy)', existsSync(OUT_MAIN) && existsSync(OUT_COPY), {
    OUT_MAIN: existsSync(OUT_MAIN),
    OUT_COPY: existsSync(OUT_COPY),
  });

  const rawMean = async (path) => {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    let r = 0;
    let g = 0;
    let b = 0;
    const n = info.width * info.height;
    for (let i = 0; i < n; i++) {
      r += data[i * info.channels];
      g += data[i * info.channels + 1];
      b += data[i * info.channels + 2];
    }
    return (r / n + g / n + b / n) / 3 / 255;
  };
  if (existsSync(OUT_MAIN) && existsSync(OUT_COPY)) {
    const mainFileMean = await rawMean(OUT_MAIN);
    const copyFileMean = await rawMean(OUT_COPY);
    check("the second (diverged) output's exported pixels differ from the first", Math.abs(mainFileMean - copyFileMean) > 0.02, {
      mainFileMean,
      copyFileMean,
    });
  }

  // Bring the clone back to identity before continuing — keeps later checks' expectations simple.
  await page.evaluate((id) => window.__debug.updateNodeParam(id, 'basic.ev', 0), cloneDevId0);

  // === (3) paste-develop-settings (whole-look) onto a 2-output doc — ACTIVE chain only ===
  console.log('verify-virtualcopy (3. paste-develop-settings onto a 2-output doc replaces only the ACTIVE chain):');
  // Seed a distinctive clipboard from the ORIGINAL ('out') chain first —
  // ⌘⇧C/⌘⇧V (copyDevelopSettings/pasteDevelopSettings's own real shortcuts,
  // App.tsx) rather than the Presets ▾ menu buttons: same store actions, no
  // dropdown-open/close choreography to fight.
  await page.locator('[data-testid="output-selector"]').selectOption(originalOutId);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.55));
  await page.keyboard.press('Meta+Shift+c');
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0)); // reset 'out' chain back to identity

  // Make the CLONE active, then paste — only its chain should change.
  await page.locator('[data-testid="output-selector"]').selectOption(cloneOut.id);
  check('clone is active before paste', (await activeOutputIdState()) === cloneOut.id, await activeOutputIdState());
  const gBeforePaste = await graphState();
  const originalChainBefore = chainSnapshot(gBeforePaste, originalOutId);

  await page.keyboard.press('Meta+Shift+v');

  const gAfterPaste = await graphState();
  const originalChainAfter = chainSnapshot(gAfterPaste, originalOutId);
  check(
    "the OTHER output's ('out') own node ids/params are byte-identical before/after paste",
    JSON.stringify(originalChainBefore) === JSON.stringify(originalChainAfter),
    { before: originalChainBefore, after: originalChainAfter }
  );
  const outputsAfterPaste = gAfterPaste.nodes.filter((n) => n.kind === 'output');
  check('still exactly 2 outputs after paste (paste never deletes the inactive one)', outputsAfterPaste.length === 2, outputsAfterPaste.map((n) => n.id));

  const pastedDevId = develNodeIdFeeding(gAfterPaste, cloneOut.id);
  const pastedDev = gAfterPaste.nodes.find((n) => n.id === pastedDevId);
  check("the pasted clipboard settings (ev=0.55) landed on the ACTIVE (clone) chain", pastedDev?.develop?.basic?.ev === 0.55, pastedDev?.develop?.basic);

  // === (4) scoped preset apply onto a 2-output doc — reachable-from-active only ===
  console.log("verify-virtualcopy (4. scoped preset apply — updates only the Develop node reachable from the active output; the inactive copy's id-colliding node is left alone):");
  // Capture a scoped ('basic-tone' only) preset FROM the ORIGINAL 'out' chain
  // (its own Develop node id is the conventional 'dev') while it's active.
  await page.locator('[data-testid="output-selector"]').selectOption(originalOutId);
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.33));
  await page.evaluate(() => window.__debug.savePreset('virtualcopy-scoped-test', ['basic-tone']));
  const presetsAfterSave = await page.evaluate(() => window.__debug.presetsState());
  const scopedSlug = presetsAfterSave.find((p) => p.name === 'virtualcopy-scoped-test')?.slug;
  check('the scoped preset was saved', !!scopedSlug, presetsAfterSave);

  // 4a. Applying it while the SAME (matching-id) chain is active updates it normally.
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0)); // reset before apply, so a real change is observable
  await page.evaluate((slug) => window.__debug.applyPreset(slug), scopedSlug);
  const gAfterApplyMatched = await graphState();
  check("applying the scoped preset while the id-MATCHING chain ('out') is active updates it", gAfterApplyMatched.nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.33, gAfterApplyMatched.nodes.find((n) => n.id === 'dev')?.develop?.basic);
  const cloneDevIdBefore4b = develNodeIdFeeding(gAfterApplyMatched, cloneOut.id);
  const cloneEvBefore4b = gAfterApplyMatched.nodes.find((n) => n.id === cloneDevIdBefore4b)?.develop?.basic?.ev;
  check("the INACTIVE clone chain is untouched by that same apply", cloneEvBefore4b !== 0.33, cloneEvBefore4b);

  // 4b. THE REAL HAZARD: switch active to the CLONE, then re-apply the SAME
  // preset (whose captured Develop id is 'dev' — the ORIGINAL chain's id,
  // not the clone's). Before this fix, mergeScopedLook matched by id
  // regardless of activeOutputId and would have silently overwritten 'dev'
  // AGAIN here even though the user is now editing the clone. After the fix,
  // 'dev' is out of scope (not reachable from the active clone) and must be
  // left exactly as 4a left it; the clone's own (non-matching-id) Develop
  // node is also untouched (no id match — same documented "left untouched
  // rather than guessed at" behavior as ever).
  await page.evaluate(() => window.__debug.updateNodeParam('dev', 'basic.ev', 0.77)); // a fresh marker only the fix can protect
  await page.locator('[data-testid="output-selector"]').selectOption(cloneOut.id);
  check('clone is active before the hazard apply', (await activeOutputIdState()) === cloneOut.id, await activeOutputIdState());
  await page.evaluate((slug) => window.__debug.applyPreset(slug), scopedSlug);
  const gAfterHazard = await graphState();
  check(
    "the WRONG (inactive, id-colliding) copy's Develop node is NOT silently updated anymore (virtual-copy.md's confirmed-real hazard)",
    gAfterHazard.nodes.find((n) => n.id === 'dev')?.develop?.basic?.ev === 0.77,
    gAfterHazard.nodes.find((n) => n.id === 'dev')?.develop?.basic
  );
  const cloneDevIdAfterHazard = develNodeIdFeeding(gAfterHazard, cloneOut.id);
  const cloneEvAfterHazard = gAfterHazard.nodes.find((n) => n.id === cloneDevIdAfterHazard)?.develop?.basic?.ev;
  check(
    "the ACTIVE clone's own Develop node is untouched too (no id match — documented limitation, not a regression)",
    cloneEvAfterHazard === cloneEvBefore4b,
    { before: cloneEvBefore4b, after: cloneEvAfterHazard }
  );
  await page.evaluate((slug) => window.__debug.deletePreset(slug), scopedSlug);

  // === (5) resetAllEdits on a 2-output doc — decided/documented collapse, one ⌘Z away ===
  console.log('verify-virtualcopy (5. resetAllEdits collapses a 2-output doc to 1 output — documented behavior — and is one ⌘Z away):');
  const gBeforeReset = await graphState();
  check('doc still has 2 outputs before reset', gBeforeReset.nodes.filter((n) => n.kind === 'output').length === 2, gBeforeReset.nodes.map((n) => n.id));
  await page.locator('[data-testid="toolbar-reset-all"]').click();
  await page.waitForFunction(() => window.__debug.graphState().nodes.filter((n) => n.kind === 'output').length === 1, { timeout: 10_000 });
  const gAfterReset = await graphState();
  check('reset-all collapses to exactly 1 output (decided, documented — not a bug)', gAfterReset.nodes.filter((n) => n.kind === 'output').length === 1, gAfterReset.nodes.map((n) => n.id));

  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => window.__debug.graphState().nodes.filter((n) => n.kind === 'output').length === 2, { timeout: 10_000 });
  const gAfterUndo = await graphState();
  check('one ⌘Z restores both outputs', gAfterUndo.nodes.filter((n) => n.kind === 'output').length === 2, gAfterUndo.nodes.map((n) => n.id));

  // === (6) Filmstrip count badge — appears at 2 outputs, disappears when pruned back to 1 ===
  console.log('verify-virtualcopy (6. filmstrip count badge appears once a look gains a 2nd output, disappears when pruned back to 1):');
  await page.locator('[data-testid="save-button"]').click();
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await page.evaluate(() => window.__debug.refreshPlaylistStatus());
  await page.waitForFunction(
    (p) => {
      const e = window.__debug.folderState().entries.find((x) => x.path === p);
      return e && e.outputCount === 2;
    },
    PRIMARY,
    { timeout: 15_000 }
  );

  const cellSel = `[data-testid="filmstrip-cell"][data-path="${PRIMARY}"]`;
  const badge = page.locator(`${cellSel} [data-testid="filmstrip-output-badge"]`);
  check('the filmstrip badge appears, showing "2"', (await badge.count()) === 1 && (await badge.textContent()) === '2', await badge.count());

  await badge.hover();
  await page.waitForSelector('[data-testid="filmstrip-output-popover"]', { timeout: 5_000 });
  const popoverNames = await page.locator('[data-testid="filmstrip-output-popover-row"] .filmstrip-output-popover-name').allTextContents();
  check("the popover lists both output names ('main' + the clone's name)", popoverNames.includes('main') && popoverNames.some((n) => n.includes('copy')), popoverNames);
  // move the mouse elsewhere so the popover's own onMouseLeave closes it before the next interaction
  await page.mouse.move(10, 10);

  // Prune back to 1: select + delete the clone output node, save, refresh.
  const gForPrune = await graphState();
  const cloneOutputNow = gForPrune.nodes.find((n) => n.kind === 'output' && n.id !== 'out');
  await page.evaluate((id) => window.__debug.selectNode(id), cloneOutputNow.id);
  await page.locator('[data-testid="delete-node-button"]').click();
  await page.waitForFunction(() => window.__debug.graphState().nodes.filter((n) => n.kind === 'output').length === 1, { timeout: 10_000 });

  await page.locator('[data-testid="save-button"]').click();
  await page.waitForFunction(() => !window.__debug.graphDirty(), { timeout: 10_000 });
  await page.evaluate(() => window.__debug.refreshPlaylistStatus());
  await page.waitForFunction(
    (p) => {
      const e = window.__debug.folderState().entries.find((x) => x.path === p);
      return e && e.outputCount === 1;
    },
    PRIMARY,
    { timeout: 15_000 }
  );
  check('the badge disappears once pruned back to 1 output', (await badge.count()) === 0, await badge.count());

  check('no page errors across the run', pageErrors.length === 0, pageErrors);
} finally {
  await app.close();
}

rmSync(workDir, { recursive: true, force: true });
if (ownUserData) rmSync(userDataDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

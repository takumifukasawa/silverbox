/**
 * Panel layout verify (PanelSplitters.tsx / panelLayout.ts):
 *  1. Defaults: Inspector 340 px wide, node editor 260 px tall.
 *  2. Dragging the Inspector splitter / node-editor bar resizes them, and
 *     sizes clamp at their minimums.
 *  3. The node editor collapses and expands with its toggle button;
 *     collapsing gives the canvas the height back.
 *  4. Sizes and the collapsed state survive a relaunch.
 *  5. Double-click restores the defaults.
 * Uses Settings.panelLayoutTest (the test-mode twin) and resets it before
 * and after.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_LAYOUT = { inspectorWidth: 340, nodeEditorHeight: 260, nodeEditorCollapsed: false };
const resetLayout = (page) => page.evaluate((l) => window.silverbox.settingsUpdate({ panelLayoutTest: l }), DEFAULT_LAYOUT);

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

async function launch() {
  const app = await electron.launch({ args: [projectRoot] });
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });
  return { app, page };
}
const sizes = (page) =>
  page.evaluate(() => {
    const r = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const ne = document.querySelector('.node-editor');
    return {
      inspector: Math.round(r('.inspector')?.width ?? -1),
      nodeEditor: ne && getComputedStyle(ne).display !== 'none' ? Math.round(ne.getBoundingClientRect().height) : 0,
      canvasH: Math.round(r('.canvas-view')?.height ?? -1),
    };
  });
async function drag(page, testid, dx, dy) {
  const b = await page.locator(`[data-testid="${testid}"]`).boundingBox();
  // grab the bar away from its toggle button
  const x = testid === 'node-editor-bar' ? b.x + b.width / 2 : b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

let { app, page } = await launch();
try {
  await resetLayout(page);
  await app.close();
  ({ app, page } = await launch());

  console.log('verify-panels (1. defaults):');
  const d = await sizes(page);
  check('Inspector starts 340 px wide', d.inspector === 340, d);
  check('node editor starts 260 px tall', d.nodeEditor === 260, d);

  console.log('verify-panels (2. drag):');
  await drag(page, 'inspector-splitter', -100, 0);
  const wide = await sizes(page);
  check('dragging the splitter left widens the Inspector by the drag', Math.abs(wide.inspector - 440) <= 2, wide);
  await drag(page, 'node-editor-bar', 0, -80);
  const tall = await sizes(page);
  check('dragging the bar up grows the node editor by the drag', Math.abs(tall.nodeEditor - 340) <= 2, tall);
  check('the canvas gives up that height', tall.canvasH < wide.canvasH - 60, { wide, tall });
  await drag(page, 'inspector-splitter', 2000, 0);
  check('the Inspector clamps at its minimum (260)', (await sizes(page)).inspector === 260, await sizes(page));
  await drag(page, 'inspector-splitter', -180, 0);

  console.log('verify-panels (3. collapse):');
  await page.locator('[data-testid="node-editor-toggle"]').click();
  await page.waitForTimeout(150);
  const collapsed = await sizes(page);
  check('the toggle hides the node editor', collapsed.nodeEditor === 0, collapsed);
  check('collapsing gives the canvas the height back', collapsed.canvasH > tall.canvasH + 200, { tall, collapsed });
  await page.locator('[data-testid="node-editor-toggle"]').click();
  await page.waitForTimeout(150);
  const reopened = await sizes(page);
  check('the toggle expands it again at the remembered height', Math.abs(reopened.nodeEditor - 340) <= 2, reopened);
  await page.locator('[data-testid="node-editor-toggle"]').click();
  await page.waitForTimeout(150);

  console.log('verify-panels (4. remembered across relaunch):');
  const before = await sizes(page);
  // the toggle's settings write is async; let it land before quitting
  await page.waitForTimeout(500);
  await app.close();
  ({ app, page } = await launch());
  const after = await sizes(page);
  check('Inspector width is remembered', after.inspector === before.inspector && after.inspector === 440, { before, after });
  check('the collapsed node editor stays collapsed', after.nodeEditor === 0, after);
  await page.locator('[data-testid="node-editor-toggle"]').click();
  await page.waitForTimeout(150);
  check('and expands at the remembered height', Math.abs((await sizes(page)).nodeEditor - 340) <= 2, await sizes(page));

  console.log('verify-panels (5. double-click resets):');
  await page.locator('[data-testid="inspector-splitter"]').dblclick();
  await page.locator('[data-testid="node-editor-bar"]').dblclick({ position: { x: 300, y: 10 } });
  await page.waitForTimeout(150);
  const reset = await sizes(page);
  check('double-click restores 340 / 260', reset.inspector === 340 && reset.nodeEditor === 260, reset);
} finally {
  await resetLayout(page).catch(() => {});
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

/**
 * Milestone 1 verify: the Electron app builds, launches, renders the layout
 * shell with React Flow, and the typed IPC round-trip works.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

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

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  console.log('verify-ms1-app:');
  check('window title is Silverbox', (await page.title()) === 'Silverbox', await page.title());

  // typed IPC round-trip (renderer → main → renderer)
  const ping = await page.evaluate(() => window.silverbox.ping());
  check('ping returns main-process pid', Number.isInteger(ping?.pid) && ping.pid > 0, ping?.pid);
  check(
    'ping returns electron/chrome/node versions',
    typeof ping?.versions?.electron === 'string' &&
      ping.versions.electron.length > 0 &&
      typeof ping.versions.chrome === 'string' &&
      typeof ping.versions.node === 'string',
    ping?.versions
  );

  // the UI reflects the successful round-trip
  await page.waitForSelector('[data-testid="ipc-status"]', { timeout: 5_000 });
  const status = await page.textContent('[data-testid="ipc-status"]');
  check('toolbar shows version info from IPC', /electron \d/.test(status ?? ''), status);

  // React Flow renders the default graph (exact shape is ms4's concern)
  const nodeCount = await page.locator('.react-flow__node').count();
  check('React Flow renders an input→…→output chain', nodeCount >= 2, nodeCount);
  const edgeCount = await page.locator('.react-flow__edge').count();
  check('React Flow renders its edges', edgeCount >= 1 && edgeCount === nodeCount - 1, { nodeCount, edgeCount });

  // layout shell
  check('canvas view present', (await page.locator('.canvas-view').count()) === 1);
  check('inspector present', (await page.locator('.inspector').count()) === 1);

  mkdirSync(join(projectRoot, 'test-artifacts'), { recursive: true });
  await page.screenshot({ path: join(projectRoot, 'test-artifacts', 'ms1-app.png') });
  console.log('screenshot: test-artifacts/ms1-app.png');
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

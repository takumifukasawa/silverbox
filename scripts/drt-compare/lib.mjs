import { mkdirSync, symlinkSync, writeFileSync, rmSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
export const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const ID = [[0, 0], [255, 255]];
export function sidecar({ rgb = ID, profile = { amount: 0, source: 'builtin', dcpPath: '' }, shader = null }) {
  const nodes = [
    { id: 'in', type: 'input', position: { x: 20, y: 60 }, lens: { distortion: 0, caRed: 0, caBlue: 0, vignette: 0, profile: { enabled: true } } },
    { id: 'dev', type: 'Develop', position: { x: 220, y: 60 }, develop: { profile, basic: { temp: 0, tint: 0 }, toneCurve: { rgb, r: ID, g: ID, b: ID },
      detail: { sharpen: { amount: 40, radius: 1, masking: 0 }, noiseLuminance: { amount: 0, detail: 50, contrast: 0 }, noiseColor: { amount: 25, detail: 50, smoothness: 50 } } } },
  ];
  const edges = [{ id: 'e0', from: 'in', to: 'dev' }];
  let last = 'dev';
  if (shader) {
    nodes.push({ id: 'drt', type: 'custom', position: { x: 420, y: 60 }, shader: { code: { src: shader, lastValidSrc: shader }, params: [] } });
    edges.push({ id: 'e1', from: 'dev', to: 'drt' });
    last = 'drt';
  }
  nodes.push({ id: 'out', type: 'output', position: { x: 620, y: 60 } });
  edges.push({ id: 'e2', from: last, to: 'out' });
  return { schemaVersion: 4, createdAt: new Date().toISOString(), graph: { nodes, edges } };
}
export function render(jobs, outDir, { maxDim = 2048, quality = 92 } = {}) {
  const work = join(outDir, '..', 'work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true }); mkdirSync(outDir, { recursive: true });
  const inputs = [];
  for (const [scene, name, sc] of jobs) {
    const p = join(work, `${scene}_${name}.ARW`);
    symlinkSync(realpathSync(join(root, 'test-assets/italy', `${scene}.ARW`)), p);
    writeFileSync(p + '.silverbox.json', JSON.stringify(sc, null, 2));
    inputs.push(p);
  }
  const ud = mkdtempSync(join(tmpdir(), 'sb-drt-ud-'));
  const r = spawnSync(join(root, 'node_modules/.bin/electron'), [root, '--render', '--json', '--max-dim', String(maxDim), '--quality', String(quality), '--out', outDir, ...inputs],
    { env: { ...process.env, SILVERBOX_USER_DATA: ud }, encoding: 'utf8', timeout: 900_000 });
  for (const l of r.stdout.split('\n').filter(Boolean)) { const j = JSON.parse(l); if (j.error) console.log('ERR', j.input, j.error); }
  console.error(r.stderr.split('\n').filter((l) => /error|warn/i.test(l)).slice(-15).join('\n'));
  console.log('exit', r.status);
}

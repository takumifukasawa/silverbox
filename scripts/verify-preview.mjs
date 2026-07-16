/**
 * Embedded-preview-first opening verify (ROADMAP "nice to have" → the
 * Lightroom trick): an ARW carries a full-size camera JPEG (Sony's
 * "JpgFromRaw" tag — see sonyLensProfile.ts's extractSonyEmbeddedPreview doc
 * comment); the store slices it out of the raw bytes and shows it as a
 * CanvasView overlay the instant extraction finishes (before libraw even
 * starts decoding), then swaps to the real render once imageStatus flips to
 * 'ready'. A separate script from verify-ms2 (which owns core decode/display
 * fundamentals): this feature's own lifecycle (overlay mount/unmount, the
 * "preview" badge, and the rapid-reopen leak/stale-overlay guard) is enough
 * surface to want its own checks, matching how every other feature since
 * ms13 (lensprofile, basecurve, hotreload, spots, …) got its own script.
 *
 * Ordering assertions only (CI-safe, no wall-clock ms):
 *  1. ARW open: the overlay appears WHILE imageState().status === 'loading',
 *     carries a blob: src, and its aspect matches the final render's aspect
 *     within 2%.
 *  2. Once status flips to 'ready': the overlay is gone and the canvas shows
 *     the real render (readbackMean non-null).
 *  3. Opening a JPEG never shows the overlay (JPEGs skip the whole path —
 *     they decode fast enough that a preview would itself be the delay).
 *  4. Two rapid consecutive opens (ARW then ARW) never leave a stale overlay
 *     or leak: the first open's blob: URL is provably revoked (tracked via
 *     openingPreviewRevocations(), not just inferred from the state going
 *     null) and the DOM ends with no overlay element.
 *  5. The 'preview' badge is present while loading, gone once ready.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { _electron as electron } from 'playwright';
import { ensureTestProjectEnv, rmLook } from './lib/testProject.mjs';

process.env.SILVERBOX_TEST = '1';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const ARW_PATH = process.env.SILVERBOX_TEST_ARW ?? 'test-assets/test.ARW';
const JPG_PATH = process.env.SILVERBOX_TEST_JPG ?? 'test-assets/test.JPG';
ensureTestProjectEnv();
for (const p of [ARW_PATH, JPG_PATH]) {
  rmLook(p); // autosave isolation, same as verify-ms2
}

if (process.env.SILVERBOX_SKIP_BUILD !== '1') {
  console.log('building…');
  execFileSync('npx', ['electron-vite', 'build'], { cwd: projectRoot, stdio: 'inherit' });
}

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

const app = await electron.launch({ args: [projectRoot] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 15_000 });

  const waitReadyOrError = () =>
    page.waitForFunction(
      () => {
        const s = window.__debug?.imageState();
        return s?.status === 'ready' || s?.status === 'error';
      },
      { timeout: 120_000 }
    );

  // Installs a fast (5ms) in-page poller that latches the FIRST
  // 'loading'-phase openingPreviewState() it sees, plus whether the overlay
  // <img> and the preview badge were actually in the DOM at that instant.
  // Runs entirely in-page (no held evaluate across the decode — the ms2
  // lesson) and self-stops once the real image reaches 'ready'/'error'.
  const armCapture = () =>
    page.evaluate(() => {
      window.__previewCapture = { seen: false };
      const iv = setInterval(() => {
        const s = window.__debug?.imageState();
        if (!window.__previewCapture.seen && s?.status === 'loading') {
          const p = window.__debug.openingPreviewState();
          if (p) {
            window.__previewCapture = {
              seen: true,
              url: p.url,
              width: p.width,
              height: p.height,
              overlayPresent: !!document.querySelector('[data-testid="opening-preview-overlay"]'),
              badgePresent: !!document.querySelector('[data-testid="preview-badge"]'),
              // Round-10 fix pack item 4: the loading chip is IN the DOM the
              // whole time imageStatus === 'loading' — its ~150ms fade-in is
              // a pure CSS opacity animation-delay (no JS timer, no
              // mount/unmount), so presence here is a reliable proxy even
              // though this poller can't observe computed opacity mid-decode.
              loadingChipPresent: !!document.querySelector('[data-testid="canvas-loading-chip"]'),
            };
          }
        }
        if (s?.status === 'ready' || s?.status === 'error') clearInterval(iv);
      }, 5);
    });

  const openFireAndForget = (path) =>
    page.evaluate((p) => {
      void window.__openImageByPath(p);
    }, path);

  // === 1 & 5. ARW open: overlay + badge appear during 'loading', match aspect ===
  console.log('verify-preview (ARW open shows the overlay while loading):');
  await armCapture();
  await openFireAndForget(ARW_PATH);
  await waitReadyOrError();
  const capture1 = await page.evaluate(() => window.__previewCapture);
  const state1 = await page.evaluate(() => window.__debug.imageState());
  check('image reaches ready', state1.status === 'ready', state1);
  check('overlay was seen during loading', capture1.seen === true, capture1);
  check('overlay carries a blob: src', typeof capture1.url === 'string' && capture1.url.startsWith('blob:'), capture1);
  check('overlay <img> was actually in the DOM while loading', capture1.overlayPresent === true, capture1);
  check('preview badge was present while loading', capture1.badgePresent === true, capture1);
  check(
    'loading chip (round-10 fix pack item 4) was present while loading',
    capture1.loadingChipPresent === true,
    capture1
  );
  const aspectPreview = capture1.width / capture1.height;
  const aspectFinal = state1.fullWidth / state1.fullHeight;
  check(
    'overlay aspect matches the final render aspect within 2%',
    Math.abs(aspectPreview / aspectFinal - 1) < 0.02,
    { aspectPreview, aspectFinal }
  );

  // === 2. Once ready: overlay gone, real render on screen ===
  console.log('verify-preview (overlay unmounts on ready, real render shows):');
  const afterReady = await page.evaluate(() => ({
    openingPreview: window.__debug.openingPreviewState(),
    overlayPresent: !!document.querySelector('[data-testid="opening-preview-overlay"]'),
    badgePresent: !!document.querySelector('[data-testid="preview-badge"]'),
    loadingChipPresent: !!document.querySelector('[data-testid="canvas-loading-chip"]'),
  }));
  check('openingPreview state cleared on ready', afterReady.openingPreview === null, afterReady);
  check('overlay <img> gone from the DOM on ready', afterReady.overlayPresent === false, afterReady);
  check('preview badge gone from the DOM on ready', afterReady.badgePresent === false, afterReady);
  check('loading chip gone from the DOM on ready', afterReady.loadingChipPresent === false, afterReady);
  const readbackMean1 = await page.evaluate(() => window.__debug.readbackMean());
  check('canvas shows the real render (readbackMean non-null)', readbackMean1 !== null, readbackMean1);

  // === 3. JPEG open never shows the overlay ===
  console.log('verify-preview (JPEG open never shows the overlay):');
  await armCapture();
  await openFireAndForget(JPG_PATH);
  await waitReadyOrError();
  const captureJpg = await page.evaluate(() => window.__previewCapture);
  const stateJpg = await page.evaluate(() => window.__debug.imageState());
  check('JPEG open reaches ready', stateJpg.status === 'ready', stateJpg);
  check('JPEG open never showed the overlay', captureJpg.seen === false, captureJpg);
  const afterJpgReady = await page.evaluate(() => ({
    openingPreview: window.__debug.openingPreviewState(),
    overlayPresent: !!document.querySelector('[data-testid="opening-preview-overlay"]'),
  }));
  check('JPEG open: no leftover preview state', afterJpgReady.openingPreview === null, afterJpgReady);
  check('JPEG open: no overlay element ever landed in the DOM', afterJpgReady.overlayPresent === false, afterJpgReady);

  // === 4. Two rapid consecutive ARW opens: no stale overlay, no leak ===
  console.log('verify-preview (rapid consecutive opens — no stale overlay, no leak):');
  const revocationsBefore = await page.evaluate(() => window.__debug.openingPreviewRevocations().length);
  await armCapture(); // latches the FIRST open's preview url (the one we need to prove got revoked)
  await openFireAndForget(ARW_PATH);
  // Deliberately NOT awaiting the first open's completion — fire the second
  // immediately, while the first is very likely still mid-decode (or even
  // still mid-extraction), which is exactly the race this check exists for.
  await openFireAndForget(ARW_PATH);
  await waitReadyOrError();
  const captureRapid = await page.evaluate(() => window.__previewCapture);
  check('first open\'s preview was observed', captureRapid.seen === true, captureRapid);
  const revocationsAfter = await page.evaluate(() => window.__debug.openingPreviewRevocations());
  check(
    "the first open's blob: URL was actually revoked (not just overwritten)",
    revocationsAfter.includes(captureRapid.url),
    { firstUrl: captureRapid.url, revocationsAfter }
  );
  check('at least one revocation happened across the two opens', revocationsAfter.length > revocationsBefore, {
    revocationsBefore,
    revocationsAfterLength: revocationsAfter.length,
  });
  const afterRapidReady = await page.evaluate(() => ({
    openingPreview: window.__debug.openingPreviewState(),
    overlayPresent: !!document.querySelector('[data-testid="opening-preview-overlay"]'),
    status: window.__debug.imageState().status,
  }));
  check('rapid-open sequence settles on ready with no stale preview state', afterRapidReady.openingPreview === null, afterRapidReady);
  check('rapid-open sequence leaves no overlay element in the DOM', afterRapidReady.overlayPresent === false, afterRapidReady);
  check('rapid-open sequence reaches ready', afterRapidReady.status === 'ready', afterRapidReady);

  // === 6. Portrait ARW: overlay renders PORTRAIT immediately, no landscape
  // flash (round-8 fix pack item 1) — same fixture convention as verify-ms2's
  // portrait section. The bare embedded-preview JPEG bytes carry no EXIF
  // orientation of their own (see sonyLensProfile.ts's EmbeddedPreview.flip
  // doc comment), so before this fix CanvasView rendered them unrotated for
  // ~1s until the real (already-rotated) decode replaced them. ===
  const PORTRAIT_ARW =
    process.env.SILVERBOX_TEST_PORTRAIT_ARW ?? 'test-assets/italy/DSC06787.ARW';
  if (!existsSync(PORTRAIT_ARW)) {
    console.log(`  SKIP  portrait overlay-orientation checks (fixture missing: ${PORTRAIT_ARW})`);
  } else {
    console.log('verify-preview (portrait ARW overlay renders portrait immediately):');
    rmLook(PORTRAIT_ARW);
    // Latches the FIRST 'loading'-phase openingPreviewState() PLUS the
    // overlay <img>'s live rendered bounding box (post CSS-rotation) at that
    // instant — same in-page-poller shape as armCapture above, plus the rect.
    await page.evaluate(() => {
      window.__portraitCapture = { seen: false };
      const iv = setInterval(() => {
        const s = window.__debug?.imageState();
        if (!window.__portraitCapture.seen && s?.status === 'loading') {
          const p = window.__debug.openingPreviewState();
          const el = document.querySelector('[data-testid="opening-preview-overlay"]');
          if (p && el) {
            const rect = el.getBoundingClientRect();
            window.__portraitCapture = {
              seen: true,
              previewWidth: p.width,
              previewHeight: p.height,
              flip: p.flip,
              rectWidth: rect.width,
              rectHeight: rect.height,
            };
          }
        }
        if (s?.status === 'ready' || s?.status === 'error') clearInterval(iv);
      }, 5);
    });
    await openFireAndForget(PORTRAIT_ARW);
    await waitReadyOrError();
    const portraitCapture = await page.evaluate(() => window.__portraitCapture);
    const portraitState = await page.evaluate(() => window.__debug.imageState());
    check('portrait ARW reaches ready', portraitState.status === 'ready', portraitState);
    check('portrait ARW reports a rotating EXIF flip (5 or 6)', portraitState.flip === 5 || portraitState.flip === 6, portraitState);
    check('overlay was seen during loading', portraitCapture.seen === true, portraitCapture);
    check(
      "overlay's extracted flip matches the real decode's flip (both read the same EXIF tag)",
      portraitCapture.flip === portraitState.flip,
      portraitCapture
    );
    check(
      'overlay RENDERED bounding box is portrait (taller than wide) WHILE LOADING',
      portraitCapture.rectHeight > portraitCapture.rectWidth,
      portraitCapture
    );
    // The bare preview JPEG bytes are UNROTATED (landscape raster) — swap its
    // dims before comparing against the final (already-rotated) decode's
    // aspect, same accounting the brief calls for.
    const swappedPreviewAspect = portraitCapture.previewHeight / portraitCapture.previewWidth;
    const finalAspect = portraitState.fullWidth / portraitState.fullHeight;
    check(
      'rotation-corrected overlay aspect matches the final render aspect within 2%',
      Math.abs(swappedPreviewAspect / finalAspect - 1) < 0.02,
      { swappedPreviewAspect, finalAspect }
    );
    const afterPortraitReady = await page.evaluate(() => ({
      overlayPresent: !!document.querySelector('[data-testid="opening-preview-overlay"]'),
    }));
    check('portrait overlay gone once ready', afterPortraitReady.overlayPresent === false, afterPortraitReady);
    rmLook(PORTRAIT_ARW);
  }
} finally {
  await app.close();
}

for (const p of [ARW_PATH, JPG_PATH]) {
  rmLook(p);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

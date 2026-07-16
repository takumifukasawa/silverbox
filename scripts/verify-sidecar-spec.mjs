/**
 * Sidecar spec verify (docs/brief-bank/git-native-completion.md §2 "the
 * verify script this brief originally called for"): keeps
 * `docs/sidecar-spec.md`'s §10 worked example honest by machine, not by
 * hand.
 *
 * Unlike every Playwright-driven verify-*.mjs script, this one does NOT
 * launch Electron — `parseGraphDoc`/`serializeGraphDoc`
 * (`src/renderer/engine/graph/graphDoc.ts`) and
 * `parseProjectManifest`/`serializeProjectManifest`
 * (`src/renderer/engine/graph/projectDoc.ts`) are pure functions with zero
 * npm-package dependencies (confirmed: every import in their dependency
 * graph is a relative sibling file; the only non-relative import,
 * `shared/ipc.ts`, is `import type`-only and erased by the TS transform).
 * That's the same "pure function, no DOM/GPU/electron" shape the vitest
 * `unit` tier already exploits for `projectDoc.test.ts`/`diffLook.test.ts`
 * (see vitest.config.ts's doc comment) — this script reaches the exact same
 * modules a different way: bundling them straight from TS source with
 * esbuild (already a devDependency, and already used this way by
 * `verify-ms0-decode.mjs` to get a browser-runnable bundle) into a plain ESM
 * file and dynamically importing it under plain Node. No app build, no
 * SILVERBOX_TEST_ARW/JPG, no test-project plumbing needed — this script
 * touches no image, no GPU, no disk state outside its own temp dir.
 *
 * Checks:
 *  1. Both `<!-- spec-example: manifest -->` / `<!-- spec-example: look -->`
 *     fenced JSON blocks are found in the doc and are valid JSON.
 *  2/3. `parseProjectManifest`/`parseGraphDoc` accept the examples unchanged.
 *  4. The look's documented wrapper fields (source/createdAt/rating/photo/
 *     fingerprint) come back exactly as written.
 *  5/6. Round-tripping each example through serialize→parse again preserves
 *     every known field, AND an unknown field injected into a COPY of each
 *     example survives the round trip (DESIGN §9 passthrough promise).
 *  7. The doc's stated schema versions ("`SIDECAR_SCHEMA_VERSION` is
 *     currently `4`" / the manifest table's "`1` (the only value accepted
 *     today)") match the real `SIDECAR_SCHEMA_VERSION`/
 *     `PROJECT_SCHEMA_VERSION` constants.
 *  8. The §7 fingerprint recipe, reimplemented here from the doc's own
 *     prose (can't import `computeFingerprint` directly — it's unexported
 *     and `src/main/index.ts` has module-scope Electron side effects that
 *     are unsafe to trigger outside a real app process), matches a golden
 *     SHA-256 hex string pinned for a fixed 200-byte test buffer and
 *     independently cross-checked via `openssl dgst -sha256` at authoring
 *     time (see the comment on FINGERPRINT_GOLDEN below).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const SPEC_PATH = join(projectRoot, 'docs/sidecar-spec.md');

let failures = 0;
const check = (name, cond, actual) => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  (actual: ${JSON.stringify(actual)})`);
  }
};

// --- 1. extract the two marked fenced JSON blocks from the spec ---------
const specText = readFileSync(SPEC_PATH, 'utf8');

function extractExample(tag) {
  const re = new RegExp('<!--\\s*spec-example:\\s*' + tag + '\\s*-->\\s*\\n```json\\n([\\s\\S]*?)\\n```', 'm');
  const m = specText.match(re);
  if (!m) {
    throw new Error(
      `could not find a "<!-- spec-example: ${tag} -->" fenced json block in docs/sidecar-spec.md §10 — ` +
        `the marker comment or the fence right after it moved, was renamed, or was deleted.`
    );
  }
  return m[1];
}

let manifestText, lookText;
try {
  manifestText = extractExample('manifest');
  lookText = extractExample('look');
  check('found the §10 manifest example (spec-example: manifest)', true, null);
  check('found the §10 look example (spec-example: look)', true, null);
} catch (err) {
  check('found both §10 worked examples', false, String(err.message));
  console.error(`\n1 check(s) failed`);
  process.exit(1);
}

let manifestJson, lookJson;
try {
  manifestJson = JSON.parse(manifestText);
  check('manifest example is valid JSON', true, null);
} catch (err) {
  check('manifest example is valid JSON (docs/sidecar-spec.md §10, project.silverbox)', false, String(err.message));
}
try {
  lookJson = JSON.parse(lookText);
  check('look example is valid JSON', true, null);
} catch (err) {
  check('look example is valid JSON (docs/sidecar-spec.md §10, looks/DSC001.ARW.json)', false, String(err.message));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

// --- bundle graphDoc.ts / projectDoc.ts straight from TS source ---------
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

const workDir = mkdtempSync(join(tmpdir(), 'silverbox-sidecar-spec-'));
let graphDocMod, projectDocMod;
try {
  const [graphDocJs, projectDocJs] = await Promise.all([
    bundleToTempModule('src/renderer/engine/graph/graphDoc.ts'),
    bundleToTempModule('src/renderer/engine/graph/projectDoc.ts'),
  ]);
  const graphDocPath = join(workDir, 'graphDoc.bundle.mjs');
  const projectDocPath = join(workDir, 'projectDoc.bundle.mjs');
  writeFileSync(graphDocPath, graphDocJs, 'utf8');
  writeFileSync(projectDocPath, projectDocJs, 'utf8');
  [graphDocMod, projectDocMod] = await Promise.all([
    import(pathToFileURL(graphDocPath).href),
    import(pathToFileURL(projectDocPath).href),
  ]);
  check('bundled graphDoc.ts via esbuild and imported it under plain Node', true, null);
  check('bundled projectDoc.ts via esbuild and imported it under plain Node', true, null);
} catch (err) {
  check('bundled graphDoc.ts/projectDoc.ts via esbuild and imported them', false, String(err.stack ?? err));
  rmSync(workDir, { recursive: true, force: true });
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

const { parseGraphDoc, serializeGraphDoc, SIDECAR_SCHEMA_VERSION } = graphDocMod;
const { parseProjectManifest, serializeProjectManifest, PROJECT_SCHEMA_VERSION } = projectDocMod;

// --- 2/3. the real parsers accept the examples unchanged ----------------
console.log('verify-sidecar-spec (the real parsers accept §10\'s examples unchanged):');

let parsedManifest, parsedLook;
try {
  parsedManifest = parseProjectManifest(manifestText);
  check('parseProjectManifest accepts the manifest example', true, null);
} catch (err) {
  check('parseProjectManifest accepts the manifest example', false, String(err.message));
}
try {
  parsedLook = parseGraphDoc(lookText);
  check('parseGraphDoc accepts the look example', true, null);
} catch (err) {
  check('parseGraphDoc accepts the look example', false, String(err.message));
}

// --- 4. the look's documented wrapper fields survive parsing exactly ----
console.log('verify-sidecar-spec (§3.1 wrapper fields come back exactly as written):');
if (parsedLook) {
  check('schemaVersion round-trips as 4', lookJson.schemaVersion === 4, lookJson.schemaVersion);
  check(
    'source block comes back exactly as written',
    parsedLook.source?.fileName === lookJson.source.fileName &&
      parsedLook.source?.cameraModel === lookJson.source.cameraModel &&
      parsedLook.source?.kind === lookJson.source.kind,
    parsedLook.source
  );
  check('createdAt comes back exactly as written', parsedLook.createdAt === lookJson.createdAt, parsedLook.createdAt);
  check('rating comes back exactly as written (4)', parsedLook.rating === lookJson.rating, parsedLook.rating);
  check('photo comes back exactly as written', parsedLook.photo === lookJson.photo, parsedLook.photo);
  check(
    'fingerprint comes back exactly as written',
    parsedLook.fingerprint === lookJson.fingerprint,
    parsedLook.fingerprint
  );
}

// --- 5/6. round-tripping preserves known fields + unknown-field passthrough
console.log('verify-sidecar-spec (round trip + unknown-field passthrough, DESIGN §9):');

if (parsedLook) {
  const rewritten = serializeGraphDoc(
    parsedLook.graph,
    parsedLook.source ?? null,
    parsedLook.createdAt ?? null,
    parsedLook.unknown,
    parsedLook.rating,
    parsedLook.photo,
    parsedLook.fingerprint
  );
  const reparsed = parseGraphDoc(rewritten);
  check(
    'look round trip (parse→serialize→parse) preserves source/createdAt/rating/photo/fingerprint',
    reparsed.source?.fileName === lookJson.source.fileName &&
      reparsed.createdAt === lookJson.createdAt &&
      reparsed.rating === lookJson.rating &&
      reparsed.photo === lookJson.photo &&
      reparsed.fingerprint === lookJson.fingerprint,
    reparsed
  );

  // Inject an unknown wrapper field into a COPY of the raw example (never
  // mutate the doc's own worked example) and confirm it survives parse AND
  // a further serialize→parse round trip.
  const lookWithUnknown = { ...lookJson, futureField: { some: 'thing', n: 3 } };
  const parsedWithUnknown = parseGraphDoc(JSON.stringify(lookWithUnknown));
  check(
    'an unknown wrapper field injected into the look example surfaces on .unknown',
    JSON.stringify(parsedWithUnknown.unknown?.futureField) === JSON.stringify(lookWithUnknown.futureField),
    parsedWithUnknown.unknown
  );
  const rewrittenWithUnknown = serializeGraphDoc(
    parsedWithUnknown.graph,
    parsedWithUnknown.source ?? null,
    parsedWithUnknown.createdAt ?? null,
    parsedWithUnknown.unknown,
    parsedWithUnknown.rating,
    parsedWithUnknown.photo,
    parsedWithUnknown.fingerprint
  );
  const reparsedWithUnknown = parseGraphDoc(rewrittenWithUnknown);
  check(
    'the injected unknown field survives a further serialize→parse round trip',
    JSON.stringify(reparsedWithUnknown.unknown?.futureField) === JSON.stringify(lookWithUnknown.futureField),
    reparsedWithUnknown.unknown
  );
}

if (parsedManifest) {
  const rewrittenManifest = serializeProjectManifest(parsedManifest);
  const reparsedManifest = parseProjectManifest(rewrittenManifest);
  check(
    'manifest round trip (parse→serialize→parse) preserves name/photos',
    reparsedManifest.name === manifestJson.name &&
      JSON.stringify(reparsedManifest.photos) === JSON.stringify(manifestJson.photos),
    reparsedManifest
  );

  const manifestWithUnknown = { ...manifestJson, futureField: { some: 'thing', n: 3 } };
  const parsedManifestWithUnknown = parseProjectManifest(JSON.stringify(manifestWithUnknown));
  check(
    'an unknown wrapper field injected into the manifest example surfaces on .unknown',
    JSON.stringify(parsedManifestWithUnknown.unknown?.futureField) === JSON.stringify(manifestWithUnknown.futureField),
    parsedManifestWithUnknown.unknown
  );
  const rewrittenManifestWithUnknown = serializeProjectManifest(parsedManifestWithUnknown);
  const reparsedManifestWithUnknown = parseProjectManifest(rewrittenManifestWithUnknown);
  check(
    'the injected unknown field survives a further serialize→parse round trip',
    JSON.stringify(reparsedManifestWithUnknown.unknown?.futureField) === JSON.stringify(manifestWithUnknown.futureField),
    reparsedManifestWithUnknown.unknown
  );
}

// --- 7. the doc's stated schema versions match the code constants -------
console.log('verify-sidecar-spec (§5/§2 stated schema versions match the source constants):');

const lookVersionMatch = specText.match(/`SIDECAR_SCHEMA_VERSION` is currently `(\d+)`/);
check(
  'found the "`SIDECAR_SCHEMA_VERSION` is currently `N`" sentence in §5',
  lookVersionMatch !== null,
  lookVersionMatch
);
if (lookVersionMatch) {
  check(
    `doc's stated look schemaVersion (${lookVersionMatch[1]}) matches SIDECAR_SCHEMA_VERSION (${SIDECAR_SCHEMA_VERSION})`,
    Number(lookVersionMatch[1]) === SIDECAR_SCHEMA_VERSION,
    { doc: lookVersionMatch[1], code: SIDECAR_SCHEMA_VERSION }
  );
}

const manifestVersionMatch = specText.match(/`schemaVersion` \| `(\d+)` \(the only value accepted today\)/);
check(
  'found the manifest table\'s "`schemaVersion` | `N` (the only value accepted today)" row in §2',
  manifestVersionMatch !== null,
  manifestVersionMatch
);
if (manifestVersionMatch) {
  check(
    `doc's stated manifest schemaVersion (${manifestVersionMatch[1]}) matches PROJECT_SCHEMA_VERSION (${PROJECT_SCHEMA_VERSION})`,
    Number(manifestVersionMatch[1]) === PROJECT_SCHEMA_VERSION,
    { doc: manifestVersionMatch[1], code: PROJECT_SCHEMA_VERSION }
  );
}

// --- 8. the §7 fingerprint recipe matches a golden reference value ------
console.log('verify-sidecar-spec (§7 fingerprint recipe matches a golden reference value):');

/**
 * Reimplements computeFingerprint's algorithm (src/main/index.ts) purely
 * from docs/sidecar-spec.md §7's prose — NOT imported from main/index.ts,
 * since computeFingerprint is unexported and that module has top-level
 * Electron side effects (app/ipcMain wiring) unsafe to trigger outside a
 * real Electron process. This is the "reference implementation" the brief
 * asks for: an independent transcription of the documented recipe, checked
 * below against a golden hex string.
 */
function docRecipeFingerprint(buf) {
  const size = buf.length;
  const headLen = Math.min(65536, size);
  const tailLen = Math.min(65536, size);
  const head = buf.subarray(0, headLen);
  const tail = buf.subarray(size - tailLen, size);
  const sizePrefix = Buffer.alloc(8);
  sizePrefix.writeBigUInt64LE(BigInt(size));
  const hash = createHash('sha256');
  hash.update(sizePrefix);
  hash.update(head);
  hash.update(tail);
  return hash.digest('hex');
}

// Fixed 200-byte test buffer (bytes 0..199 repeating the 0-255 ramp once,
// well under the 64 KiB head/tail window so head and tail are IDENTICAL
// full-buffer copies per §7's "for a file smaller than 128 KiB, head and
// tail overlap" note). Expected value computed once at authoring time via
// `openssl dgst -sha256` over the exact byte sequence sizeLE64++head++tail
// — a tool with no code-path in common with either computeFingerprint or
// docRecipeFingerprint above, so this is a real independent cross-check,
// not a self-fulfilling comparison.
const FIXED_BUFFER = Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256));
const FINGERPRINT_GOLDEN = 'cee48486174b603fe7b7ed941740731873809af4f7ed8265871a9d67568e12f9';

check(
  'docRecipeFingerprint(FIXED_BUFFER) matches the openssl-cross-checked golden hex',
  docRecipeFingerprint(FIXED_BUFFER) === FINGERPRINT_GOLDEN,
  docRecipeFingerprint(FIXED_BUFFER)
);
check('fingerprint is 64 lowercase hex characters', /^[0-9a-f]{64}$/.test(docRecipeFingerprint(FIXED_BUFFER)), docRecipeFingerprint(FIXED_BUFFER));

rmSync(workDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

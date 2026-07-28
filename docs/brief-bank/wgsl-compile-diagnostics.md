# Brief: surface built-in WGSL compile failures (no more silent black passes)

Status: DESIGN-READY (Fable, 2026-07-28) — dispatchable. Prompted by a
real bug this session: the LUT node's first WGSL struct field was named
`meta` (a reserved WGSL identifier); Dawn produced an INVALID pipeline
with NO surfaced error, so the pass rendered black and the only symptom
was a failing verify with no diagnostic. Cost ~an hour to localize.

## The gap (grounded, premise-corrected)

Compile diagnostics DO exist — `engine/shader/validateWgsl.ts` runs
`getCompilationInfo()` + a validation error scope on a DEDICATED device,
and is wired into the CUSTOM-shader-node path (customShaderNode's
artifact cache) so user-authored WGSL reports errors.

But the BUILT-IN pass shaders are NOT checked. `graphRenderer.ts`'s
`passPipeline()` (~967) and every `*PipelineCache` getter (imageGray,
imageCover, externalPassthrough/encode/decode, ENCODE_SHADER, the new
LUT3D_SHADER, etc.) call `device.createShaderModule({ code })` then
`createRenderPipeline(...)` with NO `getCompilationInfo()` and NO error
scope. A compile error in one of OUR shaders → invalid pipeline → black
output, silently. Nothing logs, nothing throws.

## The fix (dev/test-mode diagnostic, zero prod hot-path cost)

Add a small helper that, AFTER a built-in `createShaderModule`, fires an
ASYNC compile check and reports LOUDLY on error — without blocking the
synchronous, cached pipeline-creation path:

```ts
function assertShaderCompiles(module: GPUShaderModule, shaderId: string): void {
  if (!__DEV_OR_TEST__) return; // stripped/no-op in prod
  void module.getCompilationInfo().then((info) => {
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
      const detail = errors.map((m) => `L${m.lineNum}: ${m.message}`).join('\n');
      // Loud + attributable: console.error AND throw-in-test so a verify
      // script fails with the real reason instead of a mystery black pass.
      console.error(`[wgsl] built-in shader "${shaderId}" failed to compile:\n${detail}`);
      if (__TEST__) throw new Error(`WGSL compile error in "${shaderId}":\n${detail}`);
    }
  });
}
```

- Call it right after EACH built-in `createShaderModule` in graphRenderer
  (passPipeline + every `*PipelineCache` getter + lut3dPipeline). Pass a
  stable `shaderId` (the cache key / a literal name) so the message names
  the culprit.
- Use `getCompilationInfo()` on the MODULE (module-scoped, clean) — do
  NOT push/pop an error scope on the LIVE render device (error scopes are
  stateful and could entangle with real render errors). getCompilationInfo
  is the right tool for "did THIS module compile".
- Gate on dev/test (however this codebase already distinguishes — check
  for an existing `import.meta.env.DEV`, a NODE_ENV check, or a test flag
  used elsewhere; reuse it, don't invent a new global). In prod the helper
  is an early-return no-op — the sync createShaderModule/createRenderPipeline
  path is completely unchanged, so zero hot-path or first-frame regression.
- Fire-and-forget (`void ...then`) — never make pipeline creation async;
  the diagnostic races the first frame but that's fine, its job is to make
  the NEXT dev/verify run scream instead of rendering black in silence.

## Verify

- Add a unit or a tiny verify hook: feed a deliberately-broken built-in
  shader (e.g. a fixture with a reserved identifier like `meta`, or a
  syntax error) through the same module-check helper and assert it
  reports/throws with the shaderId + a line number. Guard it so it does
  NOT run the broken shader through the real renderer (that's the point —
  catch it at compile).
- Confirm every EXISTING built-in shader passes the check (no false
  positives) — the full verify suite already exercises them; with the
  helper in test-mode-throw, a green SUITE is itself the proof.

## Read before writing

engine/shader/validateWgsl.ts (the existing getCompilationInfo pattern to
mirror — but module-scoped, not a second device), graphRenderer.ts
(passPipeline ~967 + all `*PipelineCache` getters + the new lut3dPipeline
+ setLutTexture path), how the codebase flags dev/test (grep for
import.meta.env / NODE_ENV / an existing test flag).

## Standing rules

Gate loop foreground (typecheck, test:unit, verify; SUITE line). NEVER
git add/commit. zsh `=` hazard. Engine invariants untouched (this only
ADDS a diagnostic, changes no shader/output). Prod path must stay
byte-identical (dev/test-gated). English code.

## Report back

Files touched; the dev/test flag reused (file:line); every built-in
createShaderModule call site the check now covers; the broken-shader test
+ that it reports the shaderId/line; confirmation the prod path is
unchanged (helper is a no-op there); SUITE line + unit count.

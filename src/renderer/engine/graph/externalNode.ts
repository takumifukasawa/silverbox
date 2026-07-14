/**
 * External-tool hook node (denoise v1, task #41): one input, one output — a
 * chain op whose "op" is an arbitrary user-configured command run out of
 * process (main process only — sub-processes never spawn from the renderer,
 * see externalTool.ts). Doc-shape module only (params/sanitizer/argv
 * splitting), same split as spotsNode.ts/maskNode.ts: the actual round trip
 * (GPU readback → main-process subprocess → GPU re-entry) lives in
 * graphRenderer.ts/externalNodeRunner.ts.
 *
 * `command` is a Makefile-rule-style template with `{in}`/`{out}` path
 * placeholders, e.g. `gmic {in} -denoise_patchpca 5 -o {out},uint8` (the
 * `,uint8` suffix is required — this build can only read 8-bit tool output
 * back, see externalTool.ts's doc comment) — split into an
 * argv array OURSELVES (never a shell) so quoting is the user's own explicit
 * responsibility, not a shell-injection surface: a command is spawned via
 * child_process.execFile with shell:false (see externalTool.ts), which never
 * interprets `;`, `&&`, `$()`, backticks, or globs. Simple double-quoted
 * tokens are supported (`"my tool" {in} --out {out}`) for paths/args with
 * spaces; anything fancier (nested quotes, `$VAR` expansion) is out of scope
 * for v1 — the inspector hint documents this.
 *
 * `encoded` (default true) selects the color-space boundary applied at the
 * node's edges, both directions, via the engine's own exact shared helpers
 * (graphRenderer.ts's EXTERNAL_ENCODE_SHADER/EXTERNAL_DECODE_SHADER — the
 * SAME WORK_TO_SRGB matrix + exact sRGB OETF/EOTF every export/preview exit
 * uses): true pipes sRGB-encoded pixels (what virtually every external
 * denoiser expects — display-referred TIFF values); false pipes linear
 * Rec.2020 pixels (clamped to [0,1] at the wire boundary — see below) for a
 * color-space-aware tool that wants to stay a genuine graph citizen
 * (composable before/after grading, not just a final-export step).
 *
 * BIT DEPTH (v1 deviation from the original 16-bit/float design — see
 * src/main/externalTool.ts's doc comment for the full story): both modes
 * currently round-trip as plain 8-BIT TIFF, not 16-bit-encoded/32-bit-float
 * — a confirmed limitation of the bundled sharp/libvips TIFF writer in this
 * environment, not a design choice. `linear` mode's highlights above 1.0
 * clip at this wire boundary as a result. Only externalTool.ts (and its
 * verify fixture) need to change to lift this once a working sharp
 * incantation (or an alternate encoder) is found.
 */
export { splitCommandTemplate, substituteArgv } from '../../../../shared/externalTool';

export const EXTERNAL_KIND = 'external';

export interface ExternalParams {
  /** `{in}`/`{out}` path template — see this file's doc comment. Empty = identity (bit-exact pass-through, no pass emitted). */
  command: string;
  /** true = sRGB-encoded TIFF round trip (default); false = linear Rec.2020 (clamped [0,1] at the wire boundary — see this file's BIT DEPTH note). */
  encoded: boolean;
}

export function defaultExternalParams(): ExternalParams {
  return { command: '', encoded: true };
}

/** Empty command ⇒ IDENTITY — buildPlan skips emitting the pass entirely (bit-exact pass-through), same invariant every other node kind upholds. */
export function isIdentityExternal(p: ExternalParams): boolean {
  return p.command.trim() === '';
}

/** Normalize an untrusted external payload; throws on structural garbage (maskNode.ts/spotsNode.ts convention) — never executes anything at parse time regardless of what `command` says (see the SECURITY note in externalNodeRunner.ts). */
export function sanitizeExternalParams(raw: unknown, nodeId: string): ExternalParams {
  const base = defaultExternalParams();
  if (typeof raw !== 'object' || raw === null) return base;
  const src = raw as { command?: unknown; encoded?: unknown };
  if (src.command !== undefined && typeof src.command !== 'string') {
    throw new Error(`${nodeId}.external.command must be a string`);
  }
  if (src.encoded !== undefined && typeof src.encoded !== 'boolean') {
    throw new Error(`${nodeId}.external.encoded must be a boolean`);
  }
  return {
    command: typeof src.command === 'string' ? src.command : base.command,
    encoded: typeof src.encoded === 'boolean' ? src.encoded : base.encoded,
  };
}


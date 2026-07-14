/**
 * External-tool hook node (denoise v1, task #41) — pure argv helpers shared
 * by BOTH bundles: the renderer's inspector (to preview the parsed command)
 * and the main process's actual execFile call (src/main/externalTool.ts).
 * Living in shared/ (like ipc.ts) rather than src/renderer/engine/graph/
 * because src/main is a separate bundle that never imports src/renderer (see
 * src/main/lutExport.ts's doc comment for the same constraint).
 *
 * `command` is a Makefile-rule-style template with `{in}`/`{out}` path
 * placeholders, e.g. `gmic {in} -denoise_patchpca 5 -o {out}` — split into an
 * argv array OURSELVES (never a shell) so quoting is the user's own explicit
 * responsibility, not a shell-injection surface: main spawns via
 * child_process.execFile with shell:false, which never interprets `;`, `&&`,
 * `$()`, backticks, or globs. Simple double-quoted tokens are supported
 * (`"my tool" {in} --out {out}`) for paths/args with spaces; anything
 * fancier (nested quotes, `$VAR` expansion) is out of scope for v1 — the
 * inspector hint documents this.
 */

/**
 * Split a command template into an argv array — shell:false, so this is the
 * ONLY quoting silverbox ever applies. Whitespace-separated tokens; a
 * double-quoted token (`"...text..."`) keeps its interior whitespace and
 * sheds the quotes, matching the common "one path with spaces" case without
 * pulling in a full shell-quoting grammar (no escapes, no single quotes, no
 * nesting).
 */
export function splitCommandTemplate(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    out.push(m[1] !== undefined ? m[1] : m[2]!);
  }
  return out;
}

/**
 * Substitute every `{in}`/`{out}` occurrence with the resolved temp file
 * paths — SUBSTRING replacement within each token (not whole-token-only):
 * gmic's own output-type suffix syntax glues a type name directly onto the
 * placeholder (`-o {out},uint8`, see src/main/externalTool.ts's doc comment
 * for why 8-bit output is required), so "a path never needs to appear glued
 * to other text" turned out false in practice. Still injection-safe: no
 * shell is ever involved (execFile, shell:false — see this file's own doc
 * comment), so a substring replace here can't introduce any new
 * interpretation of `;`, `&&`, `$()`, etc. — it only changes which bytes end
 * up inside one argv element.
 */
export function substituteArgv(argv: string[], inPath: string, outPath: string): string[] {
  return argv.map((tok) => tok.replaceAll('{in}', inPath).replaceAll('{out}', outPath));
}

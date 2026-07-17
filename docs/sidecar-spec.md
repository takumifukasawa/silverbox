# Sidecar & project spec — the container contract

This document is the authoritative, human-and-AI-readable specification of
the **container** formats Silverbox reads and writes on disk: the project
manifest (`project.silverbox`) and the per-photo look file inside `looks/`
(historically called "the sidecar"). It exists so that anything able to
write JSON — a human in a text editor, a script, an AI coding agent — can
produce a document Silverbox will load correctly, and so that a human or AI
reading an existing document can tell what every wrapper key means and
whether it's safe to leave alone.

**Audience**: this spec is written for two readers at once — a person
reading the code for the first time, and an AI tool generating or editing a
look file by hand (the git-native / AI-loop thesis: the sidecar is the AI's
UI). Where the two would want different things, the AI reader wins, because
getting the container contract exactly right is what makes hand-authored
edits round-trip safely.

**Scope**: this is about the *container* — what wraps the graph, how a
project is laid out, what's promised to survive forever. It is deliberately
**not** a param-by-param reference for every node kind (ranges, defaults,
per-op formulas). The graph body is covered at a summary level with a
pointer to the source of truth: `src/renderer/engine/graph/graphDoc.ts` (and
the per-kind files it composes — `developNode.ts`, `maskNode.ts`,
`spotsNode.ts`, `imageNode.ts`, `externalNode.ts`, `ops.ts`). A generator
script to keep this doc in sync was considered and rejected — it would rot
silently; the verify suite (`npm run verify:sidecar-spec`, described below)
pins the one thing that must never drift: this doc's own worked example
still parses.

---

## 1. Project folder layout

A **project** is a plain, user-visible folder — something to open in
Finder, inspect, and put under git. There is exactly one storage model (no
"catalog vs. sidecar" dual mode):

```
MyProject/
  project.silverbox     ← entry point: JSON manifest + playlist
  looks/
    DSC001.ARW.json      ← one look file per photo
    DSC002.ARW.json
    DSC001-2.ARW.json    ← collision suffix (see "look-name derivation" below)
```

- `project.silverbox` is the manifest: schema version, project name, and the
  **playlist** (which photos belong to this project and which look file
  under `looks/` holds each one's develop history). Double-clicking it opens
  the app on that project (packaged builds only — see
  `docs/brief-bank/project-storage.md`).
- `looks/<name>.json` files are byte-format identical to the historical
  adjacent sidecar (§3 below), plus two project-storage additions: `photo`
  and `fingerprint` (§3.1).
- **The app never writes into photo folders.** Every write Silverbox makes
  lands inside the active project's own directory. Photos themselves are
  never copied or moved into the project — the manifest just points at them
  (relative path when the photo lives inside the project directory, absolute
  when it doesn't — an out-of-tree relative path would depend on how far the
  project folder itself later moves, so it is never written; a manifest from
  an older Silverbox with a `../`-style out-of-tree path still resolves, and
  is normalized to absolute the next time the manifest is rewritten).
- A project with no explicit home yet (opening a photo with nothing active)
  lands in the **Quick project**, a real folder at a fixed, visible,
  settings-overridable location (default `~/Silverbox/Quick/`) — never an
  app-internal cache directory. It has the exact same on-disk shape as any
  other project.

Legacy **adjacent sidecars** (`<image>.silverbox.json`, sitting right next
to the photo — the pre-project storage model) are a separate, still-valid
shape covered in §6. They are read-only from the app's point of view now;
nothing new is ever written there.

---

## 2. The project manifest (`project.silverbox`)

Source of truth: `src/renderer/engine/graph/projectDoc.ts`
(`ProjectManifest`, `serializeProjectManifest`, `parseProjectManifest`).

```jsonc
{
  "schemaVersion": 1,
  "name": "Italy 2026",
  "photos": [
    { "path": "DSC001.ARW", "look": "DSC001.ARW.json" },
    { "path": "/elsewhere/DSC900.ARW", "look": "DSC900.ARW.json" }
  ]
}
```

| Key | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` (the only value accepted today) | Manifest format version. |
| `name` | non-empty string | Project display name (title bar, "Save as project…" default). |
| `photos` | array of `{ path, look }` | The playlist: every photo this project knows about, and which `looks/` file holds its develop history. |
| `photos[].path` | string | Photo location. **Relative-to-the-project-dir when the photo lives inside it** (the common in-tree case); **absolute when it doesn't** — a photo outside the project is never stored as a `../`-relative path (see `relativizeProjectPath`'s doc comment for why: it would depend on how far the project folder itself later moves). `resolveProjectPath` still accepts an older `../`-style relative path for a photo outside the project (read-side compat only — a manifest written by this policy or later never produces one; `.`/`..` segments resolve manually, the renderer has no `node:path` — contextIsolation). |
| `photos[].look` | string | A **bare filename** inside `looks/` — never a path, never containing a `/`. |

**Unknown-field preservation promise**: any wrapper-level key the parser
doesn't recognize (currently everything except `schemaVersion`/`name`/
`photos`) is preserved verbatim across a load→save round trip. A future
Silverbox version's new manifest field, opened by today's build, survives
being re-saved by today's build untouched. This is DESIGN.md principle 9
("documents outlive versions"), applied to the manifest exactly as it
applies to the look file (§3).

**Look-name derivation** (`deriveLookName` in `projectDoc.ts`): when a photo
is newly added to a project, its look filename is `<basename>.json`
(`DSC001.ARW` → `DSC001.ARW.json`); if that name is already taken by a
*different* photo already in the project (e.g. two `DSC001.ARW` files from
different cards), the suffix `-2`, `-3`, … is appended before `.json` until
one is free. A photo already on the playlist always reuses its existing
`look` name — this derivation only runs once, the first time a photo is
added.

**Writing**: pretty-printed (`JSON.stringify(..., null, 2)`), newline-
terminated, so it diffs cleanly in git — same convention as the look file.
Written atomically (temp file in a sibling `.silverbox-save-*` dir, then
`rename()` into place) so a crash mid-save can never leave a truncated
manifest.

---

## 3. The look file (the "sidecar")

Source of truth: `src/renderer/engine/graph/graphDoc.ts`
(`SidecarDoc`, `serializeGraphDoc`, `parseGraphDoc`).

A look file is one JSON document per photo: a wrapper of metadata around a
`graph` body. Current schema version: **4**.

```jsonc
{
  "schemaVersion": 4,
  "source": {
    "fileName": "DSC001.ARW",
    "cameraModel": "ILCE-7RM4",
    "kind": "raw"
  },
  "createdAt": "2026-07-11T09:14:02.000Z",
  "updatedAt": "2026-07-16T18:30:47.512Z",
  "rating": 4,
  "photo": "DSC001.ARW",
  "fingerprint": "9f2c7a1e4b3d5f60...(64 hex chars)...",
  "graph": {
    "nodes": [ /* … see §4 … */ ],
    "edges": [ /* … see §4 … */ ]
  }
}
```

### 3.1 Wrapper keys

| Key | Type | Required? | Meaning |
|---|---|---|---|
| `schemaVersion` | `2 \| 3 \| 4` | always written; `2`/`3` still parse (§5) | Format version. |
| `source` | `{ fileName, cameraModel?, kind: 'raw'\|'jpg' }` | optional | Provenance: what file/camera this look was created against. Informational — never affects rendering. |
| `createdAt` | ISO-8601 string | optional | When the look was first created; preserved across every subsequent save. |
| `updatedAt` | ISO-8601 string | written on every save | Last-write timestamp; not read back into any typed field (round-trips as part of the wrapper). |
| `rating` | integer 0–5 | optional, **omitted entirely at 0** | Star rating of the *photo*, not the look — lives on the wrapper, not inside `graph`, so rating a photo never touches develop history. Malformed/out-of-range values sanitize quietly to `0` rather than rejecting the whole document. |
| `flag` | `"pick"` \| `"reject"` | optional, **omitted entirely when absent (unflagged)** | Pick/reject flag of the *photo* (reject-flag pack) — an axis independent of `rating`: rejecting a photo never clears its stars, and vice versa. Same wrapper-level, never-touches-`graph` placement as `rating`. Any other value sanitizes quietly to absent rather than rejecting the whole document. Reject is metadata only — the app never offers a "delete rejected" workflow (catalog-slope guard, DESIGN.md). |
| `photo` | string | optional | The photo's path, **relative to the project directory** (absolute if out-of-tree) — added by the project-storage migration so a look file knows which photo it belongs to (it no longer lives next to it). Absent on legacy adjacent sidecars and on preset/`captureLook` output (a preset is a look, not a per-photo document). |
| `fingerprint` | 64-char lowercase hex string | optional | Cheap content hash of the photo file — see §7 for the exact recipe. Used by Relink to verify a candidate replacement is (probably) the same photo. Absent on every look saved before this field existed, and on presets. |
| `graph` | `{ nodes: [...], edges: [...] }` | required | The node graph — see §4. |
| *(anything else)* | any | — | **Unknown-field passthrough**: any wrapper key not in the table above is preserved verbatim across a load→save round trip (surfaced on the parsed `SidecarDoc.unknown`, re-spread on serialize with known keys winning on conflict). |

Node- and edge-level objects follow the identical convention: any key not in
`graphDoc.ts`'s `KNOWN_NODE_KEYS`/`KNOWN_EDGE_KEYS` rides along untouched.

### 3.2 What writes `photo` and `fingerprint`

- `photo` is written on every save made while a project is active (the
  autosave path, `⌘S`, "Import sidecars from folder…", Relink). A
  `legacySidecarOnly` session (no project — should not occur post-migration,
  but the code path exists defensively) writes the exact same bytes as
  before this field existed: no `photo` key at all.
- `fingerprint` is computed once per photo path per app session and written
  alongside `photo`; it is recomputed if it's still absent, or if the look's
  recorded `photo` no longer matches what's about to be written (the one way
  that happens mid-session is a Relink repointing this same look at a
  different photo).
- Both fields are **omitted from the JSON entirely** when not applicable —
  never written as `null` or `""`. This keeps a preset's `captureLook`
  round-trip (which never has a project or a `photo` to hash) byte-identical
  to how it looked before either field existed.

### 3.3 Identity-omission convention

Every optional block on a node (`mask`, `spots`, `image`, `external`,
`shader`, `export`, `name`, `disabled`) is omitted from the written JSON
when it's at its identity/default value, and the corresponding pass is not
emitted at render time — an untouched node is a bit-exact pass-through, and
its absence in the JSON is not merely cosmetic, it's load-bearing for diffs:
touching one slider should produce a small, readable git diff, not a
rewrite of every node's block.

---

## 4. The graph body

`graph.nodes` and `graph.edges` are the node-graph itself — the executable
document. **This spec does not duplicate the per-node-kind param schema**;
that lives in `graphDoc.ts` and the files it composes, and changes often
enough that a second copy here would drift. What follows is the summary
every reader needs to orient themselves.

### 4.1 Node kinds

| `type` | One-line summary | Detail lives in |
|---|---|---|
| `input` | The decoded source image; carries non-destructive `geometry` (crop/straighten/orientation) and `lens` (manual distortion/CA/vignette + Sony embedded-profile toggle). | `graphDoc.ts` (`GeometryParams`, `LensParams`) |
| `output` | A named render target (`name`, default `'main'`); may carry per-output `export` overrides (quality/maxDim/metadata/colorSpace). | `graphDoc.ts` (`ExportOverrides`) |
| `Develop` | The sectioned "basic develop" node (exposure, white balance, tone curve, color, HSL, B&W conversion, grading, detail, grain, profile…) — most everyday edits live here. | `developNode.ts` |
| `exposure`, `whitebalance`, `contrast`, `tonecurve`, `saturation`, `vibrance`, `brightness` | Single-purpose op nodes — the node-editor's building blocks, each a matched WGSL+CPU pair. | `ops.ts` |
| `custom` | User-authored WGSL fragment shader with a typed GUI param list. | `customShaderNode.ts` |
| `blend` | Two-input compositor (`a`/`b` ports) with an optional `mask` port; `amount` mixes a→b. | `ops.ts` (`BLEND_KIND`) |
| `mask` | Analytic mask shapes (radial/linear), coordinates stored in **anchor space** (§4.3). | `maskNode.ts` |
| `spots` | Non-destructive clone-circle list (spot removal), also anchor-space. | `spotsNode.ts` |
| `image` | Reference to another image file on disk (composite/mask-by-file). | `imageNode.ts` |
| `external` | External-tool hook: a `{in}`/`{out}` command template run as a subprocess round trip (e.g. an external denoiser). | `externalNode.ts` |

### 4.2 Edges and ports

An edge is `{ id, from, to, port? }` (serialized field names — internally
`source`/`target`/`targetHandle`). `port` selects which input of a
multi-input node the edge feeds: `'a'`/`'b'` for a blend's base/overlay,
`'mask'` for a blend's optional mask input; absent means the target's
single primary input. `port` was named `targetHandle` directly in
schema v2; v3 formalized the same concept under the `port` key (see §5).

### 4.3 Anchor-space coordinates

Mask shapes and spot centers/radii are stored normalized against the
**oriented, pre-crop, pre-rotation** frame ("anchor space"), not the final
output frame — so cropping or straightening never re-points a mask at
different image content. The full coordinate-conversion math (anchor↔output)
is documented in `src/renderer/engine/graph/anchorSpace.ts`. A hand-authored
look with identity geometry (the common case) never needs to think about
this: anchor space and output space coincide exactly when crop is full and
angle is 0.

**Known limitation (round-11 decode-frame fix):** anchor space is normalized
against the *decoded* frame's own dimensions, which changed for Sony ARWs
when the decoder started applying the camera's embedded `raw_inset_crops`
recommendation instead of libraw's own (too-large, off-origin) default frame
— see `src/renderer/engine/decoder/librawDecoder.ts`'s `computeCropbox` doc
comment for the full story. A spot/mask authored against the OLD decoded
frame (any look saved before this fix, on a Sony ARW) is anchored to a
normalized fraction of a frame whose origin has since shifted by a real,
per-shot amount (tens of pixels, not a fixed constant) — reopening that look
will show the spot/mask offset from where it was placed. The sidecar has no
field recording which decode frame a look was authored against, and the
shift is per-shot (depends on that file's own `raw_inset_crops`), so there is
no safe automatic migration: `SIDECAR_SCHEMA_VERSION` was **not** bumped for
this, and no compensation is applied on load. Affected looks need their
spots/masks manually nudged back into place after reopening once. The
clamped-shot decode frame changed dimensions again in the round-12
center-preserving-clamp follow-up (`computeCropbox`'s doc comment) — same
no-silent-migration policy, no new field, no version bump.

### 4.4 Bypass

Any node except `input`/`output`/`image` may carry `"disabled": true`
(omitted, i.e. absent, means active — the default). A disabled node
resolves to its own upstream input, same as an identity-valued node. This
key is additive to schema v4 with no version bump: an older build that
doesn't know about it round-trips the key verbatim but renders every node
active (forward-compat, not data loss).

---

## 5. Versioning & migration promises

`SIDECAR_SCHEMA_VERSION` is currently `4`. `parseGraphDoc` accepts `2`, `3`,
and `4` — **every previous version loads correctly, forever** (DESIGN.md
principle 9). What changed at each bump:

- **v2** (historical baseline): edges carry `targetHandle` directly; no
  `mask` node kind; no output `name`. Loads byte-semantically identically to
  how it always did.
- **v3**: edges formalize the same port concept under the key `port` instead
  of `targetHandle` (parser reads whichever key matches the doc's own
  version). No other change to loading semantics.
- **v4**: mask/spot coordinates are stored in **anchor space** (§4.3)
  instead of the old post-geometry output frame. A v2/v3 doc's coordinates
  are migrated automatically on load (`migrateCoordsToAnchor`) using the
  doc's own input-node geometry; a doc with identity geometry — the
  overwhelming majority — is unaffected (the migration is a no-op).

Every look written by the app today is stamped `schemaVersion: 4`. A
hand-authored or AI-generated look should also write `4` unless there's a
specific reason to target an older parser's exact behavior.

**Pre-`photo`-field looks** (anything saved before the project-storage
migration, or a legacy adjacent sidecar — see §6) simply lack the `photo`
and `fingerprint` keys; they parse exactly as before, with those two fields
absent on the returned `SidecarDoc`. There is no version bump associated
with either field — they were added additively, the same way `rating` and
`disabled` were.

---

## 6. Legacy adjacent sidecars

Before the project-storage migration, every look lived at
`<image>.silverbox.json`, right next to the photo (e.g.
`DSC001.ARW.silverbox.json` beside `DSC001.ARW`). That placement is
**retired as a write target** — the app will never create one again — but:

- **They remain readable forever.** `readSidecar` accepts either shape: a
  legacy adjacent sidecar (matched by the `.silverbox.json` suffix) or a
  project look file (matched by living inside a `looks/` directory).
  Byte-format is otherwise identical to §3 — same wrapper, same `graph`
  body — they simply predate (and therefore lack) `photo`/`fingerprint`.
- **`writeSidecar` refuses to write one.** Writes are only accepted for a
  path structurally inside some project's `looks/` directory — a caller
  cannot write an adjacent sidecar even by mistake, which is how the "the
  app never writes into a photo folder" etiquette rule is enforced rather
  than merely conventional.
- **"Import sidecars from folder…"** copies a legacy sidecar's parsed
  content into the active project's `looks/` (adding fresh `photo`/
  `fingerprint` fields) and appends the photo to the playlist — the
  original adjacent file is left untouched.
- Opening a photo that has an adjacent sidecar but no look yet in the active
  project offers a one-click import of exactly this kind (never a silent
  read as live state).

An AI tool that finds a `<image>.silverbox.json` file should treat it as
read-only reference material, not a place to write a new edit — write into
the active project's `looks/<name>.json` instead (or hand the human a look
file to import).

---

## 7. The fingerprint recipe (stability contract)

Source of truth: `computeFingerprint` in `src/main/index.ts`. This recipe
**must never change** once shipped — a look's stored `fingerprint` is
compared against a *fresh* computation of this same function on a relink
candidate; changing the recipe would silently break every fingerprint ever
written.

Given a file at `path`:

1. `size` = the file's size in bytes.
2. `head` = the file's first `min(65536, size)` bytes.
3. `tail` = the file's last `min(65536, size)` bytes.
4. Hash `SHA-256(sizeLE64 ++ head ++ tail)`, where `sizeLE64` is `size`
   encoded as an 8-byte **little-endian** unsigned integer.
5. The fingerprint is the digest rendered as **lowercase hex** (64
   characters).

For a file smaller than 128 KiB, `head` and `tail` overlap (or are
identical) — this is fine; the recipe is still fully deterministic given the
file's bytes. Reading only head+tail (never the whole file) keeps this cheap
even for a 60 MB+ RAW.

A hand-authored look may omit `fingerprint` entirely (relink then falls back
to unverified basename matching) but must never write a value computed by
any other recipe — a fingerprint that doesn't match this algorithm is
strictly worse than none, since it will silently fail every future
comparison.

---

## 8. What the CLI accepts

`silverbox-render` (see `src/main/cliArgs.ts`'s `CLI_USAGE`, or
`npm run render -- --help`) takes plain image paths (`.arw`/`.jpg`/…, each
rendered with its own sidecar-or-default look), look-file paths ending in
`.json` (rendered as-is, geometry included, resolving that look's `photo`
field relative to its own project directory — a look with no `photo` field
is a clear error naming the fix), and `--project <dir>` (accepts either the
project directory or a path to its own `project.silverbox`; a relative
`.json` argument then resolves against that directory instead of the
launch `cwd`, and a photo not on the project's playlist renders with the
default look plus a stderr warning rather than being silently added). Full
flag reference — presets, per-output export overrides, golden renders
(`--check`/`--update`), and the sidecar visual diff (`--diff`) — lives in
`CLI_USAGE`; do not duplicate it here.

---

## 9. Rules for writers (read this before hand-authoring a look)

A generator — human or AI — producing a look file or project manifest by
hand should respect:

1. **Always stamp `schemaVersion`.** Write `4` for a look file, `1` for a
   project manifest, unless you have a specific reason to target an older
   parser.
2. **Omission means identity, not "value unknown."** Leave optional node
   blocks (`mask`, `spots`, `shader`, `export`, …) and wrapper fields
   (`rating`, `photo`, `fingerprint`, `source`, `createdAt`) out entirely
   rather than writing an empty object/`null`/`0` — the parser fills
   identity defaults for anything absent, and this is what keeps diffs
   small and intentional.
3. **Unknown fields are safe to add, and safe to leave alone.** Both
   parsers preserve wrapper-level (and node/edge-level, for the graph)
   keys they don't recognize across a round trip. You may stage a future
   field this way; you should never assume an unrecognized field will be
   silently dropped.
4. **Write atomically.** The app's own writers (`writeSidecar`,
   `writeProjectManifest`) write to a sibling temp file and `rename()` into
   place, specifically so the hot-reload file watcher (which relies on
   losing/regaining the file's identity across a rename) and any concurrent
   reader never observe a half-written file. An external tool editing a
   look in place for the hot-reload loop should do the same — write-then-
   rename, not an in-place truncate+write.
5. **Never invent a `fingerprint`.** Either compute it with the exact
   recipe in §7, or omit the key.
6. **`photos[].look` is a bare filename**, never a path — no `/`, no `..`.
7. **A malformed *value* (bad `rating`, bad `fingerprint` type) sanitizes
   quietly**; a malformed *shape* (not an object, missing `id`, an
   unresolvable DAG, a non-finite param number) throws and rejects the
   whole document. When in doubt, prefer omitting a field over guessing at
   a value that might reject the file outright.
8. **Every output must resolve.** `parseGraphDoc` runs `buildPlan` against
   every output node as part of validation — a graph with a cycle, a
   dangling edge, or zero output nodes is rejected at parse time, not at
   render time.

---

## 10. Full worked example

A project with one photo that's been rated, exposure-adjusted, and given a
radial vignette mask.

**`MyProject/project.silverbox`**

<!-- spec-example: manifest -->
```json
{
  "schemaVersion": 1,
  "name": "MyProject",
  "photos": [
    { "path": "DSC001.ARW", "look": "DSC001.ARW.json" }
  ]
}
```

**`MyProject/looks/DSC001.ARW.json`**

<!-- spec-example: look -->
```json
{
  "schemaVersion": 4,
  "source": {
    "fileName": "DSC001.ARW",
    "cameraModel": "ILCE-7RM4",
    "kind": "raw"
  },
  "createdAt": "2026-07-11T09:14:02.000Z",
  "updatedAt": "2026-07-16T18:30:47.512Z",
  "rating": 4,
  "photo": "DSC001.ARW",
  "fingerprint": "9f2c7a1e4b3d5f607c2a8e91d0b4f3168a5c7e2d1b9f6a4c8e3d0217b5a9c6f4",
  "graph": {
    "nodes": [
      {
        "id": "in",
        "type": "input",
        "position": { "x": 20, "y": 60 },
        "geometry": {
          "crop": { "x": 0, "y": 0, "w": 1, "h": 1 },
          "angle": 0,
          "orientation": { "quarterTurns": 0, "flipH": false }
        },
        "lens": { "distortion": 0, "caRed": 0, "caBlue": 0, "vignette": 0, "profile": { "enabled": true } }
      },
      {
        "id": "exp-1",
        "type": "exposure",
        "position": { "x": 220, "y": 60 },
        "params": { "ev": 0.3 }
      },
      {
        "id": "mask-1",
        "type": "mask",
        "position": { "x": 420, "y": 20 },
        "mask": {
          "shapes": [
            { "type": "radial", "mode": "add", "cx": 0.5, "cy": 0.5, "radius": 0.6, "feather": 0.3, "invert": true }
          ]
        }
      },
      {
        "id": "blend-1",
        "type": "blend",
        "position": { "x": 620, "y": 60 },
        "params": { "amount": 0.4 }
      },
      { "id": "out", "type": "output", "position": { "x": 820, "y": 60 } }
    ],
    "edges": [
      { "id": "e0", "from": "in", "to": "exp-1" },
      { "id": "e1", "from": "exp-1", "to": "blend-1", "port": "a" },
      { "id": "e2", "from": "exp-1", "to": "blend-1", "port": "b" },
      { "id": "e3", "from": "mask-1", "to": "blend-1", "port": "mask" },
      { "id": "e4", "from": "blend-1", "to": "out" },
      { "id": "e5", "from": "in", "to": "mask-1" }
    ]
  }
}
```

This example is meant to be kept honest by machine, not by hand:
`npm run verify:sidecar-spec` (`scripts/verify-sidecar-spec.mjs`) extracts
this document's two fenced JSON blocks under §10 (tagged with
`<!-- spec-example: manifest -->` / `<!-- spec-example: look -->` HTML
comments immediately above each fence) and round-trips them —
`parseProjectManifest` on the manifest, `parseGraphDoc` on the look file —
asserting both parse without throwing, that the look's
`photo`/`fingerprint`/`rating` come back exactly as written, that an unknown
field injected into either example survives a round trip, that this doc's
stated `schemaVersion` values (`1` for the manifest, `4` for the look) match
`PROJECT_SCHEMA_VERSION`/`SIDECAR_SCHEMA_VERSION` in the source, and that the
fingerprint recipe in §7 matches a reference implementation on a fixed byte
buffer.

# Spec draft: linked looks & shared assets

Status: DESIGN-COMPLETE DRAFT — **implementation gated on an EXPLICIT
user GO** (user, 2026-07-18: 「この話はちゃんと結論がついてから実装に
GOする感じにしようね」). No agent may be dispatched on this brief, and no
part of it may be built piecemeal inside other features, until the user
says GO — however complete the design below looks.
History: grew out of the sync-or-not question (2026-07-18 evening,
commits a42beeb..6034d55 — the dialogue-ordered originals are in git
history); reorganized into this spec form 2026-07-19 after a conductor
double-check that also resolved three internal inconsistencies the
append-driven growth had left (look-carries-structure wording, the
photo-keeps-its-own-file point, the sensor-mapping overclaim).

## 0. Summary

「そもそも、ノードベースを重視するならsyncしたいときとそうじゃないとき
があるだろうしなぁ」(user) — in a node-based system, cross-photo
"sameness" is a REFERENCE, not repeated copying. Sync answers a
declarative question ("are these the same look?") with a temporal
mechanism ("when did you last copy?") — which is why it grew the
clobber footgun (fixed ee95326) and why it keeps feeling wrong. Once
references exist, sync dissolves (user: 「そのsync先をプリセット
（マテリアル）にしちゃうって感じなのかなぁ」):

```
photo = link(look)        followed per family, forkable, revertable
      + repair sheet(s)   sensor-anchored one-shot stamp sets
      + local structure   this photo's own spots/masks — never in the look
      + local geometry    crop/angle — never shared, ever
```

## 1. Principles (each earned against a user objection)

1. **Composition over variants.** Dust presence, orientation, APS-C
   crop mode — none may multiply presets; each is an orthogonal axis or
   a coordinate mapping.
2. **Every shared element declares its anchor frame.** Look = parameter
   space; repair sheet = PHYSICAL sensor pixels; composition masks (if
   ever shared) = frame. Anchor low enough and one asset covers
   FF/APS-C/portrait/landscape mixes.
3. **Only things worth following get links.** Aesthetics evolve → the
   look follows. Dust never changes retroactively → one-shot, no link.
4. **Propagation is explicit** — (b) publish, USER-DECIDED («そうね、
   bの方が良さそう») over write-through. The Auto Sync lesson is the
   argument: implicit propagation is the accident class.
5. **Following stops at the project boundary; reuse crosses by copy**
   (vendoring). Protects project self-containedness and finished work;
   git-native alignment (local edits = working tree, publish = commit,
   following = pull).
6. **Structure is never part of the look** (UE: instances cannot change
   the graph). Photo-local spots/masks compose downstream of the link,
   so "stamp, then update the look body" cannot conflict.

## 2. Asset taxonomy (complete — exactly two kinds)

| kind | payload | ANCHOR | PROPAGATION | SCOPE |
|---|---|---|---|---|
| look (material) | develop params | parameter space, per family | FOLLOWING — link + explicit publish | follow within project; copy across (library = template store) |
| repair sheet (eraser) | spot set | physical sensor pixels | ONE-SHOT — per-frame opt-in | project-local only, no library |

The three axes (anchor × propagation × scope) are the classifier; a
hypothetical third kind would slot in without new architecture, but
nothing beyond these two is planned.

## 3. The look link (Material / Material Instance)

User's model: 「UEのマテリアルとマテリアルインスタンス的な考え方」.
Material = shared look (parameter defaults ONLY — no structure).
Instance = the photo's sparse override state.

- **Granularity: per preset FAMILY** (the shipped vocabulary —
  basic-tone/wb/curves/hsl/…): touching any param in a followed family
  FORKS that family local (visible "modified from look" badge);
  **Revert to look** per family resumes following. Refine to
  per-parameter (CSS/Houdini-style) only where real usage demands it.
  Graph-stacking (shared look as an upstream node) was REJECTED:
  replace-semantics params (highlights/shadows tone mapping, curves,
  WB) don't compose by stacking — the reason LR/C1 use value overrides.
- **One look per photo — USER-DECIDED 2026-07-19** («ok»). Layering
  needs are expressed through per-group 個別調整, never multiple links.
- **Publish undo — USER-DECIDED 2026-07-19** («合ってる»): one ⌘Z
  reverts the whole publish (all followers restored via the shared
  look's before/after — one typed global-undo entry).
- **Deleting a shared look with followers — USER-DECIDED 2026-07-19**
  («ルックがなかったら全部ローカル化»): every follower keeps its exact
  current rendering and becomes independent. No render-changing delete
  exists.
- **Link-time default (no dialog)**: adjustment groups the photo has
  already edited stay 個別調整; untouched groups follow. Deliberate
  discard = 共通ルックに合わせる afterward.
- **Orphaned overrides**: if the look body drops/reshapes a family a
  photo forked, the fork SURVIVES as local (UE silently drops; our
  non-destructive stance doesn't).
- **The photo keeps its own look file.** Link state is additive
  metadata (which look, which families follow); the file remains
  independently readable — sidecar back-compat rule 9 intact, CLI
  unaffected until it opts into resolving links.

## 4. The repair sheet (「消しゴム用のマテリアル」)

- Stored in **physical sensor pixels**; applied through each photo's
  readout-window ∘ orientation transform. Dust outside the APS-C
  window maps away (correct — it isn't in that frame).
- **One-shot per-frame opt-in, never following**: dust doesn't change
  retroactively, and aperture-dependent visibility demands per-frame
  judgment anyway. Applied spots become ordinary photo-local spots
  (editable/deletable individually afterward).
- **No library** (user instinct, endorsed): strictly dust is a BODY ×
  TIME-RANGE property, but dust states drift and stale sheets mislead —
  make-and-discard within a project is the honest weight class.

## 5. Operations

| operation | semantics |
|---|---|
| Link photo(s) to look | attach; all families follow (fresh) or keep local values as forks (choice at link time — TBD at GO) |
| Edit a followed family | forks it local (badge) |
| Revert family to look | drop the fork, resume following |
| **Publish** | write chosen families of the current photo INTO the shared look → followers update by construction. Explicit gesture only |
| Unlink (make local) | dissolve into a plain local look |
| Vendor in | copy a library look into the project; linking happens against the copy |
| Publish to library | explicit; updates the template, never past projects |
| Apply repair sheet | one-shot stamp of the sheet's spots onto selected frames |
| Apply preset to selection | the one-shot no-asset batch case (small, separate feature) |

Under this set, today's Sync button AND Auto Sync are both eventually
subsumed. USER-DECIDED (2026-07-19): the Sync button IS removed when
linked looks land («いらないかも»), and **apply-preset-to-selection is
promoted from nice-to-have to REQUIRED**, for both look presets and
repair sheets («写真を複数選択してプリセットを一気に適用できる、という
機能は必要。ルックやゴミとり系などどっちも»).

**"Force overwrite" decomposes into existing operations** (user asked to
organize it: «ローカルの値を無視して強制的にそのプリセットで上書きしちゃ
いたい…リセット的な概念に近い»): (1) one-shot case — apply-preset-to-
selection ALREADY replaces the checked adjustment groups wholesale;
that IS the force semantics. (2) linked case — "align every group to
the shared look" (revert-all), presentable as a "reset to the shared
look" button, matching the user's reset intuition. No third concept.

## UI vocabulary (user: the jargon was all confusing — plain words only)

Spec term → display term (Japanese-first):

| spec term | 表示名 |
|---|---|
| shared look | 共通ルック |
| link | 共通ルックを使う |
| publish | この写真の調整を共通ルックに反映 |
| forked family (state) | この写真だけ個別調整中 (badge) |
| revert to look | 共通ルックに合わせる |
| unlink / make local | 共通ルックから外す (見た目は変わらない) |
| vendor in | プロジェクトに取り込む |
| repair sheet | ゴミ取りセット |
| preset family | 調整グループ (the preset-save checkbox units) |

In user-facing text and this brief's future revisions, prefer 調整グループ
/ 個別調整 over family/fork.

## 6. Verified foundations (conductor double-check, 2026-07-18..19)

| claim the design leans on | verdict | evidence |
|---|---|---|
| structural families default-unchecked in presets | ✅ | presetFamilies.ts PRESET_FAMILIES defaultChecked |
| spots-only Sync can seed dust onto targets TODAY (incl. targets with no spots node — graft ADDS nodes + splices edges) | ✅ | graftStructuralFamily read in full: newNodeIds/grafted/supersede logic |
| anchor space = oriented-full-frame (photo-local) coords | ✅ | anchorSpace.ts doc comment |
| presets are already app-global (library embryo) | ✅ | `<userData>/presets/*.json` (ipc.ts) |
| per-photo orientation retained | ✅ | DecodedImage.flip / geometry.orientation |
| readout-window origin available post-decode | ⚠️ | computeCropbox COMPUTES it but DecodedImage doesn't retain it — repair sheet needs one additive field (rgbCam's stage-2 pattern) |
| publish/vendoring mechanics | design-level only | file-write + copy patterns match landed machinery (look files, import-sidecars/save-as-move); unverified because unbuilt |

## 7. Implementation questions to settle AT GO TIME (not defects)

1. **Publish undo**: one gesture changes N photos' renders. Natural
   shape: one typed global-undo entry restoring the shared look file's
   before/after (SyncUndoEntry precedent); followers recompute.
2. **Write ordering**: publish vs the autosave debounce touching the
   same files — extend the existing flush-on-switch discipline.
3. **Schema**: additive link-state fields on the photo look file +
   shared-look file format + library dir layout; migration additive per
   sidecar rules. Also: link-time choice UX (follow fresh vs fork-keep).
4. Retain the readout-window origin on DecodedImage (the ⚠️ above).

## 8. Interim operation (today, no new code)

- Look distribution: presets (develop families only).
- Dust: select affected frames → Sync with ONLY the spots family.
- Auto Sync: unused; removal awaiting the user's explicit call.

## 9. Explicitly deferred

True cross-project following (rejected, not deferred — it breaks
self-containedness). Repair-sheet library. Per-parameter override
granularity (refinement path). Any third asset kind.

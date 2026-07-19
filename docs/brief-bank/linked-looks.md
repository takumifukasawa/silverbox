# Spec: linked looks & shared assets (共通ルック)

Status: DESIGN-COMPLETE — **implementation gated on an EXPLICIT user
GO** (user, 2026-07-18: 「この話はちゃんと結論がついてから実装に
GOする感じにしようね」). No agent may be dispatched on this brief, and
no part of it may be built piecemeal inside other features, until the
user says GO — however complete the design below looks.

History: grew out of the sync-or-not question (2026-07-18..19 dialogue,
commits a42beeb..39bf246 — the dialogue-ordered originals are in git
history). Reorganized 2026-07-19 into dialogue-order spec form, then
again 2026-07-19 (this revision) into SPEC ORDER: what v1 is comes
first; rationale, judgment lenses, and rejected alternatives are
compressed into §8. Every decision below is user-decided or
conductor-verified; none are open.

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
photo = link(look)        followed per 調整グループ, forkable, revertable
      + repair sheet(s)   sensor-anchored one-shot stamp sets
      + local structure   this photo's own spots/masks/nodes — never in the look
      + local geometry    crop/angle — never shared, ever
```

The scope law in one line: **what follows = photo-independent
aesthetics (the Develop parameter space, entirely); what stays local =
everything photo-dependent** — all secondaries (radial/linear by frame
anchor, colorKey by use), spots, geometry. One-shot distribution +
per-photo tweak is the correct mechanics for the photo-dependent side,
and already works today via whole-look presets.

## 1. v1 scope at a glance

| in v1 | out of v1 (see §8/§11 for why) |
|---|---|
| shared look = **single-Develop, values only** (level ①) | structure-carrying looks (level ② frozen skeleton — SHELVED, design ready in §8.2) |
| link lives on the **Develop node**; ≤1 linked Develop per chain | publish-mutable structure (level ③ — REJECTED) |
| per-調整グループ fork (個別調整) + revert | per-parameter override granularity (refinement path) |
| explicit publish; one-⌘Z publish undo | any implicit/auto propagation |
| repair sheet (ゴミ取りセット): sensor-anchored, one-shot, RAW-only | repair-sheet library; non-RAW targets |
| vendoring across projects (copy); library = template store | cross-project FOLLOWING (rejected) |
| **apply-preset-to-selection (REQUIRED)** + Sync-button removal, same release | keeping Sync/Auto Sync alongside |

## 2. Principles (each earned against a user objection)

1. **Composition over variants.** Dust presence, orientation, APS-C
   crop mode — none may multiply presets; each is an orthogonal axis or
   a coordinate mapping.
2. **Every shared element declares its anchor frame.** Look = parameter
   space; repair sheet = PHYSICAL sensor pixels; composition masks (if
   ever shared) = frame. Anchor low enough and one asset covers
   FF/APS-C/portrait/landscape mixes.
3. **Only things worth following get links.** Aesthetics evolve → the
   look follows. Dust never changes retroactively → one-shot, no link.
   Secondaries are photo-dependent in use → one-shot, no link (§8.3).
4. **Propagation is explicit** — (b) publish, USER-DECIDED («そうね、
   bの方が良さそう») over write-through. The Auto Sync lesson is the
   argument: implicit propagation is the accident class.
5. **Following stops at the project boundary; reuse crosses by copy**
   (vendoring). Protects project self-containedness and finished work;
   git-native alignment (local edits = working tree, publish = commit,
   following = pull).
6. **Publish moves VALUES only — structure never propagates** (refined
   2026-07-19: a look MAY carry a frozen multi-node skeleton — level ②,
   shelved; what it may never do is restructure followers at publish
   time). Photo-local spots/masks compose around the link, so "stamp,
   then update the look body" cannot conflict.

## 3. Asset taxonomy (complete — exactly two kinds)

| kind | payload | ANCHOR | PROPAGATION | SCOPE |
|---|---|---|---|---|
| look (material) | develop params | parameter space, per 調整グループ | FOLLOWING — link + explicit publish | follow within project; copy across (library = template store) |
| repair sheet (eraser) | spot set | physical sensor pixels | ONE-SHOT — per-frame opt-in | project-local only, no library |

The three axes (anchor × propagation × scope) are the classifier. The
hypothetical third kind has a likely identity — the shared
node/subgraph (Houdini HDA / Nuke gizmo precedent), for looks built
from WGSL custom nodes, which are reference-shaped (graph-topology
anchor) and can't squeeze into the parameter-shaped 共通ルック. It
slots into the taxonomy without new architecture. UNSCHEDULED — noted
only to prove the node-based story and the linked-look story compose
rather than collide.

## 4. The look link

User's model: 「UEのマテリアルとマテリアルインスタンス的な考え方」.
Material = shared look (parameter defaults ONLY — no structure).
Instance = the photo's sparse override state.

### 4.1 Data model — fully materialized photo files

**The photo keeps its own look file with FULLY MATERIALIZED values
(user-confirmed 2026-07-19: 「写真の方のjsonでも基本的には全ての
パラメーターを保存している感じになるのかなぁ今まで通り」— yes,
exactly).** The photo JSON always holds the complete resolved
parameter set, as today; "following" means publish WRITES the followed
groups' new values into each follower's file at that explicit moment.
Link state is only additive sync metadata (which look, which groups
may be rewritten by a publish). Consequences, all intended:

- look deletion = strip the metadata; values were already there
  (render never moves);
- any old reader/CLI renders the file correctly standalone
  (back-compat rule);
- a publish diff touches N+1 files — the history showing one intent
  reaching N photos, a procedural feature not a smell.

The reference-resolved alternative (photo stores only individual
adjustments, followed groups resolved at open) was REJECTED: it breaks
standalone readability and old-reader compatibility.

### 4.2 Granularity & override lifecycle

- **Granularity: per 調整グループ** (the preset-save checkbox units —
  basic-tone/wb/curves/hsl/…): touching any param in a followed group
  FORKS that group local (visible 個別調整 badge); **共通ルックに合わ
  せる (revert)** per group resumes following. Refine to per-parameter
  (CSS/Houdini-style) only where real usage demands it.
- **One look per photo — USER-DECIDED 2026-07-19** («ok»). Layering
  needs are expressed through per-group 個別調整 or added local
  Develop nodes, never multiple links.
- **Link-time default (no dialog)**: adjustment groups the photo has
  already edited stay 個別調整; untouched groups follow. Deliberate
  discard = 共通ルックに合わせる afterward.
- **Orphaned overrides**: if the look body drops/reshapes a group a
  photo forked, the fork SURVIVES as local (UE silently drops; our
  non-destructive stance doesn't).

### 4.3 Node-graph rules (the link is a property of the DEVELOP NODE)

(Provenance: user, 2026-07-19 — 「ノードベースとの両立がどうなるか」
and 「developを追加した時とかに、どういう扱いになるか。プライマリ
セカンダリ的な考え方としてはそういうケースもあるかしら？」.)

A Develop node carries "following look X for these adjustment groups";
the graph around it stays entirely free (custom nodes, blends,
branches — the link never dictates topology, per principle 6).

- **≤1 linked Develop per chain**: two nodes following the same look
  would apply its values twice in series (doubled exposure etc.);
  attempting a second link moves or refuses, structurally enforced.
  "One look per photo" becomes "every linked Develop in one photo
  links to the SAME look" (no multi-look confusion), not "one linked
  node".
- **Added Develop nodes are LOCAL tweak layers**: a new Develop
  carries no link, and since a default Develop is identity, inserting
  it changes nothing on screen. The primary/secondary intuition
  emerges with no new machinery: linked node = the base the 共通ルック
  drives; added nodes = this photo's own layered tweaks.
- **Publish reads ONLY the linked node's groups** — tweak-layer values
  never leak into the shared look.
- **Virtual copies**: duplicating an output clones the Develop WITH
  its link state; each chain then independently keeps following or
  detaches.
- Graph stacking, rejected as the OVERRIDE mechanism (§8.1), remains
  available as an explicit USER choice (additive params layer fine;
  stacking curves/WB is node-craft self-responsibility — the
  node-based covenant).

### 4.4 Publish, delete, undo

- **Publish**: write chosen 調整グループ of the current photo INTO the
  shared look → followers update by construction (their files are
  re-materialized, §4.1). Explicit gesture only.
- **Publish undo — USER-DECIDED 2026-07-19** («合ってる»): one ⌘Z
  reverts the whole publish — one typed global-undo entry holding the
  shared look's before/after; followers re-materialize on undo/redo.
- **Deleting a shared look with followers — USER-DECIDED 2026-07-19**
  («ルックがなかったら全部ローカル化»): every follower keeps its exact
  current rendering and becomes independent. No render-changing delete
  exists.

## 5. The repair sheet (「消しゴム用のマテリアル」/ ゴミ取りセット)

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
- **GO-time obligations (double-check findings 2026-07-19; function
  name corrected in the second double-check):**
  (1) SPOTS_CAP is 32 and **sanitizeSpotsParams** TRUNCATES SILENTLY
  (spotsNode.ts:115 slice(0, SPOTS_CAP)) — and since sanitization runs
  on EVERY load/apply path, a photo written with existing spots + sheet
  exceeding the cap gets silently trimmed on the next open. Sheet
  application must therefore check the cap BEFORE writing and
  refuse/warn LOUDLY, never silently drop (or the cap gets raised
  deliberately). (2) Non-RAW
  targets: a JPEG has no readout-window metadata, so the sensor→frame
  mapping is undefined — v1 scopes sheet application to RAW photos
  (camera-JPEG fallback assumptions are a GO-time decision, not an
  implicit default).

## 6. Operations & UI vocabulary

| operation | semantics |
|---|---|
| Link photo(s) to look | attach; edited adjustment groups stay 個別調整, untouched groups follow (automatic — no dialog, §4.2) |
| Edit a followed group | forks it local (badge) |
| Revert group to look | drop the fork, resume following |
| **Publish** | §4.4 — explicit gesture only |
| Unlink (make local) | dissolve into a plain local look |
| Vendor in | copy a library look into the project; linking happens against the copy |
| Publish to library | explicit; updates the template, never past projects |
| Apply repair sheet | one-shot stamp of the sheet's spots onto selected frames |
| Apply preset to selection | the one-shot no-asset batch case (small, separate feature) |

Under this set, today's Sync button AND Auto Sync are both subsumed.
USER-DECIDED (2026-07-19): the Sync button IS removed when linked
looks land («いらないかも»), and **apply-preset-to-selection is
promoted from nice-to-have to REQUIRED**, for both look presets and
repair sheets («写真を複数選択してプリセットを一気に適用できる、という
機能は必要。ルックやゴミとり系などどっちも»).
ORDERING CONSTRAINT: the removal and apply-preset-to-selection land in
the SAME release — Sync is today's only batch vehicle (incl. the
interim dust workflow in §10), so removing it first would strand those
workflows.

**"Force overwrite" decomposes into existing operations** (user asked
to organize it: «ローカルの値を無視して強制的にそのプリセットで上書き
しちゃいたい…リセット的な概念に近い»): (1) one-shot case —
apply-preset-to-selection ALREADY replaces the checked adjustment
groups wholesale; that IS the force semantics. (2) linked case —
"align every group to the shared look" (revert-all), presentable as a
"reset to the shared look" button, matching the user's reset
intuition. No third concept.

### UI vocabulary (user: the jargon was all confusing — plain words only)

| spec term | 表示名 |
|---|---|
| shared look | 共通ルック |
| link | 共通ルックを使う |
| publish | この写真の調整を共通ルックに反映 |
| forked group (state) | この写真だけ個別調整中 (badge) |
| revert to look | 共通ルックに合わせる |
| unlink / make local | 共通ルックから外す (見た目は変わらない) |
| vendor in | プロジェクトに取り込む |
| repair sheet | ゴミ取りセット |
| preset family | 調整グループ (the preset-save checkbox units) |

In user-facing text and this brief's future revisions, prefer
調整グループ / 個別調整 over family/fork.

## 7. Verified foundations (conductor double-check, 2026-07-18..19)

| claim the design leans on | verdict | evidence |
|---|---|---|
| structural families default-unchecked in presets | ✅ | presetFamilies.ts PRESET_FAMILIES defaultChecked |
| spots-only Sync can seed dust onto targets TODAY (incl. targets with no spots node — graft ADDS nodes + splices edges) | ✅ | graftStructuralFamily read in full: newNodeIds/grafted/supersede logic |
| anchor space = oriented-full-frame (photo-local) coords | ✅ | anchorSpace.ts doc comment |
| presets are already app-global (library embryo) | ✅ | `<userData>/presets/*.json` (main/presets.ts presetsDir()) |
| per-photo orientation retained | ✅ | DecodedImage.flip / geometry.orientation |
| readout-window origin available post-decode | ⚠️ | computeCropbox COMPUTES it but DecodedImage doesn't retain it — repair sheet needs one additive field (rgbCam's stage-2 pattern) |
| publish/vendoring mechanics | design-level only | file-write + copy patterns match landed machinery (look files, import-sidecars/save-as-move); unverified because unbuilt |

## 8. Design rationale — how the v1 scope was earned

Kept because the reasoning IS the spec's justification; nothing here
is open.

### 8.1 Override mechanism: value overrides, not graph stacking

Graph-stacking (shared look as an upstream node) was REJECTED as the
override mechanism: replace-semantics params (highlights/shadows tone
mapping, curves, WB) don't compose by stacking — the reason LR/C1 use
value overrides. Stacking survives only as an explicit user choice
(§4.3).

### 8.2 Structure-carrying looks: the merge-cost conservation law

The user pushed on why the look should be Develop-only (「まだあんまり
developだけがいいっていう理由が腑に落ちてない。素朴な話ね」), which
exposed the real invariant: **sharing structure means paying a
merge-against-the-photo's-own-nodes cost SOMEWHERE — it never
disappears, it only moves** (「写真ごとのノードはどうなるか、という話
に戻るよねぇ」):

| level | where the merge cost lands | consequence |
|---|---|---|
| ① single-Develop look | NOWHERE | link = metadata on the existing Develop; the photo's node structure is never touched |
| ② frozen-skeleton look | ONCE, at link time | linking REPLACES the chain with the skeleton (whole-look-preset semantics: edited values carry into matching groups as 個別調整; photo-specific custom node arrangements cannot merge — replaced or link refused). After that, value-only following per node × group; look-side structure changes = a NEW look version that never auto-propagates (re-link explicitly, or keep following the old skeleton) |
| ③ publish-mutable structure | every publish × every follower | REJECTED |

Both ① and ② satisfy principle 6. **v1 = ①, USER-DECIDED 2026-07-19**
via the video-secondary lens (§8.3); ② is SHELVED, not rejected — this
table is its ready design if a real demand ever appears. Interim fact
either way: one-shot distribution of layered looks ALREADY works today
via whole-look presets (structure included); only FOLLOWING was at
stake.

### 8.3 The video-secondary lens, and why all secondaries stay local

「映像文脈のセカンダリをどこまで考慮するかって感じなのかなぁ。判断軸
として」(user) — mapping video secondaries onto silverbox made the
①/② choice concrete:

| video secondary | silverbox embodiment | shareable under ① ? |
|---|---|---|
| hue-qualified (skin isolation, per-hue push) | HSL 8-band params — INSIDE Develop | ✅ already follows |
| luma-qualified (shadow/mid/high wheels) | grading wheels — INSIDE Develop | ✅ already follows |
| spatially-qualified (windows/masks) | mask nodes (radial/linear/colorKey) — STRUCTURE | ❌ needs ② |

First resolution («マスクはまぁでも、写真ごとだよなぁさすがに»):
spatial masks are per-photo — video practice agrees (grades copied
across shots, windows re-placed PER SHOT).

Second pass — **the colorKey crack, examined and closed**: colorKey is
spatial in EFFECT but color-anchored in DEFINITION (H/S/L range +
softness), so unlike windows a skin/sky key could in principle travel
across photos — the shape of ②'s first real demand (LR
adaptive-preset precedent: semantic anchor ⇒ shareable spatial mask).
User verdict: «肌とか空は写真次第かなぁ» — key ranges are re-pulled
per photo (lighting/WB/subject), matching video practice for
qualifiers too. So colorKey is photo-anchored IN USE, and following
would actively fight the per-photo re-pull. ②'s last standing
motivator is gone; ① is stronger than when first decided.

Photography-context confirmation (2026-07-19): secondaries themselves
are load-bearing in stills (darkroom dodge & burn heritage; sky work
in landscape, skin/background in portrait, C1 skin-tone uniformity;
LR's AI-mask investment as demand evidence) — silverbox already has
the machinery (mask nodes + local adjustments, the color model's
third layer). This spec deliberately adds NO sharing on top of it.

## 9. Implementation questions to settle AT GO TIME (not defects)

1. **Publish undo**: one gesture changes N photos' renders. Natural
   shape: one typed global-undo entry restoring the shared look file's
   before/after (SyncUndoEntry precedent); followers recompute.
2. **Write ordering**: publish vs the autosave debounce touching the
   same files — extend the existing flush-on-switch discipline.
3. **Schema**: additive link-state fields on the photo look file +
   shared-look file format + library dir layout; migration additive per
   sidecar rules. Also: link-time choice UX (follow fresh vs fork-keep).
4. Retain the readout-window origin on DecodedImage (the ⚠️ in §7;
   computeCropbox lives in librawDecoder.ts, the interface in
   RawDecoder.ts).
5. **Shared-look file external-edit semantics (the AI-native path,
   principle 2 of DESIGN.md).** Photo look files hot-reload today; an
   AI's natural gesture "edit the 共通ルック file to retune the
   series" currently has NO defined propagation (materialized
   followers don't change until an app-side publish). Decide: notice
   + offer-to-publish (likely — keeps principle 4's explicitness), a
   CLI `publish` verb, or ignore-until-app-publish. Either way the
   link metadata format must be documented in sidecar-spec.md — the
   sidecar is an API surface.
6. **Sanitizer semantics for invalid link states in hand-written
   docs** (the document is an API surface, so these WILL occur): two
   linked Develops in one chain, different looks across chains of one
   photo, a link naming a look file that is MISSING (git checkout,
   external delete — distinct from app-side delete, which strips
   metadata). Materialization means rendering is always correct;
   define the load-time normalization/notice per DESIGN.md principle 9
   (never silently destroy).
7. **Library location.** `<userData>/presets` is app-internal —
   exactly the hidden-central-library shape the project-storage
   decision rejected for documents. Looks the user authors are meant
   to travel (DESIGN.md identity) and be git-able; decide whether the
   look library gets a visible folder (~/Silverbox/Library?) or
   inherits the presets dir, and whether existing presets migrate.
   USER LEANING (2026-07-19, not final): visible folder — «可視フォル
   ダかなぁ、git管理どうする問題はたしかにあるかぁ». The git question
   resolves the same way projects did: the app provides a gittable
   visible folder and never touches git itself; whether to version it
   is the user's own call.
8. **Visible-path + editor-visibility obligations for the GO-time
   brief** (DESIGN.md "Visible path to every result" REQUIRES
   new-feature briefs to enumerate, per interaction, the clickable
   path): link/unlink/publish/revert all need visible controls; the
   node editor must SHOW link state on the Develop node (the graph is
   the review surface for auditing what an AI wrote); the link
   gesture needs a completion notice ("N groups follow, M stayed
   個別調整" — the no-dialog default in §4.2 makes this the only
   feedback); publish's group-choice UI is FamilyScopeDialog reuse
   (the shared component preset scoping landed, 2e2cd0b).

## 10. Interim operation (today, no new code)

- Look distribution: presets (develop families only).
- Dust: select affected frames → Sync with ONLY the spots family.
- Auto Sync: unused; removal awaiting the user's explicit call.

## 11. Explicitly deferred / rejected

True cross-project following (REJECTED, not deferred — it breaks
self-containedness). Repair-sheet library. Per-parameter override
granularity (refinement path). The third asset kind (shared
node/subgraph — likely identity recorded in §3, unscheduled). Level ②
frozen-skeleton looks (SHELVED with ready design, §8.2).

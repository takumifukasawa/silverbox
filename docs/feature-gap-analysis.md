# Feature gap analysis — Silverbox vs Lightroom Classic / Lightroom / DaVinci Resolve

Written 2026-07-13 by the Fable conductor as a planning instrument: what
the references have that we don't, what we have that they don't, and a
recommended order. "LRC" = Lightroom Classic, "LR" = cloud Lightroom,
"DR" = DaVinci Resolve's color page (the node-graph reference).

## Where Silverbox already stands (for calibration of the comparison)

Ingest (ARW/JPEG, embedded-preview-first, folder filmstrip, ratings),
develop (WB/tone/curves/HSL/grading wheels/detail incl. six-knob NR/
effects, all LR-calibrated), geometry (crop/LR-style straighten/rotate/
flip, manual + embedded Sony lens corrections), local adjustments
(radial/linear/colorKey masks on a node graph, spot removal), the node
graph itself (blend modes with masks, custom WGSL, Image node, external
tool hook, named multi-outputs with per-output export settings),
output (JPEG/PNG exports with ICC/EXIF policy, LUT export, golden
renders, headless CLI, presets, sidecar hot-reload, compare view,
per-node preview). Suite: 49 e2e + unit tier.

## Gap table (reference-has, we-don't)

### Category A — expected by any LR-refugee, no design controversy
| Feature | Reference | Notes / effort |
|---|---|---|
| B&W conversion (per-band gray mixer) | LRC B&W tab | Small: reuse HSL band machinery, luma-weighted mix. |
| Auto tone | LRC/LR "Auto" | Medium-small: histogram-based heuristic starting point; honest v1 = percentile targets. |
| Perspective correction (Upright/keystone) | LRC Transform | Medium-large: new geometry math in RESAMPLE + UI; manual sliders v1, auto lines later. |
| Tone curve point/parametric REGIONS drag (drag-on-image) | LRC targeted adjustment tool (TAT) | Medium: we have curves + HSL; the TAT gesture (drag on the photo to edit the band under the cursor) is a beloved LR interaction. |
| Point Color (pick a color from the photo, adjust it precisely) | LRC 13+ | Medium: nearest existing = the ColorKey mask; Point Color is a different, lighter gesture (eyedropper -> hue/sat/lum + range sliders on the DEVELOP node, no mask rig). Could share the ColorKey WGSL gates. |
| History panel (persistent step list) | LRC | Medium: we have undo/redo in-session; LRC persists history in the catalog. OURS should stay session-only or sidecar-git ("look-history replay" is already a roadmap idea — git IS our history). Recommend: expose undo stack as a panel v1; git-log-based replay later. |
| Soft proofing | LRC | Medium: we have P3 export; soft proof = preview through target profile + gamut warning overlay (roadmap already lists gamut warning). |
| Batch/sync settings across photos | LRC sync | Small-medium: presets + filmstrip multi-select "apply preset/paste to selected". Multi-select is the missing primitive. |
| Snapshot/versions per photo | LRC snapshots, DR versions | Small: named saved states INSIDE the sidecar (list of graph snapshots). Git-native alternative: branches — but in-app snapshots are friendlier. |

### Category B — the node-graph identity (DR-inspired, differentiators)
| Feature | Reference | Notes |
|---|---|---|
| Node bypass toggle (solo/mute) | DR (Ctrl+D) | SMALL and high-value: temporarily disable any node without unwiring. We already bypass on delete; a `disabled` flag + keyboard toggle. Arguably Category A urgency for graph usability. |
| Group/compound nodes | DR compound nodes | Large: fold a subgraph into one node with exposed params. The preset system is a flat cousin; defer. |
| Shared/linked nodes (one correction reused across outputs) | DR shared nodes | Our DAG already allows fan-out — a node feeding two outputs IS shared. Gap is only UI affordance/education. Document, don't build. |
| Split-screen wipe compare (draggable divider) | DR/LR before-after wipe | Medium-small: we have two-pane compare; a wipe divider on one canvas is the missing variant. |
| Keyframes/animation | DR | Non-goal (stills tool). Record as such. |

### Category C — color science depth
| Feature | Reference | Notes |
|---|---|---|
| Fitted camera profile (Adobe Color character) | LRC camera profiles | DESIGNED: docs/brief-bank/profile-fit.md. The single biggest remaining image-quality item. |
| Camera profile CHOICES (Standard/Vivid/Portrait…) | LRC profile browser | After profile-fit ships, extra profiles = extra fitted lattices from in-camera picture styles. Cheap marginal cost. |
| HDR editing/output (PQ, gain map) | LR HDR mode | Large; growing relevance (gain-map JPEG). Roadmap nice-to-have; revisit when export targets demand it. |
| Scene-adaptive dehaze | LRC | Recorded from calibration; dark-channel estimate, medium. |
| AI masks (subject/sky/person) | LRC/LR | Large + inference story (same constraints as denoise v2/NAFNet). The external-hook node pattern could host a mask-producing tool first (hook node variant that outputs a MASK) — cheaper path than bundling models. |
| Content-aware heal | LRC | Our spot removal is clone-only; content-aware fill is a research-grade jump. Defer; the external-hook pattern may cover it (e.g. piping to an inpainting tool). |

### Category D — library/workflow (mostly deliberate non-goals)
| Feature | Reference | Notes |
|---|---|---|
| Catalog/DAM (collections, keywords, search) | LRC | NON-GOAL (DESIGN.md). Filmstrip + ratings + git is our answer. Keywords-in-sidecar could come cheap if ever wanted. |
| Import/copy workflow, tethering, maps, books | LRC | Non-goals. |
| Cloud sync / mobile | LR | Non-goal (git is the sync). |
| Video | DR | Non-goal. |

## What we have that the references don't (the moat — protect these)

Text-first git-native documents; the AI-editing loop (hot-reload);
headless CLI + golden-render regression for a photo ARCHIVE; per-output
export settings in the document; custom WGSL nodes; the external tool
hook with security model; LUT export to game engines; per-node preview
on a real DAG. Every roadmap decision should ask "does this strengthen
or dilute the moat?"

## Recommended order (post-Fable queue)

1. **Node bypass toggle** (B, small, graph usability daily-driver)
2. **B&W mixer + Auto tone** (A, small pair, rounds out develop)
3. **Profile fit** (C, designed, Opus) — the image-quality headliner
4. **Multi-select filmstrip + sync/apply-preset-to-selected** (A) —
   unlocks batch workflows with the primitives we have
5. **Wipe compare divider** (B, small)
6. **Snapshots in sidecar** (A, small) + **history panel v1** (A)
7. **Soft proofing + gamut overlay** (A/C)
8. **Perspective correction** (A, large)
9. **Grain quality** (designed) / **scene-adaptive dehaze** (C) as
   calibration follow-ups
10. Mask-producing external hook (C) as the cheap path toward AI masks

Deliberately NOT recommended: compound nodes (wait for real user pain),
HDR (wait for a concrete output need), content-aware heal (external
tool first), anything in Category D non-goals.

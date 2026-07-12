# Brief: Image node — composite with / mask by another file

Status: ready to dispatch (Sonnet). Prereq reading: graphDoc.ts (node
kinds, buildPlan, sanitizers), blend/mask port machinery, decodeWorker/
imageLoader, DESIGN.md §9 (text-first), the spots/mask briefs' shape.

## Decided semantics

- New node kind `'image'`: zero inputs, one output — a SOURCE node like
  'input', but referencing another file by PATH. Params:
  `image: { path: string }` (absolute v1; document that relative-to-sidecar
  is the planned upgrade for repo portability — accept both on parse,
  resolve relative against the sidecar's directory).
- The referenced file decodes through the SAME ingest as the main image
  (RAW → baseline EV + working-space; JPEG → SRGB_TO_WORK), at preview
  resolution, cached per path in the render worker (it must not re-decode
  per render). Missing/unreadable file ⇒ the node outputs solid mid-gray
  AND surfaces a node-editor badge (graphBroken-style notice, not a hard
  error — the doc must stay loadable/editable).
- Sizing: the image is resampled (cover-fit, centered) to the FRAME of
  whatever consumes it — evaluation happens in the consumer's output frame
  like every op. v1 has no placement transform (note as follow-up).
- Use cases wired by existing machinery: feed a blend's 'b' (composite)
  or a blend's 'mask' port (arbitrary image as mask — mask port reads .r).
- Sidecar: additive to v4; sanitizer accepts missing params (defaults to
  path: '' = gray). Unknown-field passthrough as usual.
- No CPU mirror (it's a texture source; plans containing it have
  cpu: null like spatial ops). LUT export: reduceGraphForLut bypasses it
  (same surgery as custom shader nodes) + reports it in `skipped`.
- UI: Add node ▾ gains 'image'; InspectorPanel shows the path + a
  "Choose…" button (main-process open dialog, images filter) + the
  filename; node label shows the basename.

## Verify sketch (verify-imagenode.mjs)

Fixture: hardlink the test JPG as the referenced image. (1) add image
node via debug hooks, wire to blend 'b', amount 0.5 ⇒ render changes,
plan cpu null; (2) wire to mask port ⇒ acts as mask (region-dependent
develop application, reuse verify-masks' region-mean technique);
(3) missing path ⇒ gray output + badge, doc still saves/reloads;
(4) sidecar round-trip preserves the path; relative path resolves
against the sidecar dir; (5) LUT export with an image-node blend
reports it skipped and still succeeds; (6) render-worker cache: two
consecutive renders don't re-decode (add a decode counter debug hook).

## Fragile spots to warn the implementer about

Render-worker owns decoding for this node (main image decoding lives in
the DECODE worker, main-thread side) — pick ONE place (recommend: decode
in the renderer main thread via the existing imageLoader, post the pixels
to the render worker with the doc, mirroring how the main image travels;
do NOT teach the render worker to run libraw). Cache invalidation on
path change and on image switch.

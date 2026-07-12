# Brief: per-node preview (UE-material-editor style)

Status: ready to dispatch (Sonnet). The user's own reference: "unreal
engine のマテリアルエディターにあるみたいな、プレビュー機能は必要かもね".
Prereq reading: graphRenderer's per-step texture retention (the renderer
already keeps intermediate step outputs), renderProtocol/renderClient
readback paths, NodeEditorPanel (React Flow custom nodes — BlendNode is
the precedent), the encodedCropForVerify plumbing.

## Decided semantics

Two tiers, ship both in one pack:

1. **Node thumbnails**: every op node in the graph editor shows a small
   (~64px long edge) live thumbnail of ITS OUTPUT. Renderer side: after a
   full render, a new worker command downsamples each step's retained
   texture to a tiny RGBA buffer (one compute/blit pass per node, cheap at
   64px) and posts a batch {nodeId → ImageBitmap|bytes} back; CanvasView
   forwards to a store map `nodeThumbs: Record<nodeId, string(blobURL)>`.
   Debounce: only refresh thumbnails ~300ms after the last render (never
   per-slider-tick). React Flow custom node type renders the thumb as the
   node body background/inset. Blob URLs revoked on doc/node removal
   (follow the thumbnailCache revocation-audit pattern).
2. **Inspect mode**: selecting a node with ⌥-click (or a small "eye"
   button on the node) previews THAT node's output on the main canvas
   instead of the active output — a store field `inspectNodeId: string |
   null`, threaded to the render worker as the plan's target step (buildPlan
   already resolves a chain per output; rendering "up to node X" = the
   step index of X — read how steps/index resolution works and pick the
   cleanest cut point). A toolbar/canvas badge shows "inspecting: <node>"
   with an ✕ to exit; Escape exits too; switching images exits.

Identity/perf guards: thumbnails OFF while a modal tool drag is in flight
(pan/zoom/crop/spot gestures must never contend with thumbnail readbacks);
the whole feature no-ops gracefully if the renderer reports no retained
step for a node (bypassed/identity nodes — show the upstream thumb or a
"=" placeholder, decide and document).

## Verify sketch (verify-nodepreview.mjs)

(1) after open+render, every op node has a thumb URL and the store map
prunes on node deletion (revocation audit); (2) a develop edit refreshes
the develop node's thumb (bytes change) but NOT an upstream node's;
(3) inspect mode: inspecting the input node's successor shows a render
that ignores downstream ops (readback mean equals a doc truncated at that
node — build the truncated doc in-script via the debug hooks and
compare); badge present; Escape exits and restores the active-output
render; (4) image switch clears inspection + thumbs.

## Fragile spots to flag

Retained-texture lifetime vs the thumbnail pass (textures are pooled —
confirm the pool doesn't recycle a step texture before the thumb pass
reads it; may need the thumb pass folded into the same submit); worker
message volume (batch, never per-node messages).

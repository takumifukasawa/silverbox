import { useEffect, useState } from 'react';
import type { PhotoFlag, PingResult } from '../../../shared/ipc';
import { useAppStore } from '../store/appStore';
import { BLEND_KIND, CUSTOM_KIND, OPS } from '../engine/graph/ops';
import { outputName, type AddableKind } from '../engine/graph/graphDoc';
import { MASK_KIND } from '../engine/graph/maskNode';
import { SPOTS_KIND } from '../engine/graph/spotsNode';
import { IMAGE_KIND } from '../engine/graph/imageNode';
import { EXTERNAL_KIND } from '../engine/graph/externalNode';
import { DENOISE_KIND } from '../engine/graph/denoiseNode';
import { PresetsMenu } from './PresetsMenu';
import { SharedLookMenu } from './SharedLookMenu';

/**
 * "Add node ▾" menu (UI spec §2): customShader + blend + mask + output + the
 * atomic nodes. Most kinds are inserted right before the active output,
 * auto-wired and selected (one undo entry); kind 'output' is special — a new
 * output node lands disconnected (named outputs, spec §6) rather than
 * hijacking the existing one; rewire it freely afterwards.
 *
 * "Duplicate output" (docs/brief-bank/virtual-copy.md) sits right next to
 * the blank 'output' entry: the everyday virtual-copy gesture (clones the
 * active output's own chain, ready to edit independently) vs. 'output's
 * from-scratch/advanced path (lands disconnected, shares nothing). Always
 * enabled while any output exists — even a single-output doc can duplicate
 * itself to create its second.
 */
function AddNodeMenu() {
  const addOpNode = useAppStore((s) => s.addOpNode);
  const duplicateOutput = useAppStore((s) => s.duplicateOutput);
  const [open, setOpen] = useState(false);
  const kinds: AddableKind[] = [
    CUSTOM_KIND,
    BLEND_KIND,
    MASK_KIND,
    SPOTS_KIND,
    IMAGE_KIND,
    EXTERNAL_KIND,
    DENOISE_KIND,
    'output',
    ...(Object.keys(OPS) as AddableKind[]),
  ];
  return (
    <span className="add-node-menu">
      <button
        data-testid="add-node-button"
        title="Insert a node right before output (rewire freely afterwards)"
        onClick={() => setOpen(!open)}
      >
        Add node ▾
      </button>
      {open && (
        <>
          <div className="add-node-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="add-node-menu-list" data-testid="add-node-menu">
            {kinds.map((kind) => (
              <button
                key={kind}
                data-testid={`add-node-${kind}`}
                onClick={() => {
                  addOpNode(kind);
                  setOpen(false);
                }}
              >
                {kind === CUSTOM_KIND ? 'customShader' : kind}
              </button>
            ))}
            <button
              data-testid="add-node-duplicate-output"
              title="Clone the active output's own chain into a new, independently-editable output (virtual copy)"
              onClick={() => {
                duplicateOutput();
                setOpen(false);
              }}
            >
              duplicate output
            </button>
          </div>
        </>
      )}
    </span>
  );
}

/**
 * "Open…" split button + a small "▾" dropdown for "Open Folder…" (folder
 * filmstrip, ROADMAP "nice to have"). The toolbar is already dense (Open,
 * Save, undo/redo, Crop, Spots, Add node, +Radial/+Linear, Presets, mask
 * overlay, Delete node, output selector, Export, Settings — wrapping across
 * two rows on a laptop-width window), and "Open Folder…" is a rare,
 * once-per-session action next to "Open…"'s everyday one — a second
 * always-visible top-level button would just be more toolbar clutter for
 * something used far less often. A tiny caret next to the existing button
 * (same "▾" dropdown pattern as Add node/Presets below) keeps the common
 * case exactly one click, unchanged, and tucks the rare case one click
 * further behind instead of permanently widening the row.
 */
function OpenMenu() {
  const imageStatus = useAppStore((s) => s.imageStatus);
  const openImageViaDialog = useAppStore((s) => s.openImageViaDialog);
  const openFolder = useAppStore((s) => s.openFolder);
  const importSidecarsFromFolder = useAppStore((s) => s.importSidecarsFromFolder);
  const saveQuickProjectAs = useAppStore((s) => s.saveQuickProjectAs);
  const newProject = useAppStore((s) => s.newProject);
  const project = useAppStore((s) => s.project);
  const quickSessionDir = useAppStore((s) => s.quickSessionDir);
  const [open, setOpen] = useState(false);
  const busy = imageStatus === 'loading';
  // "Save as project…" (Quick project → real project, MOVE — see
  // saveQuickProjectAs's own doc comment) only makes sense while the ACTIVE
  // project IS the quick project — a real project is already its own home,
  // no move semantics apply. Per-launch quick project (item A):
  // `settings.quickProjectDir` is now a ROOT, never equal to any real
  // project's own `dir` — `quickSessionDir` (this session's resolved dated
  // subdir, mirrored in the store by ensureActiveProject) is the identity
  // check now, same as saveQuickProjectAs's own.
  const quickDir = window.silverbox.testFlags.projectDirOverride ?? quickSessionDir;
  const isQuickProject = !!project && !!quickDir && project.dir === quickDir;

  return (
    <span className="open-menu">
      <button onClick={() => void openImageViaDialog()} disabled={busy} data-testid="open-button">
        Open…
      </button>
      <button
        onClick={() => setOpen(!open)}
        disabled={busy}
        data-testid="open-menu-toggle"
        title="More open options"
      >
        ▾
      </button>
      {open && (
        <>
          <div className="add-node-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="add-node-menu-list" data-testid="open-menu">
            <button
              data-testid="open-folder-button"
              title="Open a folder — thumbnail strip, click to switch images (no database, nothing persisted)"
              onClick={() => {
                setOpen(false);
                void (async () => {
                  const result = await window.silverbox.openFolderDialog();
                  if (!result.canceled) await openFolder(result.path);
                })();
              }}
            >
              Open Folder…
            </button>
            <button
              data-testid="import-sidecars-folder-button"
              title="Copy every adjacent *.silverbox.json in a folder into this project's looks/ (originals left untouched)"
              onClick={() => {
                setOpen(false);
                void (async () => {
                  const result = await window.silverbox.openFolderDialog();
                  if (!result.canceled) await importSidecarsFromFolder(result.path);
                })();
              }}
            >
              Import sidecars from folder…
            </button>
            <button
              data-testid="save-as-project-button"
              disabled={!isQuickProject}
              title={
                isQuickProject
                  ? "Move the Quick project's current photos + looks into a new project folder"
                  : 'Only the Quick project can be saved as a new project'
              }
              onClick={() => {
                setOpen(false);
                void (async () => {
                  const result = await window.silverbox.openFolderDialog();
                  if (!result.canceled) await saveQuickProjectAs(result.path);
                })();
              }}
            >
              Save as project…
            </button>
            <button
              data-testid="new-project-button"
              title="Close the current project/photo and start a fresh quick-project session (item A)"
              onClick={() => {
                setOpen(false);
                void newProject();
              }}
            >
              New Project
            </button>
          </div>
        </>
      )}
    </span>
  );
}

/**
 * Compare strip (compare pack): the second-output dropdown for Mode B, next
 * to the "Compare" toggle. Only rendered while compare is active AND the doc
 * has 2+ outputs — mirrors OutputSelector's own "appears only with 2+
 * outputs" rule below. Picking "Before" (value "") returns to Mode A;
 * picking any other output switches to Mode B against THAT output.
 */
function CompareStrip() {
  const compareMode = useAppStore((s) => s.compareMode);
  const graph = useAppStore((s) => s.graph);
  const activeOutputId = useAppStore((s) => s.activeOutputId);
  const compareOutputId = useAppStore((s) => s.compareOutputId);
  const setCompareOutputId = useAppStore((s) => s.setCompareOutputId);
  if (!compareMode) return null;
  const outputs = graph.nodes.filter((n) => n.kind === 'output');
  if (outputs.length <= 1) return null;
  const activeId = activeOutputId && outputs.some((n) => n.id === activeOutputId) ? activeOutputId : outputs[0]!.id;
  const candidates = outputs.filter((n) => n.id !== activeId);
  const current = compareOutputId && candidates.some((n) => n.id === compareOutputId) ? compareOutputId : '';
  return (
    <label className="toolbar-output-select" title="Compare the active output against Before or a second output">
      compare vs
      <select
        data-testid="compare-output-selector"
        value={current}
        onChange={(ev) => setCompareOutputId(ev.target.value || null)}
      >
        <option value="">Before</option>
        {candidates.map((n) => (
          <option key={n.id} value={n.id}>
            {outputName(n)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * "Clear rating" affordance (UX pack, hand-test 2026-07-17 item 2: "setting
 * rating back to 0 is awkward" — the '0' key already does it, but there was
 * no mouse path). A slashed star, built inline (no icon dependency): a plain
 * ☆ outline path with a diagonal line drawn across it, both stroked in
 * `currentColor` so the muted/hover coloring below is the only place that
 * needs to change. Sits at the LEFT of the star row (rating-clear reads
 * before the stars themselves, since it acts on all of them at once).
 */
function ClearRatingButton() {
  const setRating = useAppStore((s) => s.setRating);
  return (
    <button
      type="button"
      className="star-clear-button"
      data-testid="toolbar-star-clear"
      title="Clear rating (0)"
      onClick={() => setRating(0)}
    >
      <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
        <path
          d="M12 2.5l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 16.6l-5.6 3-1.4-6.3-4.8-4.3 6.4-.6z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <line x1="2.5" y1="21.5" x2="21.5" y2="2.5" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </button>
  );
}

/**
 * Star-rating control (ratings pack; round-9 fix pack item 3: the stars were
 * display-only, a visible-path violation per DESIGN.md — 1-5/0 keys worked
 * but clicking did nothing). Each star is now its own clickable button:
 * clicking star N sets the rating to N (the same `setRating` the 1-5 keys
 * call); clicking the star that already equals the current rating clears it
 * to 0 (LR's own click-the-current-star-to-clear convention), matching the
 * '0' key's behavior. Still always renders 5 glyphs (filled up to `rating`,
 * empty past it) so "unrated" reads as visible absence, not a missing
 * control — only the interactivity is new. The clear-rating button (above)
 * renders FIRST, left of the 5 stars.
 */
function RatingStars({ rating }: { rating: number }) {
  const setRating = useAppStore((s) => s.setRating);
  return (
    <span className="toolbar-rating" data-testid="toolbar-rating" data-rating={rating} title={`Rating: ${rating}/5 (click a star, or keys 1-5, 0 clears)`}>
      <ClearRatingButton />
      {Array.from({ length: 5 }, (_, i) => {
        const n = i + 1;
        return (
          <button
            key={i}
            type="button"
            className={`star star-button${i < rating ? ' star--filled' : ' star--empty'}`}
            data-testid={`toolbar-star-${n}`}
            title={`Rate ${n}/5${n === rating ? ' (click again to clear)' : ''}`}
            onClick={() => setRating(n === rating ? 0 : n)}
          >
            ★
          </button>
        );
      })}
    </span>
  );
}

/**
 * Pick/reject flag glyph, toolbar version (UX pack, hand-test 2026-07-17
 * item 3: "while editing, the pick/reject state should be visible next to
 * the rating stars"). Shares its color styling with the Filmstrip's own
 * per-cell flag glyph (`.flag-glyph--pick`/`.flag-glyph--reject` in
 * styles.css — one shared rule, not a copy) but adds a third, visible
 * "unflagged" state (⚐, an outline flag) since a toolbar control must always
 * show SOMETHING, unlike a filmstrip cell which simply renders nothing for
 * `flag === null`. Clicking cycles none→pick→reject→none — the same p/x/u
 * semantics App.tsx's keyboard handler already drives, against the same
 * `setFlag` action (an explicit look path, never "the current photo"
 * implicitly — see setFlag's own doc comment); a no-op without an open image
 * (`currentLookPath` is null before anything has ever been opened).
 */
function FlagButton({ flag }: { flag: PhotoFlag | null }) {
  const currentLookPath = useAppStore((s) => s.currentLookPath);
  const setFlag = useAppStore((s) => s.setFlag);
  const cycle = () => {
    if (!currentLookPath) return;
    const next: PhotoFlag | null = flag === null ? 'pick' : flag === 'pick' ? 'reject' : null;
    void setFlag(currentLookPath, next);
  };
  const label = flag === 'pick' ? 'Picked' : flag === 'reject' ? 'Rejected' : 'Unflagged';
  return (
    <button
      type="button"
      className={`toolbar-flag-button flag-glyph${flag ? ` flag-glyph--${flag}` : ' flag-glyph--none'}`}
      data-testid="toolbar-flag"
      data-flag={flag ?? 'none'}
      title={`${label} — click to cycle (keys: p=pick, x=reject, u=unflag)`}
      onClick={cycle}
    >
      {flag === 'pick' ? '⚑' : flag === 'reject' ? '⨯' : '⚐'}
    </button>
  );
}

/** Output selector (spec §6): appears only when the doc has more than one output node. */
function OutputSelector() {
  const graph = useAppStore((s) => s.graph);
  const activeOutputId = useAppStore((s) => s.activeOutputId);
  const setActiveOutputId = useAppStore((s) => s.setActiveOutputId);
  const outputs = graph.nodes.filter((n) => n.kind === 'output');
  if (outputs.length <= 1) return null;
  const current = activeOutputId && outputs.some((n) => n.id === activeOutputId) ? activeOutputId : outputs[0]!.id;
  return (
    <label className="toolbar-output-select" title="Which output the preview renders and export uses">
      output
      <select
        data-testid="output-selector"
        value={current}
        onChange={(ev) => setActiveOutputId(ev.target.value)}
      >
        {outputs.map((n) => (
          <option key={n.id} value={n.id}>
            {outputName(n)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Toolbar() {
  const imageStatus = useAppStore((s) => s.imageStatus);
  const image = useAppStore((s) => s.image);
  const fileName = useAppStore((s) => s.fileName);
  const graphDirty = useAppStore((s) => s.graphDirty);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const graph = useAppStore((s) => s.graph);
  const undoStack = useAppStore((s) => s.undoStack);
  const sidecarNotice = useAppStore((s) => s.sidecarNotice);
  const currentPhotoMissingNotice = useAppStore((s) => s.currentPhotoMissingNotice);
  const sidecarUnreadable = useAppStore((s) => s.sidecarUnreadable);
  const sidecarHotReloadNotice = useAppStore((s) => s.sidecarHotReloadNotice);
  const sharedLookHotReloadNotice = useAppStore((s) => s.sharedLookHotReloadNotice);
  const reflectPendingSharedLook = useAppStore((s) => s.reflectPendingSharedLook);
  const sidecarRating = useAppStore((s) => s.sidecarRating);
  const sidecarFlag = useAppStore((s) => s.sidecarFlag);
  const reloadSidecarNow = useAppStore((s) => s.reloadSidecarNow);
  const showSidecarDiff = useAppStore((s) => s.showSidecarDiff);
  const legacySidecarImportNotice = useAppStore((s) => s.legacySidecarImportNotice);
  const importLegacySidecar = useAppStore((s) => s.importLegacySidecar);
  const projectNotice = useAppStore((s) => s.projectNotice);
  const relinkMismatchNotice = useAppStore((s) => s.relinkMismatchNotice);
  const dismissNotice = useAppStore((s) => s.dismissNotice);
  const relinkPhoto = useAppStore((s) => s.relinkPhoto);
  const saveGraph = useAppStore((s) => s.saveGraph);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const resetAllEdits = useAppStore((s) => s.resetAllEdits);
  const removeOpNode = useAppStore((s) => s.removeOpNode);
  const cropMode = useAppStore((s) => s.cropMode);
  const toggleCropMode = useAppStore((s) => s.toggleCropMode);
  const maskDrawMode = useAppStore((s) => s.maskDrawMode);
  const setMaskDrawMode = useAppStore((s) => s.setMaskDrawMode);
  const maskOverlay = useAppStore((s) => s.maskOverlay);
  const toggleMaskOverlay = useAppStore((s) => s.toggleMaskOverlay);
  const spotMode = useAppStore((s) => s.spotMode);
  const setSpotMode = useAppStore((s) => s.setSpotMode);
  const spotsCapNotice = useAppStore((s) => s.spotsCapNotice);
  const compareMode = useAppStore((s) => s.compareMode);
  const setCompareMode = useAppStore((s) => s.setCompareMode);
  const setExportDialogOpen = useAppStore((s) => s.setExportDialogOpen);
  const setSettingsDialogOpen = useAppStore((s) => s.setSettingsDialogOpen);
  const [ping, setPing] = useState<PingResult | null>(null);

  useEffect(() => {
    window.silverbox.ping().then(setPing).catch(console.error);
  }, []);

  const cap = image?.capture;
  const selected = graph.nodes.find((n) => n.id === selectedNodeId);
  const deletable =
    selected &&
    selected.kind !== 'input' &&
    // an output is deletable only while another remains (removeOpNode enforces the same)
    (selected.kind !== 'output' || graph.nodes.filter((n) => n.kind === 'output').length > 1);
  const selectedIsMask = selected?.kind === MASK_KIND;

  return (
    <div className="toolbar">
      <OpenMenu />
      <button
        onClick={() => void saveGraph()}
        disabled={imageStatus !== 'ready' || sidecarUnreadable}
        data-testid="save-button"
        title={
          sidecarUnreadable
            ? 'Saving is disabled — the sidecar on disk could not be read by this build'
            : 'Save the graph to the sidecar (⌘S)'
        }
      >
        Save
        {graphDirty && (
          <span data-testid="dirty-indicator" title="unsaved graph changes" style={{ color: '#f0a832' }}>
            {' '}
            ●
          </span>
        )}
      </button>
      <button
        onClick={() => void undo()}
        disabled={undoStack.undo.length === 0}
        data-testid="undo-button"
        title={
          // Global-undo (docs/brief-bank/global-undo.md, decision 5): no
          // native Edit-menu on this app (see src/main/index.ts — the default
          // Electron menu is used, no custom Menu.setApplicationMenu) to hang
          // "Undo <label>" off of, so the tooltip is the surface instead.
          undoStack.undo.length > 0 ? `Undo ${undoStack.undo[undoStack.undo.length - 1]!.label} (⌘Z)` : 'Undo (⌘Z)'
        }
      >
        ↩︎
      </button>
      <button
        onClick={() => void redo()}
        disabled={undoStack.redo.length === 0}
        data-testid="redo-button"
        title={undoStack.redo.length > 0 ? `Redo ${undoStack.redo[0]!.label} (⌘⇧Z)` : 'Redo (⌘⇧Z)'}
      >
        ↪︎
      </button>
      {/* Round-11 fix pack item 2 ("presetsの中にあるべきじゃない気がする"): "reset all
          edits" moved out of the Presets menu into the toolbar's whole-photo
          action group (next to Save/undo/redo) — it isn't a preset-family
          concept, it's a whole-photo action like undo/redo. Confirm-free:
          undo (one entry) is still the safety net, same as before the move. */}
      <button
        onClick={resetAllEdits}
        disabled={imageStatus !== 'ready'}
        data-testid="toolbar-reset-all"
        title="Reset all edits — back to a fresh open of this photo (one undo entry, ⇧⌘R)"
      >
        Reset
      </button>
      <button
        onClick={toggleCropMode}
        disabled={imageStatus !== 'ready'}
        data-testid="crop-toggle"
        className={cropMode ? 'active' : undefined}
        title="Crop & straighten (C)"
      >
        Crop
      </button>
      <button
        onClick={() => setSpotMode(!spotMode)}
        disabled={imageStatus !== 'ready'}
        data-testid="spots-toggle"
        className={spotMode ? 'active' : undefined}
        title="Spot removal: drag from a blemish to a clean source area; Escape exits"
      >
        Spots
      </button>
      <button
        onClick={() => setCompareMode(!compareMode)}
        disabled={imageStatus !== 'ready'}
        data-testid="compare-toggle"
        className={compareMode ? 'active' : undefined}
        title="Compare view: current vs before, or a second output (Y); Escape exits"
      >
        Compare
      </button>
      <CompareStrip />
      <AddNodeMenu />
      <span className="local-adjustment-buttons">
        <button
          onClick={() => setMaskDrawMode(maskDrawMode === 'radial' ? null : 'radial')}
          disabled={imageStatus !== 'ready'}
          data-testid="add-local-adjustment-radial"
          className={maskDrawMode === 'radial' ? 'active' : undefined}
          title="Draw a radial local adjustment: drag on the canvas to set center + radius (click alone = default radius); Escape cancels"
        >
          + Radial
        </button>
        <button
          onClick={() => setMaskDrawMode(maskDrawMode === 'linear' ? null : 'linear')}
          disabled={imageStatus !== 'ready'}
          data-testid="add-local-adjustment-linear"
          className={maskDrawMode === 'linear' ? 'active' : undefined}
          title="Draw a linear (graduated) local adjustment: drag on the canvas to set the gradient axis; Escape cancels"
        >
          + Linear
        </button>
      </span>
      <PresetsMenu />
      <SharedLookMenu />
      <button
        onClick={toggleMaskOverlay}
        // Round-7 fix: mirrors 'O' (App.tsx) — always clickable to turn OFF
        // an overlay that's on (even if selection has since moved away from
        // the mask), only requires a mask selection to turn ON.
        disabled={!selectedIsMask && !maskOverlay}
        data-testid="mask-overlay-toggle"
        className={maskOverlay ? 'active' : undefined}
        title="Show the selected mask as a red overlay (O) — enabled while a mask node is selected, or to turn an active overlay off"
      >
        Mask overlay
      </button>
      <button
        onClick={() => selectedNodeId && removeOpNode(selectedNodeId)}
        disabled={!deletable}
        data-testid="delete-node-button"
        title="Delete the selected node"
      >
        Delete node
      </button>
      <OutputSelector />
      <button
        onClick={() => setExportDialogOpen(true)}
        disabled={imageStatus !== 'ready'}
        data-testid="export-button"
        title="Choose quality/output(s) and export (⌘E)"
      >
        Export…
      </button>
      <button
        onClick={() => setSettingsDialogOpen(true)}
        data-testid="settings-button"
        title="App settings (autosave, baseline exposure, preview size)"
      >
        ⚙ Settings…
      </button>
      <div className="toolbar-info">
        {sidecarHotReloadNotice && (
          // The button lives OUTSIDE the ellipsis/nowrap `.toolbar-warn` text
          // span (a sibling, not a child) — nesting it inside would put its
          // hit target under the span's `overflow:hidden` clip, which made
          // it visible but unclickable (Playwright: "span intercepts pointer
          // events").
          <span className="toolbar-hotreload-notice" data-hotreload-kind={sidecarHotReloadNotice.kind}>
            <span className="toolbar-warn" data-testid="hotreload-notice" title={sidecarHotReloadNotice.message}>
              {sidecarHotReloadNotice.message}
            </span>
            {sidecarHotReloadNotice.kind === 'pending' && (
              <>
                {/* Sidecar visual diff (git-native completion brief §1): the
                    AI-loop code-review moment — see this diff against the
                    external content BEFORE deciding Reload vs keep your own
                    unsaved edits. Only meaningful for 'pending' (the only
                    kind where the in-app graph and disk genuinely disagree
                    right now — 'reloaded' already applied, 'malformed' can't
                    be parsed to diff against). */}
                <button onClick={() => void showSidecarDiff()} data-testid="hotreload-diff-button">
                  Show diff
                </button>
                <button onClick={() => void reloadSidecarNow()} data-testid="hotreload-reload-button">
                  Reload
                </button>
              </>
            )}
          </span>
        )}
        {sharedLookHotReloadNotice && (
          // Shared-look hot-reload/drift (linked-looks-stage-d.md, semantics
          // 3/4/7) — same "button as a sibling of the ellipsis span" shape as
          // the sidecar hot-reload notice above, for the same clipped-
          // ancestor reason. 'pending' (semantic 4's clean/dirty guard) is
          // the only kind with a button — the reflect action.
          <span className="toolbar-hotreload-notice" data-sharedlook-notice-kind={sharedLookHotReloadNotice.kind}>
            <span className="toolbar-warn" data-testid="sharedlook-notice" title={sharedLookHotReloadNotice.message}>
              {sharedLookHotReloadNotice.message}
            </span>
            {sharedLookHotReloadNotice.kind === 'pending' && (
              <button onClick={() => void reflectPendingSharedLook()} data-testid="sharedlook-reflect-button">
                反映
              </button>
            )}
          </span>
        )}
        {legacySidecarImportNotice && (
          // Project-storage migration, coupling point 7: this photo has no
          // look yet in the active project, but an old adjacent sidecar
          // sits next to it — never read silently as live state (one
          // source of truth per photo), offered as a one-click import
          // instead. Same "button as a sibling of the ellipsis span, not
          // nested inside it" layout as the hot-reload notice above (its
          // own doc comment explains why: a clipped ancestor swallows
          // pointer events). NG2 fix pack: now dismissable (✕) like every
          // other notice in this group — via the shared `dismissNotice`
          // action, not a one-off local clear.
          <span className="toolbar-hotreload-notice">
            <span className="toolbar-warn" data-testid="legacy-sidecar-notice" title="An old adjacent sidecar exists for this photo but is not the active project's look">
              legacy sidecar found — not applied
            </span>
            <button onClick={() => void importLegacySidecar()} data-testid="import-legacy-sidecar-button">
              Import sidecar
            </button>
            <button
              onClick={() => dismissNotice('legacySidecarImportNotice')}
              data-testid="legacy-sidecar-notice-dismiss"
              title="Dismiss"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </span>
        )}
        {relinkMismatchNotice && (
          // Missing photos, stage 3: the row's look already has a
          // `fingerprint` that disagrees with the candidate the user just
          // picked — reusing the same notice+button pattern as the
          // hot-reload/legacy-sidecar notices above (no new modal framework).
          // NG2 fix pack: dismissable (✕) via the shared `dismissNotice`.
          <span className="toolbar-hotreload-notice">
            <span className="toolbar-warn" data-testid="relink-mismatch-notice" title={relinkMismatchNotice.message}>
              {relinkMismatchNotice.message}
            </span>
            <button
              onClick={() => void relinkPhoto(relinkMismatchNotice.playlistIndex, relinkMismatchNotice.newPath, true)}
              data-testid="relink-anyway-button"
            >
              Relink anyway
            </button>
            <button
              onClick={() => dismissNotice('relinkMismatchNotice')}
              data-testid="relink-mismatch-notice-dismiss"
              title="Dismiss"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </span>
        )}
        {projectNotice && (
          // NG2 fix pack ("imported N looks" notice never dismissed): a
          // 'success' projectNotice (a clean completion) already auto-clears
          // after ~8s via appStore.ts's raiseNotice; an 'error' one (a failed
          // open, a corrupt manifest, a "no match" scan, or any completion
          // report with a real failure in it) stays until this ✕ is clicked.
          // Same "button as a sibling of the ellipsis span" layout as the
          // notices above, for the same clipped-ancestor reason.
          <span className="toolbar-hotreload-notice" data-project-notice-kind={projectNotice.kind}>
            <span className="toolbar-warn" data-testid="project-notice" title={projectNotice.message}>
              {projectNotice.message}
            </span>
            <button
              onClick={() => dismissNotice('projectNotice')}
              data-testid="project-notice-dismiss"
              title="Dismiss"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </span>
        )}
        {sidecarNotice && (
          <span className="toolbar-warn" data-testid="sidecar-notice" title={sidecarNotice}>
            {sidecarNotice}
          </span>
        )}
        {currentPhotoMissingNotice && (
          // NG3 fix pack: the CURRENTLY OPEN photo's file no longer resolves
          // (refreshPlaylistStatus, appStore.ts) — surfaced here rather than
          // silence, since a standalone single-file open has no filmstrip
          // cell to show a missing badge on at all.
          <span className="toolbar-warn" data-testid="current-photo-missing-notice" title={currentPhotoMissingNotice}>
            {currentPhotoMissingNotice}
          </span>
        )}
        {spotsCapNotice && (
          <span className="toolbar-warn" data-testid="spots-cap-notice" title={spotsCapNotice}>
            {spotsCapNotice}
          </span>
        )}
        {sidecarUnreadable && (
          <span
            className="toolbar-warn"
            data-testid="sidecar-guard-notice"
            title="This image's sidecar file could not be parsed by this build; saving is disabled so it is never overwritten."
          >
            Sidecar could not be read — saving is disabled to protect it
          </span>
        )}
        {image && fileName ? (
          <>
            <span style={{ color: '#fff', fontWeight: 'bold' }}>{fileName}</span>
            <RatingStars rating={sidecarRating} />
            <FlagButton flag={sidecarFlag} />
            <span>
              {image.fullWidth}×{image.fullHeight}
            </span>
            <span style={{ color: '#777' }}>
              preview {image.width}×{image.height}
            </span>
            {cap && (
              <span>
                {cap.cameraMake} {cap.cameraModel}
              </span>
            )}
            {image.lensModel && (
              <span data-testid="capture-lens" style={{ color: '#bbb' }}>
                {image.lensModel}
              </span>
            )}
            {cap && cap.isoSpeed > 0 && <span>ISO {cap.isoSpeed}</span>}
            <span style={{ color: '#777' }}>{(image.decodeMs / 1000).toFixed(1)}s</span>
          </>
        ) : (
          <span data-testid="ipc-status">
            {ping ? `no image — electron ${ping.versions.electron}` : 'connecting…'}
          </span>
        )}
      </div>
    </div>
  );
}

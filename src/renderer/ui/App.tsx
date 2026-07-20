import { useEffect, useState } from 'react';
import { Toolbar } from './Toolbar';
import { CanvasView } from './CanvasView';
import { Filmstrip } from './Filmstrip';
import { InspectorPanel } from './InspectorPanel';
import { NodeEditorPanel } from './NodeEditorPanel';
import { ExportDialog } from './ExportDialog';
import { SettingsDialog } from './SettingsDialog';
import { SidecarDiffDialog } from './SidecarDiffDialog';
import { useAppStore } from '../store/appStore';
import { isBypassableNodeKind } from '../engine/graph/graphDoc';
import { isTextEntry } from './textEntry';
import { PROJECT_MANIFEST_NAME } from '../../../shared/ipc';

// Re-exported for back-compat — isTextEntry used to be defined here; it moved
// to its own module (round-10) so CanvasView.tsx could import it too without
// a circular import (App.tsx imports CanvasView).
export { isTextEntry };

declare global {
  interface Window {
    /** Verify-harness hook: open an image bypassing the native dialog. */
    __openImageByPath: (path: string, opts?: { skipSidecar?: boolean; keepFolderContext?: boolean }) => Promise<void>;
    /** Verify-harness hook: open a folder (filmstrip) bypassing the native directory dialog. */
    __openFolderByPath: (path: string) => Promise<void>;
    /** Verify-harness hook: open a project (a directory containing project.silverbox) bypassing drag-drop. */
    __openProjectByPath: (dir: string) => Promise<void>;
    /** Verify-harness hook: "New Project" (UX pack round 2, item A) — same action the toolbar button drives. */
    __newProject: () => Promise<void>;
  }
}

/**
 * "What kind of thing is this path, and what should opening it do" —
 * project.silverbox (or a directory containing one) first, then a plain
 * photo folder, then a standalone image file (openFolder's own listImages
 * call throws for anything that isn't a readable directory, which is
 * exactly the "actually just a file" signal this needs). Shared by the
 * single-file drop handler below AND the file-association `openPath` push
 * (project-storage migration, stage 2) — the same disambiguation either way,
 * whether the path arrived via drag-drop or a double-click in Finder.
 */
async function openPathSmart(path: string): Promise<void> {
  // Dropping/opening project.silverbox itself resolves to its containing
  // directory; a directory drop is handed to openProjectByPath as-is (it
  // checks for a manifest inside and returns false if there isn't one, same
  // "touch nothing, let the caller fall through" contract openFolder's own
  // false return already has).
  const projectDir = path.split('/').pop() === PROJECT_MANIFEST_NAME ? path.slice(0, -(PROJECT_MANIFEST_NAME.length + 1)) : path;
  const openedAsProject = await useAppStore.getState().openProjectByPath(projectDir);
  if (openedAsProject) return;
  const openedAsFolder = await useAppStore.getState().openFolder(path);
  // Not a folder after all — a standalone single-file open. Still activates/
  // extends whatever project is active and shows the strip (item B) — see
  // openImageByPath's own `keepFolderContext` doc comment.
  if (!openedAsFolder) await useAppStore.getState().openImageByPath(path);
}

export function App() {
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    window.__openImageByPath = (path, opts) => useAppStore.getState().openImageByPath(path, opts);
    window.__openFolderByPath = (path: string) => useAppStore.getState().openFolder(path).then(() => undefined);
    window.__openProjectByPath = (dir: string) => useAppStore.getState().openProjectByPath(dir).then(() => undefined);
    window.__newProject = () => useAppStore.getState().newProject();
    const onKeyDown = (ev: KeyboardEvent) => {
      const cmd = ev.metaKey || ev.ctrlKey;
      if (cmd && !ev.altKey && !ev.shiftKey && ev.key === 'o') {
        ev.preventDefault();
        void useAppStore.getState().openImageViaDialog();
      }
      if (cmd && !ev.altKey && !ev.shiftKey && ev.key === 's') {
        ev.preventDefault();
        void useAppStore.getState().saveGraph();
      }
      if (cmd && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'e') {
        if (isTextEntry(ev.target)) return;
        if (useAppStore.getState().imageStatus !== 'ready') return;
        ev.preventDefault();
        useAppStore.getState().setExportDialogOpen(true);
      }
      if (!cmd && !ev.altKey && (ev.key === '\\' || ev.key.toLowerCase() === 'g')) {
        // viewer toggles (LR-style \ = before/after); never steal from inputs
        if (isTextEntry(ev.target)) return;
        if (useAppStore.getState().imageStatus !== 'ready') return;
        ev.preventDefault();
        if (ev.key === '\\') useAppStore.getState().toggleBefore();
        else useAppStore.getState().toggleGrayscaleView();
      }
      if (!cmd && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'y') {
        // Compare view (compare pack): splits the canvas into two synced
        // panes (current vs before, or two outputs). Round-11 fix pack item 3
        // ("compare offはCがいい"): moved off plain `c` onto plain `y` — LRC's
        // own before/after key — freeing `c` to become a crop alias below.
        // ⌘⇧C is copyDevelopSettings above — that check requires `cmd`, so
        // the two never collide (and never did).
        if (isTextEntry(ev.target)) return;
        if (useAppStore.getState().imageStatus !== 'ready') return;
        ev.preventDefault();
        const s = useAppStore.getState();
        s.setCompareMode(!s.compareMode);
      }
      if (!cmd && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'c') {
        // Crop mode. Round-10 fix pack item 2 bound this to 'r' (LR
        // convention) and round-11 fix pack item 3 added plain `c` as a
        // second, equally-bound alias. Round-12 fix pack item 2 ("クロップの
        // Rはいらない気がする…ショートカットは2ついらない、って話でもあるな"):
        // ONE accelerator per operation — 'r' is dropped, plain `c` is now
        // the only crop binding (⌘⇧R is resetAllEdits, which requires `cmd`
        // and was never actually sharing this key).
        if (isTextEntry(ev.target)) return;
        if (useAppStore.getState().imageStatus !== 'ready') return;
        ev.preventDefault();
        useAppStore.getState().toggleCropMode();
      }
      if (!cmd && !ev.altKey && !ev.shiftKey && /^[0-5]$/.test(ev.key)) {
        // Ratings pack: 1-5 sets the star rating, 0 clears it. Deliberately
        // NOT a develop-history entry (see appStore.ts's setRating doc
        // comment) — a rating is metadata about the photo, not an undoable
        // look edit. isTextEntry already covers every digit-accepting
        // surface that must win this keystroke instead (type="number"
        // inputs, Monaco's shader editor); no other control in the app
        // binds bare digit keys, so there is nothing else to collide with.
        // Multi-select (docs/brief-bank/multi-select-sync.md): fans out over
        // the whole filmstrip selection when 2+ are selected — each
        // per-photo write pushes its OWN undo entry (LIFO handles the
        // batch-of-singles naturally; no combined entry). Degrades to
        // "just the canvas photo" for free when nothing else is selected
        // (filmstripSelection is empty then).
        if (isTextEntry(ev.target)) return;
        const s = useAppStore.getState();
        if (s.imageStatus !== 'ready') return;
        ev.preventDefault();
        const rating = Number(ev.key);
        void s.setRating(rating);
        for (const path of s.filmstripSelection) {
          const lookPath = s.lookPathForPhoto(path);
          if (lookPath) void s.setRating(rating, lookPath);
        }
      }
      if (!cmd && !ev.altKey && !ev.shiftKey && (ev.key === 'p' || ev.key === 'x' || ev.key === 'u')) {
        // Pick/reject/unflag (reject-flag pack, docs/brief-bank/reject-
        // flag.md) — LR muscle memory: p=pick, x=reject, u=unflag. Audited
        // against the round-8-13 keyboard map before binding (conductor-
        // playbook.md's shortcut notes + this file's/CanvasView.tsx's own key
        // handlers) — none of p/x/u collided with anything ('m'=bypass,
        // 'y'=compare, 'c'=crop, ⇧⌘R=reset, '['/']'=spot radius, digits
        // 0-5=rating). Multi-select fan-out (same shape as the rating keys
        // above): setFlag already takes an explicit look path rather than
        // reaching for "the current photo" internally, so this calls it once
        // for the canvas photo and once per OTHER selected playlist entry.
        // Independent of rating (LR-consistent): never clears/is cleared by
        // the 1-5/0 keys above.
        if (isTextEntry(ev.target)) return;
        const s = useAppStore.getState();
        if (s.imageStatus !== 'ready' || !s.currentLookPath) return;
        ev.preventDefault();
        const flag = ev.key === 'p' ? 'pick' : ev.key === 'x' ? 'reject' : null;
        void s.setFlag(s.currentLookPath, flag);
        for (const path of s.filmstripSelection) {
          const lookPath = s.lookPathForPhoto(path);
          if (lookPath) void s.setFlag(lookPath, flag);
        }
      }
      if (cmd && !ev.altKey && (ev.key.toLowerCase() === 'z' || ev.key.toLowerCase() === 'y')) {
        // don't steal undo from text fields (Monaco has its own undo stack)
        if (isTextEntry(ev.target)) return;
        ev.preventDefault();
        // Global-undo (docs/brief-bank/global-undo.md): undo()/redo() are
        // async now (a cross-photo entry JUMPS — awaits openImageByPath
        // before reverting) — fire-and-forget here, same as every other
        // async store action this handler kicks off without awaiting.
        if (ev.shiftKey) void useAppStore.getState().redo();
        else void useAppStore.getState().undo();
      }
      if (!cmd && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'm') {
        // Node bypass toggle (Resolve calls this "mute"). Round-11 fix pack
        // item 1 ("⌘Dはもはやいらなくない？（むしろUEだと複製のコマンドに見えるし）"):
        // ⌘D used to be the primary accelerator here (round-9 added plain
        // `m` alongside it); ⌘D is now REMOVED entirely and left unbound —
        // it reads as "duplicate" in Unreal/other tools and may become that
        // here later, so it must not keep meaning "bypass" in the meantime.
        // Plain `m` is the only bypass accelerator now; no unconditional
        // preventDefault is needed (bare `m` has no browser-native meaning to
        // race), so the ordinary isTextEntry-first guard (same shape as every
        // other plain-key shortcut in this handler) is enough.
        if (isTextEntry(ev.target)) return;
        ev.preventDefault();
        const s = useAppStore.getState();
        const node = s.graph.nodes.find((n) => n.id === s.selectedNodeId);
        if (node && isBypassableNodeKind(node.kind)) s.toggleNodeDisabled(node.id);
      }
      if (cmd && ev.shiftKey && !ev.altKey && (ev.key === 'c' || ev.key === 'C')) {
        if (isTextEntry(ev.target)) return;
        ev.preventDefault();
        useAppStore.getState().copyDevelopSettings();
      }
      if (cmd && ev.shiftKey && !ev.altKey && (ev.key === 'v' || ev.key === 'V')) {
        if (isTextEntry(ev.target)) return;
        ev.preventDefault();
        useAppStore.getState().pasteDevelopSettings();
      }
      if (cmd && ev.shiftKey && !ev.altKey && (ev.key === 'r' || ev.key === 'R')) {
        // "Reset all edits" (round-8 NG fix pack item 2) — confirm-free, one
        // undo entry (⌘Z covers it), same reasoning as ⌘⇧C/⌘⇧V above.
        if (isTextEntry(ev.target)) return;
        ev.preventDefault();
        useAppStore.getState().resetAllEdits();
      }
      if (ev.key === 'Escape' && useAppStore.getState().exportDialogOpen) {
        useAppStore.getState().setExportDialogOpen(false);
      }
      if (ev.key === 'Escape' && useAppStore.getState().settingsDialogOpen) {
        useAppStore.getState().setSettingsDialogOpen(false);
      }
      if (ev.key === 'Escape' && useAppStore.getState().sidecarDiffDialog) {
        useAppStore.getState().closeSidecarDiff();
      }
      if (ev.key === 'Escape' && useAppStore.getState().maskDrawMode !== null) {
        // draw-to-create masks (UX pack B §1): Escape cancels cleanly — no
        // nodes created. CanvasView's in-progress drag listener watches this
        // same field flip to null and tears itself down without committing.
        useAppStore.getState().setMaskDrawMode(null);
      }
      if (ev.key === 'Escape' && useAppStore.getState().wbPicking) {
        useAppStore.getState().setWbPicking(false);
      }
      if (ev.key === 'Escape' && useAppStore.getState().colorKeyPicking) {
        useAppStore.getState().setColorKeyPicking(false);
      }
      if (ev.key === 'Escape' && useAppStore.getState().spotMode) {
        // spot removal (task #50): Escape exits cleanly, same as the other
        // canvas modes above — CanvasView's in-progress drag listener (if
        // any) watches this same field flip to false and tears itself down
        // without committing.
        useAppStore.getState().setSpotMode(false);
      }
      if (ev.key === 'Escape' && useAppStore.getState().compareMode) {
        // Compare view (compare pack): Escape exits, same pattern as every
        // other modal canvas tool above — no in-progress gesture to tear
        // down (compare has none), just flip the flag off.
        useAppStore.getState().setCompareMode(false);
      }
      if (ev.key === 'Escape' && useAppStore.getState().filmstripSelection.length > 0) {
        // Multi-select (docs/brief-bank/multi-select-sync.md): Esc collapses
        // back to single-select, same as a plain click on any cell.
        useAppStore.getState().setFilmstripSelection([]);
      }
      if (ev.key === 'Escape' && useAppStore.getState().inspectNodeId !== null) {
        // Inspect mode (per-node-preview pack, tier 2): same "just flip the
        // flag off" shape as compareMode above — inspect isn't a canvas
        // pointer tool (no gesture of its own to tear down).
        useAppStore.getState().setInspectNode(null);
      }
      if ((ev.key === 'Backspace' || ev.key === 'Delete') && useAppStore.getState().spotMode) {
        // Delete-key precedence (task #50): React Flow's own node editor
        // ALSO binds Backspace/Delete (deleteKeyCode, NodeEditorPanel.tsx) to
        // delete whatever graph node is currently selected. Resolution:
        // spot mode is itself a modal tool (like crop/mask-draw) entered and
        // exited explicitly, so being in it already signals canvas-editing
        // intent — no separate DOM-focus check is needed. A selected spot
        // (selectedSpotIndex !== null) takes precedence and consumes the
        // key (preventDefault + stopPropagation, so React Flow's own
        // bubble-phase listener on window never sees it — this handler runs
        // in the capture phase, see the listener registration below). With
        // spot mode on but NO spot selected, this falls through untouched —
        // Backspace/Delete keeps its normal "delete the selected graph node"
        // behavior.
        if (isTextEntry(ev.target)) return;
        const s = useAppStore.getState();
        if (s.selectedSpotIndex !== null && s.selectedNodeId) {
          ev.preventDefault();
          ev.stopPropagation();
          s.removeSpot(s.selectedNodeId, s.selectedSpotIndex);
        }
      }
      if (ev.key === 'Backspace' || ev.key === 'Delete') {
        // "Remove from project" (UX pack round 2, item C; single-photo case
        // widened same day after the user's hand-test — ⌫ on a lone photo
        // did nothing and only the context menu worked: 「deleteで消え
        // なかった。右クリックでは消えた」). Fires when there's a real
        // multi-select (⌘/⇧-click), OR for the current photo alone when NO
        // graph node is selected — a selected node keeps owning ⌫ for React
        // Flow's node deletion / the spot-removal branch above, so graph
        // editing never loses its delete key.
        const s = useAppStore.getState();
        const multi = s.filmstripSelection.length > 0;
        // React Flow selections don't all reach our store: an EDGE (or a
        // rubber-band multi) selection leaves selectedNodeId null but must
        // still own ⌫ for its own deletion (verify-editing's broken-path
        // test caught exactly this) — sniff React Flow's own .selected
        // class as the source of truth for "the graph owns the key".
        const graphOwnsKey =
          s.selectedNodeId !== null ||
          document.querySelector('.react-flow__node.selected, .react-flow__edge.selected') !== null;
        const solo = s.imagePath !== null && !graphOwnsKey;
        if ((multi || solo) && !isTextEntry(ev.target)) {
          ev.preventDefault();
          ev.stopPropagation();
          const paths = [...(s.imagePath ? [s.imagePath] : []), ...s.filmstripSelection];
          void s.removeFromProject(paths);
        }
      }
      if (!cmd && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'o') {
        // masks milestone: 'O' toggles the LR-style red mask overlay.
        // Round-7 hand-test fix ("赤のまま" — the overlay got stuck ON):
        // turning it OFF must always work regardless of what's selected now
        // (the overlay itself auto-clears on selection change — see
        // appStore.ts's lastMaskOverlaySelection subscribe — but a stray
        // stuck-ON overlay from before that fix, or any other path, must
        // still have an escape hatch); turning it ON still requires an
        // actual mask-node selection — there's nothing sensible to show
        // otherwise (spec §5).
        if (isTextEntry(ev.target)) return;
        const s = useAppStore.getState();
        if (s.maskOverlay) {
          ev.preventDefault();
          s.toggleMaskOverlay();
          return;
        }
        const node = s.graph.nodes.find((n) => n.id === s.selectedNodeId);
        if (node?.kind !== 'mask') return;
        ev.preventDefault();
        s.toggleMaskOverlay();
      }
      if (!cmd && !ev.altKey && !ev.shiftKey && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
        // Folder filmstrip prev/next (ROADMAP "nice to have"): never steal
        // arrow keys from a text field, and a complete no-op without a
        // folder context (stepFilmstrip itself also guards this, but
        // checking here too means a bare ArrowLeft/Right on a single-file
        // open doesn't even preventDefault — nothing to lose focus/scroll to).
        if (isTextEntry(ev.target)) return;
        // Arrows are ALSO meaningful on non-text controls (a range slider
        // steps, a select navigates its options) — unlike ⌘Z/O-style
        // shortcuts, this handler must yield to ANY focused input/select,
        // not just text entry. Before the always-visible filmstrip (per-
        // launch project pack) folderDir was null on a single-file open and
        // masked this; now it's always set, and without this guard arrow
        // keys on a focused slider stepped the filmstrip instead
        // (verify-ms4's arrow-on-slider check caught it).
        const tag = (ev.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT') return;
        const s = useAppStore.getState();
        if (!s.folderDir) return;
        ev.preventDefault();
        s.stepFilmstrip(ev.key === 'ArrowRight' ? 1 : -1);
      }
      if (!cmd && !ev.altKey && !ev.shiftKey && ev.key === ' ') {
        // Space = smooth animated fit/center (round-7 UX pack G §2,
        // "スペースでpreviewにフィットする感じで滑らかに中央に戻る"). Deliberately GLOBAL
        // (not gated on cropMode) — recentering the preview is useful in any
        // tool, not just crop. isTextEntry keeps Space typing a literal space
        // in text fields; the canvas-ish target check below additionally
        // keeps Space ACTIVATING a focused <button>/<select> (its native
        // behavior) instead of being hijacked — only body/html/the canvas
        // area itself count as "nothing else wants this Space".
        if (isTextEntry(ev.target)) return;
        const target = ev.target as HTMLElement | null;
        // '.canvas-viewport' is the actual pannable canvas container — NOT
        // the outer '.canvas-view' wrapper, which also contains the
        // Fit/100%/crop-controls BUTTONS (a focused button must keep
        // Space's native "activate" behavior, not have it hijacked here).
        const canvasish = target === document.body || target === document.documentElement || !!target?.closest?.('.canvas-viewport');
        if (!canvasish) return;
        const s = useAppStore.getState();
        if (s.imageStatus !== 'ready') return;
        ev.preventDefault();
        s.viewportFitAnimated?.(250);
      }
    };
    // Capture phase + window target: these shortcuts must fire regardless of
    // which panel currently holds focus (node editor pane, canvas, inspector)
    // — capture guarantees we see the event before any descendant has a
    // chance to stopPropagation() it (React Flow's own pane/selection
    // handling included), so only isTextEntry's explicit guard opts out.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  // NG3 fix pack ("renaming an OPEN photo's file shows nothing"):
  // missing-photo status was only ever (re)computed on project/folder open —
  // an externally renamed/moved/deleted photo showed no cue until the next
  // open. Regaining window focus (alt-tabbing back after fixing/renaming a
  // file in Finder, the common real case) is a cheap, no-fs-watcher-required
  // moment to re-run the SAME projectPhotosStatus join the filmstrip already
  // uses — see appStore.ts's refreshPlaylistStatus (also called after
  // relink/import/save-as, which mutate the playlist directly).
  useEffect(() => {
    const onFocus = () => void useAppStore.getState().refreshPlaylistStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Headless CLI renderer (main/index.ts's `--render` mode): register the
  // job listener, then tell main we're ready — main holds the job until this
  // fires, so there is no race against React mounting (registering the IPC
  // listener BEFORE calling cliReady() closes that window). Harmless no-op
  // outside `--render` (main never sends cli:run otherwise).
  useEffect(() => {
    const unsubscribe = window.silverbox.onCliRun((job) => {
      void (async () => {
        // `job.mode` picks which batch runner handles it (golden renders,
        // ROADMAP "Golden renders", extends the same one-job/stream-results
        // wiring `--render` already used) — see appStore.ts's runCliCheck.
        if (job.mode === 'check') {
          await useAppStore.getState().runCliCheck(job, (result) => window.silverbox.cliProgress(result));
        } else if (job.mode === 'diff') {
          await useAppStore.getState().runCliDiff(job, (result) => window.silverbox.cliProgress(result));
        } else if (job.mode === 'extract-look') {
          await useAppStore.getState().runCliExtractLook(job, (result) => window.silverbox.cliProgress(result));
        } else if (job.mode === 'extract-references') {
          await useAppStore.getState().runCliExtractReferences(job, (result) => window.silverbox.cliProgress(result));
        } else {
          await useAppStore.getState().runCliRender(job, (result) => window.silverbox.cliProgress(result));
        }
        window.silverbox.cliDone();
      })();
    });
    window.silverbox.cliReady();
    return unsubscribe;
  }, []);

  // File-association open (project-storage migration, stage 2 — packaged
  // app only, see package.json's `build.fileAssociations` and main/index.ts's
  // `open-file` handling): same "register the listener BEFORE telling main
  // we're ready" shape as the CLI effect above, so a path queued from a cold
  // double-click launch isn't lost to a mount race. Harmless no-op otherwise
  // (dev mode / no file association never sends `openPath`).
  useEffect(() => {
    const unsubscribe = window.silverbox.onOpenPath((path) => void openPathSmart(path));
    window.silverbox.appReady();
    return unsubscribe;
  }, []);

  // Drag & drop open (UI spec §14): window-level handlers, Files-only, a
  // depth counter to absorb nested enter/leave, drop resolves the path via
  // webUtils.getPathForFile (File.path is gone in Electron 32+).
  useEffect(() => {
    let depth = 0;
    const hasFiles = (ev: DragEvent) => [...(ev.dataTransfer?.types ?? [])].includes('Files');

    const onDragEnter = (ev: DragEvent) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth++;
      setDropActive(true);
    };
    const onDragOver = (ev: DragEvent) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (ev: DragEvent) => {
      if (!hasFiles(ev)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDropActive(false);
    };
    const onDrop = (ev: DragEvent) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault(); // never navigate to the file
      depth = 0;
      setDropActive(false);
      const files = [...(ev.dataTransfer?.files ?? [])];
      // A dropped FOLDER also arrives as a single File entry (the OS gives
      // no other signal), so a lone drop is ambiguous — openPathSmart (this
      // file's module scope, shared with the file-association `openPath`
      // push below) resolves it: project first, then a plain photo folder,
      // then a standalone image file. A single-file drop keeps that exact
      // behavior untouched.
      if (files.length === 1) {
        const path = window.silverbox.getPathForFile(files[0]!);
        if (path) void openPathSmart(path);
        return;
      }
      // A multi-file drop (UX pack, hand-test 2026-07-17 item 1) — dropping
      // N image files used to silently open just one (preferring a RAW-named
      // file, discarding the rest with no feedback at all). openMultiDrop
      // (appStore.ts) now adds every one of them to the active project's
      // playlist and shows the filmstrip, opening the first — UNLESS one of
      // the dropped paths is itself a project.silverbox, in which case that
      // project wins outright (see openMultiDrop's own doc comment).
      const paths = files.map((f) => window.silverbox.getPathForFile(f)).filter((p): p is string => !!p);
      if (paths.length === 0) return;
      void useAppStore.getState().openMultiDrop(paths);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const folderDir = useAppStore((s) => s.folderDir);

  return (
    <div className="app-layout">
      <Toolbar />
      <div className="main-row">
        {/* .canvas-column wraps CanvasView + the filmstrip as a vertical pair
            taking the same horizontal slot CanvasView used to occupy alone —
            CanvasView's own internal layout/CSS is untouched (still flex:1,
            position:relative, filling whatever box it's given), so none of
            its absolute-positioned overlays (crop/mask/spot handles) needed
            to change. `key={folderDir}` forces a full remount of Filmstrip
            on every folder switch — see Filmstrip.tsx's doc comment for why
            that's what actually drives the thumbnail-cache cleanup. */}
        <div className="canvas-column">
          <CanvasView />
          {folderDir !== null && <Filmstrip key={folderDir} />}
        </div>
        <InspectorPanel />
      </div>
      <NodeEditorPanel />
      <ExportDialog />
      <SettingsDialog />
      <SidecarDiffDialog />
      {dropActive && (
        <div className="drop-overlay" data-testid="drop-overlay">
          <div className="drop-overlay-inner">Drop a RAW / JPEG file to open</div>
        </div>
      )}
    </div>
  );
}

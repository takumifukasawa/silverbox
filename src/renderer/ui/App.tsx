import { useEffect, useState } from 'react';
import { Toolbar } from './Toolbar';
import { CanvasView } from './CanvasView';
import { InspectorPanel } from './InspectorPanel';
import { NodeEditorPanel } from './NodeEditorPanel';
import { ExportDialog } from './ExportDialog';
import { SettingsDialog } from './SettingsDialog';
import { useAppStore } from '../store/appStore';
import { isRawFileName } from '../engine/decoder/librawDecoder';

declare global {
  interface Window {
    /** Verify-harness hook: open an image bypassing the native dialog. */
    __openImageByPath: (path: string) => Promise<void>;
  }
}

/** Prefer a RAW-named file; else take the first (multi-file drops open one). */
export function pickDropFile(files: File[]): File | null {
  return files.find((f) => isRawFileName(f.name)) ?? files[0] ?? null;
}

/** <input> types that actually accept free text/numeric entry — everything
 *  else (range, checkbox, radio, color, button…) is a plain control and must
 *  NOT block window-level shortcuts just because it happens to hold focus. */
const TEXT_ENTRY_INPUT_TYPES = new Set(['text', 'number', 'search', 'email', 'password', 'tel', 'url']);

/**
 * Single source of truth for "is the keydown target a text-entry surface" —
 * used to guard every window-level shortcut below. Previously each handler
 * inlined its own `tagName === 'INPUT'` check, which blocked shortcuts for
 * ANY input (including the crop angle range slider and checkboxes) rather
 * than just genuine text entry — that's why ⌘Z/O "sometimes" didn't fire: it
 * depended on which control last held focus, not on whether the user was
 * actually typing (#46/undo-focus).
 */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type || 'text';
    return TEXT_ENTRY_INPUT_TYPES.has(type);
  }
  // Monaco renders into plain <div>/<textarea> nodes inside .shader-editor —
  // its own undo stack and keybindings must own the keystroke, not ours.
  return !!el.closest?.('.shader-editor');
}

export function App() {
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    window.__openImageByPath = (path: string) => useAppStore.getState().openImageByPath(path);
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
      if (cmd && !ev.altKey && (ev.key.toLowerCase() === 'z' || ev.key.toLowerCase() === 'y')) {
        // don't steal undo from text fields (Monaco has its own undo stack)
        if (isTextEntry(ev.target)) return;
        ev.preventDefault();
        if (ev.shiftKey) useAppStore.getState().redo();
        else useAppStore.getState().undo();
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
      if (ev.key === 'Escape' && useAppStore.getState().exportDialogOpen) {
        useAppStore.getState().setExportDialogOpen(false);
      }
      if (ev.key === 'Escape' && useAppStore.getState().settingsDialogOpen) {
        useAppStore.getState().setSettingsDialogOpen(false);
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
      if (!cmd && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'o') {
        // masks milestone: 'O' toggles the LR-style red mask overlay, but
        // only while the selection is actually a mask node — off = normal
        // render, mask stays selected (spec §5).
        if (isTextEntry(ev.target)) return;
        const s = useAppStore.getState();
        const node = s.graph.nodes.find((n) => n.id === s.selectedNodeId);
        if (node?.kind !== 'mask') return;
        ev.preventDefault();
        s.toggleMaskOverlay();
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

  // Headless CLI renderer (main/index.ts's `--render` mode): register the
  // job listener, then tell main we're ready — main holds the job until this
  // fires, so there is no race against React mounting (registering the IPC
  // listener BEFORE calling cliReady() closes that window). Harmless no-op
  // outside `--render` (main never sends cli:run otherwise).
  useEffect(() => {
    const unsubscribe = window.silverbox.onCliRun((job) => {
      void (async () => {
        await useAppStore.getState().runCliRender(job, (result) => window.silverbox.cliProgress(result));
        window.silverbox.cliDone();
      })();
    });
    window.silverbox.cliReady();
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
      const file = pickDropFile([...(ev.dataTransfer?.files ?? [])]);
      if (!file) return;
      const path = window.silverbox.getPathForFile(file);
      if (path) void useAppStore.getState().openImageByPath(path);
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

  return (
    <div className="app-layout">
      <Toolbar />
      <div className="main-row">
        <CanvasView />
        <InspectorPanel />
      </div>
      <NodeEditorPanel />
      <ExportDialog />
      <SettingsDialog />
      {dropActive && (
        <div className="drop-overlay" data-testid="drop-overlay">
          <div className="drop-overlay-inner">Drop a RAW / JPEG file to open</div>
        </div>
      )}
    </div>
  );
}

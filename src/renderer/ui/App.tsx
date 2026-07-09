import { useEffect, useState } from 'react';
import { Toolbar } from './Toolbar';
import { CanvasView } from './CanvasView';
import { InspectorPanel } from './InspectorPanel';
import { NodeEditorPanel } from './NodeEditorPanel';
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
      if (!cmd && !ev.altKey && (ev.key === '\\' || ev.key.toLowerCase() === 'g')) {
        // viewer toggles (LR-style \ = before/after); never steal from inputs
        const target = ev.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.closest?.('.shader-editor'))
        ) {
          return;
        }
        if (useAppStore.getState().imageStatus !== 'ready') return;
        ev.preventDefault();
        if (ev.key === '\\') useAppStore.getState().toggleBefore();
        else useAppStore.getState().toggleGrayscaleView();
      }
      if (cmd && !ev.altKey && (ev.key.toLowerCase() === 'z' || ev.key.toLowerCase() === 'y')) {
        // don't steal undo from text fields (Monaco has its own undo stack)
        const target = ev.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.closest?.('.shader-editor'))
        ) {
          return;
        }
        ev.preventDefault();
        if (ev.shiftKey) useAppStore.getState().redo();
        else useAppStore.getState().undo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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
      {dropActive && (
        <div className="drop-overlay" data-testid="drop-overlay">
          <div className="drop-overlay-inner">Drop a RAW / JPEG file to open</div>
        </div>
      )}
    </div>
  );
}

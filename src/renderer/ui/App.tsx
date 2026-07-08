import { useEffect } from 'react';
import { Toolbar } from './Toolbar';
import { CanvasView } from './CanvasView';
import { InspectorPanel } from './InspectorPanel';
import { NodeEditorPanel } from './NodeEditorPanel';
import { useAppStore } from '../store/appStore';

declare global {
  interface Window {
    /** Verify-harness hook: open an image bypassing the native dialog. */
    __openImageByPath: (path: string) => Promise<void>;
  }
}

export function App() {
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
      if (cmd && !ev.altKey && ev.key.toLowerCase() === 'z') {
        // don't steal undo from text fields (the WGSL editor has its own)
        const target = ev.target as HTMLElement | null;
        if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
        ev.preventDefault();
        if (ev.shiftKey) useAppStore.getState().redo();
        else useAppStore.getState().undo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="app-layout">
      <Toolbar />
      <div className="main-row">
        <CanvasView />
        <InspectorPanel />
      </div>
      <NodeEditorPanel />
    </div>
  );
}

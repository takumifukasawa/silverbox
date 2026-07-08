import { useEffect, useState } from 'react';
import type { PingResult } from '../../../shared/ipc';
import { NodeEditorPanel } from './NodeEditorPanel';

export function App() {
  const [ping, setPing] = useState<PingResult | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);

  useEffect(() => {
    window.silverbox
      .ping()
      .then(setPing)
      .catch((err: Error) => setPingError(err.message));
  }, []);

  return (
    <div className="app-layout">
      <div className="toolbar">
        <button disabled>Open RAW…</button>
        <div className="toolbar-info">
          {pingError ? (
            <span style={{ color: '#e06c75' }}>ipc error: {pingError}</span>
          ) : ping ? (
            <span data-testid="ipc-status">
              electron {ping.versions.electron} / chrome {ping.versions.chrome} / node {ping.versions.node}
            </span>
          ) : (
            <span>connecting…</span>
          )}
        </div>
      </div>
      <div className="main-row">
        <div className="canvas-view">
          <div className="canvas-overlay">Open a RAW file to start</div>
        </div>
        <div className="inspector">
          <div className="inspector-placeholder">Select a node in the graph below.</div>
        </div>
      </div>
      <NodeEditorPanel />
    </div>
  );
}

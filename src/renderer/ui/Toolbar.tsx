import { useEffect, useState } from 'react';
import type { PingResult } from '../../../shared/ipc';
import { useAppStore } from '../store/appStore';
import { BLEND_KIND, CUSTOM_KIND, OPS } from '../engine/graph/ops';
import type { AddableKind } from '../engine/graph/graphDoc';

/**
 * "Add node ▾" menu (UI spec §2): customShader + blend + the atomic nodes.
 * The node is inserted right before `output`, auto-wired and selected (one
 * undo entry); rewire it freely afterwards.
 */
function AddNodeMenu() {
  const addOpNode = useAppStore((s) => s.addOpNode);
  const [open, setOpen] = useState(false);
  const kinds: AddableKind[] = [CUSTOM_KIND, BLEND_KIND, ...(Object.keys(OPS) as AddableKind[])];
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
          </div>
        </>
      )}
    </span>
  );
}

function ExportControls() {
  const imageStatus = useAppStore((s) => s.imageStatus);
  const exportStatus = useAppStore((s) => s.exportStatus);
  const exportError = useAppStore((s) => s.exportError);
  const exportInfo = useAppStore((s) => s.exportInfo);
  const exportImage = useAppStore((s) => s.exportImage);
  const [quality, setQuality] = useState('90');
  const [maxDim, setMaxDim] = useState('');

  const exporting = exportStatus === 'working';
  const q = Math.min(100, Math.max(1, Math.round(Number(quality) || 90)));
  const dim = Math.round(Number(maxDim));
  const maxDimValue = maxDim.trim() !== '' && Number.isFinite(dim) && dim > 0 ? dim : null;

  return (
    <>
      <span className="toolbar-export-opts">
        <label title="JPEG quality (1–100)">
          q
          <input
            type="number"
            min={1}
            max={100}
            value={quality}
            data-testid="export-quality"
            disabled={exporting}
            onChange={(ev) => setQuality(ev.target.value)}
          />
        </label>
        <label title="Long-edge resize in px (empty = full resolution)">
          long edge
          <input
            type="number"
            min={16}
            placeholder="full"
            value={maxDim}
            data-testid="export-maxdim"
            disabled={exporting}
            onChange={(ev) => setMaxDim(ev.target.value)}
          />
        </label>
      </span>
      <button
        onClick={() => void exportImage(undefined, { quality: q, maxDim: maxDimValue })}
        disabled={imageStatus !== 'ready' || exporting}
        data-testid="export-button"
        title="Render the graph at full resolution and export"
      >
        {exporting ? 'Exporting…' : 'Export…'}
      </button>
      {exportStatus === 'error' && (
        <span className="toolbar-error" title={exportError ?? ''}>
          export failed: {exportError}
        </span>
      )}
      {exportInfo && (
        <span className="toolbar-dim" data-testid="export-info">
          exported {exportInfo.width}×{exportInfo.height} ({(exportInfo.bytes / 1024 / 1024).toFixed(1)}MB)
        </span>
      )}
    </>
  );
}

export function Toolbar() {
  const imageStatus = useAppStore((s) => s.imageStatus);
  const image = useAppStore((s) => s.image);
  const fileName = useAppStore((s) => s.fileName);
  const graphDirty = useAppStore((s) => s.graphDirty);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const graph = useAppStore((s) => s.graph);
  const history = useAppStore((s) => s.history);
  const sidecarNotice = useAppStore((s) => s.sidecarNotice);
  const openImageViaDialog = useAppStore((s) => s.openImageViaDialog);
  const saveGraph = useAppStore((s) => s.saveGraph);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const removeOpNode = useAppStore((s) => s.removeOpNode);
  const [ping, setPing] = useState<PingResult | null>(null);

  useEffect(() => {
    window.silverbox.ping().then(setPing).catch(console.error);
  }, []);

  const cap = image?.capture;
  const selected = graph.nodes.find((n) => n.id === selectedNodeId);
  const deletable = selected && selected.kind !== 'input' && selected.kind !== 'output';

  return (
    <div className="toolbar">
      <button onClick={() => void openImageViaDialog()} disabled={imageStatus === 'loading'}>
        Open…
      </button>
      <button
        onClick={() => void saveGraph()}
        disabled={imageStatus !== 'ready'}
        data-testid="save-button"
        title="Save the graph to the sidecar (⌘S)"
      >
        Save
        {graphDirty && (
          <span data-testid="dirty-indicator" title="unsaved graph changes" style={{ color: '#f0a832' }}>
            {' '}
            ●
          </span>
        )}
      </button>
      <button onClick={undo} disabled={history.past.length === 0} data-testid="undo-button" title="Undo (⌘Z)">
        ↩︎
      </button>
      <button onClick={redo} disabled={history.future.length === 0} data-testid="redo-button" title="Redo (⌘⇧Z)">
        ↪︎
      </button>
      <AddNodeMenu />
      <button
        onClick={() => selectedNodeId && removeOpNode(selectedNodeId)}
        disabled={!deletable}
        data-testid="delete-node-button"
        title="Delete the selected node"
      >
        Delete node
      </button>
      <ExportControls />
      <div className="toolbar-info">
        {sidecarNotice && (
          <span className="toolbar-warn" data-testid="sidecar-notice" title={sidecarNotice}>
            {sidecarNotice}
          </span>
        )}
        {image && fileName ? (
          <>
            <span style={{ color: '#fff', fontWeight: 'bold' }}>{fileName}</span>
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

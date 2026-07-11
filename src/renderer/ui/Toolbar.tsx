import { useEffect, useState } from 'react';
import type { PingResult } from '../../../shared/ipc';
import { useAppStore } from '../store/appStore';
import { BLEND_KIND, CUSTOM_KIND, OPS } from '../engine/graph/ops';
import { outputName, type AddableKind } from '../engine/graph/graphDoc';
import { MASK_KIND } from '../engine/graph/maskNode';

/**
 * "Add node ▾" menu (UI spec §2): customShader + blend + mask + output + the
 * atomic nodes. Most kinds are inserted right before the active output,
 * auto-wired and selected (one undo entry); kind 'output' is special — a new
 * output node lands disconnected (named outputs, spec §6) rather than
 * hijacking the existing one; rewire it freely afterwards.
 */
function AddNodeMenu() {
  const addOpNode = useAppStore((s) => s.addOpNode);
  const [open, setOpen] = useState(false);
  const kinds: AddableKind[] = [CUSTOM_KIND, BLEND_KIND, MASK_KIND, 'output', ...(Object.keys(OPS) as AddableKind[])];
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
  const history = useAppStore((s) => s.history);
  const sidecarNotice = useAppStore((s) => s.sidecarNotice);
  const sidecarUnreadable = useAppStore((s) => s.sidecarUnreadable);
  const openImageViaDialog = useAppStore((s) => s.openImageViaDialog);
  const saveGraph = useAppStore((s) => s.saveGraph);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const removeOpNode = useAppStore((s) => s.removeOpNode);
  const cropMode = useAppStore((s) => s.cropMode);
  const toggleCropMode = useAppStore((s) => s.toggleCropMode);
  const maskDrawMode = useAppStore((s) => s.maskDrawMode);
  const setMaskDrawMode = useAppStore((s) => s.setMaskDrawMode);
  const maskOverlay = useAppStore((s) => s.maskOverlay);
  const toggleMaskOverlay = useAppStore((s) => s.toggleMaskOverlay);
  const setExportDialogOpen = useAppStore((s) => s.setExportDialogOpen);
  const [ping, setPing] = useState<PingResult | null>(null);

  useEffect(() => {
    window.silverbox.ping().then(setPing).catch(console.error);
  }, []);

  const cap = image?.capture;
  const selected = graph.nodes.find((n) => n.id === selectedNodeId);
  const deletable = selected && selected.kind !== 'input' && selected.kind !== 'output';
  const selectedIsMask = selected?.kind === MASK_KIND;

  return (
    <div className="toolbar">
      <button onClick={() => void openImageViaDialog()} disabled={imageStatus === 'loading'}>
        Open…
      </button>
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
      <button onClick={undo} disabled={history.past.length === 0} data-testid="undo-button" title="Undo (⌘Z)">
        ↩︎
      </button>
      <button onClick={redo} disabled={history.future.length === 0} data-testid="redo-button" title="Redo (⌘⇧Z)">
        ↪︎
      </button>
      <button
        onClick={toggleCropMode}
        disabled={imageStatus !== 'ready'}
        data-testid="crop-toggle"
        className={cropMode ? 'active' : undefined}
        title="Crop & straighten"
      >
        Crop
      </button>
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
      <button
        onClick={toggleMaskOverlay}
        disabled={!selectedIsMask}
        data-testid="mask-overlay-toggle"
        className={maskOverlay ? 'active' : undefined}
        title="Show the selected mask as a red overlay (O) — enabled while a mask node is selected"
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
      <div className="toolbar-info">
        {sidecarNotice && (
          <span className="toolbar-warn" data-testid="sidecar-notice" title={sidecarNotice}>
            {sidecarNotice}
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

import { useEffect, useRef, useState } from 'react';
import type { ExportColorSpace, ExportMetadataPolicy, ExportPreset, PingResult } from '../../../shared/ipc';
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
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [quality, setQuality] = useState('90');
  const [maxDim, setMaxDim] = useState('');
  const [metadata, setMetadata] = useState<ExportMetadataPolicy>('all');
  const [colorSpace, setColorSpace] = useState<ExportColorSpace>('srgb');
  const [presetName, setPresetName] = useState('');

  // Seed the controls from settings.export exactly once, when settingsGet's
  // IPC round-trip lands (the store starts on DEFAULT_SETTINGS synchronously,
  // then replaces it) — a plain [] dependency would re-seed on every later
  // settingsUpdate (e.g. applying a preset should NOT get overwritten right
  // back by a stale effect run).
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    setQuality(String(settings.export.quality));
    setMaxDim(settings.export.maxDim != null ? String(settings.export.maxDim) : '');
    setMetadata(settings.export.metadata);
    setColorSpace(settings.export.colorSpace);
  }, [settings]);

  const exporting = exportStatus === 'working';
  const q = Math.min(100, Math.max(1, Math.round(Number(quality) || 90)));
  const dim = Math.round(Number(maxDim));
  const maxDimValue = maxDim.trim() !== '' && Number.isFinite(dim) && dim > 0 ? dim : null;

  const applyPreset = (preset: ExportPreset) => {
    setQuality(String(preset.quality));
    setMaxDim(preset.maxDim != null ? String(preset.maxDim) : '');
    setMetadata(preset.metadata);
    setColorSpace(preset.colorSpace);
    setPresetName(preset.name);
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const preset: ExportPreset = { name, quality: q, maxDim: maxDimValue, metadata, colorSpace };
    const exportPresets = [...settings.exportPresets.filter((p) => p.name !== name), preset];
    void updateSettings({ exportPresets });
  };

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
        <label title="EXIF metadata carried into the export ('all' | 'minimal' | 'none' — the color-space ICC profile is always attached regardless)">
          metadata
          <select
            value={metadata}
            data-testid="export-metadata"
            disabled={exporting}
            onChange={(ev) => setMetadata(ev.target.value as ExportMetadataPolicy)}
          >
            <option value="all">all</option>
            <option value="minimal">minimal</option>
            <option value="none">none</option>
          </select>
        </label>
        <label title="Export color space / ICC profile">
          space
          <select
            value={colorSpace}
            data-testid="export-colorspace"
            disabled={exporting}
            onChange={(ev) => setColorSpace(ev.target.value as ExportColorSpace)}
          >
            <option value="srgb">sRGB</option>
            <option value="p3">Display P3</option>
          </select>
        </label>
        <label title="Apply a saved export preset (quality/long edge/metadata/color space)">
          preset
          <select
            value={settings.exportPresets.some((p) => p.name === presetName) ? presetName : ''}
            data-testid="export-preset"
            disabled={exporting || settings.exportPresets.length === 0}
            onChange={(ev) => {
              const preset = settings.exportPresets.find((p) => p.name === ev.target.value);
              if (preset) applyPreset(preset);
            }}
          >
            <option value="">–</option>
            {settings.exportPresets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          placeholder="preset name"
          value={presetName}
          data-testid="export-preset-name"
          disabled={exporting}
          onChange={(ev) => setPresetName(ev.target.value)}
        />
        <button
          type="button"
          onClick={savePreset}
          disabled={exporting || presetName.trim() === ''}
          data-testid="export-save-preset"
          title="Save the current quality/long edge/metadata/color space as a named preset"
        >
          Save preset
        </button>
      </span>
      <button
        onClick={() => void exportImage(undefined, { quality: q, maxDim: maxDimValue, metadata, colorSpace })}
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
  const sidecarUnreadable = useAppStore((s) => s.sidecarUnreadable);
  const openImageViaDialog = useAppStore((s) => s.openImageViaDialog);
  const saveGraph = useAppStore((s) => s.saveGraph);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const removeOpNode = useAppStore((s) => s.removeOpNode);
  const cropMode = useAppStore((s) => s.cropMode);
  const toggleCropMode = useAppStore((s) => s.toggleCropMode);
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

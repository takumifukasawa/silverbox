import { useEffect, useRef, useState } from 'react';
import type { ExportColorSpace, ExportMetadataPolicy, ExportPreset } from '../../../shared/ipc';
import { useAppStore } from '../store/appStore';
import { outputName } from '../engine/graph/graphDoc';

/**
 * Export dialog (UX pack B §4): the quality/long-edge/metadata/color-space/
 * preset controls used to crowd the persistent toolbar (Toolbar.tsx's old
 * ExportControls) — they now live here, opened by the toolbar's "Export…"
 * button (or ⌘E, see App.tsx). Two things this dialog adds over the old
 * inline controls:
 *  - an output-target selector: export one named output, or "All outputs"
 *    (every output node, one file each, suffixed with its name — see
 *    appStore.ts's exportSelectedOutputs/suffixExportPath);
 *  - an autosaveSidecar checkbox in the footer, so the setting the user
 *    could previously only reach via settings.json is discoverable here.
 *
 * Persistence is unchanged: quality/maxDim/metadata/colorSpace/presets still
 * live in settings.export / settings.exportPresets, same seed-once-from-
 * settings pattern the old toolbar controls used.
 */
export function ExportDialog() {
  const open = useAppStore((s) => s.exportDialogOpen);
  const setOpen = useAppStore((s) => s.setExportDialogOpen);
  const graph = useAppStore((s) => s.graph);
  const activeOutputId = useAppStore((s) => s.activeOutputId);
  const exportStatus = useAppStore((s) => s.exportStatus);
  const exportError = useAppStore((s) => s.exportError);
  const exportInfo = useAppStore((s) => s.exportInfo);
  const exportBatchInfo = useAppStore((s) => s.exportBatchInfo);
  const exportSelectedOutputs = useAppStore((s) => s.exportSelectedOutputs);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const outputs = graph.nodes.filter((n) => n.kind === 'output');
  const defaultTarget = (activeOutputId && outputs.some((n) => n.id === activeOutputId) ? activeOutputId : outputs[0]?.id) ?? '';

  const [target, setTarget] = useState(defaultTarget);
  const [quality, setQuality] = useState('90');
  const [maxDim, setMaxDim] = useState('');
  const [metadata, setMetadata] = useState<ExportMetadataPolicy>('all');
  const [colorSpace, setColorSpace] = useState<ExportColorSpace>('srgb');
  const [presetName, setPresetName] = useState('');

  // Re-seed the controls (including the output target) every time the dialog
  // OPENS — a settingsGet() round-trip may have landed while it was closed,
  // and the active output may have changed since the last time it was open.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setTarget(defaultTarget);
      setQuality(String(settings.export.quality));
      setMaxDim(settings.export.maxDim != null ? String(settings.export.maxDim) : '');
      setMetadata(settings.export.metadata);
      setColorSpace(settings.export.colorSpace);
    }
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

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

  const runExport = () => {
    void exportSelectedOutputs(target || 'active', undefined, { quality: q, maxDim: maxDimValue, metadata, colorSpace });
  };

  return (
    <div className="export-dialog-backdrop" data-testid="export-dialog-backdrop" onClick={() => !exporting && setOpen(false)}>
      <div className="export-dialog" data-testid="export-dialog" onClick={(ev) => ev.stopPropagation()}>
        <div className="export-dialog-header">
          <h3>Export</h3>
        </div>
        <div className="export-dialog-body">
          {outputs.length > 1 && (
            <label className="export-dialog-row" title="Which output(s) to render and write">
              Output
              <select
                data-testid="export-output-target"
                value={target}
                disabled={exporting}
                onChange={(ev) => setTarget(ev.target.value)}
              >
                {outputs.map((n) => (
                  <option key={n.id} value={n.id}>
                    {outputName(n)}
                  </option>
                ))}
                <option value="all">All outputs</option>
              </select>
            </label>
          )}
          <label className="export-dialog-row" title="JPEG quality (1–100)">
            Quality
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
          <label className="export-dialog-row" title="Long-edge resize in px (empty = full resolution)">
            Long edge
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
          <label
            className="export-dialog-row"
            title="EXIF metadata carried into the export ('all' | 'minimal' | 'none' — the color-space ICC profile is always attached regardless)"
          >
            Metadata
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
          <label className="export-dialog-row" title="Export color space / ICC profile">
            Color space
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
          <label className="export-dialog-row" title="Apply a saved export preset (quality/long edge/metadata/color space)">
            Preset
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
          <div className="export-dialog-row">
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
          </div>
          {exportStatus === 'error' && (
            <span className="toolbar-error" title={exportError ?? ''}>
              export failed: {exportError}
            </span>
          )}
          {exportBatchInfo ? (
            <span className="toolbar-dim" data-testid="export-info">
              exported {exportBatchInfo.count} file{exportBatchInfo.count === 1 ? '' : 's'}
            </span>
          ) : (
            exportInfo && (
              <span className="toolbar-dim" data-testid="export-info">
                exported {exportInfo.width}×{exportInfo.height} ({(exportInfo.bytes / 1024 / 1024).toFixed(1)}MB)
              </span>
            )
          )}
        </div>
        <div className="export-dialog-footer">
          <label className="export-dialog-autosave" title="Debounced (1s) sidecar autosave while an image is open — this lives in settings.json">
            <input
              type="checkbox"
              checked={settings.autosaveSidecar}
              data-testid="export-autosave-checkbox"
              onChange={(ev) => void updateSettings({ autosaveSidecar: ev.target.checked })}
            />
            Autosave sidecar
            <span className="toolbar-dim"> (settings.json)</span>
          </label>
          <div className="export-dialog-footer-buttons">
            <button type="button" onClick={() => setOpen(false)} disabled={exporting} data-testid="export-close-button">
              Close
            </button>
            <button type="button" onClick={runExport} disabled={exporting || outputs.length === 0} data-testid="export-run-button">
              {exporting ? 'Exporting…' : 'Export'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

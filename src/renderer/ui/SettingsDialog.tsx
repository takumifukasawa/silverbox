import { useAppStore } from '../store/appStore';

/**
 * Settings dialog (UX pack C §4): the app-preferences that used to hide in
 * settings.json (or awkwardly in the export dialog's footer). Opened by the
 * toolbar's "Settings…" gear. All controls persist through updateSettings (the
 * existing settings.json IPC round-trip) — no separate save button; each edit
 * commits immediately, same as the export dialog's autosave checkbox did.
 *
 * Escape (App.tsx's shortcut chain) and a backdrop click both close it — the
 * same patterns as ExportDialog.
 */
export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsDialogOpen);
  const setOpen = useAppStore((s) => s.setSettingsDialogOpen);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  if (!open) return null;

  return (
    <div className="export-dialog-backdrop" data-testid="settings-dialog-backdrop" onClick={() => setOpen(false)}>
      <div className="export-dialog" data-testid="settings-dialog" onClick={(ev) => ev.stopPropagation()}>
        <div className="export-dialog-header">
          <h3>Settings</h3>
        </div>
        <div className="export-dialog-body">
          <label className="export-dialog-autosave" title="Debounced (1s) sidecar autosave while an image is open — persisted in settings.json">
            <input
              type="checkbox"
              checked={settings.autosaveSidecar}
              data-testid="settings-autosave-checkbox"
              onChange={(ev) => void updateSettings({ autosaveSidecar: ev.target.checked })}
            />
            Autosave sidecar
          </label>
          <label className="export-dialog-row" title="Baseline exposure applied to RAW decodes (EV) — the linear first stage of the default look; the per-camera base curve is the second. Re-decodes the open image immediately (round-10 fix); will be calibrated against Lightroom.">
            Baseline exposure (EV)
            <input
              type="number"
              step={0.25}
              value={settings.baselineExposureEV}
              data-testid="settings-baseline-ev"
              onChange={(ev) => {
                const v = Number(ev.target.value);
                if (Number.isFinite(v)) void updateSettings({ baselineExposureEV: v });
              }}
            />
          </label>
          <span className="toolbar-dim">applies immediately to the open image; will be calibrated against Lightroom</span>
          <label className="export-dialog-row" title="Long-edge cap (px) for the interactive decode preview. Applies from the next open; export always decodes full-res.">
            Preview long edge (px)
            <input
              type="number"
              min={256}
              step={64}
              value={settings.previewLongEdge}
              data-testid="settings-preview-longedge"
              onChange={(ev) => {
                const v = Math.round(Number(ev.target.value));
                if (Number.isFinite(v) && v > 0) void updateSettings({ previewLongEdge: v });
              }}
            />
          </label>
          <span className="toolbar-dim">applies from the next open</span>
          <label className="export-dialog-row" title="Where a photo lands when no project is active yet — a real, visible folder you can open in Finder/git, never a hidden app cache. Only takes effect for a NEW quick project (an already-active one doesn't move — 'Save as project…' is planned separately).">
            Quick project folder
            <input
              type="text"
              value={settings.quickProjectDir}
              data-testid="settings-quick-project-dir"
              onChange={(ev) => void updateSettings({ quickProjectDir: ev.target.value })}
            />
          </label>
          <span className="toolbar-dim">only affects a NEW quick project, not the one already active</span>
        </div>
        <div className="export-dialog-footer">
          <div className="export-dialog-footer-buttons">
            <button type="button" onClick={() => setOpen(false)} data-testid="settings-close-button">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

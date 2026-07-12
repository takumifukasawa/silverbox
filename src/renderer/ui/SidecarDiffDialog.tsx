import { useAppStore } from '../store/appStore';

/**
 * Sidecar visual diff dialog (git-native completion brief §1) — the
 * AI-editing loop's "code review for looks" moment: opened by the hot-reload
 * notice's "Show diff" button (Toolbar.tsx) while a 'pending' notice is
 * showing (an external rewrite the current, unsaved session hasn't decided
 * how to handle yet). Shows diffLook's param-language lines between the
 * CURRENT in-app graph+rating and the parsed disk content, plus:
 *  - "Compare visually": rides the existing compare-view machinery with the
 *    disk content as a transient pane-B override (appStore.ts's
 *    compareDocOverride/setCompareDocOverride) — the pixels are garnish, the
 *    lines above are the load-bearing part of this feature.
 *  - "Reload" / "Keep mine": the same decisive pair the toolbar's bare
 *    Reload button and ⌘S already offer (reloadSidecarNow / saveGraph),
 *    just reachable from inside the review dialog so a decision can be made
 *    without hunting back to the toolbar.
 *
 * Same export-dialog-backdrop/export-dialog shell as SettingsDialog/
 * ExportDialog (Escape + backdrop-click close, wired in App.tsx).
 */
export function SidecarDiffDialog() {
  const dialog = useAppStore((s) => s.sidecarDiffDialog);
  const closeSidecarDiff = useAppStore((s) => s.closeSidecarDiff);
  const reloadSidecarNow = useAppStore((s) => s.reloadSidecarNow);
  const saveGraph = useAppStore((s) => s.saveGraph);
  const compareMode = useAppStore((s) => s.compareMode);
  const setCompareMode = useAppStore((s) => s.setCompareMode);
  const compareDocOverride = useAppStore((s) => s.compareDocOverride);
  const setCompareDocOverride = useAppStore((s) => s.setCompareDocOverride);

  if (!dialog) return null;

  const comparingVisually = compareMode && compareDocOverride === dialog.externalGraph;

  const toggleVisualCompare = () => {
    if (comparingVisually) {
      setCompareMode(false); // also clears compareDocOverride — see setCompareMode's doc comment
    } else {
      setCompareDocOverride(dialog.externalGraph);
      setCompareMode(true);
    }
  };

  const handleReload = async () => {
    await reloadSidecarNow();
    closeSidecarDiff();
  };

  const handleKeepMine = async () => {
    await saveGraph();
    closeSidecarDiff();
  };

  return (
    <div className="export-dialog-backdrop" data-testid="sidecar-diff-dialog-backdrop" onClick={closeSidecarDiff}>
      <div className="export-dialog sidecar-diff-dialog" data-testid="sidecar-diff-dialog" onClick={(ev) => ev.stopPropagation()}>
        <div className="export-dialog-header">
          <h3>Sidecar diff — current vs disk</h3>
        </div>
        <div className="export-dialog-body">
          {dialog.lines.length === 0 ? (
            <p className="toolbar-dim" data-testid="sidecar-diff-empty">
              No differences — the in-app graph and the disk content are look-equivalent.
            </p>
          ) : (
            <ul className="sidecar-diff-lines" data-testid="sidecar-diff-lines">
              {dialog.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={toggleVisualCompare}
            data-testid="sidecar-diff-compare-visually"
            className={comparingVisually ? 'active' : undefined}
            title="Split-pane compare: current (left) vs the disk content (right) — the same compare view as the toolbar's Compare button"
          >
            {comparingVisually ? 'Stop visual compare' : 'Compare visually'}
          </button>
        </div>
        <div className="export-dialog-footer">
          <div className="export-dialog-footer-buttons">
            <button type="button" onClick={() => void handleKeepMine()} data-testid="sidecar-diff-keep-mine-button">
              Keep mine
            </button>
            <button type="button" onClick={() => void handleReload()} data-testid="sidecar-diff-reload-button">
              Reload
            </button>
            <button type="button" onClick={closeSidecarDiff} data-testid="sidecar-diff-close-button">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

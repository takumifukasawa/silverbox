import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';

/**
 * "Presets ▾" toolbar dropdown (task #37): a develop preset is a WHOLE
 * LOOK — the entire develop graph, file-based (`<userData>/presets/*.json`)
 * and git-shareable (ROADMAP.md "Presets"). It runs through appStore.ts's
 * captureLook/applyLook, the exact copyDevelopSettings/pasteDevelopSettings
 * code path — saving snapshots what ⌘⇧C would capture, applying does
 * exactly what ⌘⇧V does.
 *
 * Placement: lives here in the toolbar (next to "+ Radial"/"+ Linear"),
 * NOT the per-node InspectorPanel — a preset is a whole-graph concept with
 * no tie to whichever node (if any) happens to be selected, so it belongs
 * with the other graph-level tools (Add node, local adjustments), not a
 * node inspector that renders nothing when selectedNodeId is null.
 *
 * Apply is an explicit button rather than apply-on-select: unlike the
 * export dialog's preset picker (which only pre-fills form fields — free to
 * reconsider), selecting a develop preset mutates the graph and burns one
 * undo entry, so arrow-keying through the <select> must not fire it.
 */
export function PresetsMenu() {
  const imageStatus = useAppStore((s) => s.imageStatus);
  const presets = useAppStore((s) => s.presets);
  const savePreset = useAppStore((s) => s.savePreset);
  const applyPreset = useAppStore((s) => s.applyPreset);
  const deletePreset = useAppStore((s) => s.deletePreset);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [saveName, setSaveName] = useState('');

  // A selected slug can vanish out from under the menu (deleted here, or —
  // in principle — another window/session) without stranding the control.
  useEffect(() => {
    if (selected && !presets.some((p) => p.slug === selected)) setSelected('');
  }, [presets, selected]);

  const ready = imageStatus === 'ready';

  return (
    <span className="presets-menu">
      <button
        data-testid="presets-button"
        title="Save/apply a whole-look develop preset (a JSON file under presets/, git-shareable)"
        onClick={() => setOpen(!open)}
      >
        Presets ▾
      </button>
      {open && (
        <>
          <div className="add-node-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="presets-menu-list" data-testid="presets-menu">
            <label className="presets-menu-row" title="Saved develop presets">
              Preset
              <select data-testid="preset-select" value={selected} onChange={(ev) => setSelected(ev.target.value)}>
                <option value="">–</option>
                {presets.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="presets-menu-row">
              <button
                type="button"
                data-testid="preset-apply"
                disabled={!ready || !selected}
                onClick={() => void applyPreset(selected)}
                title="Apply the selected preset to the open image (one undo entry)"
              >
                Apply
              </button>
              <button
                type="button"
                data-testid="preset-delete"
                disabled={!selected}
                onClick={() => {
                  const slug = selected;
                  setSelected('');
                  void deletePreset(slug);
                }}
                title="Delete this preset's file — no confirm dialog (undo doesn't cover file deletion), enabled only once a preset is explicitly selected"
              >
                Delete
              </button>
            </div>
            <div className="presets-menu-row">
              <input
                type="text"
                placeholder="preset name"
                value={saveName}
                data-testid="preset-save-name"
                onChange={(ev) => setSaveName(ev.target.value)}
              />
              <button
                type="button"
                data-testid="preset-save"
                disabled={!ready || saveName.trim() === ''}
                onClick={() => {
                  const name = saveName;
                  setSaveName('');
                  void savePreset(name);
                }}
                title="Save the current whole-look develop graph as a named preset (same name overwrites it)"
              >
                Save
              </button>
            </div>
          </div>
        </>
      )}
    </span>
  );
}

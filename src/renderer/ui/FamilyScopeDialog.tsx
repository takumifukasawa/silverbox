import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import {
  DEFAULT_CHECKED_FAMILY_IDS,
  PRESET_FAMILY_DEFS,
  type PresetFamilyDef,
  type PresetFamilyId,
} from '../engine/graph/presetFamilies';
import type { Settings } from '../../../shared/ipc';

/**
 * Shared "which param families does this touch" checkbox dialog
 * (docs/brief-bank/preset-scoping-and-export-overrides.md §1). Built for
 * the preset Save flow (PresetsMenu.tsx) but deliberately preset-agnostic —
 * docs/brief-bank/multi-select-sync.md's "Sync…" feature reuses this SAME
 * component for its own confirm dialog ("copy checked families from the
 * primary photo to N secondaries"), which is why every prop below is worded
 * in terms of "families"/"target", never "preset":
 *
 *  - `title` / `targetDescription`: the two pieces of copy that differ per
 *    caller ("Save preset" + `Save "My Look" with:` vs. a future "Sync
 *    selected photos" + `Copy from DSC001.ARW to 3 other photos:`).
 *  - `families`: defaults to the full shared list (presetFamilies.ts's
 *    PRESET_FAMILY_DEFS) — overridable only if some future caller ever
 *    needs a subset, not expected to be used yet.
 *  - `settingsKey`: which `Settings` field remembers the last-used
 *    checkboxes (LR-style) — `'presetSaveFamilies'` today, a future
 *    `'syncFamilies'` once the sync feature adds that field to
 *    shared/ipc.ts + main/settings.ts (the same additive pattern
 *    `presetSaveFamilies` itself followed — see that field's doc comment).
 *    Loosely typed as `string` (not `keyof Settings`) so this component
 *    doesn't need to know about a Settings field that doesn't exist yet;
 *    the read/write below both degrade quietly (empty/malformed →
 *    DEFAULT_CHECKED_FAMILY_IDS) exactly like every other settings field's
 *    own sanitizer.
 *  - Persistence of the remembered checkboxes lives HERE (not pushed onto
 *    each caller) — confirm always writes the just-chosen set back to
 *    `settings[settingsKey]` before invoking `onConfirm`, so both callers
 *    get "remembers last-used checks" for free.
 *
 * The dialog itself does nothing preset-specific: it hands back the checked
 * family id array on confirm and lets the caller decide what "with these
 * families" means (savePreset's `families` argument, or — later — Sync's
 * own apply call).
 */
export interface FamilyScopeDialogProps {
  open: boolean;
  title: string;
  targetDescription: string;
  families?: readonly PresetFamilyDef[];
  settingsKey: string;
  confirmLabel?: string;
  onCancel(): void;
  onConfirm(checked: PresetFamilyId[]): void;
}

export function FamilyScopeDialog({
  open,
  title,
  targetDescription,
  families = PRESET_FAMILY_DEFS,
  settingsKey,
  confirmLabel = 'Save',
  onCancel,
  onConfirm,
}: FamilyScopeDialogProps) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const knownIds = new Set(families.map((f) => f.id));
  const rememberedChecked = (): Set<PresetFamilyId> => {
    const remembered = (settings as unknown as Record<string, unknown>)[settingsKey];
    if (Array.isArray(remembered)) {
      const filtered = remembered.filter(
        (id): id is PresetFamilyId => typeof id === 'string' && knownIds.has(id as PresetFamilyId)
      );
      if (filtered.length > 0) return new Set(filtered);
    }
    return new Set(DEFAULT_CHECKED_FAMILY_IDS.filter((id) => knownIds.has(id)));
  };

  const [checked, setChecked] = useState<Set<PresetFamilyId>>(rememberedChecked);

  // Re-seed from the remembered settings on each OPEN transition (not every
  // render while open) — same idiom as ExportDialog's own wasOpenRef.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) setChecked(rememberedChecked());
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const toggle = (id: PresetFamilyId) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const developFamilies = families.filter((f) => f.group === 'develop');
  const structuralFamilies = families.filter((f) => f.group === 'structural');

  const renderRow = (f: PresetFamilyDef) => (
    <label key={f.id} className="family-scope-row" data-testid={`family-scope-checkbox-${f.id}`}>
      <input type="checkbox" checked={checked.has(f.id)} onChange={() => toggle(f.id)} />
      {f.label}
    </label>
  );

  const handleConfirm = () => {
    const ids = families.filter((f) => checked.has(f.id)).map((f) => f.id);
    // Remember-last-used (LR-style): persist before handing off, so even a
    // caller whose onConfirm throws/aborts still gets the checkbox state
    // remembered for next time.
    void updateSettings({ [settingsKey]: ids } as unknown as Partial<Settings>);
    onConfirm(ids);
  };

  return (
    <div className="export-dialog-backdrop" data-testid="family-scope-dialog-backdrop" onClick={onCancel}>
      <div className="export-dialog family-scope-dialog" data-testid="family-scope-dialog" onClick={(ev) => ev.stopPropagation()}>
        <div className="export-dialog-header">
          <h3>{title}</h3>
          <div className="family-scope-target" data-testid="family-scope-target">
            {targetDescription}
          </div>
        </div>
        <div className="export-dialog-body family-scope-list">
          {developFamilies.map(renderRow)}
          {structuralFamilies.length > 0 && (
            <>
              <div
                className="family-scope-divider"
                data-testid="family-scope-structural-divider"
                title="Graph-shaped structure — rarely what you want to carry along, so these default off"
              >
                structural (rarely what you want)
              </div>
              {structuralFamilies.map(renderRow)}
            </>
          )}
        </div>
        <div className="export-dialog-footer">
          <button type="button" data-testid="family-scope-cancel" onClick={onCancel}>
            Cancel
          </button>
          <div className="export-dialog-footer-buttons">
            <button type="button" data-testid="family-scope-confirm" onClick={handleConfirm}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

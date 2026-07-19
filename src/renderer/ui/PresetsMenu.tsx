import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { parsePresetFile, type ParsedPreset } from '../engine/graph/presetDoc';
import { FamilyScopeDialog } from './FamilyScopeDialog';

/** Debounce for the hover-preview fetch/render (round-7 UX pack G §4) — long
 *  enough that skimming past several rows doesn't trigger a full-graph render
 *  per row, short enough to still feel immediate once the pointer settles. */
const HOVER_PREVIEW_DELAY_MS = 120;

/**
 * "Presets ▾" toolbar dropdown (task #37): a develop preset is normally a
 * WHOLE LOOK — the entire develop graph, file-based
 * (`<userData>/presets/*.json`) and git-shareable (ROADMAP.md "Presets"). It
 * runs through appStore.ts's captureLook/applyLook, the exact
 * copyDevelopSettings/pasteDevelopSettings code path — saving snapshots what
 * ⌘⇧C would capture, applying does exactly what ⌘⇧V does.
 *
 * Preset scoping (docs/brief-bank/preset-scoping-and-export-overrides.md
 * §1): Save no longer writes immediately — it opens FamilyScopeDialog.tsx
 * (the same shared component docs/brief-bank/multi-select-sync.md's future
 * "Sync…" feature reuses), a checkbox list of param families (basic tone /
 * WB / curves / HSL / grading / effects / detail, plus an off-by-default
 * "structural" group: geometry/spots/masks/custom-nodes). Only the CHECKED
 * families' data is written into the file (presetFamilies.ts's
 * buildScopedLook) — the preset FILE contains only what it claims, so it
 * stays diffable and honest, and Apply merges only those families onto the
 * current graph (mergeScopedLook), leaving everything else exactly as it
 * was already open. "Update with current look" is unchanged (still one
 * click, no dialog) — it reuses whatever family scope the preset already
 * had. A preset with no `includes` key at all (every file saved before this
 * feature existed) still applies whole-look, unconditionally.
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
 * undo entry, so arrow-keying through the list must not fire it.
 *
 * Round-7 UX pack G: the preset list is now a plain row list (not a native
 * `<select>`) — a real hover target is what makes the LR-style preview
 * below possible; a native `<option>`'s hover isn't reliably reachable
 * (the popup is OS-drawn once open). §3 adds "Update with current look"
 * (overwrite the selected preset via the same savePreset name-collision
 * path); §4 adds the hover preview itself (now family-scope-aware — see
 * previewParsedPreset in appStore.ts).
 */
export function PresetsMenu() {
  const imageStatus = useAppStore((s) => s.imageStatus);
  const imagePath = useAppStore((s) => s.imagePath);
  // Apply-to-selection (docs/brief-bank/apply-preset-to-selection.md,
  // linked-looks stage A): same total-selected-count shape Filmstrip.tsx's
  // own "N selected" badge uses (imagePath counts once, filmstripSelection
  // never contains it — appStore.ts's own invariant).
  const filmstripSelection = useAppStore((s) => s.filmstripSelection);
  const presets = useAppStore((s) => s.presets);
  const savePreset = useAppStore((s) => s.savePreset);
  const applyPreset = useAppStore((s) => s.applyPreset);
  const applyPresetToSelection = useAppStore((s) => s.applyPresetToSelection);
  const deletePreset = useAppStore((s) => s.deletePreset);
  const setPreviewLook = useAppStore((s) => s.setPreviewLook);
  const previewParsedPreset = useAppStore((s) => s.previewParsedPreset);
  const copyDevelopSettings = useAppStore((s) => s.copyDevelopSettings);
  const pasteDevelopSettings = useAppStore((s) => s.pasteDevelopSettings);
  const hasClipboard = useAppStore((s) => s.developClipboard !== null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [saveName, setSaveName] = useState('');
  // Preset scoping (docs/brief-bank/preset-scoping-and-export-overrides.md
  // §1): Save no longer writes immediately — it opens the shared family-
  // checkbox dialog first (FamilyScopeDialog.tsx), which hands back the
  // checked family ids on confirm. "Update with current look" is unchanged
  // (no dialog) — it deliberately reuses whatever scope the preset already
  // had, see appStore.ts's savePreset doc comment.
  const [saveScopeOpen, setSaveScopeOpen] = useState(false);

  // Parsed-PRESET cache (not just its `.look`), per menu OPEN (brief: "parse
  // the preset file lazily + cache per open of the menu") — a preset file
  // edited on disk while the menu happens to stay open across several
  // hovers would otherwise show a stale preview, but that's the same
  // staleness window presetsState() itself already accepts (a snapshot
  // refreshed on save/delete/boot). Caching the WHOLE ParsedPreset (not just
  // `.look`) is what lets the hover preview stay family-scope-aware — see
  // previewParsedPreset's doc comment.
  const cacheRef = useRef<Map<string, ParsedPreset>>(new Map());
  const hoverTimerRef = useRef<number | undefined>(undefined);
  // Which slug is CURRENTLY hovered, so a debounced fetch that resolves
  // after the pointer has already left (or moved to a different row) never
  // clobbers the preview with a stale result.
  const hoveredSlugRef = useRef<string | null>(null);

  // A selected slug can vanish out from under the menu (deleted here, or —
  // in principle — another window/session) without stranding the control.
  useEffect(() => {
    if (selected && !presets.some((p) => p.slug === selected)) setSelected('');
  }, [presets, selected]);

  // Opening resets the cache (fresh presets may have been saved/deleted since
  // the last open); closing — by any path (backdrop click, Apply, Escape via
  // the menu's own toggle) — clears any lingering preview so the canvas never
  // shows a look the user can no longer see the menu for.
  useEffect(() => {
    if (open) {
      cacheRef.current = new Map();
    } else {
      clearTimeout(hoverTimerRef.current);
      hoveredSlugRef.current = null;
      setPreviewLook(null);
    }
  }, [open, setPreviewLook]);

  // Belt-and-suspenders: clear the preview if this component ever unmounts
  // while a hover (or its debounce) is in flight.
  useEffect(
    () => () => {
      clearTimeout(hoverTimerRef.current);
      setPreviewLook(null);
    },
    [setPreviewLook]
  );

  const ready = imageStatus === 'ready';

  const handleRowEnter = (slug: string) => {
    if (!ready) return;
    hoveredSlugRef.current = slug;
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      void (async () => {
        let parsed = cacheRef.current.get(slug);
        if (!parsed) {
          try {
            const text = await window.silverbox.presetRead(slug);
            if (!text) return;
            parsed = parsePresetFile(text);
            cacheRef.current.set(slug, parsed);
          } catch (err) {
            // Parse failure = no preview, no crash (brief's explicit rule) —
            // the row stays hoverable, it just never shows a preview.
            console.warn(`preset "${slug}" could not be parsed for preview:`, err);
            return;
          }
        }
        // previewParsedPreset (not the raw setPreviewLook) so a family-scoped
        // preset previews the exact MERGED result Apply would produce, not
        // the raw preset content (preset-scoping brief's explicit rule).
        if (hoveredSlugRef.current === slug) previewParsedPreset(parsed);
      })();
    }, HOVER_PREVIEW_DELAY_MS);
  };

  const handleRowLeave = (slug: string) => {
    clearTimeout(hoverTimerRef.current);
    if (hoveredSlugRef.current === slug) hoveredSlugRef.current = null;
    setPreviewLook(null);
  };

  const selectedPreset = presets.find((p) => p.slug === selected);
  const totalSelectedCount = (imagePath ? 1 : 0) + filmstripSelection.length;

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
            <div className="preset-rows" data-testid="preset-select" role="listbox" title="Saved develop presets — hover to preview">
              {presets.length === 0 && <div className="preset-row preset-row--empty">No presets saved</div>}
              {presets.map((p) => (
                <div
                  key={p.slug}
                  className={`preset-row${selected === p.slug ? ' preset-row--selected' : ''}`}
                  data-testid="preset-row"
                  data-slug={p.slug}
                  role="option"
                  aria-selected={selected === p.slug}
                  onClick={() => setSelected(p.slug)}
                  onMouseEnter={() => handleRowEnter(p.slug)}
                  onMouseLeave={() => handleRowLeave(p.slug)}
                >
                  {p.name}
                </div>
              ))}
            </div>
            <div className="presets-menu-row">
              <button
                type="button"
                data-testid="preset-apply"
                disabled={!ready || !selected}
                onClick={() => {
                  setPreviewLook(null);
                  void applyPreset(selected);
                }}
                title="Apply the selected preset to the open image (one undo entry)"
              >
                Apply
              </button>
              {/* Apply-to-selection (docs/brief-bank/apply-preset-to-selection.md,
                  linked-looks stage A — visible-path principle: the SAME
                  preset row, not a new modifier-key-only gesture) — appears
                  only once 2+ photos are selected, applying the preset's
                  OWN saved scope to every one of them (primary included) as
                  ONE undoable batch, no apply-time dialog. */}
              {totalSelectedCount >= 2 && (
                <button
                  type="button"
                  data-testid="preset-apply-selection"
                  disabled={!ready || !selected}
                  onClick={() => {
                    setPreviewLook(null);
                    void applyPresetToSelection(selected);
                  }}
                  title={`Apply the selected preset to every one of the ${totalSelectedCount} selected photos (one undo entry — ⌘Z reverts all of them)`}
                >
                  選択中の{totalSelectedCount}枚に適用
                </button>
              )}
              <button
                type="button"
                data-testid="preset-update"
                disabled={!ready || !selected}
                onClick={() => {
                  setPreviewLook(null);
                  if (selectedPreset) void savePreset(selectedPreset.name);
                }}
                title="Overwrite this preset with the current look (same file: slug/created date are kept)"
              >
                Update with current look
              </button>
              <button
                type="button"
                data-testid="preset-delete"
                disabled={!selected}
                onClick={() => {
                  setPreviewLook(null);
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
                onClick={() => setSaveScopeOpen(true)}
                title="Choose which develop families to save as a named preset (same name overwrites it)"
              >
                Save
              </button>
            </div>
            <FamilyScopeDialog
              open={saveScopeOpen}
              title="Save preset"
              targetDescription={`Save "${saveName.trim()}" with:`}
              settingsKey="presetSaveFamilies"
              confirmLabel="Save"
              onCancel={() => setSaveScopeOpen(false)}
              onConfirm={(families) => {
                setSaveScopeOpen(false);
                const name = saveName;
                setSaveName('');
                void savePreset(name, families);
              }}
            />
            {/* Visible-path principle (DESIGN.md): copy/paste develop
                settings existed only as ⌘⇧C/V — the adoption audit's one
                violation. The clickable path lives here because a preset is
                the persistent cousin of the same concept (captureLook/
                applyLook are literally shared). */}
            <div className="presets-menu-row">
              <button
                type="button"
                data-testid="preset-copy-settings"
                disabled={!ready}
                onClick={copyDevelopSettings}
                title="Copy the current develop settings for pasting onto another photo (⌘⇧C)"
              >
                Copy settings
              </button>
              <button
                type="button"
                data-testid="preset-paste-settings"
                disabled={!ready || !hasClipboard}
                onClick={pasteDevelopSettings}
                title="Paste the copied develop settings onto this photo — one undo entry (⌘⇧V)"
              >
                Paste
              </button>
            </div>
          </div>
        </>
      )}
    </span>
  );
}

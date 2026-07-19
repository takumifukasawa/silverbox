import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { FamilyScopeDialog } from './FamilyScopeDialog';
import { PRESET_FAMILY_DEFS } from '../engine/graph/presetFamilies';

/** Only the `develop` group — a shared look never offers a structural family (linked-looks-stage-b.md semantic 1: refuse/ignore at create time). */
const LOOK_FAMILY_DEFS = PRESET_FAMILY_DEFS.filter((f) => f.group === 'develop');

/**
 * "共通ルック ▾" toolbar dropdown (docs/brief-bank/linked-looks-stage-b.md):
 * the shared-look counterpart of PresetsMenu.tsx, natural home per the
 * brief ("near PresetsMenu in the toolbar"). A shared look is the SAME
 * preset file format (presetDoc.ts), stored per-project at
 * `<projectDir>/shared-looks/<slug>.json` instead of global userData — see
 * appStore.ts's sharedLooks/refreshSharedLooks.
 *
 * Three gestures live here (link/create/delete — the "visible path"
 * obligations that touch the WHOLE-GRAPH/whole-selection surface, not one
 * Develop node): revert-per-family, reset-all, and unlink are per-node
 * concerns and live in the Inspector next to the Develop node they act on
 * (InspectorPanel.tsx's DevelopInspector) — see linked-looks-stage-b.md
 * semantics 4-6.
 *
 * "共通ルックを使う" (Link) always includes the primary (docs' semantic 2:
 * "works on the current filmstrip selection (1..N photos, primary
 * included)") — unlike PresetsMenu's apply-to-selection, there is no
 * "0 secondary selected" special case: linking just the open photo IS the
 * common single-photo gesture, not a batch fallback.
 */
export function SharedLookMenu() {
  const imageStatus = useAppStore((s) => s.imageStatus);
  const imagePath = useAppStore((s) => s.imagePath);
  const project = useAppStore((s) => s.project);
  const filmstripSelection = useAppStore((s) => s.filmstripSelection);
  const sharedLooks = useAppStore((s) => s.sharedLooks);
  const createSharedLook = useAppStore((s) => s.createSharedLook);
  const linkPhotosToLook = useAppStore((s) => s.linkPhotosToLook);
  const deleteSharedLook = useAppStore((s) => s.deleteSharedLook);

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [createName, setCreateName] = useState('');
  const [createScopeOpen, setCreateScopeOpen] = useState(false);

  useEffect(() => {
    if (selected && !sharedLooks.some((p) => p.slug === selected)) setSelected('');
  }, [sharedLooks, selected]);

  const ready = imageStatus === 'ready';
  const linkTargets = imagePath ? [imagePath, ...filmstripSelection] : [];

  return (
    <span className="shared-look-menu">
      <button
        data-testid="shared-look-button"
        disabled={!project}
        title="共通ルック — a shared develop look, followed by 1+ photos in this project (linked-looks-stage-b.md)"
        onClick={() => setOpen(!open)}
      >
        共通ルック ▾
      </button>
      {open && (
        <>
          <div className="add-node-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="shared-look-menu-list" data-testid="shared-look-menu">
            <div className="preset-rows" data-testid="shared-look-select" role="listbox" title="This project's shared looks">
              {sharedLooks.length === 0 && <div className="preset-row preset-row--empty">No shared looks yet</div>}
              {sharedLooks.map((p) => (
                <div
                  key={p.slug}
                  className={`preset-row${selected === p.slug ? ' preset-row--selected' : ''}`}
                  data-testid="shared-look-row"
                  data-slug={p.slug}
                  role="option"
                  aria-selected={selected === p.slug}
                  onClick={() => setSelected(p.slug)}
                >
                  {p.name}
                </div>
              ))}
            </div>
            <div className="presets-menu-row">
              <button
                type="button"
                data-testid="shared-look-link"
                disabled={!ready || !selected}
                onClick={() => {
                  const slug = selected;
                  setOpen(false);
                  void linkPhotosToLook(linkTargets, slug);
                }}
                title="共通ルックを使う — link the open photo (+ any other filmstrip selection) to the selected shared look; one undo entry"
              >
                共通ルックを使う
              </button>
              <button
                type="button"
                data-testid="shared-look-delete"
                disabled={!selected}
                onClick={() => {
                  const slug = selected;
                  setSelected('');
                  setOpen(false);
                  void deleteSharedLook(slug);
                }}
                title="Delete this shared look's file — every follower loses its link (values unchanged); undo restores the link fields, not the file"
              >
                Delete
              </button>
            </div>
            <div className="presets-menu-row">
              <input
                type="text"
                placeholder="shared look name"
                value={createName}
                data-testid="shared-look-create-name"
                onChange={(ev) => setCreateName(ev.target.value)}
              />
              <button
                type="button"
                data-testid="shared-look-create"
                disabled={!ready || createName.trim() === ''}
                onClick={() => setCreateScopeOpen(true)}
                title="Create a new 共通ルック from this photo's checked develop families, then link this photo to it"
              >
                Create
              </button>
            </div>
            <FamilyScopeDialog
              open={createScopeOpen}
              title="Create shared look"
              targetDescription={`Create "${createName.trim()}" with:`}
              families={LOOK_FAMILY_DEFS}
              settingsKey="sharedLookFamilies"
              confirmLabel="Create"
              onCancel={() => setCreateScopeOpen(false)}
              onConfirm={(families) => {
                setCreateScopeOpen(false);
                setOpen(false);
                const name = createName;
                setCreateName('');
                void createSharedLook(name, families);
              }}
            />
          </div>
        </>
      )}
    </span>
  );
}

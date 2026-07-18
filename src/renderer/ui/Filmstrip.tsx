import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { FolderImageEntry } from '../../../shared/ipc';
import { getThumbnail, revokeAllThumbnails } from '../engine/thumbnail/thumbnailCache';
import { MAX_RATING } from '../engine/graph/graphDoc';
import { FamilyScopeDialog } from './FamilyScopeDialog';
import type { PresetFamilyId } from '../engine/graph/presetFamilies';

/**
 * Missing-photo placeholder cell (project-storage migration §"Missing
 * photos", stage 3): the playlist row's path no longer resolves. Two
 * affordances, per the brief — "Relink…" (native file dialog, verifying a
 * `fingerprint` if the look has one — appStore.ts's relinkPhoto handles the
 * match/mismatch/no-fingerprint cases) and "Scan folder…" (pick a folder,
 * main fingerprints candidates in it and relinks on the first match —
 * scanFolderForRelink). A plain `<div>`, not a `<button>` (it holds two real
 * `<button>`s of its own — nesting interactive controls inside a `<button>`
 * is invalid HTML and would make the inner ones unreachable).
 */
function MissingFilmstripCell({ entry, playlistIndex }: { entry: FolderImageEntry; playlistIndex: number }) {
  const relinkPhoto = useAppStore((s) => s.relinkPhoto);
  const scanFolderForRelink = useAppStore((s) => s.scanFolderForRelink);
  const removeFromProject = useAppStore((s) => s.removeFromProject);

  return (
    <div
      className="filmstrip-cell filmstrip-cell--missing"
      data-testid="filmstrip-cell"
      data-path={entry.path}
      title={`${entry.name} — file not found`}
    >
      <span className="filmstrip-missing-badge" data-testid="filmstrip-missing-badge">
        ?
      </span>
      <div className="filmstrip-relink-actions">
        <button
          type="button"
          data-testid="filmstrip-relink-button"
          title="Locate this photo's new location"
          onClick={() => {
            void (async () => {
              const result = await window.silverbox.openImageDialog();
              if (!result.canceled) await relinkPhoto(playlistIndex, result.path);
            })();
          }}
        >
          Relink…
        </button>
        <button
          type="button"
          data-testid="filmstrip-scan-folder-button"
          title="Scan a folder for this photo (matched by content, not just filename)"
          onClick={() => {
            void (async () => {
              const result = await window.silverbox.openFolderDialog();
              if (!result.canceled) await scanFolderForRelink(playlistIndex, result.path);
            })();
          }}
        >
          Scan folder…
        </button>
        <button
          type="button"
          data-testid="filmstrip-remove-button"
          title="Remove this row from the project's playlist (never deletes the photo file; a look file, if any, stays on disk)"
          onClick={() => void removeFromProject([entry.path])}
        >
          Remove from project
        </button>
      </div>
    </div>
  );
}

/**
 * One cell: a thumbnail button that opens its image on click. The thumbnail
 * itself loads lazily — an IntersectionObserver (rooted at the scrolling
 * strip, `.filmstrip`) fires getThumbnail() the first time the cell actually
 * scrolls into view, not on mount, so opening a 400-image folder doesn't
 * decode 400 previews eagerly (thumbnailCache.ts's own concurrency queue
 * caps how many run at once regardless). A `missing` entry renders as
 * MissingFilmstripCell instead (its own relink affordances) — see that
 * component's doc comment.
 *
 * Multi-select (docs/brief-bank/multi-select-sync.md): plain click keeps
 * today's unchanged behavior (open + collapse the selection); ⌘-click
 * toggles this cell's SECONDARY membership without opening it; ⇧-click
 * extends a range from the last plain-clicked cell to this one, over
 * `visibleOrder` (the strip's own currently-visible path list, so a range
 * never reaches through a cell hidden by the ★n+/pick-reject filters).
 */
function FilmstripCell({
  entry,
  current,
  secondary,
  playlistIndex,
  visibleOrder,
}: {
  entry: FolderImageEntry;
  current: boolean;
  secondary: boolean;
  playlistIndex: number;
  visibleOrder: string[];
}) {
  const cellRef = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  // Fixed-position popup, anchored to the CLICK point (not to the cell via
  // `position:absolute`) — `.filmstrip`'s own `overflow-y: hidden` (needed so
  // the horizontally-scrolling strip doesn't grow the canvas column taller)
  // would otherwise clip an absolutely-positioned popup regardless of which
  // direction it opened, since clipping applies to the ancestor's bounding
  // box on every side, not just the one the popup happened to overflow past.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const openImageByPath = useAppStore((s) => s.openImageByPath);
  const toggleFilmstripSelection = useAppStore((s) => s.toggleFilmstripSelection);
  const rangeSelectFilmstrip = useAppStore((s) => s.rangeSelectFilmstrip);
  const setFilmstripSelection = useAppStore((s) => s.setFilmstripSelection);
  const setFilmstripSelectionAnchor = useAppStore((s) => s.setFilmstripSelectionAnchor);
  const removeFromProject = useAppStore((s) => s.removeFromProject);
  const imagePath = useAppStore((s) => s.imagePath);
  const filmstripSelection = useAppStore((s) => s.filmstripSelection);

  useEffect(() => {
    const el = cellRef.current;
    if (!el || entry.missing) return; // nothing to decode for a photo that doesn't resolve — see MissingFilmstripCell
    let cancelled = false;
    const observer = new IntersectionObserver(
      (observed) => {
        if (!observed.some((o) => o.isIntersecting)) return;
        observer.disconnect();
        void getThumbnail(entry.path).then((loaded) => {
          if (!cancelled) setUrl(loaded);
        });
      },
      { root: el.closest('.filmstrip'), rootMargin: '200px' }
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [entry.path, entry.missing]);

  if (entry.missing) return <MissingFilmstripCell entry={entry} playlistIndex={playlistIndex} />;

  // "Remove from project" context menu (item C): right-clicking a cell that's
  // PART of the current selection (primary or secondary) removes the WHOLE
  // selection, same "act on the whole selection" convention the rating/flag
  // keys already follow (App.tsx) — right-clicking an unselected cell removes
  // just that one photo.
  const removalPaths = current || secondary ? [...(imagePath ? [imagePath] : []), ...filmstripSelection] : [entry.path];

  return (
    <div className="filmstrip-cell-container">
      <button
        ref={cellRef}
        type="button"
        className={`filmstrip-cell${current ? ' filmstrip-cell--current' : ''}${secondary ? ' filmstrip-cell--secondary-selected' : ''}`}
        data-testid="filmstrip-cell"
        data-path={entry.path}
        data-selected={current || secondary ? 'true' : undefined}
        title={entry.name}
        onClick={(ev) => {
          if (ev.metaKey || ev.ctrlKey) {
            toggleFilmstripSelection(entry.path);
            return;
          }
          if (ev.shiftKey) {
            rangeSelectFilmstrip(entry.path, visibleOrder);
            return;
          }
          // Plain click (unchanged behavior): open it, collapse any
          // multi-select back to single, and move the ⇧-click range anchor
          // here (LR muscle memory).
          setFilmstripSelection([]);
          setFilmstripSelectionAnchor(entry.path);
          void openImageByPath(entry.path, { keepFolderContext: true });
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setMenuPos({ x: ev.clientX, y: ev.clientY });
        }}
      >
      {url && (
        // Rejected cells dim the THUMBNAIL only (reject-flag pack,
        // docs/brief-bank/reject-flag.md — "≈45% opacity on the thumbnail,
        // not the border"): the cell's own hover/current border rings stay
        // at full opacity, so a rejected cell is still legible as a real
        // clickable cell, just visually de-emphasized.
        <img
          src={url}
          alt=""
          className={`filmstrip-thumb${entry.flag === 'reject' ? ' filmstrip-thumb--rejected' : ''}`}
          data-testid="filmstrip-thumb"
        />
      )}
      {entry.hasLook && (
        <span className="filmstrip-edited-dot" data-testid="filmstrip-edited-dot" title="Has a saved look" />
      )}
      {entry.rating > 0 && (
        // Tiny rating indicator (ratings pack) — read cheaply off the
        // sidecar wrapper by main's listImages handler (see shared/ipc.ts's
        // FolderImageEntry.rating doc comment), not re-parsed here.
        <span
          className="filmstrip-rating"
          data-testid="filmstrip-rating"
          data-rating={entry.rating}
          title={`${entry.rating} star${entry.rating === 1 ? '' : 's'}`}
        >
          {'★'.repeat(entry.rating)}
        </span>
      )}
      {entry.flag && (
        // Pick/reject glyph (reject-flag pack) — same "read cheaply off the
        // wrapper, don't re-parse here" pattern as the rating span above.
        // Bottom-right so it never collides with the edited-dot (top-right)
        // or the rating stars (bottom-left). Coloring is the shared
        // .flag-glyph--pick/--reject rule (styles.css) also used by the
        // toolbar's own flag button (UX pack item 3) — one rule, not a copy.
        <span
          className={`filmstrip-flag flag-glyph flag-glyph--${entry.flag}`}
          data-testid="filmstrip-flag"
          data-flag={entry.flag}
          title={entry.flag === 'pick' ? 'Pick' : 'Reject'}
        >
          {entry.flag === 'pick' ? '⚑' : '⨯'}
        </span>
      )}
      </button>
      {menuPos && (
        <>
          <div className="add-node-menu-backdrop" onClick={() => setMenuPos(null)} />
          <div
            className="add-node-menu-list filmstrip-cell-menu"
            data-testid="filmstrip-cell-menu"
            style={{ position: 'fixed', left: menuPos.x, top: menuPos.y, transform: 'translateY(-100%)' }}
          >
            <button
              type="button"
              data-testid="filmstrip-remove-button"
              title="Never deletes/moves the photo file — a look file, if any, stays on disk (recoverable by re-dropping the photo)"
              onClick={() => {
                setMenuPos(null);
                void removeFromProject(removalPaths);
              }}
            >
              Remove from project{removalPaths.length > 1 ? ` (${removalPaths.length})` : ''}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * "★n+" view-only filter (ratings pack): narrows the visible cells to
 * `rating >= minRating`, purely client-side over the already-fetched
 * `folderEntries` — never persisted, never touches the filesystem again
 * (same "browse a folder, not a catalog" spirit as the strip itself). Lives
 * as local component state in Filmstrip below, reset to "All" on every
 * folder switch (the strip itself remounts per folder — see this file's own
 * doc comment on `key={dir}`).
 */
function RatingFilter({ value, onChange }: { value: number; onChange: (rating: number) => void }) {
  return (
    <label className="filmstrip-rating-filter" title="Show only images rated at least this high (view only — not saved)">
      <select
        data-testid="filmstrip-rating-filter"
        value={value}
        onChange={(ev) => onChange(Number(ev.target.value))}
      >
        <option value={0}>All</option>
        {Array.from({ length: MAX_RATING }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>
            {'★'.repeat(n)}+
          </option>
        ))}
      </select>
    </label>
  );
}

/** Session-only flag filter values (reject-flag pack) — the second segment alongside the ★n+ filter, composed with it by AND. */
type FlagFilterValue = 'all' | 'hideRejected' | 'picksOnly';

/**
 * Pick/reject view-only filter (reject-flag pack, docs/brief-bank/reject-
 * flag.md): "All" / "Hide rejected" / "Picks only" — same purely client-side,
 * never-persisted, `key={dir}`-resets-it-to-"All" shape as RatingFilter
 * above (this is deliberately a SEPARATE control, not folded into the same
 * `<select>`, since the two filters compose by AND rather than being
 * mutually exclusive options of one axis).
 */
function FlagFilter({ value, onChange }: { value: FlagFilterValue; onChange: (value: FlagFilterValue) => void }) {
  return (
    <label className="filmstrip-flag-filter" title="Show only picked/non-rejected images (view only — not saved)">
      <select
        data-testid="filmstrip-flag-filter"
        value={value}
        onChange={(ev) => onChange(ev.target.value as FlagFilterValue)}
      >
        <option value="all">All</option>
        <option value="hideRejected">Hide rejected</option>
        <option value="picksOnly">Picks only</option>
      </select>
    </label>
  );
}

/**
 * Folder filmstrip (ROADMAP "nice to have" — browse a folder, NOT a
 * catalog): a horizontal, lazily-thumbnailed strip below the canvas,
 * rendered whenever a PROJECT is active (appStore.ts's folderDir — UX pack
 * round 2, item B: ANY photo open activates one, including a standalone
 * single-file open, which shows a 1-cell strip that grows). Post-project-
 * storage-migration (stage 1), the cells are the
 * active PROJECT's whole playlist (appStore.ts's folderEntries, rebuilt from
 * `project.photos` — see buildPlaylistEntries), not one folder's raw
 * listing — a playlist doesn't own photos, they can come from anywhere (see
 * FolderImageEntry's own doc comment). `key={dir}` at the mount site forces
 * a full remount on every folder/project switch, which is what actually
 * drives the thumbnail-cache cleanup: this component's unmount effect below
 * runs for the OLD folder before the new one's instance mounts fresh (see
 * App.tsx).
 */
export function Filmstrip() {
  const folderEntries = useAppStore((s) => s.folderEntries);
  const imagePath = useAppStore((s) => s.imagePath);
  const fileName = useAppStore((s) => s.fileName);
  // Multi-select (docs/brief-bank/multi-select-sync.md): SECONDARY paths
  // only — the primary is `imagePath` itself (see this field's own doc
  // comment in appStore.ts).
  const filmstripSelection = useAppStore((s) => s.filmstripSelection);
  const syncSelection = useAppStore((s) => s.syncSelection);
  // Auto Sync (item E): LR-style toggle beside Sync… — persisted, default
  // off (today's explicit-only behavior unless the user opts in). The
  // fan-out itself lives in appStore.ts's debounced subscriber (gesture-end
  // proxy, same shape as sidecar autosave); this checkbox only flips the
  // setting it reads.
  const autoSyncEnabled = useAppStore((s) => s.settings.autoSyncEnabled);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  // ★n+ filter (ratings pack): strip-local view state, reset to "All" every
  // time this component remounts (a fresh folder — see the doc comment
  // above on `key={dir}`), never persisted.
  const [minRating, setMinRating] = useState(0);
  // Pick/reject filter (reject-flag pack): same reset-on-remount, session-
  // only state, composed with the ★n+ filter above by AND (a photo must
  // satisfy BOTH to stay visible).
  const [flagFilter, setFlagFilter] = useState<FlagFilterValue>('all');

  // Folder-switch cleanup: this instance is remounted (key={dir} at the
  // mount site — see App.tsx) whenever the folder changes, so this cleanup
  // runs for the OUTGOING folder's cached blob: URLs right as the new
  // instance takes over — never leaked, never revoked while still in use.
  useEffect(() => () => revokeAllThumbnails(), []);

  // Indexed BEFORE the rating filter: folderEntries is 1:1 with the active
  // project's `photos` array in order (buildPlaylistEntries, appStore.ts),
  // so an entry's position here IS its playlist index — relinkPhoto/
  // scanFolderForRelink (Missing photos, stage 3) need that index, and the
  // ★n+ filter below must not renumber it.
  const indexedEntries = useMemo(() => folderEntries.map((entry, playlistIndex) => ({ entry, playlistIndex })), [folderEntries]);
  const visibleEntries = useMemo(
    () =>
      indexedEntries.filter(({ entry }) => {
        if (minRating > 0 && entry.rating < minRating) return false;
        if (flagFilter === 'hideRejected' && entry.flag === 'reject') return false;
        if (flagFilter === 'picksOnly' && entry.flag !== 'pick') return false;
        return true;
      }),
    [indexedEntries, minRating, flagFilter]
  );

  // ⇧-click's range order — the currently VISIBLE path list, so a range
  // never silently reaches through a cell hidden by either filter above.
  const visibleOrder = useMemo(() => visibleEntries.map(({ entry }) => entry.path), [visibleEntries]);
  const secondarySelected = useMemo(() => new Set(filmstripSelection), [filmstripSelection]);
  // "N selected" (multi-select-sync.md's toolbar badge): the primary
  // (imagePath) counts once, plus every secondary — filmstripSelection never
  // contains imagePath itself (see appStore.ts's own invariant), so no dedup
  // is needed here.
  const totalSelectedCount = (imagePath ? 1 : 0) + filmstripSelection.length;
  const primaryName = fileName ?? 'the current photo';

  return (
    <div className="filmstrip-wrap" data-testid="filmstrip-wrap">
      <div className="filmstrip-toolbar">
        {totalSelectedCount >= 2 && (
          <span className="filmstrip-selection-count" data-testid="filmstrip-selection-count">
            {totalSelectedCount} selected
          </span>
        )}
        <button
          type="button"
          className="filmstrip-sync-button"
          data-testid="filmstrip-sync-button"
          disabled={totalSelectedCount < 2}
          title="Copy checked develop families from the current photo to every other selected photo (undoable — ⌘Z)"
          onClick={() => setSyncDialogOpen(true)}
        >
          Sync…
        </button>
        <label
          className="filmstrip-autosync-toggle"
          title="Auto Sync (LR-style): while on, every completed edit on the current photo fans out to the rest of the selection automatically (uses the same checked families as Sync…)"
        >
          <input
            type="checkbox"
            data-testid="filmstrip-autosync-toggle"
            checked={autoSyncEnabled}
            onChange={(ev) => void updateSettings({ autoSyncEnabled: ev.target.checked })}
          />
          Auto Sync
        </label>
        <RatingFilter value={minRating} onChange={setMinRating} />
        <FlagFilter value={flagFilter} onChange={setFlagFilter} />
      </div>
      <div className="filmstrip" data-testid="filmstrip">
        {visibleEntries.map(({ entry, playlistIndex }) => (
          <FilmstripCell
            key={entry.path}
            entry={entry}
            current={entry.path === imagePath}
            secondary={secondarySelected.has(entry.path)}
            playlistIndex={playlistIndex}
            visibleOrder={visibleOrder}
          />
        ))}
      </div>
      <FamilyScopeDialog
        open={syncDialogOpen}
        title="Sync…"
        targetDescription={`Copy from "${primaryName}" to ${filmstripSelection.length} other photo${filmstripSelection.length === 1 ? '' : 's'} (⌘Z reverts all of them):`}
        settingsKey="syncFamilies"
        confirmLabel="Sync"
        onCancel={() => setSyncDialogOpen(false)}
        onConfirm={(families: PresetFamilyId[]) => {
          setSyncDialogOpen(false);
          void syncSelection(families);
        }}
      />
    </div>
  );
}

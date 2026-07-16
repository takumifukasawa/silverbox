import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { FolderImageEntry } from '../../../shared/ipc';
import { getThumbnail, revokeAllThumbnails } from '../engine/thumbnail/thumbnailCache';
import { MAX_RATING } from '../engine/graph/graphDoc';

/**
 * One cell: a thumbnail button that opens its image on click. The thumbnail
 * itself loads lazily — an IntersectionObserver (rooted at the scrolling
 * strip, `.filmstrip`) fires getThumbnail() the first time the cell actually
 * scrolls into view, not on mount, so opening a 400-image folder doesn't
 * decode 400 previews eagerly (thumbnailCache.ts's own concurrency queue
 * caps how many run at once regardless).
 */
function FilmstripCell({ entry, current }: { entry: FolderImageEntry; current: boolean }) {
  const cellRef = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const openImageByPath = useAppStore((s) => s.openImageByPath);

  useEffect(() => {
    const el = cellRef.current;
    if (!el || entry.missing) return; // nothing to decode for a photo that doesn't resolve — see the `missing` placeholder styling below
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

  return (
    <button
      ref={cellRef}
      type="button"
      className={`filmstrip-cell${current ? ' filmstrip-cell--current' : ''}${entry.missing ? ' filmstrip-cell--missing' : ''}`}
      data-testid="filmstrip-cell"
      data-path={entry.path}
      title={entry.missing ? `${entry.name} — file not found` : entry.name}
      disabled={entry.missing}
      onClick={() => {
        if (!entry.missing) void openImageByPath(entry.path, { keepFolderContext: true });
      }}
    >
      {url && <img src={url} alt="" className="filmstrip-thumb" data-testid="filmstrip-thumb" />}
      {entry.missing && (
        <span className="filmstrip-missing-badge" data-testid="filmstrip-missing-badge">
          ?
        </span>
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
    </button>
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

/**
 * Folder filmstrip (ROADMAP "nice to have" — browse a folder, NOT a
 * catalog): a horizontal, lazily-thumbnailed strip below the canvas,
 * rendered only while a folder/project context exists (appStore.ts's
 * folderDir) — a single-file open shows none of this, exactly today's
 * experience. Post-project-storage-migration (stage 1), the cells are the
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
  // ★n+ filter (ratings pack): strip-local view state, reset to "All" every
  // time this component remounts (a fresh folder — see the doc comment
  // above on `key={dir}`), never persisted.
  const [minRating, setMinRating] = useState(0);

  // Folder-switch cleanup: this instance is remounted (key={dir} at the
  // mount site — see App.tsx) whenever the folder changes, so this cleanup
  // runs for the OUTGOING folder's cached blob: URLs right as the new
  // instance takes over — never leaked, never revoked while still in use.
  useEffect(() => () => revokeAllThumbnails(), []);

  const visibleEntries = useMemo(
    () => (minRating === 0 ? folderEntries : folderEntries.filter((e) => e.rating >= minRating)),
    [folderEntries, minRating]
  );

  return (
    <div className="filmstrip-wrap" data-testid="filmstrip-wrap">
      <div className="filmstrip-toolbar">
        <RatingFilter value={minRating} onChange={setMinRating} />
      </div>
      <div className="filmstrip" data-testid="filmstrip">
        {visibleEntries.map((entry) => (
          <FilmstripCell key={entry.path} entry={entry} current={entry.path === imagePath} />
        ))}
      </div>
    </div>
  );
}

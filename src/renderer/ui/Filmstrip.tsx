import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { FolderImageEntry } from '../../../shared/ipc';
import { getThumbnail, revokeAllThumbnails } from '../engine/thumbnail/thumbnailCache';
import { MAX_RATING } from '../engine/graph/graphDoc';

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
 */
function FilmstripCell({ entry, current, playlistIndex }: { entry: FolderImageEntry; current: boolean; playlistIndex: number }) {
  const cellRef = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const openImageByPath = useAppStore((s) => s.openImageByPath);

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

  return (
    <button
      ref={cellRef}
      type="button"
      className={`filmstrip-cell${current ? ' filmstrip-cell--current' : ''}`}
      data-testid="filmstrip-cell"
      data-path={entry.path}
      title={entry.name}
      onClick={() => void openImageByPath(entry.path, { keepFolderContext: true })}
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
        // or the rating stars (bottom-left).
        <span
          className={`filmstrip-flag filmstrip-flag--${entry.flag}`}
          data-testid="filmstrip-flag"
          data-flag={entry.flag}
          title={entry.flag === 'pick' ? 'Pick' : 'Reject'}
        >
          {entry.flag === 'pick' ? '⚑' : '⨯'}
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

  return (
    <div className="filmstrip-wrap" data-testid="filmstrip-wrap">
      <div className="filmstrip-toolbar">
        <RatingFilter value={minRating} onChange={setMinRating} />
        <FlagFilter value={flagFilter} onChange={setFlagFilter} />
      </div>
      <div className="filmstrip" data-testid="filmstrip">
        {visibleEntries.map(({ entry, playlistIndex }) => (
          <FilmstripCell key={entry.path} entry={entry} current={entry.path === imagePath} playlistIndex={playlistIndex} />
        ))}
      </div>
    </div>
  );
}

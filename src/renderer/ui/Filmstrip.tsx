import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { FolderImageEntry } from '../../../shared/ipc';
import { getThumbnail, revokeAllThumbnails } from '../engine/thumbnail/thumbnailCache';

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
    if (!el) return;
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
  }, [entry.path]);

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
      {url && <img src={url} alt="" className="filmstrip-thumb" data-testid="filmstrip-thumb" />}
      {entry.hasSidecar && (
        <span className="filmstrip-edited-dot" data-testid="filmstrip-edited-dot" title="Has a saved sidecar" />
      )}
    </button>
  );
}

/**
 * Folder filmstrip (ROADMAP "nice to have" — browse a folder, NOT a
 * catalog): a horizontal, lazily-thumbnailed strip below the canvas,
 * rendered only while a folder context exists (appStore.ts's folderDir) —
 * a single-file open shows none of this, exactly today's experience.
 * `key={dir}` at the mount site forces a full remount on every folder
 * switch, which is what actually drives the thumbnail-cache cleanup: this
 * component's unmount effect below runs for the OLD folder before the new
 * one's instance mounts fresh (see App.tsx).
 */
export function Filmstrip() {
  const folderEntries = useAppStore((s) => s.folderEntries);
  const imagePath = useAppStore((s) => s.imagePath);

  // Folder-switch cleanup: this instance is remounted (key={dir} at the
  // mount site — see App.tsx) whenever the folder changes, so this cleanup
  // runs for the OUTGOING folder's cached blob: URLs right as the new
  // instance takes over — never leaked, never revoked while still in use.
  useEffect(() => () => revokeAllThumbnails(), []);

  return (
    <div className="filmstrip" data-testid="filmstrip">
      {folderEntries.map((entry) => (
        <FilmstripCell key={entry.path} entry={entry} current={entry.path === imagePath} />
      ))}
    </div>
  );
}

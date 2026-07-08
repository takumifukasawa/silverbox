import { useEffect, useState } from 'react';
import type { PingResult } from '../../../shared/ipc';
import { useAppStore } from '../store/appStore';

export function Toolbar() {
  const imageStatus = useAppStore((s) => s.imageStatus);
  const image = useAppStore((s) => s.image);
  const fileName = useAppStore((s) => s.fileName);
  const graphDirty = useAppStore((s) => s.graphDirty);
  const openImageViaDialog = useAppStore((s) => s.openImageViaDialog);
  const [ping, setPing] = useState<PingResult | null>(null);

  useEffect(() => {
    window.silverbox.ping().then(setPing).catch(console.error);
  }, []);

  const cap = image?.capture;

  return (
    <div className="toolbar">
      <button onClick={() => void openImageViaDialog()} disabled={imageStatus === 'loading'}>
        Open…
      </button>
      <div className="toolbar-info">
        {image && fileName ? (
          <>
            <span style={{ color: '#fff', fontWeight: 'bold' }}>{fileName}</span>
            {graphDirty && (
              <span data-testid="dirty-indicator" title="unsaved graph changes (⌘S to save)" style={{ color: '#e5c07b' }}>
                ●
              </span>
            )}
            <span>
              {image.fullWidth}×{image.fullHeight}
            </span>
            <span style={{ color: '#777' }}>
              preview {image.width}×{image.height}
            </span>
            {cap && (
              <span>
                {cap.cameraMake} {cap.cameraModel}
              </span>
            )}
            {cap && cap.isoSpeed > 0 && <span>ISO {cap.isoSpeed}</span>}
            <span style={{ color: '#777' }}>{(image.decodeMs / 1000).toFixed(1)}s</span>
          </>
        ) : (
          <span data-testid="ipc-status">
            {ping ? `no image — electron ${ping.versions.electron}` : 'connecting…'}
          </span>
        )}
      </div>
    </div>
  );
}

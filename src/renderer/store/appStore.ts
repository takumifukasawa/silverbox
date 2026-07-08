import { create } from 'zustand';
import { loadImage } from '../engine/decoder/imageLoader';
import { isRawFileName } from '../engine/decoder/librawDecoder';
import type { PreparedImage } from '../engine/decoder/decodeWorker';

export type ImageStatus = 'idle' | 'loading' | 'ready' | 'error';

interface AppState {
  imageStatus: ImageStatus;
  image: PreparedImage | null;
  fileName: string | null;
  imageError: string | null;
  openImageByPath(path: string): Promise<void>;
  openImageViaDialog(): Promise<void>;
}

export function isJpegFileName(name: string): boolean {
  return /\.(jpg|jpeg)$/i.test(name);
}

export const useAppStore = create<AppState>((set, get) => ({
  imageStatus: 'idle',
  image: null,
  fileName: null,
  imageError: null,

  async openImageByPath(path: string) {
    const fileName = path.split('/').pop() ?? path;
    const kind = isRawFileName(fileName) ? 'raw' : isJpegFileName(fileName) ? 'jpg' : null;
    if (!kind) {
      set({ imageStatus: 'error', imageError: `unsupported file type: ${fileName}` });
      return;
    }
    set({ imageStatus: 'loading', fileName, imageError: null });
    try {
      const bytes = await window.silverbox.readFile(path);
      const image = await loadImage(bytes, kind);
      set({ imageStatus: 'ready', image });
    } catch (err) {
      set({ imageStatus: 'error', image: null, imageError: err instanceof Error ? err.message : String(err) });
    }
  },

  async openImageViaDialog() {
    if (get().imageStatus === 'loading') return;
    const result = await window.silverbox.openImageDialog();
    if (result.canceled) return;
    await get().openImageByPath(result.path);
  },
}));

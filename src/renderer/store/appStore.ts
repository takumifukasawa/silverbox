import { create } from 'zustand';
import { loadImage } from '../engine/decoder/imageLoader';
import { isRawFileName } from '../engine/decoder/librawDecoder';
import type { PreparedImage } from '../engine/decoder/decodeWorker';
import { defaultGraphDoc, type GraphDoc } from '../engine/graph/graphDoc';

export type ImageStatus = 'idle' | 'loading' | 'ready' | 'error';

interface AppState {
  imageStatus: ImageStatus;
  image: PreparedImage | null;
  fileName: string | null;
  imageError: string | null;
  graph: GraphDoc;
  selectedNodeId: string | null;
  openImageByPath(path: string): Promise<void>;
  openImageViaDialog(): Promise<void>;
  selectNode(id: string | null): void;
  updateNodeParam(nodeId: string, key: string, value: number): void;
  moveNode(nodeId: string, position: { x: number; y: number }): void;
}

export function isJpegFileName(name: string): boolean {
  return /\.(jpg|jpeg)$/i.test(name);
}

export const useAppStore = create<AppState>((set, get) => ({
  imageStatus: 'idle',
  image: null,
  fileName: null,
  imageError: null,
  graph: defaultGraphDoc(),
  selectedNodeId: null,

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

  selectNode(id) {
    set({ selectedNodeId: id });
  },

  updateNodeParam(nodeId, key, value) {
    set((s) => ({
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) =>
          n.id === nodeId ? { ...n, params: { ...n.params, [key]: value } } : n
        ),
      },
    }));
  },

  moveNode(nodeId, position) {
    set((s) => ({
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
      },
    }));
  },
}));

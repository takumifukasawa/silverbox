import { create } from 'zustand';
import { loadImage } from '../engine/decoder/imageLoader';
import { isRawFileName } from '../engine/decoder/librawDecoder';
import type { PreparedImage } from '../engine/decoder/decodeWorker';
import { defaultGraphDoc, defaultParams, nextId, type GraphDoc } from '../engine/graph/graphDoc';
import type { OpKind } from '../engine/graph/ops';

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
  addOpNode(kind: OpKind): void;
  removeOpNode(nodeId: string): void;
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

  // Insert before the output node; the new node takes the output's spot and
  // the output shifts right so the chain stays readable.
  addOpNode(kind) {
    set((s) => {
      const g = s.graph;
      const out = g.nodes.find((n) => n.kind === 'output');
      const inEdge = g.edges.find((e) => e.target === out?.id);
      if (!out || !inEdge) return {};
      const id = nextId(g, kind);
      const node = { id, kind, position: { ...out.position }, params: defaultParams(kind) };
      const nodes = g.nodes
        .map((n) => (n.id === out.id ? { ...n, position: { x: n.position.x + 180, y: n.position.y } } : n))
        .concat(node);
      const e1 = { id: nextId({ ...g, nodes }, 'e'), source: inEdge.source, target: id };
      const e2 = { id: nextId({ ...g, nodes, edges: [...g.edges, e1] }, 'e'), source: id, target: out.id };
      const edges = g.edges.filter((e) => e !== inEdge).concat(e1, e2);
      return { graph: { ...g, nodes, edges }, selectedNodeId: id };
    });
  },

  removeOpNode(nodeId) {
    set((s) => {
      const g = s.graph;
      const node = g.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind === 'input' || node.kind === 'output') return {};
      const inEdge = g.edges.find((e) => e.target === nodeId);
      const outEdge = g.edges.find((e) => e.source === nodeId);
      const edges = g.edges.filter((e) => e !== inEdge && e !== outEdge);
      if (inEdge && outEdge) edges.push({ id: nextId(g, 'e'), source: inEdge.source, target: outEdge.target });
      return {
        graph: { ...g, nodes: g.nodes.filter((n) => n.id !== nodeId), edges },
        selectedNodeId: s.selectedNodeId === nodeId ? null : s.selectedNodeId,
      };
    });
  },
}));

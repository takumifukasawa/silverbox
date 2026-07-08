import { create } from 'zustand';
import { loadImage } from '../engine/decoder/imageLoader';
import { isRawFileName } from '../engine/decoder/librawDecoder';
import type { PreparedImage } from '../engine/decoder/decodeWorker';
import {
  defaultGraphDoc,
  defaultParams,
  nextId,
  parseGraphDoc,
  serializeGraphDoc,
  type GraphDoc,
} from '../engine/graph/graphDoc';
import { CUSTOM_KIND, DEFAULT_CUSTOM_CODE, type OpKind } from '../engine/graph/ops';
import { SIDECAR_SUFFIX } from '../../../shared/ipc';

export type ImageStatus = 'idle' | 'loading' | 'ready' | 'error';

interface AppState {
  imageStatus: ImageStatus;
  image: PreparedImage | null;
  fileName: string | null;
  imagePath: string | null;
  imageError: string | null;
  graph: GraphDoc;
  /** Graph differs from what the sidecar holds (or would hold). */
  graphDirty: boolean;
  selectedNodeId: string | null;
  /** WGSL compile errors by node id (custom nodes render identity meanwhile). */
  shaderErrors: Record<string, string>;
  openImageByPath(path: string): Promise<void>;
  openImageViaDialog(): Promise<void>;
  selectNode(id: string | null): void;
  updateNodeParam(nodeId: string, key: string, value: number): void;
  moveNode(nodeId: string, position: { x: number; y: number }): void;
  addOpNode(kind: OpKind | typeof CUSTOM_KIND): void;
  removeOpNode(nodeId: string): void;
  updateNodeCode(nodeId: string, code: string): void;
  setShaderErrors(errors: Record<string, string>): void;
  /** Write the graph to the image's sidecar (`<image>.silverbox.json`). */
  saveGraph(): Promise<void>;
}

export function isJpegFileName(name: string): boolean {
  return /\.(jpg|jpeg)$/i.test(name);
}

export const useAppStore = create<AppState>((set, get) => ({
  imageStatus: 'idle',
  image: null,
  fileName: null,
  imagePath: null,
  imageError: null,
  graph: defaultGraphDoc(),
  graphDirty: false,
  selectedNodeId: null,
  shaderErrors: {},

  async openImageByPath(path: string) {
    const fileName = path.split('/').pop() ?? path;
    const kind = isRawFileName(fileName) ? 'raw' : isJpegFileName(fileName) ? 'jpg' : null;
    if (!kind) {
      set({ imageStatus: 'error', imageError: `unsupported file type: ${fileName}` });
      return;
    }
    set({ imageStatus: 'loading', fileName, imagePath: path, imageError: null });
    try {
      const bytes = await window.silverbox.readFile(path);
      const image = await loadImage(bytes, kind);
      // The graph belongs to the image: restore its sidecar, or start fresh.
      // A malformed sidecar falls back to the default doc (and stays on disk
      // untouched until the user saves over it).
      let graph = defaultGraphDoc();
      try {
        const sidecar = await window.silverbox.readSidecar(path + SIDECAR_SUFFIX);
        if (sidecar !== null) graph = parseGraphDoc(sidecar);
      } catch (err) {
        console.warn(`ignoring invalid sidecar for ${fileName}:`, err);
      }
      set({ imageStatus: 'ready', image, graph, graphDirty: false, selectedNodeId: null });
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
      graphDirty: true,
    }));
  },

  moveNode(nodeId, position) {
    set((s) => ({
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
      },
      graphDirty: true,
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
      const node = {
        id,
        kind,
        position: { ...out.position },
        params: defaultParams(kind),
        ...(kind === CUSTOM_KIND ? { code: DEFAULT_CUSTOM_CODE } : {}),
      };
      const nodes = g.nodes
        .map((n) => (n.id === out.id ? { ...n, position: { x: n.position.x + 180, y: n.position.y } } : n))
        .concat(node);
      const e1 = { id: nextId({ ...g, nodes }, 'e'), source: inEdge.source, target: id };
      const e2 = { id: nextId({ ...g, nodes, edges: [...g.edges, e1] }, 'e'), source: id, target: out.id };
      const edges = g.edges.filter((e) => e !== inEdge).concat(e1, e2);
      return { graph: { ...g, nodes, edges }, graphDirty: true, selectedNodeId: id };
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
        graphDirty: true,
        selectedNodeId: s.selectedNodeId === nodeId ? null : s.selectedNodeId,
      };
    });
  },

  updateNodeCode(nodeId, code) {
    set((s) => ({
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, code } : n)),
      },
      graphDirty: true,
    }));
  },

  setShaderErrors(errors) {
    set({ shaderErrors: errors });
  },

  async saveGraph() {
    const { imagePath, graph } = get();
    if (!imagePath) return;
    await window.silverbox.writeSidecar(imagePath + SIDECAR_SUFFIX, serializeGraphDoc(graph));
    set({ graphDirty: false });
  },
}));

import { create } from 'zustand';
import { loadImage } from '../engine/decoder/imageLoader';
import { isRawFileName } from '../engine/decoder/librawDecoder';
import type { PreparedImage } from '../engine/decoder/decodeWorker';
import {
  buildPlan,
  defaultGraphDoc,
  defaultParams,
  nextId,
  parseGraphDoc,
  serializeGraphDoc,
  type AddableKind,
  type GraphDoc,
} from '../engine/graph/graphDoc';
import type { GraphRenderer, HistogramData } from '../engine/gpu/graphRenderer';
import { BLEND_KIND, CUSTOM_KIND, DEFAULT_CUSTOM_CODE } from '../engine/graph/ops';
import { SIDECAR_SUFFIX } from '../../../shared/ipc';

export type ImageStatus = 'idle' | 'loading' | 'ready' | 'error';

interface GraphHistory {
  past: GraphDoc[];
  future: GraphDoc[];
  /**
   * Coalescing tag of the edit that produced the newest `past` entry —
   * consecutive edits with the same tag (one slider drag) share one entry.
   */
  lastCoalesceKey: string | null;
}

const HISTORY_LIMIT = 100;

const emptyHistory = (): GraphHistory => ({ past: [], future: [], lastCoalesceKey: null });

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
  /** The live GraphRenderer (registered by CanvasView; used for export). */
  renderer: GraphRenderer | null;
  exportStatus: 'idle' | 'working' | 'error';
  exportError: string | null;
  /** Stats of the current render (updated debounced after each render). */
  histogram: HistogramData | null;
  history: GraphHistory;
  openImageByPath(path: string): Promise<void>;
  openImageViaDialog(): Promise<void>;
  selectNode(id: string | null): void;
  updateNodeParam(nodeId: string, key: string, value: number): void;
  moveNode(nodeId: string, position: { x: number; y: number }): void;
  addOpNode(kind: AddableKind): void;
  removeOpNode(nodeId: string): void;
  /** Rewire an input: replaces whatever currently feeds (target, handle). */
  connectEdge(source: string, target: string, targetHandle?: 'a' | 'b'): void;
  updateNodeCode(nodeId: string, code: string): void;
  setShaderErrors(errors: Record<string, string>): void;
  setRenderer(renderer: GraphRenderer): void;
  setHistogram(histogram: HistogramData | null): void;
  /** Write the graph to the image's sidecar (`<image>.silverbox.json`). */
  saveGraph(): Promise<void>;
  /** Develop at full resolution and write .jpg/.png (dialog when no path). */
  exportImage(path?: string): Promise<void>;
  undo(): void;
  redo(): void;
}

/** History advance for a graph mutation; `key` coalesces slider-drag runs. */
function pushHistory(s: AppState, key: string | null): { history: GraphHistory } {
  const coalesce = key !== null && key === s.history.lastCoalesceKey;
  return {
    history: {
      past: coalesce ? s.history.past : [...s.history.past.slice(-(HISTORY_LIMIT - 1)), s.graph],
      future: [],
      lastCoalesceKey: key,
    },
  };
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
  renderer: null,
  exportStatus: 'idle',
  exportError: null,
  histogram: null,
  history: emptyHistory(),

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
      set({ imageStatus: 'ready', image, graph, graphDirty: false, selectedNodeId: null, history: emptyHistory() });
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
      ...pushHistory(s, `param:${nodeId}:${key}`),
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
      ...pushHistory(s, `move:${nodeId}`),
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
      },
      graphDirty: true,
    }));
  },

  // Insert before the output node; the new node takes the output's spot and
  // the output shifts right so the chain stays readable. A blend node gets
  // both inputs from the previous source (a self-blend is an identity) —
  // rewiring 'b' onto another branch is what makes it useful.
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
      let scratch: GraphDoc = { ...g, nodes, edges: g.edges.filter((e) => e !== inEdge) };
      const addEdge = (source: string, target: string, targetHandle?: 'a' | 'b') => {
        const edge = { id: nextId(scratch, 'e'), source, target, ...(targetHandle ? { targetHandle } : {}) };
        scratch = { ...scratch, edges: [...scratch.edges, edge] };
      };
      if (kind === BLEND_KIND) {
        addEdge(inEdge.source, id, 'a');
        addEdge(inEdge.source, id, 'b');
      } else {
        addEdge(inEdge.source, id);
      }
      addEdge(id, out.id);
      return { ...pushHistory(s, null), graph: scratch, graphDirty: true, selectedNodeId: id };
    });
  },

  removeOpNode(nodeId) {
    set((s) => {
      const g = s.graph;
      const node = g.nodes.find((n) => n.id === nodeId);
      if (!node || node.kind === 'input' || node.kind === 'output') return {};
      // bypass: route the node's input (blend: its 'a' input) to every target
      // it fed, preserving handles
      const incoming = g.edges.filter((e) => e.target === nodeId);
      const outgoing = g.edges.filter((e) => e.source === nodeId);
      const bypass =
        node.kind === BLEND_KIND ? incoming.find((e) => e.targetHandle === 'a')?.source : incoming[0]?.source;
      let scratch: GraphDoc = {
        ...g,
        nodes: g.nodes.filter((n) => n.id !== nodeId),
        edges: g.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      };
      if (bypass) {
        for (const e of outgoing) {
          const edge = {
            id: nextId(scratch, 'e'),
            source: bypass,
            target: e.target,
            ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
          };
          scratch = { ...scratch, edges: [...scratch.edges, edge] };
        }
      }
      return {
        ...pushHistory(s, null),
        graph: scratch,
        graphDirty: true,
        selectedNodeId: s.selectedNodeId === nodeId ? null : s.selectedNodeId,
      };
    });
  },

  connectEdge(source, target, targetHandle) {
    set((s) => {
      const g = s.graph;
      const edges = g.edges.filter(
        (e) => !(e.target === target && (e.targetHandle ?? null) === (targetHandle ?? null))
      );
      const edge = {
        id: nextId({ ...g, edges }, 'e'),
        source,
        target,
        ...(targetHandle ? { targetHandle } : {}),
      };
      const graph = { ...g, edges: [...edges, edge] };
      try {
        buildPlan(graph); // reject cycles / invalid wiring outright
      } catch {
        return {};
      }
      return { ...pushHistory(s, null), graph, graphDirty: true };
    });
  },

  updateNodeCode(nodeId, code) {
    set((s) => ({
      ...pushHistory(s, null),
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => (n.id === nodeId ? { ...n, code } : n)),
      },
      graphDirty: true,
    }));
  },

  undo() {
    set((s) => {
      const prev = s.history.past.at(-1);
      if (!prev) return {};
      return {
        graph: prev,
        history: {
          past: s.history.past.slice(0, -1),
          future: [s.graph, ...s.history.future],
          lastCoalesceKey: null,
        },
        graphDirty: true,
        selectedNodeId: prev.nodes.some((n) => n.id === s.selectedNodeId) ? s.selectedNodeId : null,
      };
    });
  },

  redo() {
    set((s) => {
      const next = s.history.future[0];
      if (!next) return {};
      return {
        graph: next,
        history: {
          past: [...s.history.past, s.graph],
          future: s.history.future.slice(1),
          lastCoalesceKey: null,
        },
        graphDirty: true,
        selectedNodeId: next.nodes.some((n) => n.id === s.selectedNodeId) ? s.selectedNodeId : null,
      };
    });
  },

  setShaderErrors(errors) {
    set({ shaderErrors: errors });
  },

  setRenderer(renderer) {
    set({ renderer });
  },

  setHistogram(histogram) {
    set({ histogram });
  },

  async exportImage(path) {
    const { imagePath, fileName, graph, renderer, imageStatus, exportStatus } = get();
    if (!imagePath || !fileName || !renderer || imageStatus !== 'ready' || exportStatus === 'working') return;
    let target = path ?? null;
    if (!target) {
      const result = await window.silverbox.exportImageDialog(imagePath.replace(/\.[^.]+$/, '') + '.jpg');
      if (result.canceled) return;
      target = result.path;
    }
    set({ exportStatus: 'working', exportError: null });
    try {
      const bytes = await window.silverbox.readFile(imagePath);
      const kind = isRawFileName(fileName) ? 'raw' : 'jpg';
      const full = await loadImage(bytes, kind, Number.MAX_SAFE_INTEGER);
      const { data, width, height } = await renderer.renderToPixels(full, buildPlan(graph));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
      ctx.putImageData(new ImageData(data, width, height), 0, 0);
      const png = /\.png$/i.test(target);
      const blob = await canvas.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.92 });
      await window.silverbox.writeImageFile(target, await blob.arrayBuffer());
      set({ exportStatus: 'idle' });
    } catch (err) {
      set({ exportStatus: 'error', exportError: err instanceof Error ? err.message : String(err) });
    }
  },

  async saveGraph() {
    const { imagePath, graph } = get();
    if (!imagePath) return;
    await window.silverbox.writeSidecar(imagePath + SIDECAR_SUFFIX, serializeGraphDoc(graph));
    set({ graphDirty: false });
  },
}));

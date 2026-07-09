import { create } from 'zustand';
import { loadImage } from '../engine/decoder/imageLoader';
import { isRawFileName } from '../engine/decoder/librawDecoder';
import type { PreparedImage } from '../engine/decoder/decodeWorker';
import {
  buildPlan,
  defaultGraphDoc,
  defaultParams,
  DEVELOP_KIND,
  nextId,
  parseGraphDoc,
  serializeGraphDoc,
  type AddableKind,
  type GraphDoc,
} from '../engine/graph/graphDoc';
import { defaultDevelopParams } from '../engine/graph/developNode';
import type { GraphRenderer, HistogramData } from '../engine/gpu/graphRenderer';
import { BLEND_KIND, CUSTOM_KIND } from '../engine/graph/ops';
import {
  buildCustomShaderWgsl,
  clearCustomShaderArtifacts,
  createDefaultCustomShaderParams,
  makeCustomShaderArtifact,
  seedDefaultCustomShaderArtifact,
  setCustomShaderArtifact,
  WGSL_IDENT_RE,
  type CustomShaderParams,
} from '../engine/graph/customShaderNode';
import { validateWgsl } from '../engine/shader/validateWgsl';
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
  /**
   * Bumped whenever a customShader artifact is (re)compiled — the render
   * effect keys on it so validation results reach the screen even when the
   * GraphDoc itself did not change.
   */
  shaderRev: number;
  /** Validate `src` for a custom node; on success apply it (one undo step). */
  applyShaderSource(nodeId: string, src: string): Promise<void>;
  /** Declare a new GUI param; returns an error message or null. */
  addShaderParam(nodeId: string, def: { name: string; min: number; max: number; default: number }): string | null;
  removeShaderParam(nodeId: string, name: string): void;
  updateShaderParam(nodeId: string, name: string, value: number): void;
  setRenderer(renderer: GraphRenderer): void;
  setHistogram(histogram: HistogramData | null): void;
  /** Write the graph to the image's sidecar (`<image>.silverbox.json`). */
  saveGraph(): Promise<void>;
  /** Develop at full resolution and write .jpg/.png (dialog when no path). */
  exportImage(path?: string, opts?: { quality?: number; maxDim?: number | null }): Promise<void>;
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

function getShader(graph: GraphDoc, nodeId: string): CustomShaderParams | null {
  const node = graph.nodes.find((n) => n.id === nodeId);
  return node?.kind === CUSTOM_KIND ? (node.shader ?? null) : null;
}

function withShader(
  graph: GraphDoc,
  nodeId: string,
  fn: (shader: CustomShaderParams) => CustomShaderParams
): GraphDoc {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === nodeId && n.kind === CUSTOM_KIND ? { ...n, shader: fn(n.shader ?? createDefaultCustomShaderParams()) } : n
    ),
  };
}

export const useAppStore = create<AppState>((set, get) => {
  /** Supersede stale validations: per-node sequence + a global epoch bumped on open/undo/redo. */
  const validationSeq = new Map<string, number>();
  let shaderEpoch = 0;

  /**
   * Validate `src` against the node's current param list on the dedicated
   * device. Success commits the artifact and moves `src`/`lastValidSrc` in
   * the doc (its own history entry when `opts.history`); failure publishes
   * the error while the last valid shader keeps rendering.
   */
  const validateShaderSource = async (nodeId: string, src: string, opts: { history: boolean }): Promise<void> => {
    const shader = getShader(get().graph, nodeId);
    if (!shader) return;
    const paramList = shader.params;
    const { wgsl, userLineOffset } = buildCustomShaderWgsl(src, paramList.map((p) => p.name));
    const seq = (validationSeq.get(nodeId) ?? 0) + 1;
    validationSeq.set(nodeId, seq);
    const epoch = shaderEpoch;

    let error: string | null;
    try {
      error = await validateWgsl(wgsl, userLineOffset);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (validationSeq.get(nodeId) !== seq || shaderEpoch !== epoch) return;
    const now = getShader(get().graph, nodeId);
    if (!now) return; // node deleted while validating

    if (error === null) {
      setCustomShaderArtifact(nodeId, makeCustomShaderArtifact(wgsl, paramList));
      if (now.code.src !== src || now.code.lastValidSrc !== src) {
        set((s) => ({
          ...(opts.history ? pushHistory(s, null) : {}),
          graph: withShader(s.graph, nodeId, (p) => ({ ...p, code: { src, lastValidSrc: src } })),
          graphDirty: true,
        }));
      }
      set((s) => {
        const { [nodeId]: _cleared, ...rest } = s.shaderErrors;
        return { shaderErrors: rest, shaderRev: s.shaderRev + 1 };
      });
    } else {
      set((s) => ({ shaderErrors: { ...s.shaderErrors, [nodeId]: error } }));
    }
  };

  /**
   * Re-seed artifacts for every custom node of a (re)loaded / jumped-to doc:
   * validate `lastValidSrc` and set ONLY the artifact (no doc mutation — this
   * must never clobber a differing editing source). A doc saved mid-edit then
   * gets its editing source surfaced through the normal path.
   */
  const revalidateShaders = (graph: GraphDoc): void => {
    for (const node of graph.nodes) {
      if (node.kind !== CUSTOM_KIND || !node.shader) continue;
      const { code, params } = node.shader;
      const nodeId = node.id;
      const { wgsl, userLineOffset } = buildCustomShaderWgsl(code.lastValidSrc, params.map((p) => p.name));
      const seq = (validationSeq.get(nodeId) ?? 0) + 1;
      validationSeq.set(nodeId, seq);
      const epoch = shaderEpoch;
      void (async () => {
        let error: string | null;
        try {
          error = await validateWgsl(wgsl, userLineOffset);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        if (validationSeq.get(nodeId) !== seq || shaderEpoch !== epoch) return;
        if (!getShader(get().graph, nodeId)) return;
        if (error === null) {
          setCustomShaderArtifact(nodeId, makeCustomShaderArtifact(wgsl, params));
          set((s) => ({ shaderRev: s.shaderRev + 1 }));
        } else {
          set((s) => ({ shaderErrors: { ...s.shaderErrors, [nodeId]: error } }));
        }
        if (code.src !== code.lastValidSrc) {
          void validateShaderSource(nodeId, code.src, { history: false });
        }
      })();
    }
  };

  return {
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
      // node ids of the previous doc must never alias into stale shaders
      clearCustomShaderArtifacts();
      shaderEpoch++;
      set({
        imageStatus: 'ready',
        image,
        graph,
        graphDirty: false,
        selectedNodeId: null,
        history: emptyHistory(),
        shaderErrors: {},
      });
      revalidateShaders(graph);
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

  // `key` is a flat param key for op nodes, or a dot path into the Develop
  // sections (e.g. 'basic.ev') for Develop nodes.
  updateNodeParam(nodeId, key, value) {
    set((s) => ({
      ...pushHistory(s, `param:${nodeId}:${key}`),
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          if (n.kind === DEVELOP_KIND) {
            const develop = structuredClone(n.develop ?? defaultDevelopParams());
            const parts = key.split('.');
            let obj = develop as unknown as Record<string, unknown>;
            for (const part of parts.slice(0, -1)) obj = obj[part] as Record<string, unknown>;
            obj[parts[parts.length - 1]!] = value;
            return { ...n, develop };
          }
          return { ...n, params: { ...n.params, [key]: value } };
        }),
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
      // Fresh custom nodes are seeded with the engine-authored identity
      // artifact — known valid, no async validation round-trip needed.
      if (kind === CUSTOM_KIND) seedDefaultCustomShaderArtifact(id);
      const node =
        kind === CUSTOM_KIND
          ? { id, kind, position: { ...out.position }, shader: createDefaultCustomShaderParams() }
          : { id, kind, position: { ...out.position }, params: defaultParams(kind) };
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

  shaderRev: 0,

  async applyShaderSource(nodeId, src) {
    await validateShaderSource(nodeId, src, { history: true });
  },

  addShaderParam(nodeId, def) {
    const shader = getShader(get().graph, nodeId);
    if (!shader) return 'no such shader node';
    if (!WGSL_IDENT_RE.test(def.name)) return `"${def.name}" is not a valid WGSL identifier`;
    if (shader.params.some((p) => p.name === def.name)) return `param "${def.name}" already exists`;
    if (![def.min, def.max, def.default].every(Number.isFinite) || def.min > def.max) return 'invalid range';
    set((s) => ({
      ...pushHistory(s, null),
      graph: withShader(s.graph, nodeId, (p) => ({
        ...p,
        params: [...p.params, { ...def, value: def.default }],
      })),
      graphDirty: true,
    }));
    // the uniform struct changed — recompile the current editing source
    const code = getShader(get().graph, nodeId)?.code;
    if (code) void validateShaderSource(nodeId, code.src, { history: false });
    return null;
  },

  removeShaderParam(nodeId, name) {
    if (!getShader(get().graph, nodeId)) return;
    set((s) => ({
      ...pushHistory(s, null),
      graph: withShader(s.graph, nodeId, (p) => ({ ...p, params: p.params.filter((x) => x.name !== name) })),
      graphDirty: true,
    }));
    const code = getShader(get().graph, nodeId)?.code;
    if (code) void validateShaderSource(nodeId, code.src, { history: false });
  },

  updateShaderParam(nodeId, name, value) {
    set((s) => ({
      ...pushHistory(s, `shaderparam:${nodeId}:${name}`),
      graph: withShader(s.graph, nodeId, (p) => ({
        ...p,
        params: p.params.map((x) => (x.name === name ? { ...x, value } : x)),
      })),
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
    // a jump may restore shader sources whose artifacts are stale
    shaderEpoch++;
    revalidateShaders(get().graph);
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
    shaderEpoch++;
    revalidateShaders(get().graph);
  },

  setRenderer(renderer) {
    set({ renderer });
  },

  setHistogram(histogram) {
    set({ histogram });
  },

  async exportImage(path, opts) {
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
      let canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
      ctx.putImageData(new ImageData(data, width, height), 0, 0);
      // optional long-edge resize (fit inside, never enlarged)
      const maxDim = opts?.maxDim ?? null;
      if (maxDim && maxDim > 0 && maxDim < Math.max(width, height)) {
        const scale = maxDim / Math.max(width, height);
        const rw = Math.max(1, Math.round(width * scale));
        const rh = Math.max(1, Math.round(height * scale));
        const resized = new OffscreenCanvas(rw, rh);
        const rctx = resized.getContext('2d');
        if (!rctx) throw new Error('OffscreenCanvas 2d context unavailable');
        rctx.imageSmoothingQuality = 'high';
        rctx.drawImage(canvas, 0, 0, rw, rh);
        canvas = resized;
      }
      const png = /\.png$/i.test(target);
      const quality = Math.min(100, Math.max(1, Math.round(opts?.quality ?? 90))) / 100;
      const blob = await canvas.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality });
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
  };
});

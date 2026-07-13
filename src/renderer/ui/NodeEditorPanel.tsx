import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  applyNodeChanges,
  type Connection,
  type Node,
  type NodeChange,
  type NodeProps,
  type Edge,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAppStore } from '../store/appStore';
import { BLEND_KIND, CUSTOM_KIND, isOpKind } from '../engine/graph/ops';
import { DEVELOP_KIND, nodeLabel, type GraphDoc } from '../engine/graph/graphDoc';
import { MASK_KIND } from '../engine/graph/maskNode';
import { SPOTS_KIND } from '../engine/graph/spotsNode';
import { IMAGE_KIND } from '../engine/graph/imageNode';
import { EXTERNAL_KIND } from '../engine/graph/externalNode';

/** A node's own data, as `buildNodes` below packs it — thumbUrl/inspecting are per-node-preview pack additions, `missing` is the image node feature's own, `badge`/`badgeTitle` is the external-tool hook node's (needs-confirm/pending/error), `disabled` is the node bypass feature's. */
interface OpNodeData {
  label: string;
  thumbUrl?: string;
  inspecting: boolean;
  missing?: boolean;
  badge?: string;
  badgeTitle?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

/**
 * Live thumbnail body (per-node-preview pack, tier 1) + the "eye" inspect
 * toggle (tier 2) + the bypass toggle (node bypass feature) shared by every
 * non-input/non-output node type below. `thumbUrl` is undefined for a node
 * buildPlan never reached from the resolved output (a disconnected branch) —
 * shown as a plain "=" placeholder rather than nothing, so an editor full of
 * freshly-added, not-yet-wired nodes doesn't read as "thumbnails are
 * broken". A bypassed node's thumbUrl needs no special handling here: buildPlan
 * resolves it to its ancestor's step (same mechanism an identity-valued op
 * already gets — see graphDoc.ts's resolve()), so the thumbnail naturally
 * shows the passthrough result.
 */
function NodeThumb({
  id,
  thumbUrl,
  inspecting,
  disabled,
  bypassable,
}: {
  id: string;
  thumbUrl?: string;
  inspecting: boolean;
  disabled?: boolean;
  /** False for the image node (not a bypassable kind — see isBypassableNodeKind): no button rendered at all, "the UI simply doesn't offer it there" per the bypass feature's decided semantics. */
  bypassable?: boolean;
}) {
  const setInspectNode = useAppStore((s) => s.setInspectNode);
  const toggleNodeDisabled = useAppStore((s) => s.toggleNodeDisabled);
  return (
    <div className="op-node-body">
      <div
        className={`op-node-thumb${thumbUrl ? '' : ' op-node-thumb--empty'}`}
        style={thumbUrl ? { backgroundImage: `url(${thumbUrl})` } : undefined}
        data-testid={`node-thumb-${id}`}
      >
        {!thumbUrl && <span aria-hidden>=</span>}
      </div>
      {bypassable && (
        <button
          type="button"
          className={`op-node-bypass${disabled ? ' op-node-bypass--active' : ''}`}
          title={disabled ? 'Re-enable this node (M or ⌘D)' : 'Bypass this node (M or ⌘D)'}
          data-testid={`node-bypass-${id}`}
          onClick={(ev) => {
            ev.stopPropagation();
            toggleNodeDisabled(id);
          }}
        >
          {disabled ? '⊘' : '⊙'}
        </button>
      )}
      <button
        type="button"
        className={`op-node-eye${inspecting ? ' op-node-eye--active' : ''}`}
        title={inspecting ? 'Stop inspecting this node’s output' : 'Inspect this node’s output (⌥-click also works)'}
        data-testid={`node-inspect-${id}`}
        onClick={(ev) => {
          ev.stopPropagation();
          setInspectNode(inspecting ? null : id);
        }}
      >
        {inspecting ? '◉' : '○'}
      </button>
    </div>
  );
}

/** Generic op-kind node: single in/out, live thumbnail + inspect eye (per-node-preview pack); an optional `badge` (external-tool hook node's needs-confirm/pending/error state, task #41) renders the same small corner glyph the image node's missing-file badge uses. `disabled` (node bypass feature) mutes the whole body and strikes the label. */
function OpNode({ id, data, selected }: NodeProps) {
  const { label, thumbUrl, inspecting, badge, badgeTitle, disabled } = data as unknown as OpNodeData;
  return (
    <div
      className={`op-node${selected ? ' selected' : ''}${inspecting ? ' op-node--inspecting' : ''}${disabled ? ' op-node--disabled' : ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <NodeThumb id={id} thumbUrl={thumbUrl} inspecting={inspecting} disabled={disabled} bypassable />
      <span className="op-node-label">{label}</span>
      {badge && (
        <span className="op-node-badge" data-testid={`external-node-badge-${id}`} title={badgeTitle}>
          {badge}
        </span>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** Blend node: three labeled inputs (a = base, b = overlay, mask = optional), one output, same thumbnail/eye/bypass body as OpNode. */
function BlendNode({ id, data, selected }: NodeProps) {
  const { label, thumbUrl, inspecting, disabled } = data as unknown as OpNodeData;
  return (
    <div
      className={`blend-node${selected ? ' selected' : ''}${inspecting ? ' op-node--inspecting' : ''}${disabled ? ' op-node--disabled' : ''}`}
    >
      <Handle type="target" id="a" position={Position.Left} style={{ top: '30%' }} />
      <Handle type="target" id="b" position={Position.Left} style={{ top: '70%' }} />
      <Handle type="target" id="mask" position={Position.Bottom} style={{ left: '50%' }} />
      <span className="blend-node-ports">
        a<br />b
      </span>
      <NodeThumb id={id} thumbUrl={thumbUrl} inspecting={inspecting} disabled={disabled} bypassable />
      <span className="op-node-label">{label}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/**
 * Image node body (composite/mask-by-another-file feature): zero inputs —
 * unlike OpNode, there is no target Handle to wire up (an 'image' node is a
 * SOURCE like 'input', just referencing a different file — see graphDoc.ts)
 * — plus a "missing file" badge when the referenced path failed to decode
 * (graphBroken-style notice, not a hard error; see appStore.ts's
 * imageNodeMissing / imageNodeSource.ts).
 */
function ImageSourceNode({ id, data, selected }: NodeProps) {
  const { label, thumbUrl, inspecting, missing } = data as unknown as OpNodeData;
  return (
    <div className={`op-node${selected ? ' selected' : ''}${inspecting ? ' op-node--inspecting' : ''}`}>
      <NodeThumb id={id} thumbUrl={thumbUrl} inspecting={inspecting} />
      <span>{label}</span>
      {missing && (
        <span className="op-node-badge" data-testid={`image-node-missing-${id}`} title="referenced file not found">
          ⚠
        </span>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { blend: BlendNode, op: OpNode, image: ImageSourceNode };

/** Pure GraphDoc → React Flow Node[] projection, shared by the initial state and the resync effect below. */
function buildNodes(
  graph: GraphDoc,
  fileName: string | null,
  selectedNodeId: string | null,
  nodeThumbs: Record<string, string>,
  inspectNodeId: string | null,
  imageNodeMissing: Record<string, boolean>,
  externalNodeNeedsConfirm: Record<string, string>,
  externalNodeErrors: Record<string, string>
): Node[] {
  // outputs are deletable only while another one remains (removeOpNode
  // enforces the same rule — the doc must always keep at least one output)
  const outputCount = graph.nodes.filter((n) => n.kind === 'output').length;
  return graph.nodes.map((n) => {
    // External-tool hook node (task #41): error takes priority over
    // needs-confirm (a node that just failed is more actionable to notice
    // than one merely awaiting its first confirm) — see externalNodeRunner.ts.
    let badge: string | undefined;
    let badgeTitle: string | undefined;
    if (n.kind === EXTERNAL_KIND) {
      if (externalNodeErrors[n.id]) {
        badge = '⚠';
        badgeTitle = externalNodeErrors[n.id];
      } else if (externalNodeNeedsConfirm[n.id]) {
        badge = '●';
        badgeTitle = 'Confirm to run this external command (see the Inspector)';
      }
    }
    return {
      id: n.id,
      type:
        n.kind === 'input' ? 'input' : n.kind === 'output' ? 'output' : n.kind === BLEND_KIND ? 'blend' : n.kind === IMAGE_KIND ? 'image' : 'op',
      data: {
        label: nodeLabel(n, fileName),
        thumbUrl: nodeThumbs[n.id],
        inspecting: n.id === inspectNodeId,
        missing: n.kind === IMAGE_KIND ? imageNodeMissing[n.id] === true : undefined,
        badge,
        badgeTitle,
        disabled: n.disabled === true,
      },
      position: n.position,
      selected: n.id === selectedNodeId,
      sourcePosition: 'right',
      targetPosition: 'left',
      deletable:
        isOpKind(n.kind) ||
        n.kind === CUSTOM_KIND ||
        n.kind === BLEND_KIND ||
        n.kind === DEVELOP_KIND ||
        n.kind === MASK_KIND ||
        n.kind === SPOTS_KIND ||
        n.kind === IMAGE_KIND ||
        n.kind === EXTERNAL_KIND ||
        (n.kind === 'output' && outputCount > 1),
    };
  }) as Node[];
}

/**
 * Node editor rendering the GraphDoc. Selection feeds the inspector; ops can
 * be inserted before the output (toolbar), removed (Delete/Backspace), and
 * rewired by dragging a connection onto an input — the store validates and
 * rejects wirings that break the DAG.
 */
export function NodeEditorPanel() {
  const fileName = useAppStore((s) => s.fileName);
  const graph = useAppStore((s) => s.graph);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const selectNode = useAppStore((s) => s.selectNode);
  const moveNode = useAppStore((s) => s.moveNode);
  const addOpNode = useAppStore((s) => s.addOpNode);
  const removeOpNode = useAppStore((s) => s.removeOpNode);
  const connectEdge = useAppStore((s) => s.connectEdge);
  const removeEdge = useAppStore((s) => s.removeEdge);
  const connectNotice = useAppStore((s) => s.connectNotice);
  const graphBroken = useAppStore((s) => s.graphBroken);
  // Per-node-preview pack: RENDER OUTPUT, not doc input (kept out of
  // GraphDoc/history entirely — see appStore.ts's nodeThumbs/inspectNodeId
  // doc comments) but still flows through buildNodes/rfNodes below like any
  // other per-node display data, rather than a second, competing per-frame
  // write path into React Flow.
  const nodeThumbs = useAppStore((s) => s.nodeThumbs);
  const inspectNodeId = useAppStore((s) => s.inspectNodeId);
  const setInspectNode = useAppStore((s) => s.setInspectNode);
  // Image node feature: missing-file badge state, resynced the same
  // debounced way nodeThumbs/inspectNodeId are (see below).
  const imageNodeMissing = useAppStore((s) => s.imageNodeMissing);
  // External-tool hook node (task #41): needs-confirm/error badge state,
  // resynced the same debounced way as imageNodeMissing above.
  const externalNodeNeedsConfirm = useAppStore((s) => s.externalNodeNeedsConfirm);
  const externalNodeErrors = useAppStore((s) => s.externalNodeErrors);
  // edge selection is transient UI state — the GraphDoc doesn't carry it
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // React Flow's OWN, LOCAL node list — NOT derived fresh from `graph` on
  // every render. This is the fix for the node-drag lag (#pointer-drag-lag):
  // node.position is layout-only (graphDoc.ts's buildPlan never reads it), so
  // dragging must never write to the store per mouse-move — that would push
  // one history entry per pixel AND make CanvasView's render effect re-post
  // to the worker on every move. Instead, onNodesChange applies EVERY change
  // (including in-flight 'position' drag changes) to this local state only;
  // the GraphDoc is written exactly once, at drag end (onNodeDragStop below).
  // nodeThumbs/inspectNodeId resync the SAME way as graph/fileName/selection
  // below (they change at most every ~300ms, via CanvasView's debounce — far
  // below drag-lag territory, so no extra guard is needed for them).
  const [rfNodes, setRfNodes] = useState<Node[]>(() =>
    buildNodes(graph, fileName, selectedNodeId, nodeThumbs, inspectNodeId, imageNodeMissing, externalNodeNeedsConfirm, externalNodeErrors)
  );
  // Suppressed while a drag is in flight: the store's node position is still
  // the PRE-drag value until drop, so resyncing from it mid-drag would fight
  // the local per-move state right back into the lag this exists to avoid.
  const draggingRef = useRef(false);
  useEffect(() => {
    if (draggingRef.current) return;
    setRfNodes(
      buildNodes(graph, fileName, selectedNodeId, nodeThumbs, inspectNodeId, imageNodeMissing, externalNodeNeedsConfirm, externalNodeErrors)
    );
  }, [graph, fileName, selectedNodeId, nodeThumbs, inspectNodeId, imageNodeMissing, externalNodeNeedsConfirm, externalNodeErrors]);

  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    targetHandle: e.targetHandle,
    selected: e.id === selectedEdgeId,
  }));

  // ⌥-click toggles inspect mode instead of selecting (per-node-preview pack,
  // tier 2) — the same node also has its own always-visible "eye" button
  // (NodeThumb above) for discoverability, per the brief.
  const onNodeClick: NodeMouseHandler = useCallback(
    (ev, node) => {
      if (ev.altKey) {
        setInspectNode(inspectNodeId === node.id ? null : node.id);
        return;
      }
      selectNode(node.id);
    },
    [selectNode, setInspectNode, inspectNodeId]
  );
  // Every intermediate position lands in local state only (see rfNodes above)
  // — applyNodeChanges is the same helper React Flow's own useNodesState uses.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((nds) => applyNodeChanges(changes, nds));
  }, []);
  const onNodeDragStart: OnNodeDrag = useCallback(() => {
    draggingRef.current = true;
  }, []);
  // The ONE point the GraphDoc actually changes: one moveNode call, one
  // history entry, regardless of how many mouse-moves the drag contained.
  const onNodeDragStop: OnNodeDrag = useCallback(
    (_ev, node) => {
      draggingRef.current = false;
      moveNode(node.id, node.position);
    },
    [moveNode]
  );
  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const handle =
        conn.targetHandle === 'a' || conn.targetHandle === 'b' || conn.targetHandle === 'mask'
          ? conn.targetHandle
          : undefined;
      connectEdge(conn.source, conn.target, handle);
    },
    [connectEdge]
  );
  // one unified delete handler: node deletion rewires its neighbors itself,
  // so the adjacent edges React Flow reports alongside must NOT be removed
  // separately (their freed ids may already be reused by the bypass edge)
  const onDelete = useCallback(
    ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) => {
      if (deletedNodes.length > 0) {
        for (const node of deletedNodes) removeOpNode(node.id);
      } else {
        for (const edge of deletedEdges) removeEdge(edge.id);
      }
      setSelectedEdgeId(null);
    },
    [removeOpNode, removeEdge]
  );
  const onEdgeClick = useCallback((_ev: React.MouseEvent, edge: Edge) => setSelectedEdgeId(edge.id), []);

  return (
    <div className="node-editor">
      {graphBroken && (
        <div className="node-editor-banner" data-testid="broken-banner">
          input → output path is broken — preview shows the unedited image (pass-through)
        </div>
      )}
      {connectNotice && (
        <div className="node-editor-banner node-editor-banner--reject" data-testid="reject-banner">
          {connectNotice}
        </div>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        onNodeClick={onNodeClick}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onDelete={onDelete}
        onEdgeClick={onEdgeClick}
        onConnect={onConnect}
        onPaneClick={() => {
          selectNode(null);
          setSelectedEdgeId(null);
        }}
      >
        <Background gap={16} />
      </ReactFlow>
    </div>
  );
}

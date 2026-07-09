import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import {
  BLEND_KIND,
  BLEND_PARAM_DEFS,
  CUSTOM_KIND,
  CUSTOM_PARAM_DEFS,
  DEFAULT_CUSTOM_CODE,
  OPS,
  isOpKind,
  toneCurvePoint,
  type OpParamDef,
} from '../engine/graph/ops';
import { DEVELOP_KIND, type GraphNode } from '../engine/graph/graphDoc';
import { defaultDevelopParams, type DevelopParams } from '../engine/graph/developNode';
import { HistogramPanel } from './HistogramPanel';

/**
 * Common parameter row (UI spec §6): label / range / number in a grid;
 * double-clicking the row resets to the default.
 */
function ParamSlider({ nodeId, def, value }: { nodeId: string; def: OpParamDef; value: number }) {
  const updateNodeParam = useAppStore((s) => s.updateNodeParam);
  const set = (v: number) => updateNodeParam(nodeId, def.key, Math.min(def.max, Math.max(def.min, v)));
  const changed = value !== def.default;
  return (
    <div className="param-row" title="Double-click to reset" onDoubleClick={() => set(def.default)}>
      <span className={`param-label${changed ? ' changed' : ''}`}>{def.label}</span>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(ev) => set(Number(ev.target.value))}
      />
      <input
        type="number"
        className="param-number"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(ev) => {
          const v = Number(ev.target.value);
          if (Number.isFinite(v)) set(v);
        }}
      />
    </div>
  );
}

/** Collapsible inspector section (UI spec §5). */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="inspector-section">
      <div className="inspector-section-header" onClick={() => setOpen((o) => !o)}>
        <span className="inspector-section-caret">{open ? '▾' : '▸'}</span> {title}
      </div>
      {open && <div className="inspector-section-body">{children}</div>}
    </div>
  );
}

const DEVELOP_BASIC_DEFS: OpParamDef[] = [
  { key: 'basic.ev', label: 'Exposure', min: -5, max: 5, step: 0.01, default: 0 },
  { key: 'basic.contrast', label: 'Contrast', min: -100, max: 100, step: 1, default: 0 },
  { key: 'basic.highlights', label: 'Highlights', min: -100, max: 100, step: 1, default: 0 },
  { key: 'basic.shadows', label: 'Shadows', min: -100, max: 100, step: 1, default: 0 },
  { key: 'basic.whites', label: 'Whites', min: -100, max: 100, step: 1, default: 0 },
  { key: 'basic.blacks', label: 'Blacks', min: -100, max: 100, step: 1, default: 0 },
  { key: 'basic.saturation', label: 'Saturation', min: -100, max: 100, step: 1, default: 0 },
  { key: 'basic.vibrance', label: 'Vibrance', min: -100, max: 100, step: 1, default: 0 },
];

/** The aggregated Develop panel — Basic now; more sections per spec order. */
function DevelopInspector({ node }: { node: GraphNode }) {
  const params: DevelopParams = node.develop ?? defaultDevelopParams();
  const basic = params.basic as unknown as Record<string, number>;
  return (
    <>
      <div className="inspector-title">Develop</div>
      <Section title="Basic">
        {DEVELOP_BASIC_DEFS.map((def) => (
          <ParamSlider key={def.key} nodeId={node.id} def={def} value={basic[def.key.split('.')[1]!] ?? def.default} />
        ))}
      </Section>
    </>
  );
}

/** WGSL editor for a custom node: edit freely, compile on Apply. */
function CustomEditor({ node }: { node: GraphNode }) {
  const updateNodeCode = useAppStore((s) => s.updateNodeCode);
  const error = useAppStore((s) => s.shaderErrors[node.id]);
  const savedCode = node.code ?? DEFAULT_CUSTOM_CODE;
  const [draft, setDraft] = useState(savedCode);
  useEffect(() => setDraft(savedCode), [node.id, savedCode]);

  return (
    <>
      <textarea
        className="inspector-code"
        spellCheck={false}
        value={draft}
        onChange={(ev) => setDraft(ev.target.value)}
      />
      <div className="inspector-code-actions">
        <button onClick={() => updateNodeCode(node.id, draft)} disabled={draft === savedCode}>
          Apply
        </button>
        {error && (
          <pre className="inspector-code-error" data-testid="shader-error">
            {error}
          </pre>
        )}
      </div>
    </>
  );
}

/** x/y plot of the tone curve in encoded space (identity = the diagonal). */
function CurvePreview({ node }: { node: GraphNode }) {
  const uniform = OPS.tonecurve.packUniform(node.params ?? {});
  const size = 120;
  const points = Array.from({ length: 65 }, (_, i) => {
    const x = i / 64;
    return `${x * size},${(1 - toneCurvePoint(x, uniform)) * size}`;
  }).join(' ');
  return (
    <svg
      className="curve-preview"
      data-testid="curve-preview"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
    >
      <line x1="0" y1={size} x2={size} y2="0" stroke="#444" strokeDasharray="3 3" />
      <polyline points={points} fill="none" stroke="#8ab4f8" strokeWidth="1.5" />
    </svg>
  );
}

function NodeContent({ node }: { node: GraphNode | undefined }) {
  if (!node) {
    return <div className="inspector-placeholder">Select a node in the graph below.</div>;
  }
  if (node.kind === DEVELOP_KIND) {
    return <DevelopInspector node={node} />;
  }
  if (node.kind === CUSTOM_KIND) {
    return (
      <>
        <div className="inspector-title">Custom (WGSL)</div>
        <CustomEditor node={node} />
        {CUSTOM_PARAM_DEFS.map((p) => (
          <ParamSlider key={p.key} nodeId={node.id} def={p} value={node.params?.[p.key] ?? p.default} />
        ))}
      </>
    );
  }
  if (node.kind === BLEND_KIND) {
    return (
      <>
        <div className="inspector-title">Blend</div>
        {BLEND_PARAM_DEFS.map((p) => (
          <ParamSlider key={p.key} nodeId={node.id} def={p} value={node.params?.[p.key] ?? p.default} />
        ))}
      </>
    );
  }
  if (!isOpKind(node.kind)) {
    return (
      <div className="inspector-placeholder">
        {node.kind === 'input' ? 'Input: the decoded linear image.' : 'Output: sRGB-encoded display.'}
      </div>
    );
  }
  const def = OPS[node.kind];
  return (
    <>
      <div className="inspector-title">{def.label}</div>
      {node.kind === 'tonecurve' && <CurvePreview node={node} />}
      {def.params.map((p) => (
        <ParamSlider key={p.key} nodeId={node.id} def={p} value={node.params?.[p.key] ?? p.default} />
      ))}
    </>
  );
}

/** Histogram + parameter editor for the node selected in the graph. */
export function InspectorPanel() {
  const graph = useAppStore((s) => s.graph);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const node = graph.nodes.find((n) => n.id === selectedNodeId);
  return (
    <div className="inspector">
      <HistogramPanel />
      <NodeContent node={node} />
    </div>
  );
}

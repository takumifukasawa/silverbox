import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import {
  BLEND_KIND,
  BLEND_PARAM_DEFS,
  CUSTOM_KIND,
  OPS,
  TEMP_GRADIENT,
  TINT_GRADIENT,
  isOpKind,
  toneCurvePoint,
  type OpParamDef,
} from '../engine/graph/ops';
import { DEVELOP_KIND, type GraphNode } from '../engine/graph/graphDoc';
import {
  defaultDevelopParams,
  HSL_BAND_CENTER_DEG,
  HSL_BANDS,
  type DevelopParams,
  type HslBand,
} from '../engine/graph/developNode';
import { createDefaultCustomShaderParams } from '../engine/graph/customShaderNode';
import { ShaderEditor } from './ShaderEditor';
import { ToneCurveEditor } from './ToneCurveEditor';

/**
 * Common parameter row (UI spec §6): label / range / number in a grid;
 * double-clicking the row resets to the default. `defaultValue` overrides
 * the static def.default (WB resets to the image's as-shot values). A 'log'
 * scale rides a hidden 0..1000 position axis (Kelvin travel); the number
 * input always speaks real units.
 */
function ParamSlider({
  nodeId,
  def,
  value,
  defaultValue,
}: {
  nodeId: string;
  def: OpParamDef;
  value: number;
  defaultValue?: number;
}) {
  const updateNodeParam = useAppStore((s) => s.updateNodeParam);
  const set = (v: number) => updateNodeParam(nodeId, def.key, Math.min(def.max, Math.max(def.min, v)));
  const resetTo = defaultValue ?? def.default;
  const changed = value !== resetTo;
  const isLog = def.scale === 'log';
  const toPos = (v: number) => (1000 * Math.log(v / def.min)) / Math.log(def.max / def.min);
  const fromPos = (p: number) => Math.round(def.min * Math.exp((p / 1000) * Math.log(def.max / def.min)));
  return (
    <div className="param-row" title="Double-click to reset" onDoubleClick={() => set(resetTo)}>
      <span className={`param-label${changed ? ' changed' : ''}`}>{def.label}</span>
      <input
        type="range"
        className={def.gradient ? 'param-range--gradient' : undefined}
        style={def.gradient ? { background: def.gradient } : undefined}
        min={isLog ? 0 : def.min}
        max={isLog ? 1000 : def.max}
        step={isLog ? 1 : def.step}
        value={isLog ? toPos(Math.max(def.min, value)) : value}
        onChange={(ev) => set(isLog ? fromPos(Number(ev.target.value)) : Number(ev.target.value))}
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

const HSL_CHANNELS = [
  { key: 'h', label: 'Hue' },
  { key: 's', label: 'Saturation' },
  { key: 'l', label: 'Luminance' },
] as const;

/** Per-band track ramp: hue = reachable rotation, sat = gray→vivid, lum = dark→bright. */
function hslTrackGradient(band: HslBand, channel: 'h' | 's' | 'l'): string {
  const c = HSL_BAND_CENTER_DEG[band];
  if (channel === 'h') {
    return `linear-gradient(90deg, hsl(${(c + 330) % 360},80%,55%), hsl(${c},80%,55%), hsl(${(c + 30) % 360},80%,55%))`;
  }
  if (channel === 's') {
    return `linear-gradient(90deg, hsl(${c},0%,55%), hsl(${c},90%,55%))`;
  }
  return `linear-gradient(90deg, hsl(${c},60%,20%), hsl(${c},60%,80%))`;
}

/** LR-style HSL section: 3 sub-tabs × 8 band sliders with band-color tracks. */
function HslSection({ node, params }: { node: GraphNode; params: DevelopParams }) {
  const [channel, setChannel] = useState<'h' | 's' | 'l'>('h');
  return (
    <>
      <div className="hsl-tabs">
        {HSL_CHANNELS.map((ch) => (
          <button
            key={ch.key}
            className={`hsl-tab${ch.key === channel ? ' active' : ''}`}
            data-testid={`hsl-tab-${ch.key}`}
            onClick={() => setChannel(ch.key)}
          >
            {ch.label}
          </button>
        ))}
      </div>
      {HSL_BANDS.map((band) => (
        <ParamSlider
          key={`${band}.${channel}`}
          nodeId={node.id}
          def={{
            key: `hsl.${band}.${channel}`,
            label: band,
            min: -100,
            max: 100,
            step: 1,
            default: 0,
            gradient: hslTrackGradient(band, channel),
          }}
          value={params.hsl[band][channel]}
        />
      ))}
    </>
  );
}

/** The aggregated Develop panel — Basic now; more sections per spec order. */
function DevelopInspector({ node }: { node: GraphNode }) {
  const wbModel = useAppStore((s) => s.wbModel);
  const params: DevelopParams = node.develop ?? defaultDevelopParams();
  const basic = params.basic as unknown as Record<string, number>;
  const wbDefs: OpParamDef[] = [
    { key: 'basic.temp', label: 'Temp', min: 2000, max: 50000, step: 1, default: 0, scale: 'log', gradient: TEMP_GRADIENT },
    { key: 'basic.tint', label: 'Tint', min: -150, max: 150, step: 1, default: 0, gradient: TINT_GRADIENT },
  ];
  const wbDefault = (key: string) => (key === 'basic.temp' ? wbModel.asShot.temp : wbModel.asShot.tint);
  const wbValue = (key: string) => {
    const v = basic[key.split('.')[1]!] ?? 0;
    return v !== 0 || key === 'basic.tint' ? v : wbDefault(key); // temp 0 = unresolved placeholder
  };
  return (
    <>
      <div className="inspector-title">Develop</div>
      <Section title="Basic">
        {wbDefs.map((def) => (
          <ParamSlider
            key={def.key}
            nodeId={node.id}
            def={def}
            value={wbValue(def.key)}
            defaultValue={wbDefault(def.key)}
          />
        ))}
        {DEVELOP_BASIC_DEFS.map((def) => (
          <ParamSlider key={def.key} nodeId={node.id} def={def} value={basic[def.key.split('.')[1]!] ?? def.default} />
        ))}
      </Section>
      <Section title="Tone Curve">
        <ToneCurveEditor nodeId={node.id} params={params} />
      </Section>
      <Section title="HSL">
        <HslSection node={node} params={params} />
      </Section>
    </>
  );
}

/** customShader inspector: GUI param declarations + the Monaco WGSL editor. */
function CustomShaderInspector({ node }: { node: GraphNode }) {
  const addShaderParam = useAppStore((s) => s.addShaderParam);
  const removeShaderParam = useAppStore((s) => s.removeShaderParam);
  const updateShaderParam = useAppStore((s) => s.updateShaderParam);
  const [draft, setDraft] = useState({ name: '', min: '0', max: '1', default: '0' });
  const [addError, setAddError] = useState<string | null>(null);
  const shader = node.shader ?? createDefaultCustomShaderParams();

  const add = () => {
    const err = addShaderParam(node.id, {
      name: draft.name.trim(),
      min: Number(draft.min),
      max: Number(draft.max),
      default: Number(draft.default),
    });
    setAddError(err);
    if (!err) setDraft({ name: '', min: '0', max: '1', default: '0' });
  };

  return (
    <>
      <div className="inspector-title">customShader — {node.id}</div>
      <Section title="Parameters">
        {shader.params.map((p) => (
          <div key={p.name} className="shader-param-row">
            <div
              className="param-row"
              title="Double-click to reset"
              onDoubleClick={() => updateShaderParam(node.id, p.name, p.default)}
            >
              <span className={`param-label${p.value !== p.default ? ' changed' : ''}`}>{p.name}</span>
              <input
                type="range"
                min={p.min}
                max={p.max}
                step={(p.max - p.min) / 200 || 0.01}
                value={p.value}
                onChange={(ev) => updateShaderParam(node.id, p.name, Number(ev.target.value))}
              />
              <input
                type="number"
                className="param-number"
                value={p.value}
                step={(p.max - p.min) / 200 || 0.01}
                onChange={(ev) => {
                  const v = Number(ev.target.value);
                  if (Number.isFinite(v)) updateShaderParam(node.id, p.name, Math.min(p.max, Math.max(p.min, v)));
                }}
              />
            </div>
            <button
              className="shader-param-remove"
              title={`remove ${p.name}`}
              onClick={() => removeShaderParam(node.id, p.name)}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="shader-add-param-row">
          <input
            placeholder="name"
            value={draft.name}
            data-testid="shader-param-name"
            onChange={(ev) => setDraft({ ...draft, name: ev.target.value })}
          />
          <input value={draft.min} title="min" onChange={(ev) => setDraft({ ...draft, min: ev.target.value })} />
          <input value={draft.max} title="max" onChange={(ev) => setDraft({ ...draft, max: ev.target.value })} />
          <input
            value={draft.default}
            title="default"
            onChange={(ev) => setDraft({ ...draft, default: ev.target.value })}
          />
          <button onClick={add} disabled={draft.name.trim() === ''} data-testid="shader-param-add">
            +Add
          </button>
        </div>
        {addError && <div className="shader-add-error">{addError}</div>}
        <div className="shader-hint">Params become P.&lt;name&gt; (f32) in the shader body.</div>
      </Section>
      <Section title="Shader (WGSL)">
        <ShaderEditor nodeId={node.id} src={shader.code.src} />
      </Section>
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
  const wbModel = useAppStore((s) => s.wbModel);
  if (!node) {
    return <div className="inspector-placeholder">Select a node in the graph below.</div>;
  }
  if (node.kind === DEVELOP_KIND) {
    return <DevelopInspector node={node} />;
  }
  if (node.kind === CUSTOM_KIND) {
    return <CustomShaderInspector node={node} />;
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
  // the WB atomic resets to the image's as-shot values, not a fixed default
  const dynamicDefault = (key: string): number | undefined => {
    if (node.kind !== 'whitebalance') return undefined;
    return key === 'temp' ? wbModel.asShot.temp : wbModel.asShot.tint;
  };
  return (
    <>
      <div className="inspector-title">{def.label}</div>
      {node.kind === 'tonecurve' && <CurvePreview node={node} />}
      {def.params.map((p) => (
        <ParamSlider
          key={p.key}
          nodeId={node.id}
          def={p}
          value={node.params?.[p.key] ?? dynamicDefault(p.key) ?? p.default}
          defaultValue={dynamicDefault(p.key)}
        />
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
      <NodeContent node={node} />
    </div>
  );
}

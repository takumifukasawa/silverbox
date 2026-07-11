import { useRef, useState } from 'react';
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
import { DEVELOP_KIND, outputName, defaultLensParams, type GraphNode, type LensParams } from '../engine/graph/graphDoc';
import {
  defaultColorKeyMaskShape,
  defaultLinearMaskShape,
  defaultMaskParams,
  defaultRadialMaskShape,
  MASK_KIND,
  type MaskShape,
} from '../engine/graph/maskNode';
import {
  defaultDevelopParams,
  GRADING_REGIONS,
  HSL_BAND_CENTER_DEG,
  HSL_BANDS,
  type DevelopParams,
  type HslBand,
} from '../engine/graph/developNode';
import { ColorWheel } from './ColorWheel';
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
  setValue,
}: {
  nodeId: string;
  def: OpParamDef;
  value: number;
  defaultValue?: number;
  /** Overrides the default updateNodeParam(nodeId, def.key, v) commit (e.g. the input node's lens, which isn't stored under node.params). */
  setValue?: (v: number) => void;
}) {
  const updateNodeParam = useAppStore((s) => s.updateNodeParam);
  const set = (v: number) => {
    const clamped = Math.min(def.max, Math.max(def.min, v));
    if (setValue) setValue(clamped);
    else updateNodeParam(nodeId, def.key, clamped);
  };
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
  const wbPicking = useAppStore((s) => s.wbPicking);
  const setWbPicking = useAppStore((s) => s.setWbPicking);
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
        <div className="wb-eyedropper-row">
          <button
            type="button"
            data-testid="wb-eyedropper"
            className={`wb-eyedropper-button${wbPicking ? ' active' : ''}`}
            title="Pick a neutral point in the image to set white balance (Esc to cancel)"
            onClick={() => setWbPicking(!wbPicking)}
          >
            {wbPicking ? 'Click the image…' : 'Eyedropper'}
          </button>
        </div>
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
      <Section title="Color Grading">
        <div className="grading-wheels">
          {GRADING_REGIONS.map((region) => (
            <ColorWheel key={region} nodeId={node.id} region={region} wheel={params.grading[region]} />
          ))}
        </div>
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'grading.blending', label: 'Blending', min: 0, max: 100, step: 1, default: 50 }}
          value={params.grading.blending}
        />
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'grading.balance', label: 'Balance', min: -100, max: 100, step: 1, default: 0 }}
          value={params.grading.balance}
        />
      </Section>
      <Section title="Detail">
        <div className="detail-group-label">Sharpening</div>
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'detail.sharpen.amount', label: 'Amount', min: 0, max: 150, step: 1, default: 0 }}
          value={params.detail.sharpen.amount}
        />
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'detail.sharpen.radius', label: 'Radius', min: 0.5, max: 3, step: 0.1, default: 1 }}
          value={params.detail.sharpen.radius}
        />
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'detail.sharpen.masking', label: 'Masking', min: 0, max: 100, step: 1, default: 0 }}
          value={params.detail.sharpen.masking}
        />
        <div className="detail-group-label">Noise Reduction</div>
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'detail.noiseLuminance.amount', label: 'Luminance', min: 0, max: 100, step: 1, default: 0 }}
          value={params.detail.noiseLuminance.amount}
        />
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'detail.noiseColor.amount', label: 'Color', min: 0, max: 100, step: 1, default: 0 }}
          value={params.detail.noiseColor.amount}
        />
        <div className="detail-hint">
          Preview is downsampled — judge sharpening/NR at 100% zoom or in the exported file.
        </div>
      </Section>
      <Section title="Effects">
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'effects.dehaze', label: 'Dehaze', min: -100, max: 100, step: 1, default: 0 }}
          value={params.effects.dehaze}
        />
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'effects.clarity', label: 'Clarity', min: -100, max: 100, step: 1, default: 0 }}
          value={params.effects.clarity}
        />
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'effects.texture', label: 'Texture', min: -100, max: 100, step: 1, default: 0 }}
          value={params.effects.texture}
        />
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'effects.grain', label: 'Grain', min: 0, max: 100, step: 1, default: 0 }}
          value={params.effects.grain}
        />
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'effects.grainSize', label: 'Grain Size', min: 1, max: 3, step: 0.1, default: 1.5 }}
          value={params.effects.grainSize}
        />
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'effects.vignette', label: 'Vignette', min: -100, max: 100, step: 1, default: 0 }}
          value={params.effects.vignette}
        />
        <ParamSlider
          nodeId={node.id}
          def={{ key: 'effects.vignetteMidpoint', label: 'Midpoint', min: 0, max: 1, step: 0.01, default: 0.5 }}
          value={params.effects.vignetteMidpoint}
        />
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

const LENS_SLIDER_DEFS: { key: 'distortion' | 'caRed' | 'caBlue' | 'vignette'; label: string; min: number; max: number }[] = [
  { key: 'distortion', label: 'Distortion', min: -100, max: 100 },
  { key: 'caRed', label: 'CA Red', min: -100, max: 100 },
  { key: 'caBlue', label: 'CA Blue', min: -100, max: 100 },
  { key: 'vignette', label: 'Vignetting', min: 0, max: 100 },
];

/**
 * Manual lens corrections — optical, so (like geometry/crop) it lives on the
 * input node rather than a Develop section. Pinned as the input node's ONLY
 * inspector content (geometry itself is edited via the crop overlay, not a
 * slider here). Each slider commits through setLens with a per-drag session
 * key so a whole drag coalesces into one undo entry — same pattern as
 * CropOverlay's angle slider / setGeometry.
 */
function LensSection({ node }: { node: GraphNode }) {
  const setLens = useAppStore((s) => s.setLens);
  // The embedded profile lives on the decoded image (parsed from the ARW);
  // the checkbox is disabled + hinted when there is none (JPEG / non-Sony).
  const hasProfile = useAppStore((s) => !!s.image?.profile);
  const lens = node.lens ?? defaultLensParams();
  const sessionRef = useRef<Partial<Record<keyof LensParams, number | null>>>({});
  const profileEnabled = lens.profile?.enabled ?? false;

  return (
    <Section title="Lens Corrections">
      <label className="lens-profile-row" title={hasProfile ? undefined : 'No embedded profile (JPEG or non-Sony image)'}>
        <input
          type="checkbox"
          data-testid="lens-profile-toggle"
          disabled={!hasProfile}
          checked={hasProfile && profileEnabled}
          onChange={(ev) => setLens({ ...lens, profile: { enabled: ev.target.checked } }, null)}
        />
        Profile corrections (embedded)
      </label>
      {LENS_SLIDER_DEFS.map((d) => (
        <div
          key={d.key}
          onPointerDown={() => {
            sessionRef.current[d.key] = Date.now();
          }}
          onPointerUp={() => {
            sessionRef.current[d.key] = null;
          }}
        >
          <ParamSlider
            nodeId={node.id}
            def={{ key: `lens.${d.key}`, label: d.label, min: d.min, max: d.max, step: 1, default: 0 }}
            value={lens[d.key]}
            setValue={(v) => {
              sessionRef.current[d.key] ??= Date.now();
              setLens({ ...lens, [d.key]: v }, `lens:${node.id}:${d.key}:${sessionRef.current[d.key]}`);
            }}
          />
        </div>
      ))}
    </Section>
  );
}

/**
 * Mask node inspector (masks milestone): a shape-type toggle (fresh default
 * shape of the other type — combine modes/multi-shape editing ship later, so
 * only shapes[0] is ever touched here), numeric rows for its geometry (the
 * canvas overlay's drag handles edit the SAME fields), and feather/invert.
 * Each field's own session key coalesces a whole drag/typing run into one
 * undo entry (CropOverlay/LensSection precedent); the type toggle and the
 * invert checkbox are each their own discrete undo entry.
 *
 * colorKey (secondary color mask) adds an eyedropper (same picking-mode
 * pattern as the WB eyedropper — see CanvasView's handleColorKeyPick) that
 * seeds hue/sat/lum from a clicked pixel in one undo entry, plus its own
 * numeric rows.
 */
function MaskInspector({ node }: { node: GraphNode }) {
  const setMaskShape = useAppStore((s) => s.setMaskShape);
  const colorKeyPicking = useAppStore((s) => s.colorKeyPicking);
  const setColorKeyPicking = useAppStore((s) => s.setColorKeyPicking);
  const mask = node.mask ?? defaultMaskParams();
  const shape = mask.shapes[0] ?? defaultMaskParams().shapes[0]!;
  const sessionRef = useRef<Record<string, number | null>>({});

  const commit = (next: MaskShape, key: string) => {
    sessionRef.current[key] ??= Date.now();
    setMaskShape(node.id, next, `mask:${node.id}:${key}:${sessionRef.current[key]}`);
  };
  const commitDiscrete = (next: MaskShape) => {
    setMaskShape(node.id, next, null);
  };

  const numRow = (
    label: string,
    key: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void
  ) => (
    <div
      key={key}
      className="param-row"
      onPointerDown={() => {
        sessionRef.current[key] = Date.now();
      }}
      onPointerUp={() => {
        sessionRef.current[key] = null;
      }}
    >
      <span className="param-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(ev) => onChange(Number(ev.target.value))}
      />
      <input
        type="number"
        className="param-number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(ev) => {
          const v = Number(ev.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </div>
  );

  return (
    <>
      <div className="inspector-title">Mask</div>
      <Section title="Mask">
        <div className="mask-type-toggle">
          <button
            className={shape.type === 'radial' ? 'active' : undefined}
            data-testid="mask-type-radial"
            onClick={() => commitDiscrete(defaultRadialMaskShape())}
          >
            Radial
          </button>
          <button
            className={shape.type === 'linear' ? 'active' : undefined}
            data-testid="mask-type-linear"
            onClick={() => commitDiscrete(defaultLinearMaskShape())}
          >
            Linear
          </button>
          <button
            className={shape.type === 'colorKey' ? 'active' : undefined}
            data-testid="mask-type-colorkey"
            onClick={() => commitDiscrete(defaultColorKeyMaskShape())}
          >
            Color Key
          </button>
        </div>
        {shape.type === 'radial' ? (
          <>
            {numRow('Center X', 'cx', shape.cx, 0, 1, 0.01, (v) => commit({ ...shape, cx: v }, 'cx'))}
            {numRow('Center Y', 'cy', shape.cy, 0, 1, 0.01, (v) => commit({ ...shape, cy: v }, 'cy'))}
            {numRow('Radius', 'radius', shape.radius, 0, 1.5, 0.01, (v) => commit({ ...shape, radius: v }, 'radius'))}
            {numRow('Feather', 'feather', shape.feather, 0, 1, 0.01, (v) => commit({ ...shape, feather: v }, 'feather'))}
          </>
        ) : shape.type === 'linear' ? (
          <>
            {numRow('X0', 'x0', shape.x0, -0.5, 1.5, 0.01, (v) => commit({ ...shape, x0: v }, 'x0'))}
            {numRow('Y0', 'y0', shape.y0, -0.5, 1.5, 0.01, (v) => commit({ ...shape, y0: v }, 'y0'))}
            {numRow('X1', 'x1', shape.x1, -0.5, 1.5, 0.01, (v) => commit({ ...shape, x1: v }, 'x1'))}
            {numRow('Y1', 'y1', shape.y1, -0.5, 1.5, 0.01, (v) => commit({ ...shape, y1: v }, 'y1'))}
            {numRow('Feather', 'feather', shape.feather, 0, 1, 0.01, (v) => commit({ ...shape, feather: v }, 'feather'))}
          </>
        ) : (
          <>
            <div className="colorkey-eyedropper-row">
              <button
                type="button"
                data-testid="colorkey-eyedropper"
                className={`colorkey-eyedropper-button${colorKeyPicking ? ' active' : ''}`}
                title="Pick a pixel in the image to set hue/sat/lum (Esc to cancel)"
                onClick={() => setColorKeyPicking(!colorKeyPicking)}
              >
                {colorKeyPicking ? 'Click the image…' : 'Eyedropper'}
              </button>
            </div>
            {numRow('Hue', 'hue', shape.hue, 0, 360, 1, (v) => commit({ ...shape, hue: v }, 'hue'))}
            {numRow('Hue Range', 'hueRange', shape.hueRange, 0, 180, 1, (v) => commit({ ...shape, hueRange: v }, 'hueRange'))}
            {numRow('Saturation', 'sat', shape.sat, 0, 1, 0.01, (v) => commit({ ...shape, sat: v }, 'sat'))}
            {numRow('Sat Range', 'satRange', shape.satRange, 0, 1, 0.01, (v) => commit({ ...shape, satRange: v }, 'satRange'))}
            {numRow('Luminance', 'lum', shape.lum, 0, 1, 0.01, (v) => commit({ ...shape, lum: v }, 'lum'))}
            {numRow('Lum Range', 'lumRange', shape.lumRange, 0, 1, 0.01, (v) => commit({ ...shape, lumRange: v }, 'lumRange'))}
            {numRow('Softness', 'softness', shape.softness, 0, 1, 0.01, (v) => commit({ ...shape, softness: v }, 'softness'))}
          </>
        )}
        <label className="mask-invert-row">
          <input
            type="checkbox"
            data-testid="mask-invert"
            checked={shape.invert}
            onChange={(ev) => commitDiscrete({ ...shape, invert: ev.target.checked })}
          />
          Invert
        </label>
      </Section>
    </>
  );
}

/** Output node inspector: editable display name (spec §6, default 'main'). */
function OutputInspector({ node }: { node: GraphNode }) {
  const renameOutput = useAppStore((s) => s.renameOutput);
  const sessionRef = useRef<number | null>(null);
  return (
    <>
      <div className="inspector-title">Output: sRGB-encoded display.</div>
      <Section title="Output">
        <label className="output-name-row">
          Name
          <input
            type="text"
            data-testid="output-name"
            value={outputName(node)}
            onChange={(ev) => {
              sessionRef.current ??= Date.now();
              renameOutput(node.id, ev.target.value, `output-name:${node.id}:${sessionRef.current}`);
            }}
            onBlur={() => {
              sessionRef.current = null;
            }}
          />
        </label>
      </Section>
    </>
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
  if (node.kind === MASK_KIND) {
    return <MaskInspector node={node} />;
  }
  if (node.kind === 'input') {
    return (
      <>
        <div className="inspector-title">Input</div>
        <LensSection node={node} />
      </>
    );
  }
  if (node.kind === 'output') {
    return <OutputInspector node={node} />;
  }
  if (!isOpKind(node.kind)) {
    return <div className="inspector-placeholder">Output: sRGB-encoded display.</div>;
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

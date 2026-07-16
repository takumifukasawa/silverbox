import { describe, expect, it } from 'vitest';
import { diffLook, fmtNum } from './diffLook';
import {
  DEVELOP_KIND,
  defaultGeometryParams,
  defaultLensParams,
  type GraphDoc,
  type GraphEdge,
  type GraphNode,
  type SidecarDoc,
} from '../graph/graphDoc';
import { defaultDevelopParams, identityCurvePoints, type DevelopParams } from '../graph/developNode';
import { MASK_KIND, defaultMaskParams, defaultRadialMaskShape, defaultLinearMaskShape } from '../graph/maskNode';
import { SPOTS_KIND, defaultSpotsParams } from '../graph/spotsNode';
import { IMAGE_KIND, defaultImageParams } from '../graph/imageNode';
import { EXTERNAL_KIND, defaultExternalParams } from '../graph/externalNode';
import { createDefaultCustomShaderParams } from '../graph/customShaderNode';
import { BLEND_KIND, CUSTOM_KIND } from '../graph/ops';
import { curveEvaluator } from '../color/toneCurve';

function doc(nodes: GraphNode[], edges: GraphEdge[] = [], rating = 0, flag?: SidecarDoc['flag']): SidecarDoc {
  const graph: GraphDoc = { version: 1, nodes, edges };
  return { graph, rating, ...(flag ? { flag } : {}) };
}

function devNode(id: string, develop: Partial<DevelopParams> = {}, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: DEVELOP_KIND,
    position: { x: 0, y: 0 },
    develop: { ...defaultDevelopParams(), ...develop },
    ...extra,
  };
}

function inputNode(extra: Partial<GraphNode> = {}): GraphNode {
  return { id: 'in', kind: 'input', position: { x: 0, y: 0 }, geometry: defaultGeometryParams(), lens: defaultLensParams(), ...extra };
}

function outputNode(id = 'out', extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind: 'output', position: { x: 0, y: 0 }, ...extra };
}

const chain = (dev: GraphNode) => [inputNode(), dev, outputNode()];
const chainEdges: GraphEdge[] = [
  { id: 'e0', source: 'in', target: 'dev' },
  { id: 'e1', source: 'dev', target: 'out' },
];

describe('diffLook', () => {
  it('identical docs produce no lines', () => {
    const a = doc(chain(devNode('dev')), chainEdges);
    const b = doc(chain(devNode('dev')), chainEdges);
    expect(diffLook(a, b)).toEqual([]);
  });

  it('rating change', () => {
    const nodes = chain(devNode('dev'));
    const a = doc(nodes, chainEdges, 3);
    const b = doc(nodes, chainEdges, 5);
    expect(diffLook(a, b)).toContain('rating: 3 → 5');
  });

  it('rating change to/from unrated (0)', () => {
    const nodes = chain(devNode('dev'));
    expect(diffLook(doc(nodes, chainEdges, 0), doc(nodes, chainEdges, 5))).toContain('rating: unrated → 5');
    expect(diffLook(doc(nodes, chainEdges, 3), doc(nodes, chainEdges, 0))).toContain('rating: 3 → unrated');
  });

  it('flag change (reject-flag pack): unflagged/pick/reject, independent of rating', () => {
    const nodes = chain(devNode('dev'));
    expect(diffLook(doc(nodes, chainEdges, 0), doc(nodes, chainEdges, 0, 'pick'))).toContain('flag: none → pick');
    expect(diffLook(doc(nodes, chainEdges, 0, 'pick'), doc(nodes, chainEdges, 0, 'reject'))).toContain('flag: pick → reject');
    expect(diffLook(doc(nodes, chainEdges, 0, 'reject'), doc(nodes, chainEdges, 0))).toContain('flag: reject → none');
    // rating changing alongside an unchanged flag reports only the rating line
    const lines = diffLook(doc(nodes, chainEdges, 3, 'pick'), doc(nodes, chainEdges, 5, 'pick'));
    expect(lines).toContain('rating: 3 → 5');
    expect(lines.some((l) => l.startsWith('flag:'))).toBe(false);
  });

  it('basic.ev change matches the brief\'s own example format exactly', () => {
    const a = doc(chain(devNode('dev')), chainEdges);
    const b = doc(chain(devNode('dev', { basic: { ...defaultDevelopParams().basic, ev: 0.3 } })), chainEdges);
    expect(diffLook(a, b)).toContain('dev: basic.ev 0 → +0.3');
  });

  it('a negative basic.contrast change', () => {
    const a = doc(chain(devNode('dev', { basic: { ...defaultDevelopParams().basic, contrast: 20 } })), chainEdges);
    const b = doc(chain(devNode('dev', { basic: { ...defaultDevelopParams().basic, contrast: -10 } })), chainEdges);
    expect(diffLook(a, b)).toContain('dev: basic.contrast +20 → -10');
  });

  it('bypass toggle (dev: active <-> bypassed)', () => {
    const a = doc(chain(devNode('dev')), chainEdges);
    const b = doc(chain(devNode('dev', {}, { disabled: true })), chainEdges);
    expect(diffLook(a, b)).toContain('dev: active → bypassed');
    expect(diffLook(b, a)).toContain('dev: bypassed → active');
  });

  it('unchanged Develop params produce no lines even when the node is otherwise present in both', () => {
    const a = doc(chain(devNode('dev')), chainEdges);
    const b = doc(chain(devNode('dev')), chainEdges);
    expect(diffLook(a, b)).toEqual([]);
  });

  describe('toneCurve summarization', () => {
    it('summarizes a changed curve by p25/p50/p75, never as a point list', () => {
      const before = identityCurvePoints();
      const after: DevelopParams['toneCurve']['rgb'] = [
        [0, 0],
        [255, 200],
      ];
      const a = doc(chain(devNode('dev')), chainEdges);
      const b = doc(chain(devNode('dev', { toneCurve: { ...defaultDevelopParams().toneCurve, rgb: after } })), chainEdges);
      const lines = diffLook(a, b);
      const line = lines.find((l) => l.startsWith('dev: toneCurve.rgb'));
      expect(line).toBeDefined();
      // No raw point list ever appears in the line.
      expect(line).not.toMatch(/\[\s*\d+\s*,\s*\d+\s*\]/);
      // The exact evaluated quantiles (both curves are 2-point lines, so
      // PCHIP collapses to plain linear interpolation — hand-computable).
      const evalBefore = curveEvaluator(before);
      const evalAfter = curveEvaluator(after);
      expect(line).toBe(
        `dev: toneCurve.rgb  p25 ${fmtNum(evalBefore(63.75))}→${fmtNum(evalAfter(63.75))}  ` +
          `p50 ${fmtNum(evalBefore(127.5))}→${fmtNum(evalAfter(127.5))}  ` +
          `p75 ${fmtNum(evalBefore(191.25))}→${fmtNum(evalAfter(191.25))}`
      );
    });

    it('two different point lists tracing the SAME line produce no line (evaluated, not raw, comparison)', () => {
      const straightA: DevelopParams['toneCurve']['rgb'] = [
        [0, 0],
        [255, 255],
      ];
      const straightB: DevelopParams['toneCurve']['rgb'] = [
        [0, 0],
        [100, 100],
        [255, 255],
      ];
      const a = doc(chain(devNode('dev', { toneCurve: { ...defaultDevelopParams().toneCurve, rgb: straightA } })), chainEdges);
      const b = doc(chain(devNode('dev', { toneCurve: { ...defaultDevelopParams().toneCurve, rgb: straightB } })), chainEdges);
      expect(diffLook(a, b).some((l) => l.startsWith('dev: toneCurve.rgb'))).toBe(false);
    });

    it('only the changed channel is reported', () => {
      const after: DevelopParams['toneCurve']['r'] = [
        [0, 10],
        [255, 255],
      ];
      const a = doc(chain(devNode('dev')), chainEdges);
      const b = doc(chain(devNode('dev', { toneCurve: { ...defaultDevelopParams().toneCurve, r: after } })), chainEdges);
      const lines = diffLook(a, b).filter((l) => l.startsWith('dev: toneCurve.'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^dev: toneCurve\.r /);
    });
  });

  it('hsl band change', () => {
    const devB = defaultDevelopParams();
    devB.hsl.red = { h: 0, s: 20, l: 0 };
    const a = doc(chain(devNode('dev')), chainEdges);
    const b = doc(chain(devNode('dev', { hsl: devB.hsl })), chainEdges);
    expect(diffLook(a, b)).toContain('dev: hsl.red.s 0 → +20');
  });

  it('grading wheel + blending/balance change', () => {
    const devB = defaultDevelopParams();
    devB.grading.shadows = { hue: 200, sat: 30, lum: -10 };
    devB.grading.balance = 15;
    const a = doc(chain(devNode('dev')), chainEdges);
    const b = doc(chain(devNode('dev', { grading: devB.grading })), chainEdges);
    const lines = diffLook(a, b);
    expect(lines).toContain('dev: grading.shadows.sat 0 → +30');
    expect(lines).toContain('dev: grading.shadows.lum 0 → -10');
    expect(lines).toContain('dev: grading.balance 0 → +15');
  });

  it('detail (sharpen/NR) change', () => {
    const devB = defaultDevelopParams();
    devB.detail.sharpen.amount = 40;
    const a = doc(chain(devNode('dev')), chainEdges);
    const b = doc(chain(devNode('dev', { detail: devB.detail })), chainEdges);
    expect(diffLook(a, b)).toContain('dev: detail.sharpen.amount 0 → +40');
  });

  it('effects change', () => {
    const devB = defaultDevelopParams();
    devB.effects.vignette = -30;
    const a = doc(chain(devNode('dev')), chainEdges);
    const b = doc(chain(devNode('dev', { effects: devB.effects })), chainEdges);
    expect(diffLook(a, b)).toContain('dev: effects.vignette 0 → -30');
  });

  it('input geometry (crop/angle) + lens change', () => {
    const a = doc(chain(devNode('dev')), chainEdges);
    const bNodes = chain(devNode('dev'));
    bNodes[0] = inputNode({ geometry: { crop: { x: 0.1, y: 0, w: 0.8, h: 1 }, angle: 5, orientation: { quarterTurns: 0, flipH: false } } });
    const b = doc(bNodes, chainEdges);
    const lines = diffLook(a, b);
    expect(lines).toContain('in: geometry.crop.x 0 → +0.1');
    expect(lines).toContain('in: geometry.crop.w +1 → +0.8');
    expect(lines).toContain('in: geometry.angle 0 → +5');
  });

  it('lens distortion change', () => {
    const a = doc(chain(devNode('dev')), chainEdges);
    const bNodes = chain(devNode('dev'));
    bNodes[0] = inputNode({ lens: { ...defaultLensParams(), distortion: 25 } });
    const b = doc(bNodes, chainEdges);
    expect(diffLook(a, b)).toContain('in: lens.distortion 0 → +25');
  });

  describe('mask node', () => {
    function maskNode(shapes: ReturnType<typeof defaultRadialMaskShape>[] | ReturnType<typeof defaultLinearMaskShape>[]): GraphNode {
      return { id: 'mask-1', kind: MASK_KIND, position: { x: 0, y: 0 }, mask: { shapes } };
    }

    it('shape count change', () => {
      const a = doc([maskNode([defaultRadialMaskShape()])]);
      const b = doc([maskNode([defaultRadialMaskShape(), defaultRadialMaskShape()])]);
      expect(diffLook(a, b)).toContain('mask-1: shapes 1 → 2');
    });

    it('per-shape field change (same count)', () => {
      const a = doc([maskNode([defaultRadialMaskShape()])]);
      const changed = { ...defaultRadialMaskShape(), radius: 0.5 };
      const b = doc([maskNode([changed])]);
      expect(diffLook(a, b)).toContain('mask-1: shapes[0].radius +0.25 → +0.5');
    });

    it('shape TYPE change at the same index', () => {
      const a = doc([maskNode([defaultRadialMaskShape()])]);
      const b = doc([maskNode([defaultLinearMaskShape()])]);
      expect(diffLook(a, b)).toContain('mask-1: shapes[0] radial → linear');
    });
  });

  describe('spots node', () => {
    function spotsNode(spots: ReturnType<typeof defaultSpotsParams>['spots']): GraphNode {
      return { id: 'spots-1', kind: SPOTS_KIND, position: { x: 0, y: 0 }, spots: { spots } };
    }
    const spot = (dx: number) => ({ dx, dy: 0.5, sx: 0.6, sy: 0.5, radius: 0.05, feather: 0.3 });

    it('count change matches the brief\'s "spots: 3 → 5" grammar', () => {
      const a = doc([spotsNode([spot(0.1), spot(0.2), spot(0.3)])]);
      const b = doc([spotsNode([spot(0.1), spot(0.2), spot(0.3), spot(0.4), spot(0.5)])]);
      expect(diffLook(a, b)).toContain('spots-1: spots 3 → 5');
    });

    it('same count, edited positions', () => {
      const a = doc([spotsNode([spot(0.1)])]);
      const b = doc([spotsNode([spot(0.15)])]);
      expect(diffLook(a, b)).toContain('spots-1: spots edited (same count, positions/radius changed)');
    });

    it('same count, untouched -> no line', () => {
      const a = doc([spotsNode([spot(0.1)])]);
      const b = doc([spotsNode([spot(0.1)])]);
      expect(diffLook(a, b)).toEqual([]);
    });
  });

  it('image node path change', () => {
    const a = doc([{ id: 'img-1', kind: IMAGE_KIND, position: { x: 0, y: 0 }, image: defaultImageParams() }]);
    const b = doc([{ id: 'img-1', kind: IMAGE_KIND, position: { x: 0, y: 0 }, image: { path: '/tmp/mask.png' } }]);
    expect(diffLook(a, b)).toContain('img-1: image.path "" → "/tmp/mask.png"');
  });

  it('external node command + encoded change', () => {
    const a = doc([{ id: 'ext-1', kind: EXTERNAL_KIND, position: { x: 0, y: 0 }, external: defaultExternalParams() }]);
    const b = doc([
      { id: 'ext-1', kind: EXTERNAL_KIND, position: { x: 0, y: 0 }, external: { command: 'denoise {in} {out}', encoded: false } },
    ]);
    const lines = diffLook(a, b);
    expect(lines).toContain('ext-1: external.command "" → "denoise {in} {out}"');
    expect(lines).toContain('ext-1: external.encoded on → off');
  });

  describe('custom shader node', () => {
    it('param value change', () => {
      const base = createDefaultCustomShaderParams();
      const withParam = { ...base, params: [{ name: 'amount', min: 0, max: 1, default: 0, value: 0 }] };
      const a = doc([{ id: 'custom-1', kind: CUSTOM_KIND, position: { x: 0, y: 0 }, shader: withParam }]);
      const b = doc([
        {
          id: 'custom-1',
          kind: CUSTOM_KIND,
          position: { x: 0, y: 0 },
          shader: { ...withParam, params: [{ ...withParam.params[0]!, value: 0.7 }] },
        },
      ]);
      expect(diffLook(a, b)).toContain('custom-1: shader.amount 0 → +0.7');
    });

    it('param added/removed', () => {
      const base = createDefaultCustomShaderParams();
      const a = doc([{ id: 'custom-1', kind: CUSTOM_KIND, position: { x: 0, y: 0 }, shader: base }]);
      const b = doc([
        {
          id: 'custom-1',
          kind: CUSTOM_KIND,
          position: { x: 0, y: 0 },
          shader: { ...base, params: [{ name: 'strength', min: 0, max: 1, default: 0, value: 0.5 }] },
        },
      ]);
      expect(diffLook(a, b)).toContain('custom-1: shader param added strength');
      expect(diffLook(b, a)).toContain('custom-1: shader param removed strength');
    });

    it('code change reports a line count, not the source text', () => {
      const base = createDefaultCustomShaderParams();
      const a = doc([{ id: 'custom-1', kind: CUSTOM_KIND, position: { x: 0, y: 0 }, shader: base }]);
      const newSrc = 'return color * 0.5;\nreturn color;\n';
      const b = doc([
        {
          id: 'custom-1',
          kind: CUSTOM_KIND,
          position: { x: 0, y: 0 },
          shader: { ...base, code: { src: newSrc, lastValidSrc: newSrc } },
        },
      ]);
      const lines = diffLook(a, b);
      expect(lines.some((l) => l.startsWith('custom-1: shader code changed ('))).toBe(true);
      expect(lines.some((l) => l.includes(base.code.lastValidSrc))).toBe(false);
    });
  });

  describe('output node', () => {
    it('name change', () => {
      const a = doc([outputNode('out')]);
      const b = doc([outputNode('out', { name: 'web' })]);
      expect(diffLook(a, b)).toContain('out: name "main" → "web"');
    });

    it('export overrides: added, changed, and reverted-to-inherit', () => {
      const a = doc([outputNode('out')]);
      const bAdded = doc([outputNode('out', { export: { quality: 60 } })]);
      expect(diffLook(a, bAdded)).toContain('out: export.quality inherit → 60');
      const cChanged = doc([outputNode('out', { export: { quality: 80 } })]);
      expect(diffLook(bAdded, cChanged)).toContain('out: export.quality 60 → 80');
      expect(diffLook(bAdded, a)).toContain('out: export.quality 60 → inherit');
    });

    it('export maxDim distinguishes null (full-res override) from absent (inherit)', () => {
      const a = doc([outputNode('out')]);
      const b = doc([outputNode('out', { export: { maxDim: null } })]);
      expect(diffLook(a, b)).toContain('out: export.maxDim inherit → full-res');
    });
  });

  it('legacy op-kind node param change', () => {
    const a = doc([{ id: 'exp-1', kind: 'exposure', position: { x: 0, y: 0 }, params: { ev: 0 } }]);
    const b = doc([{ id: 'exp-1', kind: 'exposure', position: { x: 0, y: 0 }, params: { ev: -1.5 } }]);
    expect(diffLook(a, b)).toContain('exp-1: ev 0 → -1.5');
  });

  it('blend node param change', () => {
    const a = doc([{ id: 'blend-1', kind: BLEND_KIND, position: { x: 0, y: 0 }, params: { amount: 0.5 } }]);
    const b = doc([{ id: 'blend-1', kind: BLEND_KIND, position: { x: 0, y: 0 }, params: { amount: 0.9 } }]);
    expect(diffLook(a, b)).toContain('blend-1: amount +0.5 → +0.9');
  });

  it('added nodes join on one line with " + ", each described (brief\'s own "mask-2 (radial) + blend-2" shape)', () => {
    const a = doc([outputNode('out')]);
    const b = doc([
      outputNode('out'),
      { id: 'mask-2', kind: MASK_KIND, position: { x: 0, y: 0 }, mask: defaultMaskParams() },
      { id: 'blend-2', kind: BLEND_KIND, position: { x: 0, y: 0 }, params: { amount: 0.5 } },
    ]);
    expect(diffLook(a, b)).toContain('added: mask-2 (radial) + blend-2 (blend)');
  });

  it('removed nodes', () => {
    const a = doc([outputNode('out'), { id: 'blend-2', kind: BLEND_KIND, position: { x: 0, y: 0 }, params: { amount: 0.5 } }]);
    const b = doc([outputNode('out')]);
    expect(diffLook(a, b)).toContain('removed: blend-2 (blend)');
  });

  it('node kind mismatch at the same id is reported as "replaced", not partially diffed', () => {
    const a = doc([{ id: 'n1', kind: MASK_KIND, position: { x: 0, y: 0 }, mask: defaultMaskParams() }]);
    const b = doc([{ id: 'n1', kind: SPOTS_KIND, position: { x: 0, y: 0 }, spots: defaultSpotsParams() }]);
    expect(diffLook(a, b)).toContain('n1: replaced (mask (radial) → spots (0))');
  });

  describe('edges', () => {
    it('added and removed wires, matched by (source,target,port) signature not edge id', () => {
      const nodes = [inputNode(), devNode('dev'), outputNode()];
      const a = doc(nodes, [{ id: 'e0', source: 'in', target: 'dev' }]);
      // same wire, DIFFERENT edge id -> no diff reported
      const bSameWire = doc(nodes, [{ id: 'totally-different-id', source: 'in', target: 'dev' }]);
      expect(diffLook(a, bSameWire)).toEqual([]);

      const bRewired = doc(nodes, [{ id: 'e0', source: 'in', target: 'out' }]);
      const lines = diffLook(a, bRewired);
      expect(lines).toContain('unwired: in → dev');
      expect(lines).toContain('wired: in → out');
    });

    it('port (targetHandle) is part of the signature', () => {
      const nodes = [inputNode()];
      const a = doc(nodes, [{ id: 'e0', source: 'in', target: 'blend-1', targetHandle: 'a' }]);
      const b = doc(nodes, [{ id: 'e0', source: 'in', target: 'blend-1', targetHandle: 'b' }]);
      const lines = diffLook(a, b);
      expect(lines).toContain('unwired: in → blend-1 (a)');
      expect(lines).toContain('wired: in → blend-1 (b)');
    });
  });

  describe('fmtNum', () => {
    it('zero (and negative zero) format as bare "0"', () => {
      expect(fmtNum(0)).toBe('0');
      expect(fmtNum(-0)).toBe('0');
    });
    it('positive values get an explicit +', () => {
      expect(fmtNum(0.3)).toBe('+0.3');
      expect(fmtNum(5600)).toBe('+5600');
    });
    it('negative values keep their native sign', () => {
      expect(fmtNum(-2)).toBe('-2');
      expect(fmtNum(-0.25)).toBe('-0.25');
    });
    it('trims float noise to 3 decimals', () => {
      expect(fmtNum(0.1 + 0.2 - 0.3)).toBe('0'); // ~2.7e-17, rounds to 0
      expect(fmtNum(0.30000000000000004)).toBe('+0.3');
    });
  });
});

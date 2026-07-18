/**
 * Look extraction, mode 1 — sidecar-consensus distillation (docs/brief-bank/
 * look-extraction.md §"Mode 1"). Given N already-edited looks that share a
 * "vibe", this module computes the SHARED Develop parameters: a robust
 * center (median, or mean-resultant direction for the one circular field,
 * grading hue) per scalar field, plus an AGREEMENT score per param FAMILY
 * (presetFamilies.ts's vocabulary) that gates whether the family makes it
 * into the extracted preset's `includes` at all — a family the input looks
 * don't actually agree on isn't part of "the look" (per the brief) and is
 * left at identity, reported as excluded rather than silently averaged into
 * a value nobody asked for.
 *
 * No DOM/Electron/GPU dependency (same "pure, unit-testable" shape as
 * diffLook.ts, this module's closest sibling) — the CLI orchestration (read
 * N files, parseGraphDoc each, pull out the Develop node, call this, then
 * presetDoc.ts's serializePreset) lives in appStore.ts's runCliExtractLook.
 * Structural families (geometry/spots/masks/custom-nodes) are OUT OF SCOPE
 * here entirely — the brief calls them "per-photo, not look", so the caller
 * never even passes them into `families`; this module only ever sees the 8
 * 'develop'-group family ids.
 *
 * AGREEMENT DESIGN: deliberately RANGE-based (max−min of the input values,
 * normalized by the field's own slider domain), not a robust/outlier-
 * resistant statistic like MAD — a single input look that disagrees with
 * every other one on a field is EXACTLY the "huge variance" signal the
 * brief wants to catch (a MAD-style measure would shrug off one outlier
 * among many agreeing looks, which is the opposite of what "isn't part of
 * the look" means here). The CENTER value stays the median regardless
 * (robust to a lone outlier), so a family that narrowly clears the
 * threshold still reports a sane consensus value, not one dragged toward
 * the outlier.
 */
import {
  GRADING_REGIONS,
  HSL_BANDS,
  defaultDevelopParams,
  type CurvePoints,
  type DevelopParams,
  type HslBand,
} from '../graph/developNode';
import { curveEvaluator } from '../color/toneCurve';
import { pickDevelopFamilies, type PresetFamilyId } from '../graph/presetFamilies';
import { fmtNum } from './diffLook';

/** Family included/excluded gate — a documented, tunable constant (see this file's doc comment for why range-based, not MAD). */
export const DEFAULT_AGREEMENT_THRESHOLD = 0.5;

/** Common x grid the tone-curve consensus resamples every input curve onto before averaging (brief: "resample to a common x grid… refit ~8 control points") — 9 points spanning the full 0–255 domain, endpoints included. */
export const CURVE_CONSENSUS_GRID = [0, 32, 64, 96, 128, 160, 192, 224, 255];

// --- scalar field plumbing ----------------------------------------------------

type FieldKind = 'linear' | 'circular';

interface FieldSpec {
  /** Report label, dot-path style matching InspectorPanel's slider `key`s (e.g. 'basic.ev', 'hsl.red.h'). */
  label: string;
  family: PresetFamilyId;
  kind: FieldKind;
  /** Slider domain (InspectorPanel.tsx's own min/max for this field) — the denominator agreement normalizes spread against. */
  min: number;
  max: number;
  get(p: DevelopParams): number;
  set(p: DevelopParams, v: number): void;
  /**
   * wb.temp only: 0 is "unresolved as-shot placeholder, WB never touched"
   * (DevelopBasicParams.temp's own doc comment), not a real Kelvin value —
   * excluded from the median/agreement math so one never-white-balanced
   * input doesn't drag the consensus toward zero; if EVERY input is 0 the
   * field stays 0 (identity), same as if nobody had ever set it.
   */
  skipZero?: boolean;
}

function boolField(
  label: string,
  family: PresetFamilyId,
  get: (p: DevelopParams) => boolean,
  set: (p: DevelopParams, v: boolean) => void
): FieldSpec {
  return {
    label,
    family,
    kind: 'linear',
    min: 0,
    max: 1,
    get: (p) => (get(p) ? 1 : 0),
    set: (p, v) => set(p, v >= 0.5),
  };
}

function linField(
  label: string,
  family: PresetFamilyId,
  min: number,
  max: number,
  get: (p: DevelopParams) => number,
  set: (p: DevelopParams, v: number) => void,
  skipZero?: boolean
): FieldSpec {
  return { label, family, kind: 'linear', min, max, get, set, skipZero };
}

/** Every scalar Develop field the 'develop' preset families cover — toneCurve is handled separately (curve consensus, not a scalar median). Ranges lifted from InspectorPanel.tsx's own slider defs (the single source of truth for "what's the full domain of this control"). */
const FIELD_SPECS: FieldSpec[] = [
  // basic-tone (pickDevelopFamilies: profile + basic MINUS temp/tint)
  linField('profile.amount', 'basic-tone', 0, 100, (p) => p.profile.amount, (p, v) => (p.profile.amount = v)),
  linField('basic.ev', 'basic-tone', -5, 5, (p) => p.basic.ev, (p, v) => (p.basic.ev = v)),
  linField('basic.contrast', 'basic-tone', -100, 100, (p) => p.basic.contrast, (p, v) => (p.basic.contrast = v)),
  linField('basic.highlights', 'basic-tone', -100, 100, (p) => p.basic.highlights, (p, v) => (p.basic.highlights = v)),
  linField('basic.shadows', 'basic-tone', -100, 100, (p) => p.basic.shadows, (p, v) => (p.basic.shadows = v)),
  linField('basic.whites', 'basic-tone', -100, 100, (p) => p.basic.whites, (p, v) => (p.basic.whites = v)),
  linField('basic.blacks', 'basic-tone', -100, 100, (p) => p.basic.blacks, (p, v) => (p.basic.blacks = v)),
  linField('basic.saturation', 'basic-tone', -100, 100, (p) => p.basic.saturation, (p, v) => (p.basic.saturation = v)),
  linField('basic.vibrance', 'basic-tone', -100, 100, (p) => p.basic.vibrance, (p, v) => (p.basic.vibrance = v)),
  // wb (pickDevelopFamilies: temp/tint only)
  linField('basic.temp', 'wb', 2000, 50000, (p) => p.basic.temp, (p, v) => (p.basic.temp = v), true),
  linField('basic.tint', 'wb', -150, 150, (p) => p.basic.tint, (p, v) => (p.basic.tint = v)),
  // bw
  boolField('bw.enabled', 'bw', (p) => p.bw.enabled, (p, v) => (p.bw.enabled = v)),
  ...HSL_BANDS.map((band, i) =>
    linField(`bw.mix.${band}`, 'bw', -100, 100, (p) => p.bw.mix[i] ?? 0, (p, v) => (p.bw.mix[i] = v))
  ),
  // grading
  linField('grading.blending', 'grading', 0, 100, (p) => p.grading.blending, (p, v) => (p.grading.blending = v)),
  linField('grading.balance', 'grading', -100, 100, (p) => p.grading.balance, (p, v) => (p.grading.balance = v)),
  ...GRADING_REGIONS.flatMap((region) => [
    linField(`grading.${region}.sat`, 'grading', 0, 100, (p) => p.grading[region].sat, (p, v) => (p.grading[region].sat = v)),
    linField(`grading.${region}.lum`, 'grading', -100, 100, (p) => p.grading[region].lum, (p, v) => (p.grading[region].lum = v)),
    { label: `grading.${region}.hue`, family: 'grading', kind: 'circular', min: 0, max: 360,
      get: (p: DevelopParams) => p.grading[region].hue, set: (p: DevelopParams, v: number) => (p.grading[region].hue = v) } as FieldSpec,
  ]),
  // effects
  linField('effects.dehaze', 'effects', -100, 100, (p) => p.effects.dehaze, (p, v) => (p.effects.dehaze = v)),
  linField('effects.clarity', 'effects', -100, 100, (p) => p.effects.clarity, (p, v) => (p.effects.clarity = v)),
  linField('effects.texture', 'effects', -100, 100, (p) => p.effects.texture, (p, v) => (p.effects.texture = v)),
  linField('effects.grain', 'effects', 0, 100, (p) => p.effects.grain, (p, v) => (p.effects.grain = v)),
  linField('effects.grainSize', 'effects', 1, 3, (p) => p.effects.grainSize, (p, v) => (p.effects.grainSize = v)),
  linField('effects.vignette', 'effects', -100, 100, (p) => p.effects.vignette, (p, v) => (p.effects.vignette = v)),
  linField('effects.vignetteMidpoint', 'effects', 0, 1, (p) => p.effects.vignetteMidpoint, (p, v) => (p.effects.vignetteMidpoint = v)),
  // detail
  linField('detail.sharpen.amount', 'detail', 0, 150, (p) => p.detail.sharpen.amount, (p, v) => (p.detail.sharpen.amount = v)),
  linField('detail.sharpen.radius', 'detail', 0.5, 3, (p) => p.detail.sharpen.radius, (p, v) => (p.detail.sharpen.radius = v)),
  linField('detail.sharpen.masking', 'detail', 0, 100, (p) => p.detail.sharpen.masking, (p, v) => (p.detail.sharpen.masking = v)),
  linField('detail.noiseLuminance.amount', 'detail', 0, 100, (p) => p.detail.noiseLuminance.amount, (p, v) => (p.detail.noiseLuminance.amount = v)),
  linField('detail.noiseLuminance.detail', 'detail', 0, 100, (p) => p.detail.noiseLuminance.detail, (p, v) => (p.detail.noiseLuminance.detail = v)),
  linField('detail.noiseLuminance.contrast', 'detail', 0, 100, (p) => p.detail.noiseLuminance.contrast, (p, v) => (p.detail.noiseLuminance.contrast = v)),
  linField('detail.noiseColor.amount', 'detail', 0, 100, (p) => p.detail.noiseColor.amount, (p, v) => (p.detail.noiseColor.amount = v)),
  linField('detail.noiseColor.detail', 'detail', 0, 100, (p) => p.detail.noiseColor.detail, (p, v) => (p.detail.noiseColor.detail = v)),
  linField('detail.noiseColor.smoothness', 'detail', 0, 100, (p) => p.detail.noiseColor.smoothness, (p, v) => (p.detail.noiseColor.smoothness = v)),
  // hsl (8 bands x h/s/l)
  ...HSL_BANDS.flatMap((band: HslBand) => [
    linField(`hsl.${band}.h`, 'hsl', -100, 100, (p) => p.hsl[band].h, (p, v) => (p.hsl[band].h = v)),
    linField(`hsl.${band}.s`, 'hsl', -100, 100, (p) => p.hsl[band].s, (p, v) => (p.hsl[band].s = v)),
    linField(`hsl.${band}.l`, 'hsl', -100, 100, (p) => p.hsl[band].l, (p, v) => (p.hsl[band].l = v)),
  ]),
];

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Mean resultant length (standard circular-statistics concentration, 0..1) — this field's own agreement for a circular quantity (hue): 1 when every input agrees exactly, shrinking toward 0 as they spread around the wheel, collapsing a single wild outlier's effect exactly like the linear range-based measure does for linear fields. */
function circularConsensus(valuesDeg: number[]): { center: number; agreement: number } {
  let sumC = 0;
  let sumS = 0;
  for (const deg of valuesDeg) {
    const rad = (deg * Math.PI) / 180;
    sumC += Math.cos(rad);
    sumS += Math.sin(rad);
  }
  const n = valuesDeg.length;
  const r = Math.sqrt(sumC * sumC + sumS * sumS) / n;
  let center = (Math.atan2(sumS / n, sumC / n) * 180) / Math.PI;
  if (center < 0) center += 360;
  return { center, agreement: Math.max(0, Math.min(1, r)) };
}

export interface FieldConsensusReport {
  label: string;
  values: number[];
  center: number;
  agreement: number;
}

/** Per-tone-curve-channel consensus (toneCurve.rgb/r/g/b) — never reported as a raw point dump (diffLook.ts's own convention), just the resulting control points plus one agreement number. */
export interface CurveChannelReport {
  label: string;
  points: CurvePoints;
  agreement: number;
}

export type FamilyExclusionReason = 'ok' | 'below-threshold' | 'excluded-by-filter';

export interface FamilyConsensusReport {
  family: PresetFamilyId;
  agreement: number;
  included: boolean;
  reason: FamilyExclusionReason;
  fields: FieldConsensusReport[];
  /** Present only for family === 'curves'. */
  curves?: CurveChannelReport[];
}

export interface LookConsensusResult {
  /** The extracted Develop params — identity everywhere EXCEPT the included families (pickDevelopFamilies' own identity-base semantics). */
  params: DevelopParams;
  includes: PresetFamilyId[];
  reports: FamilyConsensusReport[];
}

function fieldConsensus(spec: FieldSpec, paramsList: DevelopParams[]): FieldConsensusReport {
  let values = paramsList.map(spec.get);
  if (spec.skipZero) {
    const nonZero = values.filter((v) => v !== 0);
    if (nonZero.length > 0) values = nonZero;
  }
  if (spec.kind === 'circular') {
    const { center, agreement } = circularConsensus(values);
    return { label: spec.label, values, center, agreement };
  }
  const center = median(values);
  const range = Math.max(...values) - Math.min(...values);
  const domain = Math.max(1e-9, spec.max - spec.min);
  const agreement = Math.max(0, Math.min(1, 1 - range / domain));
  return { label: spec.label, values, center, agreement };
}

/** One channel's consensus: PCHIP-evaluate every input curve at the common grid, median the y's per grid point (the "refit ~8 control points" the brief describes — the grid IS the new control-point set), agreement = mean of the grid points' own range-based agreement (same normalization the linear scalar fields use, domain = the full 0..255 curve axis). */
function curveChannelConsensus(label: string, curvesList: CurvePoints[]): CurveChannelReport {
  const evaluators = curvesList.map((pts) => curveEvaluator(pts));
  const points: CurvePoints = [];
  let agreementSum = 0;
  for (const x of CURVE_CONSENSUS_GRID) {
    const ys = evaluators.map((ev) => ev(x));
    const y = median(ys);
    points.push([x, y]);
    const range = Math.max(...ys) - Math.min(...ys);
    agreementSum += Math.max(0, Math.min(1, 1 - range / 255));
  }
  return { label, points, agreement: agreementSum / CURVE_CONSENSUS_GRID.length };
}

/**
 * Compute the sidecar-consensus look (docs/brief-bank/look-extraction.md
 * mode 1). `paramsList` is each input look's OWN Develop node params
 * (already parsed/sanitized by the caller — see appStore.ts's
 * runCliExtractLook); at least one is required. `families` restricts which
 * 'develop'-group families are even considered (default: every develop
 * family, presetFamilies.ts's own DEFAULT_CHECKED_FAMILY_IDS-equivalent set)
 * — a family outside this filter is reported `excluded-by-filter` and never
 * included regardless of how well the inputs agree on it. `minAgreement`
 * (default DEFAULT_AGREEMENT_THRESHOLD) is the inclusion gate.
 */
export function computeLookConsensus(
  paramsList: DevelopParams[],
  opts: { families?: readonly PresetFamilyId[]; minAgreement?: number } = {}
): LookConsensusResult {
  if (paramsList.length === 0) throw new Error('computeLookConsensus needs at least one look');
  const threshold = opts.minAgreement ?? DEFAULT_AGREEMENT_THRESHOLD;
  const allowed = opts.families ? new Set(opts.families) : null;

  const consensusParams = defaultDevelopParams();
  const byFamily = new Map<PresetFamilyId, FieldConsensusReport[]>();
  for (const spec of FIELD_SPECS) {
    const report = fieldConsensus(spec, paramsList);
    spec.set(consensusParams, spec.kind === 'circular' ? report.center : report.center);
    const arr = byFamily.get(spec.family) ?? [];
    arr.push(report);
    byFamily.set(spec.family, arr);
  }

  const curveChannels: CurveChannelReport[] = (['rgb', 'r', 'g', 'b'] as const).map((ch) =>
    curveChannelConsensus(`toneCurve.${ch}`, paramsList.map((p) => p.toneCurve[ch]))
  );
  consensusParams.toneCurve = {
    rgb: curveChannels[0]!.points,
    r: curveChannels[1]!.points,
    g: curveChannels[2]!.points,
    b: curveChannels[3]!.points,
  };

  const familyOrder: PresetFamilyId[] = ['basic-tone', 'wb', 'curves', 'hsl', 'bw', 'grading', 'effects', 'detail'];
  const reports: FamilyConsensusReport[] = familyOrder.map((family) => {
    const isFilteredOut = allowed !== null && !allowed.has(family);
    if (family === 'curves') {
      const agreement = curveChannels.reduce((s, c) => s + c.agreement, 0) / curveChannels.length;
      const included = !isFilteredOut && agreement >= threshold;
      return {
        family,
        agreement,
        included,
        reason: isFilteredOut ? 'excluded-by-filter' : included ? 'ok' : 'below-threshold',
        fields: [],
        curves: curveChannels,
      };
    }
    const fields = byFamily.get(family) ?? [];
    const agreement = fields.length > 0 ? fields.reduce((s, f) => s + f.agreement, 0) / fields.length : 1;
    const included = !isFilteredOut && agreement >= threshold;
    return {
      family,
      agreement,
      included,
      reason: isFilteredOut ? 'excluded-by-filter' : included ? 'ok' : 'below-threshold',
      fields,
    };
  });

  const includes = reports.filter((r) => r.included).map((r) => r.family);
  const params = pickDevelopFamilies(consensusParams, defaultDevelopParams(), new Set(includes));
  return { params, includes, reports };
}

/** Human-readable "fit report" lines (brief: "a preset file + a fit report (per-param spread table)") — reuses diffLook.ts's fmtNum for the same signed-number formatting every other look-inspection surface already uses. */
export function formatConsensusReport(reports: FamilyConsensusReport[]): string[] {
  const lines: string[] = [];
  for (const r of reports) {
    const status =
      r.reason === 'excluded-by-filter' ? 'SKIPPED (--families)' : r.included ? 'INCLUDED' : 'EXCLUDED (below agreement threshold)';
    lines.push(`${r.family}: ${status} — agreement ${r.agreement.toFixed(2)}`);
    if (r.curves) {
      for (const c of r.curves) lines.push(`  ${c.label.padEnd(16)} agreement ${c.agreement.toFixed(2)}`);
    } else {
      for (const f of r.fields) {
        lines.push(`  ${f.label.padEnd(28)} median ${fmtNum(f.center)}  values [${f.values.map(fmtNum).join(', ')}]  agreement ${f.agreement.toFixed(2)}`);
      }
    }
  }
  return lines;
}

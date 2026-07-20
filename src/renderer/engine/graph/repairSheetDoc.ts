/**
 * Repair sheet (ゴミ取りセット) file schema
 * (docs/brief-bank/linked-looks-stage-f.md semantic 1): a named set of spots
 * in PHYSICAL SENSOR PIXELS, one file per sheet at
 * `<projectDir>/repair-sheets/<slug>.json`. Its OWN tiny schema — nothing to
 * do with the develop-graph sidecar/preset format — because a sheet carries no
 * look, just dust coordinates: name, createdAt, an optional cameraModel (whose
 * body these spots belong to, informational), and the sensor-space spot list.
 *
 * Project-local only, no library, ever (parent spec §5: dust is make-and-
 * discard within a project). Like presetDoc.ts, this module is pure schema —
 * main/repairSheets.ts only touches bytes; the renderer parses/serializes.
 *
 * Coordinates are physical sensor px (SensorSpot — see repairSheetTransform.ts):
 * dx/dy/sx/sy/radius in px, feather a dimensionless 0..1 ratio. They are a
 * CREATE/APPLY-time transform of the photo's anchor-space spots, never a
 * storage format for a photo (engine invariant: photo files store anchor-space
 * spots only).
 */
import type { SensorSpot } from './repairSheetTransform';

export const REPAIR_SHEET_VERSION = 1;

/** Top-level keys this schema knows; anything else round-trips verbatim (DESIGN §9). */
const KNOWN_KEYS = new Set(['repairSheetVersion', 'name', 'createdAt', 'cameraModel', 'spots']);

export interface RepairSheetDoc {
  name: string;
  createdAt: string;
  /** The camera body model these sensor coords belong to (informational; from the source photo's capture). */
  cameraModel?: string;
  /** Spots in physical sensor px. */
  spots: SensorSpot[];
  /** Unrecognized top-level keys — round-tripped verbatim (never surfaced or written by this build's UI). */
  unknown?: Record<string, unknown>;
}

/** Serialize a repair sheet to its on-disk JSON text (trailing newline, same shape as presetDoc/sidecars). */
export function serializeRepairSheet(doc: RepairSheetDoc): string {
  const out: Record<string, unknown> = {
    repairSheetVersion: REPAIR_SHEET_VERSION,
    name: doc.name,
    createdAt: doc.createdAt,
    ...(doc.cameraModel ? { cameraModel: doc.cameraModel } : {}),
    spots: doc.spots.map((s) => ({ dx: s.dx, dy: s.dy, sx: s.sx, sy: s.sy, radius: s.radius, feather: s.feather })),
    ...(doc.unknown ?? {}),
  };
  return JSON.stringify(out, null, 2) + '\n';
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${path} must be a finite number`);
  return v;
}

/** Normalize one untrusted sensor spot; throws on non-finite numbers (spotsNode.ts's sanitizeSpot convention). */
function sanitizeSensorSpot(raw: unknown, path: string): SensorSpot {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path} must be an object`);
  const src = raw as Record<string, unknown>;
  return {
    dx: num(src.dx, `${path}.dx`),
    dy: num(src.dy, `${path}.dy`),
    sx: num(src.sx, `${path}.sx`),
    sy: num(src.sy, `${path}.sy`),
    radius: num(src.radius, `${path}.radius`),
    // feather defaults like spotsNode.ts's DEFAULT_SPOT_FEATHER if a hand-edited file omits it.
    feather: typeof src.feather === 'number' && Number.isFinite(src.feather) ? src.feather : 0.3,
  };
}

/**
 * Parse a repair sheet file's raw JSON text; throws on a structurally invalid
 * file (non-object, missing name, non-array spots, or a non-finite coordinate)
 * — the caller (main/repairSheets.ts's listRepairSheets) catches and skips a
 * bad file rather than crashing the list, same convention as listSharedLooks.
 * Unlike the spots node's SPOTS_CAP truncation, a sheet is NEVER length-capped
 * here: the cap is enforced per-target at APPLY time (semantic 6), never by a
 * silent slice.
 */
export function parseRepairSheet(text: string): RepairSheetDoc {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('repair sheet must be an object');
  const src = raw as Record<string, unknown>;
  if (typeof src.name !== 'string') throw new Error('repair sheet must have a string name');
  if (!Array.isArray(src.spots)) throw new Error('repair sheet must have a spots array');
  const spots = src.spots.map((s, i) => sanitizeSensorSpot(s, `spots[${i}]`));
  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) if (!KNOWN_KEYS.has(k)) unknown[k] = v;
  return {
    name: src.name,
    createdAt: typeof src.createdAt === 'string' ? src.createdAt : '',
    ...(typeof src.cameraModel === 'string' ? { cameraModel: src.cameraModel } : {}),
    spots,
    ...(Object.keys(unknown).length > 0 ? { unknown } : {}),
  };
}

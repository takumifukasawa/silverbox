/**
 * Develop presets (task #37): a preset is a WHOLE LOOK — the entire develop
 * graph — persisted as an individual JSON file at
 * `<userData>/presets/<slug>.json`, one per preset, text-first and
 * git-shareable (ROADMAP.md "Presets") — the same philosophy as sidecars.
 *
 * A preset IS "a named, persisted develop clipboard": the `look` payload is
 * exactly what appStore.ts's captureLook produces (copyDevelopSettings'
 * exact geometry-stripping contract), stored via the SAME serializer/parser
 * the sidecar uses (serializeGraphDoc/parseGraphDoc) — schema-version
 * acceptance (v2/v3) and per-node/edge unknown-field passthrough come for
 * free. The preset file adds one more wrapper layer around that
 * (presetVersion/name/createdAt), with its OWN unknown-key passthrough
 * (DESIGN §9), independent of the nested look's.
 */
import { parseGraphDoc, serializeGraphDoc, type GraphDoc } from './graphDoc';

export const PRESET_VERSION = 1;

/** Wrapper-level keys this schema knows about; anything else round-trips verbatim (DESIGN §9). */
const KNOWN_PRESET_KEYS = new Set(['presetVersion', 'name', 'createdAt', 'look']);

export interface ParsedPreset {
  name: string;
  createdAt: string;
  look: GraphDoc;
  /** Unrecognized top-level keys — round-tripped verbatim on update (see appStore.ts's savePreset). */
  unknown?: Record<string, unknown>;
}

/**
 * Serialize a preset file. `look` embeds serializeGraphDoc's own wrapper
 * object (schemaVersion/createdAt/updatedAt/graph) verbatim — presets carry
 * no `source` block (no single photo owns a preset, unlike a sidecar).
 * `unknownFields` are whatever this slug's on-disk file already carried,
 * read back by the caller (appStore.ts's savePreset) before overwriting, so
 * a newer Silverbox's not-yet-understood top-level keys survive an older
 * build's re-save.
 */
export function serializePreset(
  name: string,
  look: GraphDoc,
  createdAt: string,
  unknownFields?: Record<string, unknown>
): string {
  const wrapper = {
    ...(unknownFields ?? {}),
    presetVersion: PRESET_VERSION,
    name,
    createdAt,
    look: JSON.parse(serializeGraphDoc(look, null, null)),
  };
  return JSON.stringify(wrapper, null, 2) + '\n';
}

/** Parse + validate a preset file; throws with a reason on anything malformed (parseGraphDoc's own convention). */
export function parsePresetFile(text: string): ParsedPreset {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('preset must be an object');
  const wrapper = raw as { presetVersion?: unknown; name?: unknown; createdAt?: unknown; look?: unknown };
  if (typeof wrapper.name !== 'string' || wrapper.name.trim() === '') throw new Error('preset missing a name');
  if (typeof wrapper.look !== 'object' || wrapper.look === null) throw new Error('preset missing its look');
  // parseGraphDoc parses its own text and does the full schema-version +
  // sanitization + buildPlan validation — re-stringifying the embedded
  // object reuses that entire path rather than duplicating it.
  const { graph } = parseGraphDoc(JSON.stringify(wrapper.look));
  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_PRESET_KEYS.has(k)) unknown[k] = v;
  }
  return {
    name: wrapper.name,
    createdAt: typeof wrapper.createdAt === 'string' ? wrapper.createdAt : new Date().toISOString(),
    look: graph,
    ...(Object.keys(unknown).length > 0 ? { unknown } : {}),
  };
}

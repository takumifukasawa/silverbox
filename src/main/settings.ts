/**
 * `<userData>/settings.json` — main-process owned, text-first app preferences.
 *
 * Same atomic-write discipline as writeSidecar in index.ts (write to a temp
 * file next to the target, rename over it) so a crash mid-save never leaves a
 * truncated settings.json. Sanitization follows graphDoc's parseGraphDoc
 * pattern: missing/invalid known fields fall back to defaults, and unknown
 * top-level fields (a newer Silverbox's not-yet-understood keys) are
 * preserved verbatim across a read→settingsUpdate→write round-trip — DESIGN.md
 * §9 ("documents outlive versions") applies to this document too.
 */
import { app } from 'electron';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  type ExportColorSpace,
  type ExportMetadataPolicy,
  type ExportPreset,
  type ExportSettingsShape,
  type Settings,
} from '../../shared/ipc';

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

async function atomicWriteFile(target: string, content: string): Promise<void> {
  const tmpDir = await mkdtemp(join(dirname(target), '.silverbox-save-'));
  const tmpFile = join(tmpDir, 'settings.json');
  try {
    await writeFile(tmpFile, content, 'utf8');
    await rename(tmpFile, target);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function sanitizeExportSettings(raw: unknown): ExportSettingsShape {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const defaults = DEFAULT_SETTINGS.export;
  const quality =
    typeof src.quality === 'number' && Number.isFinite(src.quality)
      ? Math.min(100, Math.max(1, Math.round(src.quality)))
      : defaults.quality;
  const maxDim =
    typeof src.maxDim === 'number' && Number.isFinite(src.maxDim) && src.maxDim > 0
      ? Math.round(src.maxDim)
      : null;
  const metadata: ExportMetadataPolicy =
    src.metadata === 'all' || src.metadata === 'minimal' || src.metadata === 'none' ? src.metadata : defaults.metadata;
  const colorSpace: ExportColorSpace =
    src.colorSpace === 'srgb' || src.colorSpace === 'p3' ? src.colorSpace : defaults.colorSpace;
  return { quality, maxDim, metadata, colorSpace };
}

function sanitizeExportPresets(raw: unknown): ExportPreset[] {
  if (!Array.isArray(raw)) return [];
  const presets: ExportPreset[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object' || typeof (p as Record<string, unknown>).name !== 'string') continue;
    presets.push({ name: (p as Record<string, unknown>).name as string, ...sanitizeExportSettings(p) });
  }
  return presets;
}

/**
 * Sanitize an untrusted settings.json payload: every KNOWN field is validated
 * with a default fallback, while any OTHER top-level key on `raw` rides
 * through unchanged (spread first, known fields overwritten after) so a
 * future schema's fields survive an older build's round-trip untouched.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const result: Record<string, unknown> = { ...src };
  result.settingsVersion = SETTINGS_VERSION;
  result.autosaveSidecar =
    typeof src.autosaveSidecar === 'boolean' ? src.autosaveSidecar : DEFAULT_SETTINGS.autosaveSidecar;
  result.previewLongEdge =
    typeof src.previewLongEdge === 'number' && Number.isFinite(src.previewLongEdge) && src.previewLongEdge > 0
      ? src.previewLongEdge
      : DEFAULT_SETTINGS.previewLongEdge;
  result.baselineExposureEV =
    typeof src.baselineExposureEV === 'number' && Number.isFinite(src.baselineExposureEV)
      ? Math.min(5, Math.max(-5, src.baselineExposureEV))
      : DEFAULT_SETTINGS.baselineExposureEV;
  result.export = sanitizeExportSettings(src.export);
  result.exportPresets = sanitizeExportPresets(src.exportPresets);
  return result as unknown as Settings;
}

let cache: Settings | null = null;

/** Read + sanitize settings.json, writing fresh defaults if it is missing. */
export async function readSettings(): Promise<Settings> {
  if (cache) return cache;
  const target = settingsPath();
  let raw: unknown = null;
  try {
    raw = JSON.parse(await readFile(target, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('settings.json unreadable, falling back to defaults:', err);
    }
  }
  const sanitized = sanitizeSettings(raw);
  cache = sanitized;
  // Missing file (first run) or a payload sanitization changed (malformed
  // JSON, older/newer known-field shapes) — persist the sanitized result so
  // the file on disk always reflects what this build will actually read back.
  if (raw === null || JSON.stringify(raw) !== JSON.stringify(sanitized)) {
    await atomicWriteFile(target, JSON.stringify(sanitized, null, 2) + '\n');
  }
  return sanitized;
}

/** Merge `partial` into the persisted settings (one level deep for `export`), persist, return the full result. */
export async function updateSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = await readSettings();
  const merged: Record<string, unknown> = { ...current, ...partial };
  if (partial && typeof partial === 'object' && 'export' in partial && partial.export) {
    merged.export = { ...current.export, ...partial.export };
  }
  const sanitized = sanitizeSettings(merged);
  cache = sanitized;
  await atomicWriteFile(settingsPath(), JSON.stringify(sanitized, null, 2) + '\n');
  return sanitized;
}

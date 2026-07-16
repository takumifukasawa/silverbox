/**
 * Unit tier (vitest) for projectDoc.ts (project-storage migration, stage 1):
 * parse/sanitize/serialize round trip, unknown-field preservation, look-name
 * collision suffixing, and the resolve/relativize path helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveLookName,
  parseProjectManifest,
  relativizeProjectPath,
  resolveProjectPath,
  serializeProjectManifest,
  type ProjectManifest,
} from './projectDoc';

describe('parseProjectManifest / serializeProjectManifest round trip', () => {
  it('round-trips a manifest with photos', () => {
    const manifest: ProjectManifest = {
      schemaVersion: 1,
      name: 'MyProject',
      photos: [
        { path: '../photos/DSC001.ARW', look: 'DSC001.ARW.json' },
        { path: '/out/of/tree/DSC900.ARW', look: 'DSC900.ARW.json' },
      ],
    };
    const text = serializeProjectManifest(manifest);
    expect(parseProjectManifest(text)).toEqual(manifest);
  });

  it('round-trips an empty playlist', () => {
    const manifest: ProjectManifest = { schemaVersion: 1, name: 'Quick', photos: [] };
    expect(parseProjectManifest(serializeProjectManifest(manifest))).toEqual(manifest);
  });

  it('preserves unknown wrapper-level fields verbatim (DESIGN §9)', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      name: 'MyProject',
      photos: [],
      futureField: { some: 'thing' },
    });
    const parsed = parseProjectManifest(text);
    expect(parsed.unknown).toEqual({ futureField: { some: 'thing' } });
    // A rewrite carries the unknown field forward unchanged.
    const rewritten = serializeProjectManifest(parsed);
    expect(parseProjectManifest(rewritten).unknown).toEqual({ futureField: { some: 'thing' } });
  });

  it('throws on structural garbage', () => {
    expect(() => parseProjectManifest('null')).toThrow();
    expect(() => parseProjectManifest('{}')).toThrow(/schemaVersion/);
    expect(() => parseProjectManifest(JSON.stringify({ schemaVersion: 1, photos: [] }))).toThrow(/name/);
    expect(() => parseProjectManifest(JSON.stringify({ schemaVersion: 1, name: 'X' }))).toThrow(/photos/);
    expect(() =>
      parseProjectManifest(JSON.stringify({ schemaVersion: 1, name: 'X', photos: [{ path: 'a.ARW' }] }))
    ).toThrow(/look/);
    expect(() => parseProjectManifest(JSON.stringify({ schemaVersion: 2, name: 'X', photos: [] }))).toThrow(
      /schemaVersion/
    );
  });
});

describe('deriveLookName', () => {
  it('derives basename + .json when nothing collides', () => {
    expect(deriveLookName('/photos/DSC001.ARW', new Map())).toBe('DSC001.ARW.json');
  });

  it('reuses the same name for the SAME photo already in the map (not a collision)', () => {
    const existing = new Map([['/photos/DSC001.ARW', 'DSC001.ARW.json']]);
    // Same abs path as a key — not "a different photo" — so the plain name still comes back.
    expect(deriveLookName('/photos/DSC001.ARW', existing)).toBe('DSC001.ARW.json');
  });

  it('suffixes -2, -3… when a DIFFERENT photo already holds that name', () => {
    const existing = new Map([['/photos/a/DSC001.ARW', 'DSC001.ARW.json']]);
    expect(deriveLookName('/photos/b/DSC001.ARW', existing)).toBe('DSC001.ARW-2.json');
    existing.set('/photos/b/DSC001.ARW', 'DSC001.ARW-2.json');
    expect(deriveLookName('/photos/c/DSC001.ARW', existing)).toBe('DSC001.ARW-3.json');
  });
});

describe('resolveProjectPath / relativizeProjectPath', () => {
  const projectDir = '/Users/x/Silverbox/Quick';

  it('resolves a relative path against the project dir', () => {
    expect(resolveProjectPath(projectDir, '../photos/DSC001.ARW')).toBe('/Users/x/Silverbox/photos/DSC001.ARW');
    expect(resolveProjectPath(projectDir, 'looks/DSC001.ARW.json')).toBe(
      '/Users/x/Silverbox/Quick/looks/DSC001.ARW.json'
    );
  });

  it('passes an absolute (out-of-tree) path through unchanged', () => {
    expect(resolveProjectPath(projectDir, '/elsewhere/DSC900.ARW')).toBe('/elsewhere/DSC900.ARW');
  });

  it('relativizes an absolute path under a common ancestor', () => {
    expect(relativizeProjectPath(projectDir, '/Users/x/Silverbox/photos/DSC001.ARW')).toBe('../photos/DSC001.ARW');
    expect(relativizeProjectPath(projectDir, '/Users/x/Silverbox/Quick/other/DSC.ARW')).toBe('other/DSC.ARW');
  });

  it('resolve/relativize round-trip', () => {
    const abs = '/Users/x/Silverbox/photos/DSC001.ARW';
    const rel = relativizeProjectPath(projectDir, abs);
    expect(resolveProjectPath(projectDir, rel)).toBe(abs);
  });
});

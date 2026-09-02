/**
 * Unit tests for scripts/lib/toneExperimentsR2.mjs — see that file's header
 * comment for why there are two different clip strategies, and this file's
 * "collapse" test below for the worked numbers behind that design decision.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stopsPairClipIndependent, stopsPairClipScaled, writeLinearDngOnce } from './toneExperimentsR2.mjs';

describe('stopsPairClipScaled', () => {
  it('places dark/light symmetrically around meanFrac with no clip when both fit', () => {
    const { dark, light, realizedMean, clipAdjusted } = stopsPairClipScaled(2, 0.18);
    const ratio = 2 ** 2;
    expect(dark).toBeCloseTo(0.18 / Math.sqrt(ratio), 10);
    expect(light).toBeCloseTo(0.18 * Math.sqrt(ratio), 10);
    expect(realizedMean).toBeCloseTo(0.18, 10);
    expect(clipAdjusted).toBe(false);
  });

  it('scales both sides down together when light would exceed hi, preserving the exact stop ratio', () => {
    const stops = 4.5;
    const meanFrac = 0.2;
    const { dark, light, clipAdjusted } = stopsPairClipScaled(stops, meanFrac);
    expect(clipAdjusted).toBe(true);
    expect(light).toBeCloseTo(0.95, 10);
    // ratio must still be exactly 2^stops even though both sides shrank
    expect(light / dark).toBeCloseTo(2 ** stops, 6);
    // the realized mean has shifted darker than the nominal 0.2
    expect(Math.sqrt(dark * light)).toBeLessThan(meanFrac);
  });
});

describe('stopsPairClipIndependent', () => {
  it('matches stopsPairClipScaled when nothing clips', () => {
    const a = stopsPairClipIndependent(2, 0.18);
    const b = stopsPairClipScaled(2, 0.18);
    expect(a.dark).toBeCloseTo(b.dark, 10);
    expect(a.light).toBeCloseTo(b.light, 10);
    expect(a.clipAdjusted).toBe(false);
    expect(a.realizedStops).toBeCloseTo(2, 10);
  });

  it('clamps only the offending side, leaving the other exact — the whole reason this strategy exists', () => {
    // 8-stop spread centered on 50%: light = 0.5 * 16 = 8.0, way over 0.95;
    // dark = 0.5 / 16 = 0.03125, comfortably inside [0.002, 0.95].
    const { dark, light, clipAdjusted, realizedStops } = stopsPairClipIndependent(8, 0.5);
    expect(dark).toBeCloseTo(0.03125, 10); // untouched — NOT dragged down with light
    expect(light).toBeCloseTo(0.95, 10); // clamped to the ceiling
    expect(clipAdjusted).toBe(true);
    expect(realizedStops).toBeLessThan(8); // spread shrank because only one side moved
  });

  it('demonstrates why stopsPairClipScaled would collapse the mean6/mean50 probes to the same corners, and independent clamping keeps them apart', () => {
    const mean6 = stopsPairClipScaled(8, 0.06);
    const mean50 = stopsPairClipScaled(8, 0.5);
    // both hit the light ceiling, and the ratio-preserving rescue forces the
    // SAME dark value regardless of the original mean once light==hi (since
    // dark = hi / 2^stops for both) — this is the degenerate case the E6
    // corner sweep must avoid.
    expect(mean6.dark).toBeCloseTo(mean50.dark, 6);
    expect(mean6.light).toBeCloseTo(mean50.light, 10);

    const indep6 = stopsPairClipIndependent(8, 0.06);
    const indep50 = stopsPairClipIndependent(8, 0.5);
    // independent clamping keeps the two probes clearly distinguishable
    expect(indep6.dark).not.toBeCloseTo(indep50.dark, 2);
  });

  it('clamps the low side up into range when it would fall below lo', () => {
    const { dark, clipAdjusted } = stopsPairClipIndependent(12, 0.0005, { lo: 0.002, hi: 0.95 });
    expect(dark).toBeCloseTo(0.002, 10);
    expect(clipAdjusted).toBe(true);
  });
});

describe('writeLinearDngOnce', () => {
  it('writes a fresh file successfully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'silverbox-lineardng-once-'));
    try {
      const target = join(dir, 'a.dng');
      const result = writeLinearDngOnce(target, { width: 4, height: 4, generator: () => 0.18 });
      expect(existsSync(target)).toBe(true);
      expect(result.width).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws and does not touch the file when the target already exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'silverbox-lineardng-once-'));
    try {
      const target = join(dir, 'a.dng');
      writeLinearDngOnce(target, { width: 4, height: 4, generator: () => 0.18 });
      const sizeBefore = existsSync(target);
      expect(() => writeLinearDngOnce(target, { width: 8, height: 8, generator: () => 0.5 })).toThrow(/refusing to overwrite/);
      expect(existsSync(target)).toBe(sizeBefore); // still there, untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

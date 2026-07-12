/**
 * Unit tier (vitest) for OpenSession's own mechanics (OpenSession extraction
 * — architecture-audit risk #1): epoch claim/supersession, guard()'s
 * staleness throw, and the disposer ledger's run-on-supersede behavior.
 * appStore.openImageByPath's own end-to-end race behavior (rapid filmstrip
 * bursts, preview revocation) stays covered by verify-filmstrip.mjs /
 * verify-preview.mjs — this file is scoped to OpenSession in isolation,
 * which is exactly why it was pulled into its own dependency-free module.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OpenSession, StaleOpenError } from './openSession';

/** A promise plus its resolve/reject, so tests can control settle order explicitly. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('OpenSession', () => {
  beforeEach(() => {
    OpenSession.resetForTests();
  });

  it('claims a monotonically increasing epoch per instance', () => {
    const a = new OpenSession('/a.arw');
    const b = new OpenSession('/b.arw');
    const c = new OpenSession('/c.arw');
    expect(a.epoch).toBeLessThan(b.epoch);
    expect(b.epoch).toBeLessThan(c.epoch);
  });

  it('stores the path/opts it was constructed with', () => {
    const session = new OpenSession('/photo.arw', { keepFolderContext: true });
    expect(session.path).toBe('/photo.arw');
    expect(session.opts).toEqual({ keepFolderContext: true });
  });

  it('a session is not stale until a newer one is constructed', () => {
    const a = new OpenSession('/a.arw');
    expect(a.stale()).toBe(false);
    const b = new OpenSession('/b.arw');
    expect(a.stale()).toBe(true);
    expect(b.stale()).toBe(false);
  });

  it('the newest session stays fresh across several supersessions', () => {
    new OpenSession('/a.arw');
    new OpenSession('/b.arw');
    const c = new OpenSession('/c.arw');
    expect(c.stale()).toBe(false);
  });

  describe('guard()', () => {
    it('resolves with the value when the session is still current', async () => {
      const session = new OpenSession('/a.arw');
      await expect(session.guard(Promise.resolve(42))).resolves.toBe(42);
    });

    it('throws StaleOpenError once a newer session claims the epoch before the promise settles', async () => {
      const session = new OpenSession('/a.arw');
      const d = deferred<number>();
      const guarded = session.guard(d.promise);
      new OpenSession('/b.arw'); // supersede while `guarded` is still pending
      d.resolve(42);
      await expect(guarded).rejects.toBeInstanceOf(StaleOpenError);
    });

    it('propagates the ORIGINAL rejection (not StaleOpenError) when the promise itself rejects, even if stale', async () => {
      const session = new OpenSession('/a.arw');
      const d = deferred<number>();
      const guarded = session.guard(d.promise);
      new OpenSession('/b.arw'); // supersede while `guarded` is still pending
      const boom = new Error('read failed');
      d.reject(boom);
      await expect(guarded).rejects.toBe(boom);
    });

    it('does not throw for a session that is still current when the promise settles', async () => {
      const session = new OpenSession('/a.arw');
      const d = deferred<string>();
      const guarded = session.guard(d.promise);
      d.resolve('ok');
      await expect(guarded).resolves.toBe('ok');
    });
  });

  describe('own() / disposer ledger', () => {
    it('does not run a disposer while its session is still current', () => {
      const session = new OpenSession('/a.arw');
      let ran = false;
      session.own(() => {
        ran = true;
      });
      expect(ran).toBe(false);
    });

    it('runs a superseded session\'s disposers when the next session is constructed', () => {
      const session = new OpenSession('/a.arw');
      let ran = false;
      session.own(() => {
        ran = true;
      });
      expect(ran).toBe(false);
      new OpenSession('/b.arw');
      expect(ran).toBe(true);
    });

    it('runs multiple disposers in registration order, exactly once', () => {
      const session = new OpenSession('/a.arw');
      const order: number[] = [];
      session.own(() => order.push(1));
      session.own(() => order.push(2));
      session.own(() => order.push(3));
      new OpenSession('/b.arw');
      expect(order).toEqual([1, 2, 3]);
      // a THIRD session must not re-run the first session's already-run disposers
      new OpenSession('/c.arw');
      expect(order).toEqual([1, 2, 3]);
    });

    it('runs a disposer immediately if registered AFTER this session already went stale', () => {
      const session = new OpenSession('/a.arw');
      new OpenSession('/b.arw'); // session is now stale
      let ran = false;
      session.own(() => {
        ran = true;
      });
      expect(ran).toBe(true); // no leak: never queued, run right away
    });

    it('a disposer only fires on supersession, never on a resolved guard() alone', async () => {
      const session = new OpenSession('/a.arw');
      let ran = false;
      session.own(() => {
        ran = true;
      });
      await session.guard(Promise.resolve(1));
      expect(ran).toBe(false);
    });
  });
});

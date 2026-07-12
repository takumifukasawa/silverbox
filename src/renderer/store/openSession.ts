/**
 * Newest-open-wins epoch guard + cleanup ledger for AppState.openImageByPath
 * (architecture-audit risk #1: "openImageByPath is a god-function under
 * async pressure"). openImageByPath awaits three times (readFile, loadImage,
 * readSidecar); a rapid filmstrip arrow-key burst can resolve those awaits
 * out of call order, so whichever RAW decode happens to finish LAST used to
 * win the UI regardless of which one was actually requested last.
 *
 * One `OpenSession` per call. Constructing a new one:
 *  1. claims the next epoch — an older session's `stale()` starts returning
 *     true from this instant on, and any `guard()` it's mid-`await` on will
 *     throw `StaleOpenError` the moment its awaited promise settles;
 *  2. runs the PREVIOUS session's disposer ledger (whatever it registered
 *     via `own()`), in registration order — so a superseded session's blob
 *     URLs / transient state are torn down structurally instead of via a
 *     scattered `if (stale()) cleanup()` at every call site that could
 *     forget one.
 *
 * Pure/dependency-free on purpose (no zustand import, no appStore types) so
 * its mechanics are unit-testable in isolation; appStore wires in the
 * store-specific disposers (blob URL revocation, etc.) as closures passed to
 * `own()`.
 */
export class StaleOpenError extends Error {
  constructor() {
    super('open superseded by a newer openImageByPath call');
    this.name = 'StaleOpenError';
  }
}

export class OpenSession<Opts = unknown> {
  private static epochCounter = 0;
  private static current: OpenSession<unknown> | null = null;

  readonly epoch: number;
  readonly path: string;
  readonly opts: Opts | undefined;
  private disposers: Array<() => void> = [];

  constructor(path: string, opts?: Opts) {
    this.path = path;
    this.opts = opts;
    const previous = OpenSession.current;
    this.epoch = ++OpenSession.epochCounter;
    OpenSession.current = this as OpenSession<unknown>;
    // `previous` is stale from this line on (OpenSession.current !== previous) —
    // tear down whatever it registered, in registration order.
    previous?.runDisposers();
  }

  /** True once a NEWER OpenSession has been constructed. */
  stale(): boolean {
    return OpenSession.current !== (this as OpenSession<unknown>);
  }

  /**
   * Register a teardown to run when a newer session claims the epoch. If
   * THIS session is already stale by the time it's registered, runs `dispose`
   * immediately instead of queuing it — a resource created after supersession
   * slipped in must never leak just because it missed the ledger sweep.
   */
  own(dispose: () => void): void {
    if (this.stale()) {
      dispose();
      return;
    }
    this.disposers.push(dispose);
  }

  /**
   * Await `p`; once it settles, throw `StaleOpenError` if a newer session has
   * since claimed the epoch. Callers with no error-handling layer of their
   * own between them and openImageByPath's single try/catch can just
   * `await session.guard(promise)` — the newest-open-wins bail-out falls out
   * of that one catch. Callers with an inner try/catch (e.g. sidecar
   * parsing, which recovers from a genuine read error in place) must
   * re-throw a caught StaleOpenError instead of swallowing it — see
   * openImageByPath's sidecar step.
   */
  async guard<T>(p: Promise<T>): Promise<T> {
    const value = await p;
    if (this.stale()) throw new StaleOpenError();
    return value;
  }

  private runDisposers(): void {
    const toRun = this.disposers.splice(0);
    for (const dispose of toRun) dispose();
  }

  /** Test-only: reset the module-scope epoch counter/current pointer between unit tests. */
  static resetForTests(): void {
    OpenSession.current = null;
    OpenSession.epochCounter = 0;
  }
}

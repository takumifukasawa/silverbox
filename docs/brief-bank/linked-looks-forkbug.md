# Debug+fix: publish overwrites a forked (個別調整) follower

Status: DISPATCHED 2026-07-21. USER-REPORTED bug (hand-test), core
linked-looks correctness. REPRO-FIRST: build the exact scenario as a
deterministic verify check BEFORE theorizing — the static read of the
fan-out filter looks correct, so the bug is subtle (persistence / flush
/ re-materialize timing), and only a repro will pin it.

## The user's exact repro (from hand-testing)

1. A shared look exists; link photos 1 AND 2 to it (both follow
   basic-tone — they were unedited at link time).
2. Open photo 1, adjust CONTRAST (a basic.contrast edit) → this should
   FORK basic-tone on photo 1 (个别调整; basic-tone leaves photo1.follows,
   photo1 keeps its own contrast).
3. Switch to photo 2, adjust its contrast → forks basic-tone on photo 2.
4. Publish from photo 2 (この写真の調整を共通ルックに反映), basic-tone
   checked.
EXPECTED (spec §4.2/§4.4): photo 1's contrast is UNCHANGED — a forked
family is not in follows, so publish's fan-out
(follows ∩ published) skips it. OBSERVED (user): photo 1's contrast
became the LOOK's value — the fork was lost.

## What the static read already establishes (don't re-verify, extend)

- publishToSharedLook's other-follower branch reads each follower's
  look file FROM DISK, computes `intersect = node.link.follows.filter(
  f => developFamilies.includes(f))`, and rewrites values ONLY for the
  intersection (empty ⇒ node.develop unchanged). This is CORRECT *if*
  photo 1's on-disk `link.follows` no longer contains basic-tone.
- So the bug is almost certainly UPSTREAM of the fan-out: photo 1's
  fork (link.follows shrinking) is not on disk at publish time.

## Prime suspects — check IN THIS ORDER, with the repro proving each

1. **Does adjusting contrast actually fork?** familyForDevelopKey maps
   `basic.contrast` → 'basic-tone' (presetFamilies.ts:114). Confirm the
   contrast slider's edit path (updateNodeParam / updateNodeParamsBatch)
   passes a `basic.*` key so forkLinkedFamilies fires and removes
   basic-tone from link.follows IN MEMORY. If a slider-drag/coalesce
   path applies the value WITHOUT the key that forks, that's the bug.
2. **Is the fork PERSISTED?** After the fork, is link.follows's new
   (shrunk) value serialized (serializeGraphDoc) and written to photo
   1's look file when the user switches away (flush-on-switch) or via
   autosave? Confirm sanitizeDevelopLink/serialize round-trip the
   shrunk follows (not the original). A flush-on-switch that saves the
   develop VALUES but an older link snapshot would reintroduce
   basic-tone into follows.
3. **Does re-materialization RE-ADD basic-tone to follows or clobber
   the value?** Drift-at-open / hot-reload / the publish fan-out's own
   materializedFrom bump — check none of them rewrites photo 1's
   follows back to include basic-tone, or re-materializes photo 1's
   basic-tone values, between the fork and the publish. value-drift-
   implies-fork (stage D) should PROTECT, not clobber — verify it isn't
   inverted for this path.
4. **Autosave-vs-publish ordering.** Publish flushes the OPEN photo
   (saveGraph) but reads OTHER followers from disk. If photo 1's fork
   was still in the autosave debounce (never flushed on switch),
   disk has the pre-fork follows. Check the flush-on-switch actually
   fired for photo 1's fork edit.

## Fix

Whatever the repro shows — fix at the root (fork must persist; or the
flush must capture the link change; or the re-materialize must not
touch a forked family). Do NOT patch the fan-out to special-case this
(the filter is already correct). Add the repro scenario as a PERMANENT
check in verify-linkedlooks.mjs (or a new verify-linkedlooks-forkbug):
link 2 photos → fork basic-tone on #1 (via the real contrast edit +
switch/flush path, NOT a direct store poke that bypasses the bug) →
fork + publish from #2 → assert #1's on-disk basic-tone equals #1's own
forked value, NOT the look's.

## Read before writing

publishToSharedLook + its fan-out (appStore.ts), forkLinkedFamilies +
its call sites (updateNodeParam/updateNodeParamsBatch), familyForDevelop
Key (presetFamilies.ts:114), sanitizeDevelopLink + serializeGraphDoc
(link round-trip), the flush-on-switch discipline (writeGraphSaveSnapshot
/ flushPendingAutosave), the drift/value-drift-fork path (stage D). The
contrast slider's actual update key.

## Standing rules

Gate loop foreground (typecheck, test:unit, verify; SUITE line). NEVER
git add/commit. zsh `=` hazard. Engine invariants. libraryDir seed if
the script mints its own userData. English code.

## Report back

The ROOT CAUSE (which suspect, with file:line evidence); the fix and
where it lives; the new repro check and that it FAILS before the fix /
PASSES after; whether the repro reproduced at all in-harness (if not,
that itself localizes it to a real-app timing path — report that);
deviations; SUITE line + unit count.

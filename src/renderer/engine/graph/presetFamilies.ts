/**
 * Preset scoping (docs/brief-bank/preset-scoping-and-export-overrides.md §1):
 * the shared "which param FAMILIES does this action touch" vocabulary and
 * its pure filter/merge helpers. Two callers share this module by design:
 *
 *  - PresetsMenu.tsx's Save flow (appStore.ts's savePreset) uses it at
 *    SAVE time to write ONLY the checked families' data into a preset file
 *    — the file contains exactly what it claims (`includes`), nothing more,
 *    so it stays diffable and honest and apply-time never has to guess.
 *  - appStore.ts's applyPreset uses it at APPLY time, in the other
 *    direction: pull only the checked families FROM the preset's look ONTO
 *    the currently open graph, leaving every other family exactly as it
 *    was already open (never reset to some default).
 *  - docs/brief-bank/multi-select-sync.md's "Sync…" feature (not yet built)
 *    reuses the SAME family list and the SAME merge direction as apply —
 *    copying checked families from a primary photo onto secondaries is
 *    structurally identical to applying a preset. FamilyScopeDialog.tsx (the
 *    checkbox UI) is the third leg of this shared design; see its own doc
 *    comment for the props contract this module's shape was chosen to serve.
 *
 * Both directions are the SAME pure function (pickDevelopFamilies) with the
 * `src`/`base` arguments swapped — see its doc comment.
 */
import { type GraphDoc, type GraphNode, type GraphNodeKind, DEVELOP_KIND } from './graphDoc';
import { defaultDevelopParams, type DevelopParams } from './developNode';
import { MASK_KIND } from './maskNode';
import { SPOTS_KIND } from './spotsNode';
import { BLEND_KIND } from './ops';

/**
 * Every family this build knows about. Ordered for display (FamilyScopeDialog
 * renders them in this order, "develop" group first, "structural" group
 * after a divider).
 */
export const PRESET_FAMILIES = [
  { id: 'basic-tone', label: 'Basic tone', defaultChecked: true, group: 'develop' },
  { id: 'wb', label: 'White balance', defaultChecked: true, group: 'develop' },
  { id: 'curves', label: 'Tone curve', defaultChecked: true, group: 'develop' },
  { id: 'hsl', label: 'HSL', defaultChecked: true, group: 'develop' },
  { id: 'bw', label: 'Black & White', defaultChecked: true, group: 'develop' },
  { id: 'grading', label: 'Color grading', defaultChecked: true, group: 'develop' },
  { id: 'effects', label: 'Effects', defaultChecked: true, group: 'develop' },
  { id: 'detail', label: 'Detail', defaultChecked: true, group: 'develop' },
  { id: 'geometry', label: 'Geometry (crop / straighten)', defaultChecked: false, group: 'structural' },
  { id: 'spots', label: 'Spot removal', defaultChecked: false, group: 'structural' },
  { id: 'masks', label: 'Masks', defaultChecked: false, group: 'structural' },
  { id: 'custom-nodes', label: 'Custom / external / image / blend nodes', defaultChecked: false, group: 'structural' },
] as const;

export type PresetFamilyId = (typeof PRESET_FAMILIES)[number]['id'];
export interface PresetFamilyDef {
  id: PresetFamilyId;
  label: string;
  defaultChecked: boolean;
  /** 'develop' families live inside a Develop node's params; 'structural' ones are whole graph nodes/geometry — the "rarely what you want" divider group (LR precedent per the sync brief). */
  group: 'develop' | 'structural';
}
// Re-assert the const array satisfies the widened interface (documentation, not a runtime check).
export const PRESET_FAMILY_DEFS: readonly PresetFamilyDef[] = PRESET_FAMILIES;

export const ALL_FAMILY_IDS: readonly PresetFamilyId[] = PRESET_FAMILIES.map((f) => f.id);
export const DEFAULT_CHECKED_FAMILY_IDS: readonly PresetFamilyId[] = PRESET_FAMILIES.filter((f) => f.defaultChecked).map(
  (f) => f.id
);

const KNOWN_FAMILY_IDS = new Set<string>(ALL_FAMILY_IDS);

/**
 * True for any id this build actually understands. A preset's (or a synced
 * look's) `includes` array may carry ids a NEWER build wrote and this one
 * doesn't recognize yet — those are preserved verbatim across a rewrite
 * (see presetDoc.ts's ParsedPreset.includes doc comment) but must be
 * filtered out with this guard before doing anything semantic with them.
 */
export function isKnownFamilyId(id: string): id is PresetFamilyId {
  return KNOWN_FAMILY_IDS.has(id);
}

const DEVELOP_FAMILY_IDS = new Set<PresetFamilyId>(
  PRESET_FAMILIES.filter((f) => f.group === 'develop').map((f) => f.id)
);

/** True for the families whose data lives inside a Develop node's `develop` params, as opposed to whole graph nodes/geometry. */
export function isDevelopFamily(id: PresetFamilyId): boolean {
  return DEVELOP_FAMILY_IDS.has(id);
}

// --- develop-param family picking --------------------------------------------

/**
 * The one function both directions of family scoping share:
 *
 *  - SAVE time (buildScopedLook below): `src` = the CURRENT open graph's
 *    develop params, `base` = defaultDevelopParams() (identity) — unchecked
 *    families come out at identity, so the written preset really does
 *    contain nothing else.
 *  - APPLY time (mergeScopedLook below): `src` = the preset's own look,
 *    `base` = the CURRENT open graph's develop params — unchecked families
 *    come out UNCHANGED from whatever's already open, never reset.
 *
 * `basic-tone` and `wb` both read from DevelopBasicParams (the schema
 * doesn't separate them into two structs) but write disjoint keys, so
 * checking one without the other is exactly "everything in `basic` except
 * temp/tint" vs. "only temp/tint" — no key is ever touched by both.
 */
export function pickDevelopFamilies(
  src: DevelopParams,
  base: DevelopParams,
  families: ReadonlySet<PresetFamilyId>
): DevelopParams {
  const out: DevelopParams = structuredClone(base);
  if (families.has('basic-tone')) {
    out.profile = structuredClone(src.profile);
    out.basic = {
      ...out.basic,
      ev: src.basic.ev,
      contrast: src.basic.contrast,
      highlights: src.basic.highlights,
      shadows: src.basic.shadows,
      whites: src.basic.whites,
      blacks: src.basic.blacks,
      saturation: src.basic.saturation,
      vibrance: src.basic.vibrance,
    };
  }
  if (families.has('wb')) {
    out.basic = { ...out.basic, temp: src.basic.temp, tint: src.basic.tint };
  }
  if (families.has('curves')) out.toneCurve = structuredClone(src.toneCurve);
  if (families.has('hsl')) out.hsl = structuredClone(src.hsl);
  if (families.has('bw')) out.bw = structuredClone(src.bw);
  if (families.has('grading')) out.grading = structuredClone(src.grading);
  if (families.has('effects')) out.effects = structuredClone(src.effects);
  if (families.has('detail')) out.detail = structuredClone(src.detail);
  return out;
}

// --- structural (whole-node) family membership -------------------------------

/**
 * Which structural family (if any) governs a node kind. `input`/`output`/
 * Develop nodes are never dropped by structural scoping — Develop's OWN
 * data is scoped by pickDevelopFamilies above, not by removing the node.
 * A second Develop node (rare) is likewise never dropped; per-section
 * picking already reduces an unwanted one to a bit-exact identity node,
 * which is indistinguishable from "not there" at render time.
 */
function structuralFamilyOf(kind: GraphNodeKind): Extract<PresetFamilyId, 'masks' | 'spots' | 'custom-nodes'> | null {
  if (kind === 'input' || kind === 'output' || kind === DEVELOP_KIND) return null;
  if (kind === MASK_KIND) return 'masks';
  if (kind === SPOTS_KIND) return 'spots';
  // Everything else — custom shader, external, denoise, image, blend, and
  // any standalone op-kind node (exposure/whitebalance/contrast/…) dropped
  // into the node editor by hand — is "structure beyond the default chain".
  return 'custom-nodes';
}

/**
 * Save-time structural stripping: delete every node whose family isn't
 * checked, splicing single-input chain nodes out of the DAG so the
 * remaining graph is still valid (buildPlan-resolvable), rather than merely
 * disabling them — a disabled node's params would still be sitting in the
 * file, which breaks "the file contains only what it claims".
 *
 * Splice rule per dropped node:
 *  - A 1-in/1-out chain node (mask, spots, custom, external, denoise, a
 *    standalone op) is spliced out: its outgoing edge(s) are rewired to
 *    its own incoming edge's source, then its own edges are dropped.
 *  - A blend (2-in/1-out) has no canonical single "identity" input, so the
 *    node's 'a'-port source becomes the survivor (documented simplification
 *    — see this module's doc comment; the 'b'/'mask' branches are dropped,
 *    along with anything that fed ONLY them, since a node that has nothing
 *    left downstream of it is unreachable and gets swept up in the SAME
 *    dropIds pass if its own kind is also excluded, which is guaranteed
 *    here because dropCustom is a single all-or-nothing bit).
 *  - A zero-input source (image) has no survivor at all: its outgoing
 *    edge is simply dropped (as invariably paired with the blend it fed,
 *    per the point above).
 *
 * KNOWN LIMITATION (documented, not covered by the shipped verify suite): a
 * graph where excluding custom-nodes would strand an otherwise-kept node
 * (e.g. a second Develop node fed ONLY by an image composite, with no
 * plain-chain path from input) can produce a doc that fails buildPlan's own
 * validation. This is an advanced/rare graph shape; the common case —
 * default chain, optionally decorated with masks/spots/a handful of chain
 * ops — always splices to a valid result.
 */
export function stripStructuralFamilies(graph: GraphDoc, families: ReadonlySet<PresetFamilyId>): GraphDoc {
  const shouldDrop = (kind: GraphNodeKind): boolean => {
    const fam = structuralFamilyOf(kind);
    return fam !== null && !families.has(fam);
  };
  const dropIds = new Set(graph.nodes.filter((n) => shouldDrop(n.kind)).map((n) => n.id));
  if (dropIds.size === 0) return graph;

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let edges = graph.edges.map((e) => ({ ...e }));
  for (const id of dropIds) {
    const node = byId.get(id)!;
    const incoming = edges.filter((e) => e.target === id);
    let survivor: string | undefined;
    if (node.kind === BLEND_KIND) {
      survivor = incoming.find((e) => e.targetHandle === 'a')?.source;
    } else if (incoming.length === 1) {
      survivor = incoming[0]!.source;
    }
    edges = edges
      .map((e) =>
        // A 'mask'-port edge is NEVER bridged, regardless of the dropped
        // node's own kind: per buildPlan's own bypass semantics (see
        // GraphNode.disabled's doc comment in graphDoc.ts), an absent mask
        // edge means "no mask" — reconnecting it to the dropped node's own
        // upstream would instead multiply by whatever arbitrary pixel that
        // upstream happens to hold, which is a different (wrong) result.
        e.source === id && survivor !== undefined && e.targetHandle !== 'mask' ? { ...e, source: survivor } : e
      )
      .filter((e) => e.source !== id && e.target !== id);
  }
  const nodes = graph.nodes.filter((n) => !dropIds.has(n.id));
  return { ...graph, nodes, edges };
}

/**
 * Save-time transform: captureLook's geometry-stripping contract (input
 * node's crop/straighten/orientation stay per-photo) PLUS family scoping.
 * `graph` should already be the geometry-stripped candidate (appStore.ts's
 * captureLook) unless the `geometry` family is checked, in which case the
 * caller passes the UN-stripped graph instead — see appStore.ts's
 * savePreset for exactly which one it hands in.
 *
 * `scope` (virtual-copy.md's multi-output preset-scoping fix): when given,
 * every node id OUTSIDE it is dropped before anything else runs — a preset
 * saved from a 2+-output doc captures ONLY the active output's own chain
 * (appStore.ts computes `scope` via `reachableToOutput`, the ACTIVE-output
 * resolution this module deliberately stays ignorant of — see this file's
 * own top doc comment). Omitted/`null` (every existing caller before this
 * fix, and any single-output doc) leaves `graph` untouched, bit-identical to
 * today's behavior.
 */
export function buildScopedLook(
  graph: GraphDoc,
  families: ReadonlySet<PresetFamilyId>,
  scope?: ReadonlySet<string> | null
): GraphDoc {
  const scoped = scope
    ? {
        ...graph,
        nodes: graph.nodes.filter((n) => scope.has(n.id)),
        edges: graph.edges.filter((e) => scope.has(e.source) && scope.has(e.target)),
      }
    : graph;
  const nodes: GraphNode[] = scoped.nodes.map((n) => {
    if (n.kind === DEVELOP_KIND && n.develop) {
      return { ...n, develop: pickDevelopFamilies(n.develop, defaultDevelopParams(), families) };
    }
    return { ...n };
  });
  return stripStructuralFamilies({ ...scoped, nodes }, families);
}

// --- apply-time merge ---------------------------------------------------------

/**
 * Best-effort structural graft for APPLY time: for the given structural
 * family, any node in `look` of that family whose id already exists in
 * `graph` has its payload refreshed in place; any node whose id is new gets
 * appended, along with whichever of `look`'s own edges connect exclusively
 * within the now-resolvable id set. This is intentionally NOT a general
 * graph-merge — it handles the common case (both docs descend from the same
 * seeded chain, ids line up) correctly; a structural mismatch (target has no
 * matching blend/mask slot) simply grafts nothing extra for that node,
 * which is the same "skip, don't corrupt" spirit multi-select-sync's own
 * "skipped for structurally incompatible target" note calls for — sync's
 * own reporting UI can build on this later without changing this function.
 *
 * A brand-new grafted node that spliced INLINE in `look` (single incoming
 * edge A→N, one or more outgoing edges N→B) supersedes whatever direct A→B
 * edge (same port) `graph` still has from before that node existed — that
 * stale direct edge is dropped, or `graph` would end up with two edges
 * feeding B (buildPlan's "needs exactly one input" rejects that). This is
 * the exact mirror, run in reverse, of stripStructuralFamilies' own splice.
 *
 * `scope` (virtual-copy.md's multi-output preset-scoping fix): when given,
 * an EXISTING node is only eligible to be replaced in place, or to anchor a
 * newly-grafted node's edge, when its id is in scope — an out-of-scope
 * node's id happening to collide with one of `look`'s own family-node ids
 * (the "wrong copy by id" hazard the brief documents) must never graft onto
 * it. A brand-new grafted node's own (never-colliding) id is always eligible
 * regardless of scope.
 */
function graftStructuralFamily(
  graph: GraphDoc,
  look: GraphDoc,
  family: Extract<PresetFamilyId, 'masks' | 'spots' | 'custom-nodes'>,
  scope?: ReadonlySet<string> | null
): GraphDoc {
  const inScope = (id: string) => !scope || scope.has(id);
  const srcNodes = look.nodes.filter((n) => structuralFamilyOf(n.kind) === family);
  if (srcNodes.length === 0) return graph;
  const currentIds = new Set(graph.nodes.map((n) => n.id));
  const srcById = new Map(srcNodes.map((n) => [n.id, n]));
  const nodes = graph.nodes.map((n) => {
    const replacement = structuralFamilyOf(n.kind) === family && inScope(n.id) ? srcById.get(n.id) : undefined;
    return replacement ? structuredClone(replacement) : n;
  });
  const newNodeIds = new Set(srcNodes.filter((n) => !currentIds.has(n.id)).map((n) => n.id));
  const grafted = srcNodes.filter((n) => newNodeIds.has(n.id)).map((n) => structuredClone(n));
  const allIds = new Set([
    ...graph.nodes.filter((n) => inScope(n.id)).map((n) => n.id),
    ...grafted.map((n) => n.id),
  ]);
  const lookById = new Map(look.nodes.map((n) => [n.id, n]));
  const edgeKey = (e: { source: string; target: string; targetHandle?: string }) => `${e.source}>${e.target}:${e.targetHandle ?? ''}`;

  const relevantLookEdges = look.edges.filter((e) => {
    const sourceKind = lookById.get(e.source)?.kind;
    const targetKind = lookById.get(e.target)?.kind;
    const touchesFamily =
      (sourceKind !== undefined && structuralFamilyOf(sourceKind) === family) ||
      (targetKind !== undefined && structuralFamilyOf(targetKind) === family);
    return touchesFamily && allIds.has(e.source) && allIds.has(e.target);
  });

  // A newly grafted node's edges can never collide by key with anything
  // already in `graph` (its id didn't exist there before), so every
  // relevant edge touching a NEW node is safe to add outright; only dedup
  // against edges between already-MATCHED (same-id) family nodes.
  const existingEdgeKeys = new Set(graph.edges.map(edgeKey));
  const extraEdges = relevantLookEdges.filter((e) => newNodeIds.has(e.source) || newNodeIds.has(e.target) || !existingEdgeKeys.has(edgeKey(e)));

  // Supersede: for each newly grafted node, any CURRENT edge that goes
  // DIRECTLY from one of its (look-side) incoming sources to one of its
  // (look-side) outgoing targets, on the matching port, is the pre-splice
  // edge this node now sits inline on — drop it.
  let currentEdges = graph.edges;
  for (const nodeId of newNodeIds) {
    const incoming = relevantLookEdges.filter((e) => e.target === nodeId);
    const outgoing = relevantLookEdges.filter((e) => e.source === nodeId);
    for (const inE of incoming) {
      for (const outE of outgoing) {
        const supersededKey = edgeKey({ source: inE.source, target: outE.target, targetHandle: outE.targetHandle });
        currentEdges = currentEdges.filter((e) => edgeKey(e) !== supersededKey);
      }
    }
  }

  return { ...graph, nodes: [...nodes, ...grafted], edges: [...currentEdges, ...extraEdges.map((e) => ({ ...e }))] };
}

/**
 * Sync's own skip-detection (docs/brief-bank/multi-select-sync.md: "the
 * target has a structurally compatible default chain; otherwise that family
 * is skipped for that photo and counted in the report notice"). Read-only
 * INSPECTION of the exact same by-id matching rule graftStructuralFamily
 * above already uses — not a second merge implementation: `true` when
 * `source` carries no nodes of this family at all (nothing to graft, so
 * trivially not a skip); `false` when grafting would leave at least one of
 * the family's own nodes with an edge to an anchor (an 'in'/'out'/blend id,
 * whatever the chain calls it) that doesn't exist in `target` — exactly the
 * case where graftStructuralFamily's own `allIds.has(...)` filter would drop
 * that edge, leaving the grafted node orphaned (present in the file, but
 * unreachable from any output). `target`/`source` are compared by NODE ID
 * only, same as the graft itself — two docs that both descend from the same
 * seeded default chain (the common case) line up; a hand-built custom graph
 * with renamed/renumbered ids is the "structurally incompatible" case this
 * exists to catch.
 */
export function structuralFamilyCompatible(
  target: GraphDoc,
  source: GraphDoc,
  family: Extract<PresetFamilyId, 'masks' | 'spots' | 'custom-nodes'>
): boolean {
  const srcNodes = source.nodes.filter((n) => structuralFamilyOf(n.kind) === family);
  if (srcNodes.length === 0) return true;
  const srcIds = new Set(srcNodes.map((n) => n.id));
  const targetIds = new Set(target.nodes.map((n) => n.id));
  const relevantEdges = source.edges.filter((e) => srcIds.has(e.source) || srcIds.has(e.target));
  return relevantEdges.every((e) => {
    const other = srcIds.has(e.source) ? e.target : e.source;
    return srcIds.has(other) || targetIds.has(other);
  });
}

/**
 * Apply-time transform: merge only `families` FROM `look` ONTO `graph`
 * (the currently open document) — everything not checked stays exactly as
 * it already was open, never reset toward `look`'s own values for that
 * section (that asymmetry with buildScopedLook's identity-`base` is the
 * whole point — see pickDevelopFamilies's doc comment).
 *
 * Matches a Develop node in `look` to one in `graph` BY ID (both docs
 * typically descend from the same seeded default chain, so 'dev' lines up
 * on both sides); a `graph` Develop node with no id match in `look` is left
 * untouched rather than guessed at.
 *
 * `scope` (virtual-copy.md's multi-output preset-scoping fix): when given,
 * a Develop/input node in `graph` is only eligible to be updated when its id
 * is in scope — on a 2+-output doc this keeps a scoped apply/paste/sync from
 * silently updating whichever copy's Develop node happens to share an id
 * with `look`'s (the brief's documented "wrong copy by id" hazard) instead
 * of the one actually reachable from the active output; a Develop node
 * outside `scope` is left alone, exactly as if it belonged to a different
 * photo. Threaded into graftStructuralFamily for the same reason. Omitted/
 * `null` (every existing caller before this fix, and any single-output doc,
 * where only one Develop node is ever reachable so scoping changes nothing)
 * leaves this bit-identical to today's behavior.
 */
export function mergeScopedLook(
  graph: GraphDoc,
  look: GraphDoc,
  families: ReadonlySet<PresetFamilyId>,
  scope?: ReadonlySet<string> | null
): GraphDoc {
  const inScope = (id: string) => !scope || scope.has(id);
  // Unambiguous-single-Develop fallback (virtual-copy follow-up): a clone
  // chain's Develop has a fresh id, so a preset captured from any ordinary
  // doc (id 'dev') id-matches nothing there and the apply used to no-op —
  // safe but a dead button. When the scope holds EXACTLY one Develop node
  // and the look holds EXACTLY one, the pairing is unambiguous and the id
  // check adds nothing — match them. Multi-Develop chains (or unscoped
  // calls) keep strict id matching: with 2+ candidates on either side an
  // id-less pairing WOULD be a guess, and "left untouched rather than
  // guessed at" still stands.
  const scopedDevelops = scope ? graph.nodes.filter((n) => n.kind === DEVELOP_KIND && n.develop && scope.has(n.id)) : [];
  const lookDevelops = look.nodes.filter((ln) => ln.kind === DEVELOP_KIND && ln.develop);
  const uniqueFallback = scope && scopedDevelops.length === 1 && lookDevelops.length === 1 ? lookDevelops[0] : null;
  const nodes = graph.nodes.map((n) => {
    if (n.kind === DEVELOP_KIND) {
      if (!n.develop || !inScope(n.id)) return n;
      const srcNode =
        look.nodes.find((ln) => ln.id === n.id && ln.kind === DEVELOP_KIND) ??
        (uniqueFallback && n.id === scopedDevelops[0]!.id ? uniqueFallback : undefined);
      if (!srcNode?.develop) return n;
      return { ...n, develop: pickDevelopFamilies(srcNode.develop, n.develop, families) };
    }
    if (n.kind === 'input' && families.has('geometry') && inScope(n.id)) {
      const srcInput = look.nodes.find((ln) => ln.kind === 'input');
      if (srcInput?.geometry) return { ...n, geometry: structuredClone(srcInput.geometry) };
    }
    return n;
  });
  let merged: GraphDoc = { ...graph, nodes };
  for (const fam of ['masks', 'spots', 'custom-nodes'] as const) {
    if (families.has(fam)) merged = graftStructuralFamily(merged, look, fam, scope);
  }
  return merged;
}

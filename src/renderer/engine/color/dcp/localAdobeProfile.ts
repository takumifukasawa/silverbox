/**
 * Discovery + parsing for the TWO local Adobe Camera Raw files stage base-2's
 * fixes read at runtime (never bundled/redistributed — the dcp-profile.md
 * legal line): the per-camera "Adobe Standard" DCP (used by fix ①'s
 * dual-illuminant color-matrix interpolation AND as the base profile fix ②
 * layers its Look table on top of) and the ONE shared "Adobe Color.xmp" Look
 * preset (fix ②). Pure functions only — no file IO here, matching the
 * existing dcpPath flow's own separation (appStore.ts does every
 * `window.silverbox.readFile` call, same idiom `refreshDcpProfile` already
 * uses for a user-chosen .dcp; this module just knows WHERE to look and HOW
 * to parse what comes back).
 *
 * Stage-order reasoning for fix ② (documented here, once, since both
 * appStore.ts's bake call and pipeline.ts's `renderDcpPixel` extra-stage
 * plumbing depend on getting this right):
 *
 *   Adobe Standard DCP (ForwardMatrix illuminant-interpolated → XYZ D50 →
 *   linear ProPhoto → HSV) → the DCP's OWN HueSatMap/LookTable if it carries
 *   any (Adobe Standard for the a7C II does — see the research doc's DCP
 *   round-1 finding: HueSatMap 90×30×1 + LookTable 36×8×16, TONE-LESS) →
 *   the ACR "Adobe Color" Look's OWN 36×16×16 table, in the SAME
 *   linear-ProPhoto HSV space (the DNG big-table `encoding_Linear` — a
 *   Look's table is defined exactly like a profile's own LookTable, just
 *   layered on afterward — this is how ACR composes a Look preset on top of
 *   whichever camera profile is active, per the DNG spec's profile/look
 *   architecture) → back to RGB → the Look's `ToneCurvePV2012` (REPLACES
 *   Adobe Standard's ProfileToneCurve slot; Adobe Standard has none to
 *   replace — it is documented TONE-LESS, so this is purely additive, not a
 *   conflict) → XYZ D50 → Bradford D65 → Rec.2020 (our working space) →
 *   BaselineExposureOffset (Adobe Standard's is 0, per the research doc).
 *
 * This is exactly `renderDcpPixel(adobeStandardDcp, ..., { lookTable:
 * acrLook.table, lookTableEncoding: acrLook.encoding, toneCurve: pv2012
 * })` — no new pipeline math, the extra-stage plumbing added to
 * `renderDcpPixel`/`bakeDcpLattice` for this purpose.
 */
import { bakeDcpLattice } from './pipeline';
import type { Mat3 } from './matrices';
import type { HueSatTable, ParsedDcp, ToneCurve } from './parser';
import type { AcrLookTable } from './bigTable';

/** Fixed base directory Adobe Camera Raw installs its per-camera profiles into on macOS. */
const ADOBE_STANDARD_DIR = '/Library/Application Support/Adobe/CameraRaw/CameraProfiles/Adobe Standard';

/** The ONE "Adobe Color" creative-profile Look preset — not per-camera (it's a cross-camera Look, per dcp-profile.md's earlier research: "an obfuscated, cross-camera LookTable Look layered on top of the per-camera Adobe Standard profile"). */
export const ADOBE_COLOR_LOOK_XMP_PATH =
  '/Library/Application Support/Adobe/CameraRaw/Settings/Adobe/Profiles/Adobe Raw/Adobe Color.xmp';

/**
 * Title-case a manufacturer string ("SONY" → "Sony") to match Adobe's own
 * filename casing convention. libraw/EXIF `Make` is typically ALL CAPS
 * (confirmed for this project's own Sony test files: "SONY"); Adobe's
 * CameraProfiles directory uses "Sony". A simple per-word title-case covers
 * every single-word Make this discovery has been checked against — a
 * multi-word manufacturer (rare) gets the same treatment, best-effort.
 */
export function normalizeMakeForAdobePath(make: string): string {
  return make
    .trim()
    .split(/\s+/)
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');
}

/** The candidate path for camera (`make`, `model`)'s local "Adobe Standard" DCP — see this file's doc comment. Pure path construction; the caller does the actual read+parse (see appStore.ts's `refreshLocalAdobeProfile`). */
export function adobeStandardDcpPath(make: string, model: string): string {
  const normalizedMake = normalizeMakeForAdobePath(make);
  return `${ADOBE_STANDARD_DIR}/${normalizedMake} ${model} Adobe Standard.dcp`;
}

export interface ParsedAcrLookXmp {
  /** The base85 text of `crs:Table_<md5>` — feed to `decodeAcrLookTable` (bigTable.ts). */
  lookTableBase85: string;
  /** The `crs:LookTable` attribute value (also the `<md5>` suffix of the sibling `Table_<md5>` attribute name) — an MD5 hex digest, used only for the verify script's own self-check (see bigTable.ts's doc comment); production code never needs to compute it. */
  lookTableMd5: string;
  /** `crs:CameraProfile` — informational; "Adobe Color" is defined against "Adobe Standard", checked opportunistically, not load-bearing (the discovery flow always pairs it with the per-camera Adobe Standard DCP regardless). */
  cameraProfile: string | null;
  /** `crs:ToneCurvePV2012`'s (x,y) points, normalized from the XMP's 0..255 space to [0,1] (parser.ts's own ToneCurve convention) — see this file's doc comment for where this applies in the pipeline. */
  toneCurvePv2012: ToneCurve;
}

/**
 * Parse the handful of `crs:*` XMP fields fix ② needs out of the raw XMP
 * text — a small hand-rolled extraction (not a general XML parser; this
 * project has no XML dependency and the fields we need are all flat
 * attributes or one simple `rdf:Seq` of `rdf:li` text nodes), matching the
 * ACTUAL structure of Adobe's "Adobe Color.xmp" as read from disk while
 * writing this (RDF/XML with `crs:Table_<hash>` as a plain XML ATTRIBUTE,
 * `crs:ToneCurvePV2012` as an ELEMENT containing `<rdf:Seq><rdf:li>x,
 * y</rdf:li>...`). Returns `null` (not a throw) when the file doesn't look
 * like an ACR Look preset at all (missing `crs:LookTable`/`Table_<hash>`) —
 * callers treat that as "mode unavailable", the same graceful-absence
 * posture as a missing file.
 */
export function parseAcrLookXmp(xmpText: string): ParsedAcrLookXmp | null {
  const md5Match = xmpText.match(/crs:LookTable="([0-9a-fA-F]{32})"/);
  if (!md5Match) return null;
  const md5 = md5Match[1]!;
  const tableMatch = xmpText.match(new RegExp(`crs:Table_${md5}="([^"]+)"`, 'i'));
  if (!tableMatch) return null;
  const cameraProfileMatch = xmpText.match(/crs:CameraProfile="([^"]*)"/);
  const curveMatch = xmpText.match(/crs:ToneCurvePV2012>\s*<rdf:Seq>([\s\S]*?)<\/rdf:Seq>/);
  if (!curveMatch) return null;
  const points: [number, number][] = [];
  const liRe = /<rdf:li>\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*<\/rdf:li>/g;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(curveMatch[1]!)) !== null) {
    points.push([Number(m[1]) / 255, Number(m[2]) / 255]);
  }
  if (points.length < 2) return null;
  for (let i = 1; i < points.length; i++) {
    if (points[i]![0] <= points[i - 1]![0]) return null; // malformed (non-increasing x) — treat as "not a usable curve", not a crash
  }
  return {
    lookTableBase85: tableMatch[1]!,
    lookTableMd5: md5,
    cameraProfile: cameraProfileMatch?.[1] ?? null,
    toneCurvePv2012: { points },
  };
}

/**
 * Bake the "Adobe Color (local)" look into the SAME N³ residual-lattice
 * shape every other profile source uses (bakeDcpLattice, reused verbatim —
 * see its own doc comment) — thin wrapper that just supplies fix ②'s extra
 * stage (the ACR Look table + its PV2012 curve, layered on top of Adobe
 * Standard's own HueSatMap/LookTable — see this file's doc comment for the
 * order reasoning).
 */
export function bakeAcrLookLattice(
  adobeStandardDcp: ParsedDcp,
  lookTable: HueSatTable,
  lookTableEncoding: 'linear' | 'sRGB',
  toneCurvePv2012: ToneCurve,
  cameraFromWorking: Mat3,
  asShotTempK: number,
  n: number
): number[] {
  return bakeDcpLattice(adobeStandardDcp, cameraFromWorking, asShotTempK, n, {
    lookTable,
    lookTableEncoding,
    toneCurve: toneCurvePv2012,
  });
}

/** Re-exported so a caller only needs this one module for the "does the decoded table look sane" question, without reaching into bigTable.ts directly. */
export type { AcrLookTable };

/**
 * DNG camera-profile (.dcp) tag IDs and the EXIF LightSource → CCT lookup the
 * illuminant interpolation needs. Tag numbers are the DNG 1.7 spec's, and were
 * cross-checked against several REAL Adobe-shipped DCPs on this machine (read
 * locally for research only — see docs/brief-bank/dcp-profile.md's legal
 * line; none of their bytes are committed here, only the numeric tag IDs,
 * which are public DNG-spec constants, not Adobe's expression).
 */

// --- Container-level -----------------------------------------------------

/** UniqueCameraModel (ASCII) — the camera this profile targets. */
export const TAG_UNIQUE_CAMERA_MODEL = 50708;
/** ProfileName (ASCII) — the profile's own display name ("Adobe Standard", "Camera Vivid", …). */
export const TAG_PROFILE_NAME = 50936;

// --- Matrices (SRATIONAL[9], row-major 3×3) --------------------------------

export const TAG_COLOR_MATRIX_1 = 50721;
export const TAG_COLOR_MATRIX_2 = 50722;
export const TAG_FORWARD_MATRIX_1 = 50964;
export const TAG_FORWARD_MATRIX_2 = 50965;

// --- Illuminants (SHORT — EXIF LightSource enum) ---------------------------

export const TAG_CALIBRATION_ILLUMINANT_1 = 50778;
export const TAG_CALIBRATION_ILLUMINANT_2 = 50779;

// --- HueSatMap (the "2.5D" hue/sat/value LUT) ------------------------------

/** LONG[3]: [hueDivisions, satDivisions, valDivisions]. */
export const TAG_PROFILE_HUE_SAT_MAP_DIMS = 50937;
/** FLOAT[hueDivisions*satDivisions*valDivisions*3] at CalibrationIlluminant1. */
export const TAG_PROFILE_HUE_SAT_MAP_DATA_1 = 50938;
/** Same shape, at CalibrationIlluminant2 (optional — single-illuminant profiles omit it). */
export const TAG_PROFILE_HUE_SAT_MAP_DATA_2 = 50939;
/** LONG: 0 = linear (default when absent), 1 = sRGB — encodes the VALUE axis lookup coordinate. */
export const TAG_PROFILE_HUE_SAT_MAP_ENCODING = 51107;

// --- LookTable (same shape as HueSatMap, applied after it, single-illuminant) ---

export const TAG_PROFILE_LOOK_TABLE_DIMS = 50981;
export const TAG_PROFILE_LOOK_TABLE_DATA = 50982;
export const TAG_PROFILE_LOOK_TABLE_ENCODING = 51108;

// --- Tone curve + exposure --------------------------------------------------

/** FLOAT[2*n]: n (x,y) control points in [0,1], increasing x. */
export const TAG_PROFILE_TONE_CURVE = 50940;
/** SRATIONAL: a global EV gain applied to the profile's rendered output. */
export const TAG_BASELINE_EXPOSURE_OFFSET = 51109;

/** Every tag this parser understands (anything else in the IFD is ignored, not an error — see parser.ts). */
export const KNOWN_TAGS = new Set<number>([
  TAG_UNIQUE_CAMERA_MODEL,
  TAG_PROFILE_NAME,
  TAG_COLOR_MATRIX_1,
  TAG_COLOR_MATRIX_2,
  TAG_FORWARD_MATRIX_1,
  TAG_FORWARD_MATRIX_2,
  TAG_CALIBRATION_ILLUMINANT_1,
  TAG_CALIBRATION_ILLUMINANT_2,
  TAG_PROFILE_HUE_SAT_MAP_DIMS,
  TAG_PROFILE_HUE_SAT_MAP_DATA_1,
  TAG_PROFILE_HUE_SAT_MAP_DATA_2,
  TAG_PROFILE_HUE_SAT_MAP_ENCODING,
  TAG_PROFILE_LOOK_TABLE_DIMS,
  TAG_PROFILE_LOOK_TABLE_DATA,
  TAG_PROFILE_LOOK_TABLE_ENCODING,
  TAG_PROFILE_TONE_CURVE,
  TAG_BASELINE_EXPOSURE_OFFSET,
]);

/**
 * EXIF LightSource enum → correlated color temperature (Kelvin). DCP
 * CalibrationIlluminant1/2 store one of these codes (typically 17=StdA and
 * 21=D65 — confirmed on every locally-installed Sony ILCE-7CM2 profile this
 * parser was smoke-tested against). Only the illuminant CODES this table
 * covers are meaningful for the interpolation fraction below; an unlisted
 * code falls back to 5503 K (D55, a neutral daylight-ish middle) rather than
 * throwing — CalibrationIlluminant is validated to be a nonzero SHORT at
 * parse time, but an exotic/reserved enum value should degrade gracefully,
 * not reject an otherwise-valid profile.
 */
export const LIGHT_SOURCE_CCT: Readonly<Record<number, number>> = {
  1: 5500, // Daylight
  2: 4230, // Fluorescent
  3: 2856, // Tungsten (incandescent) — same as StdA
  4: 6000, // Flash
  9: 6500, // Fine weather
  10: 6500, // Cloudy weather
  11: 7500, // Shade
  12: 6500, // Daylight fluorescent (D)
  13: 5000, // Day white fluorescent (N)
  14: 4200, // Cool white fluorescent (W)
  15: 3450, // White fluorescent (WW)
  17: 2856, // CIE Standard Illuminant A
  18: 4874, // CIE Standard Illuminant B
  19: 6774, // CIE Standard Illuminant C
  20: 5503, // D55
  21: 6504, // D65
  22: 7504, // D75
  23: 5003, // D50
  24: 3200, // ISO studio tungsten
};

export const DEFAULT_ILLUMINANT_CCT = 5503;

/** CCT for a CalibrationIlluminant code, with the documented fallback above. */
export function illuminantCct(code: number): number {
  return LIGHT_SOURCE_CCT[code] ?? DEFAULT_ILLUMINANT_CCT;
}

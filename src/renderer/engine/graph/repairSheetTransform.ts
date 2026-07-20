/**
 * Repair sheet (ゴミ取りセット) sensor↔anchor coordinate transform
 * (docs/brief-bank/linked-looks-stage-f.md semantic 3).
 *
 * A repair sheet stores its spots in PHYSICAL SENSOR PIXELS so the SAME dust
 * set can be stamped onto any frame of the same body regardless of that
 * frame's own crop/aspect. A PHOTO, by contrast, always stores its spots in
 * ANCHOR SPACE — normalized 0..1 against the DECODE-ORIENTED full frame
 * (PreparedImage.fullWidth/fullHeight; see anchorSpace.ts's doc comment). This
 * module is the bridge, used only at CREATE time (photo anchor → sensor, to
 * build the sheet) and APPLY time (sensor → each target's anchor, to stamp it);
 * it is NEVER a storage format — photo files still hold anchor-space spots only
 * (engine invariant).
 *
 * The coordinate contract (semantic 3), both directions unit-tested:
 *
 *     sensor px = readoutOrigin + orientation⁻¹(anchorNorm × orientedDims)
 *
 * where `orientation` is the DECODE orientation (libraw `flip`) that produced
 * the oriented full frame — a DIFFERENT axis from geometry.orientation (the
 * user's own rotate, which lives inside the oriented frame and is anchorSpace's
 * concern, not this module's). `readoutOrigin` is the camera-recommended crop
 * origin librawDecoder.ts's computeCropbox retains (RawDecoder.ts's
 * DecodedImage.readoutOrigin), i.e. the sensor-frame position of the decoded
 * raster's (0,0) corner, in libraw's pre-rotation active-area px.
 *
 * Geometry map (all px). Let the DECODE-oriented full-frame dims be OW×OH
 * (= fullWidth×fullHeight); the pre-orientation raster is OW×OH for flip 0/3
 * and OH×OW for flip 5/6 (a quarter turn swaps them). libraw already applied
 * `flip` to the decoded buffer (decodeWorker.ts's round-7 note), so the forward
 * orientation maps a pre-orientation raster point (px,py) to its oriented
 * position (ox,oy), and the inverse undoes it:
 *
 *   flip 0 (none):    (ox,oy) = (px, py)          (px,py) = (ox, oy)
 *   flip 3 (180°):    (ox,oy) = (OW−px, OH−py)    (px,py) = (OW−ox, OH−oy)
 *   flip 6 (90° CW):  (ox,oy) = (OW−py, px)       (px,py) = (oy, OW−ox)
 *   flip 5 (90° CCW): (ox,oy) = (py, OH−px)       (px,py) = (OH−oy, ox)
 *
 * Rotation preserves pixel distances and the readout window is a plain
 * translation (no scaling), so a radius — normalized in anchor space by the
 * oriented max dim, same convention as anchorSpace.ts — converts to sensor px
 * by simply multiplying by that max dim (orientation-invariant), and back by
 * dividing. `feather` is a fraction OF the radius (dimensionless) and is
 * carried through unchanged in both directions.
 */
import { clampSpot, type Spot } from './spotsNode';

/**
 * The readout window + decode orientation of one decoded RAW frame — the only
 * per-frame facts the sensor↔anchor transform needs. Sourced from
 * PreparedImage: `originX/originY` = readoutOrigin (absent ⇒ this frame has no
 * readout window and cannot participate — JPEG, or a RAW libraw exposed no
 * raw_inset_crops for), `orientedWidth/orientedHeight` = fullWidth/fullHeight,
 * `flip` = the EXIF orientation code (0/3/5/6).
 */
export interface ReadoutWindow {
  /** Readout-window origin in physical sensor px (pre-orientation active-area frame). */
  originX: number;
  originY: number;
  /** Decode-oriented full-frame dims (PreparedImage.fullWidth/fullHeight). */
  orientedWidth: number;
  orientedHeight: number;
  /** EXIF orientation code applied by libraw to produce the oriented frame: 0/3/5/6. */
  flip: number;
}

/** One spot in physical sensor px — the repair-sheet storage shape (dx/dy/sx/sy/radius in px; feather is a dimensionless ratio, same as Spot.feather). */
export interface SensorSpot {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  radius: number;
  feather: number;
}

/** A quarter turn (flip 5/6) swaps the oriented dims relative to the pre-orientation raster; 0/3 leave them. */
function isQuarterTurn(flip: number): boolean {
  return flip === 5 || flip === 6;
}

/** Oriented full-frame point (ox,oy) → pre-orientation raster point (px,py). Inverse of `orientForward`. */
function orientInverse(ox: number, oy: number, w: ReadoutWindow): { px: number; py: number } {
  const OW = w.orientedWidth;
  const OH = w.orientedHeight;
  switch (w.flip) {
    case 3:
      return { px: OW - ox, py: OH - oy };
    case 6:
      return { px: oy, py: OW - ox };
    case 5:
      return { px: OH - oy, py: ox };
    default: // 0 (and any unknown code — treated as no rotation)
      return { px: ox, py: oy };
  }
}

/** Pre-orientation raster point (px,py) → oriented full-frame point (ox,oy). Inverse of `orientInverse`. */
function orientForward(px: number, py: number, w: ReadoutWindow): { ox: number; oy: number } {
  const OW = w.orientedWidth;
  const OH = w.orientedHeight;
  switch (w.flip) {
    case 3:
      return { ox: OW - px, oy: OH - py };
    case 6:
      return { ox: OW - py, oy: px };
    case 5:
      return { ox: py, oy: OH - px };
    default:
      return { ox: px, oy: py };
  }
}

/** Anchor-space normalized point → physical sensor px. */
export function anchorPointToSensor(nx: number, ny: number, w: ReadoutWindow): { x: number; y: number } {
  const ox = nx * w.orientedWidth;
  const oy = ny * w.orientedHeight;
  const { px, py } = orientInverse(ox, oy, w);
  return { x: w.originX + px, y: w.originY + py };
}

/** Physical sensor px → anchor-space normalized point (inverse of anchorPointToSensor). */
export function sensorPointToAnchor(sx: number, sy: number, w: ReadoutWindow): { x: number; y: number } {
  const px = sx - w.originX;
  const py = sy - w.originY;
  const { ox, oy } = orientForward(px, py, w);
  return { x: ox / w.orientedWidth, y: oy / w.orientedHeight };
}

/** Anchor-space radius (÷ oriented max dim) → sensor-px radius. */
export function anchorRadiusToSensor(r: number, w: ReadoutWindow): number {
  return r * Math.max(w.orientedWidth, w.orientedHeight);
}

/** Sensor-px radius → anchor-space radius (inverse of anchorRadiusToSensor). Max dim is orientation-invariant. */
export function sensorRadiusToAnchor(r: number, w: ReadoutWindow): number {
  return r / Math.max(w.orientedWidth, w.orientedHeight);
}

/** Convert a photo's anchor-space spot into a sensor-px SensorSpot (create-time). */
export function anchorSpotToSensor(spot: Spot, w: ReadoutWindow): SensorSpot {
  const dst = anchorPointToSensor(spot.dx, spot.dy, w);
  const src = anchorPointToSensor(spot.sx, spot.sy, w);
  return {
    dx: dst.x,
    dy: dst.y,
    sx: src.x,
    sy: src.y,
    radius: anchorRadiusToSensor(spot.radius, w),
    feather: spot.feather,
  };
}

/**
 * Convert a sensor-px SensorSpot into a target's anchor-space Spot (apply-time),
 * or `null` when the spot's DESTINATION (blemish) center maps OUTSIDE the
 * target's oriented frame [0,1]² — that dust simply isn't in this frame (e.g. a
 * full-frame sheet applied to an APS-C crop window; parent spec §5), so it is
 * dropped for this target. The source center may fall outside and is kept: the
 * clone pass clamps source reads to the texture bounds (spotsNode.ts), matching
 * the existing "off-canvas source is allowed" behavior. The returned spot is
 * clampSpot'd so radius/feather land in valid ranges exactly like an
 * interactively placed spot.
 */
export function sensorSpotToAnchor(spot: SensorSpot, w: ReadoutWindow): Spot | null {
  const dst = sensorPointToAnchor(spot.dx, spot.dy, w);
  if (dst.x < 0 || dst.x > 1 || dst.y < 0 || dst.y > 1) return null;
  const src = sensorPointToAnchor(spot.sx, spot.sy, w);
  return clampSpot({
    dx: dst.x,
    dy: dst.y,
    sx: src.x,
    sy: src.y,
    radius: sensorRadiusToAnchor(spot.radius, w),
    feather: spot.feather,
  });
}

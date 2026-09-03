/** Public surface of the DCP (DNG Camera Profile) engine module — see docs/brief-bank/dcp-profile.md. */
export { DcpParseError } from './tiffReader';
export { parseDcp } from './parser';
export type { ParsedDcp, HueSatTable, ToneCurve, Mat3Flat } from './parser';
export {
  illuminantFraction,
  cameraToXyzD50Matrix,
  cameraNativeFromWorking,
  exactCameraFromWorkingMatrix,
  approxCameraFromWorkingMatrix,
  cameraFromWorkingMatrix,
  rgbToHsv,
  hsvToRgb,
  lookupTable,
  valueLookupCoord,
  blendTables,
  evalToneCurve,
  applyToneCurve,
  renderDcpPixel,
  bakeDcpLattice,
  lerpMat3Flat,
} from './pipeline';
export { decodeAcrLookTable, decodeBase85, ACR_BASE85_ALPHABET, type AcrLookTable } from './bigTable';
export {
  adobeStandardDcpPath,
  normalizeMakeForAdobePath,
  ADOBE_COLOR_LOOK_XMP_PATH,
  parseAcrLookXmp,
  bakeAcrLookLattice,
  type ParsedAcrLookXmp,
} from './localAdobeProfile';
export * from './matrices';

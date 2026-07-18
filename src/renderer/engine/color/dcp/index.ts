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
} from './pipeline';
export * from './matrices';

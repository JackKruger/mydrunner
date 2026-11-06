// Tyre footprint surface sampling: blends the grip and traction curve of the
// surfaces under the contact patch, with the build's tyre compound applied.

import { TUNING } from '../tuning.js';
import { sampleSurface, surfaceInfo, type SurfaceTractionSpec, type TerrainData } from './terrain.js';
import type { VehicleGeom } from './vehicleGeom.js';

type Vec3 = { x: number; y: number; z: number };

export interface ContactPatchSample {
  grip: number;
  traction: SurfaceTractionSpec;
}

export function createContactPatchSample(): ContactPatchSample {
  return {
    grip: 0,
    traction: {
      peakSlip: 0,
      slidingToPeak: 0,
      relaxationLength: 0,
      lateralPeakAngle: 0,
      loadSensitivityExponent: 0,
      soil: 'none',
    },
  };
}

export function surfaceGrip(s: number, geom: VehicleGeom): number {
  // TUNING rather than SURFACE_FRICTION: the debug panel mutates the
  // former in place, and this is the reader that makes those sliders do
  // something.
  const key = surfaceInfo(s).friction;
  const compound = key === 'road' || key === 'concrete' ? geom.spec.grip.road
    : key === 'dirt' || key === 'grass' ? geom.spec.grip.dirt
    : key === 'gravel' ? geom.spec.grip.gravel
    : key === 'mud' ? geom.spec.grip.mud
    : geom.spec.grip.deepMud;
  return TUNING.surfaceFriction[key] * compound;
}

function addPatchSurface(
  out: ContactPatchSample,
  terrain: TerrainData,
  x: number,
  z: number,
  weight: number,
  geom: VehicleGeom,
): void {
  const surface = sampleSurface(terrain, x, z);
  const traction = surfaceInfo(surface).traction;
  out.grip += surfaceGrip(surface, geom) * weight;
  out.traction.peakSlip += traction.peakSlip * weight;
  out.traction.slidingToPeak += traction.slidingToPeak * weight;
  out.traction.relaxationLength += traction.relaxationLength * weight;
  out.traction.lateralPeakAngle += traction.lateralPeakAngle * weight;
  out.traction.loadSensitivityExponent += traction.loadSensitivityExponent * weight;
}

/** Centre plus four footprint samples, weighted 0.40 + 4×0.15. */
export function sampleContactPatch(
  terrain: TerrainData,
  point: Vec3,
  longitudinal: Vec3,
  lateral: Vec3,
  geom: VehicleGeom,
  out: ContactPatchSample,
): void {
  out.grip = 0;
  out.traction.peakSlip = 0;
  out.traction.slidingToPeak = 0;
  out.traction.relaxationLength = 0;
  out.traction.lateralPeakAngle = 0;
  out.traction.loadSensitivityExponent = 0;
  out.traction.soil = surfaceInfo(sampleSurface(terrain, point.x, point.z)).traction.soil;
  const longitudinalOffset = geom.wheelRadius * 0.45;
  const lateralOffset = geom.wheelWidth * 0.35;
  addPatchSurface(out, terrain, point.x, point.z, 0.40, geom);
  addPatchSurface(out, terrain,
    point.x + longitudinal.x * longitudinalOffset,
    point.z + longitudinal.z * longitudinalOffset, 0.15, geom);
  addPatchSurface(out, terrain,
    point.x - longitudinal.x * longitudinalOffset,
    point.z - longitudinal.z * longitudinalOffset, 0.15, geom);
  addPatchSurface(out, terrain,
    point.x + lateral.x * lateralOffset,
    point.z + lateral.z * lateralOffset, 0.15, geom);
  addPatchSurface(out, terrain,
    point.x - lateral.x * lateralOffset,
    point.z - lateral.z * lateralOffset, 0.15, geom);
}

export function setSingleSurfacePatch(
  out: ContactPatchSample,
  surface: number,
  geom: VehicleGeom,
  grip = surfaceGrip(surface, geom),
): void {
  const traction = surfaceInfo(surface).traction;
  out.grip = grip;
  out.traction.peakSlip = traction.peakSlip;
  out.traction.slidingToPeak = traction.slidingToPeak;
  out.traction.relaxationLength = traction.relaxationLength;
  out.traction.lateralPeakAngle = traction.lateralPeakAngle;
  out.traction.loadSensitivityExponent = traction.loadSensitivityExponent;
  out.traction.soil = traction.soil;
}

import {
  Physics,
  normalizeVehicleBuild,
  type VehicleBuild,
} from '@mydrunner/shared';

export interface VisualVec3 {
  x: number;
  y: number;
  z: number;
}

export interface VisualBox {
  center: VisualVec3;
  size: VisualVec3;
  rotationX?: number;
}

export interface MountSurface {
  center: VisualVec3;
  width: number;
  length: number;
}

export interface CabinVisualLayout {
  center: VisualVec3;
  size: VisualVec3;
  frontZ: number;
  rearZ: number;
  roofY: number;
  sideWindows: [VisualBox, VisualBox];
  windshield: VisualBox;
  rearWindow: VisualBox;
}

export interface TrayVisualLayout {
  frontZ: number;
  rearZ: number;
  centerZ: number;
  length: number;
  wallHeight: number;
}

export interface VehicleVisualLayout {
  style: 'wagon' | 'utility' | 'crawler' | 'rally';
  extents: VisualVec3;
  cabin: CabinVisualLayout;
  tray: TrayVisualLayout | null;
  canopy: VisualBox | null;
  roofSurface: MountSurface;
  dashboard: VisualBox;
  seats: VisualBox[];
  anchors: {
    frontBar: VisualVec3;
    roof: VisualVec3;
    snorkel: VisualVec3;
    rearBody: VisualVec3;
  };
  snorkel: {
    pipeBottomY: number;
    pipeTopY: number;
  };
}

const WINDOW_THICKNESS = 0.025;
const SNORKEL_PIPE_RADIUS = 0.055;
const SNORKEL_HEAD_HALF_WIDTH = 0.09;
const SNORKEL_SKIN_CLEARANCE = 0.02;

function box(
  center: VisualVec3,
  size: VisualVec3,
  rotationX?: number,
): VisualBox {
  return rotationX === undefined ? { center, size } : { center, size, rotationX };
}

/**
 * Pure build-to-visual layout. All body builders and fitted-part builders
 * consume this result so a mounting surface cannot drift away from the body
 * geometry that created it.
 */
export function createVehicleVisualLayout(value: VehicleBuild | unknown): VehicleVisualLayout {
  const build = normalizeVehicleBuild(value);
  const ext = Physics.geomFor(build).chassisHalfExtents;
  const utility = build.baseId === 'stockman-single' || build.baseId === 'stockman-dual';
  const crawler = build.baseId === 'outclaw';
  const rally = build.baseId === 'dustback-rs';

  const cabinWidth = ext.x * (crawler ? 1.55 : rally ? 1.82 : utility ? 1.86 : 1.93);
  // Keep the cage roof on the shared chassis collision envelope so an
  // upside-down crawler rests on its tubes instead of clipping through them.
  const cabinHeight = crawler ? 0.86 : rally ? 0.68 : ext.y * (utility ? 1.55 : 1.7);
  const cabinFrontZ = crawler ? ext.z * 0.39 : rally ? ext.z * 0.48 : utility ? ext.z * 0.925 : ext.z * 0.375;
  const cabinRearZ = crawler
    ? -ext.z * 0.44
    : rally
      ? -ext.z * 0.86
    : build.baseId === 'stockman-dual'
    ? -ext.z * 0.375
    : utility
      ? -ext.z * 0.025
      : -ext.z * 0.875;
  const cabinLength = cabinFrontZ - cabinRearZ;
  const cabinCenterZ = (cabinFrontZ + cabinRearZ) / 2;
  const cabinRoofY = ext.y + cabinHeight;
  const windowHeight = cabinHeight * (crawler ? 0.50 : rally ? 0.52 : utility ? 0.55 : 0.6);
  const windowY = ext.y + cabinHeight / 2 + cabinHeight * (utility ? 0.07 : 0.05);
  const sideWindowLength = cabinLength * (crawler ? 0.72 : rally ? 0.78 : utility ? 0.8 : 0.85);
  const cabinHalfWidth = cabinWidth / 2;

  const sideWindows = [-1, 1].map((side) => box(
    { x: side * (cabinHalfWidth + WINDOW_THICKNESS / 2), y: windowY, z: cabinCenterZ },
    { x: WINDOW_THICKNESS, y: windowHeight, z: sideWindowLength },
  )) as [VisualBox, VisualBox];
  const windshield = box(
    { x: 0, y: windowY, z: cabinFrontZ + WINDOW_THICKNESS / 2 },
    { x: cabinWidth * 0.92, y: windowHeight, z: WINDOW_THICKNESS },
    crawler ? -0.26 : rally ? -0.18 : utility ? -0.12 : -0.07,
  );
  const rearWindow = box(
    { x: 0, y: windowY, z: cabinRearZ - WINDOW_THICKNESS / 2 },
    { x: cabinWidth * (utility ? 0.85 : 0.92), y: windowHeight * (utility ? 0.8 : 1), z: WINDOW_THICKNESS },
    utility ? 0 : rally ? 0.16 : 0.07,
  );

  let tray: TrayVisualLayout | null = null;
  let canopy: VisualBox | null = null;
  if (utility) {
    const trayLength = cabinRearZ - (-ext.z);
    tray = {
      frontZ: cabinRearZ,
      rearZ: -ext.z,
      centerZ: (cabinRearZ - ext.z) / 2,
      length: trayLength,
      wallHeight: ext.y * 0.55,
    };
    if (build.rearBodyId.endsWith('.option-b')) {
      canopy = box(
        { x: 0, y: ext.y + (cabinRoofY - ext.y) / 2, z: tray.centerZ },
        { x: ext.x * 1.88, y: cabinRoofY - ext.y, z: tray.length * 0.92 },
      );
    }
  }

  const roofSurface: MountSurface = canopy
    ? {
        center: { x: 0, y: canopy.center.y + canopy.size.y / 2, z: canopy.center.z },
        width: canopy.size.x,
        length: canopy.size.z,
      }
    : {
        center: { x: 0, y: cabinRoofY, z: cabinCenterZ },
        width: cabinWidth,
        length: cabinLength,
      };

  const dashboard = box(
    { x: 0, y: windowY - windowHeight / 2 + 0.06, z: cabinFrontZ - 0.22 },
    { x: ext.x * 1.55, y: 0.15, z: 0.32 },
  );
  const seatFractions = build.baseId === 'stockman-single' ? [0.27] : crawler ? [0.58] : rally ? [0.30, 0.68] : [0.27, 0.67];
  const seats: VisualBox[] = [];
  for (const fraction of seatFractions) {
    const rowZ = cabinFrontZ - cabinLength * fraction;
    for (const side of [-1, 1]) {
      seats.push(box(
        { x: side * ext.x * 0.39, y: ext.y + 0.34, z: rowZ },
        { x: ext.x * 0.52, y: 0.54, z: 0.46 },
      ));
    }
  }

  // The head is wider than the pipe, so use it to set the whole snorkel
  // assembly outside the skin. This guarantees both pieces clear glass.
  const snorkelX = cabinHalfWidth + Math.max(SNORKEL_PIPE_RADIUS, SNORKEL_HEAD_HALF_WIDTH)
    + SNORKEL_SKIN_CLEARANCE;
  const rearAnchor = tray
    ? { x: 0, y: ext.y, z: tray.centerZ }
    : { x: 0, y: 0, z: -ext.z };

  return {
    style: crawler ? 'crawler' : rally ? 'rally' : utility ? 'utility' : 'wagon',
    extents: { ...ext },
    cabin: {
      center: { x: 0, y: ext.y + cabinHeight / 2, z: cabinCenterZ },
      size: { x: cabinWidth, y: cabinHeight, z: cabinLength },
      frontZ: cabinFrontZ,
      rearZ: cabinRearZ,
      roofY: cabinRoofY,
      sideWindows,
      windshield,
      rearWindow,
    },
    tray,
    canopy,
    roofSurface,
    dashboard,
    seats,
    anchors: {
      frontBar: { x: 0, y: 0, z: ext.z },
      roof: { ...roofSurface.center },
      snorkel: { x: snorkelX, y: ext.y + 0.05, z: cabinFrontZ - 0.12 },
      rearBody: rearAnchor,
    },
    snorkel: {
      pipeBottomY: ext.y + 0.05,
      pipeTopY: cabinRoofY + 0.15,
    },
  };
}

import { normalizeVehicleBaseId } from './types.js';
import type { PaintFinish, VehicleBaseId, VehicleBuild } from './types.js';

export const VEHICLE_BUILD_VERSION = 1 as const;
export const VEHICLE_BASE_IDS: readonly VehicleBaseId[] = [
  'ridgeback',
  'overlander',
  'stockman-single',
  'stockman-dual',
  'longreach',
  'outclaw',
  'dustback-rs',
] as const;

export type VehiclePartSlot =
  | 'suspensionId'
  | 'axleId'
  | 'tireId'
  | 'wheelId'
  | 'frontBarId'
  | 'winchId'
  | 'snorkelId'
  | 'roofId'
  | 'rearBodyId';

export interface VehiclePartOption {
  id: string;
  slot: VehiclePartSlot;
  name: string;
  description: string;
  priceLabel: 'FREE';
  massKg: number;
}

export interface VehiclePartCatalog {
  baseId: VehicleBaseId;
  suspension: readonly VehiclePartOption[];
  axles: readonly VehiclePartOption[];
  tires: readonly VehiclePartOption[];
  wheels: readonly VehiclePartOption[];
  frontBars: readonly VehiclePartOption[];
  winches: readonly VehiclePartOption[];
  snorkels: readonly VehiclePartOption[];
  roofs: readonly VehiclePartOption[];
  rearBodies: readonly VehiclePartOption[];
}

interface BaseTune {
  name: string;
  character: string;
  half: { x: number; y: number; z: number };
  wheelbase: number;
  track: number;
  massKg: number;
  powerMult: number;
  frontSpring: number;
  rearSpring: number;
  articulation: number;
  intakeHeight: number;
  damageResistance: number;
  stability: number;
  steeringResponse: number;
  stockWheelRadius?: number;
  stockWheelWidth?: number;
  lowRangeRatio?: number;
  lowRangeMaxSpeed?: number;
  suspensionRestLength?: number;
  groundClearance?: number;
  drivetrain?: 'selectable-4wd' | 'fixed-rwd';
  collisionRoofY?: number;
  finalDriveMult?: number;
  rearNames: readonly [string, string];
  rearMasses: readonly [number, number];
}

const BASE_TUNING: Record<VehicleBaseId, BaseTune> = {
  ridgeback: {
    name: 'Ridgeback Wagon',
    character: 'Articulated trail wagon',
    half: { x: 0.89, y: 0.49, z: 2.02 },
    wheelbase: 2.72,
    track: 1.78,
    massKg: 1800,
    powerMult: 1.42,
    frontSpring: 86_000,
    rearSpring: 92_000,
    articulation: 0.56,
    intakeHeight: 0.32,
    damageResistance: 0.84,
    stability: 0.72,
    steeringResponse: 0.92,
    rearNames: ['Single spare swing-away', 'Twin carrier + jerry mount'],
    rearMasses: [45, 86],
  },
  overlander: {
    name: 'Overlander Wagon',
    character: 'Durable touring wagon',
    half: { x: 0.94, y: 0.47, z: 2.20 },
    wheelbase: 2.86,
    track: 1.86,
    massKg: 1980,
    powerMult: 1.35,
    frontSpring: 101_000,
    rearSpring: 110_000,
    articulation: 0.47,
    intakeHeight: 0.34,
    damageResistance: 0.94,
    stability: 0.91,
    steeringResponse: 0.78,
    rearNames: ['Touring rear bar', 'Dual carrier + ladder'],
    rearMasses: [62, 104],
  },
  'stockman-single': {
    name: 'Stockman Single Cab',
    character: 'Nimble work ute',
    half: { x: 0.86, y: 0.43, z: 2.08 },
    wheelbase: 2.78,
    track: 1.72,
    massKg: 1480,
    powerMult: 1.35,
    frontSpring: 79_000,
    rearSpring: 72_000,
    articulation: 0.46,
    intakeHeight: 0.25,
    damageResistance: 0.76,
    stability: 0.69,
    steeringResponse: 1.08,
    rearNames: ['Alloy flat tray', 'Enclosed service canopy'],
    rearMasses: [36, 168],
  },
  'stockman-dual': {
    name: 'Stockman Dual Cab',
    character: 'Balanced modern utility',
    half: { x: 0.91, y: 0.45, z: 2.30 },
    wheelbase: 3.10,
    track: 1.82,
    massKg: 1740,
    powerMult: 1.38,
    frontSpring: 91_000,
    rearSpring: 88_000,
    articulation: 0.44,
    intakeHeight: 0.27,
    damageResistance: 0.82,
    stability: 0.82,
    steeringResponse: 0.9,
    rearNames: ['Steel tray', 'Touring canopy'],
    rearMasses: [92, 182],
  },
  longreach: {
    name: 'Longreach Troop Carrier',
    character: 'Expedition and wading specialist',
    half: { x: 0.92, y: 0.50, z: 2.52 },
    wheelbase: 3.18,
    track: 1.80,
    massKg: 1930,
    powerMult: 1.34,
    frontSpring: 100_000,
    rearSpring: 112_000,
    articulation: 0.43,
    intakeHeight: 0.55,
    damageResistance: 0.96,
    stability: 0.88,
    steeringResponse: 0.68,
    rearNames: ['Expedition carrier', 'Cargo box + ladder'],
    rearMasses: [74, 126],
  },
  outclaw: {
    name: 'Outclaw Tube Crawler',
    character: 'Wide-axle, high-articulation rock crawler',
    half: { x: 0.76, y: 0.34, z: 1.82 },
    wheelbase: 2.68,
    track: 2.14,
    massKg: 1320,
    powerMult: 1.48,
    frontSpring: 72_000,
    rearSpring: 68_000,
    articulation: 0.68,
    intakeHeight: 0.47,
    damageResistance: 0.88,
    stability: 0.86,
    steeringResponse: 1.02,
    stockWheelRadius: 0.43,
    stockWheelWidth: 0.36,
    lowRangeRatio: 3.35,
    lowRangeMaxSpeed: 7.2,
    rearNames: ['Rear recovery hoop', 'Crawler spare carrier'],
    rearMasses: [24, 58],
  },
  'dustback-rs': {
    name: 'Dustback RS',
    character: 'Lightweight rear-drive gravel rally hatch',
    half: { x: 0.78, y: 0.28, z: 1.75 },
    wheelbase: 2.42,
    track: 1.52,
    massKg: 980,
    powerMult: 2.05,
    frontSpring: 62_000,
    rearSpring: 56_000,
    articulation: 0.24,
    intakeHeight: 0.18,
    damageResistance: 0.52,
    stability: 0.84,
    steeringResponse: 1.34,
    stockWheelRadius: 0.295,
    stockWheelWidth: 0.185,
    suspensionRestLength: 0.31,
    groundClearance: 0.12,
    drivetrain: 'fixed-rwd',
    collisionRoofY: 0.96,
    finalDriveMult: 0.78,
    rearNames: ['Ducktail spoiler', 'Spare wheel + tool pack'],
    rearMasses: [8, 32],
  },
};

function part(
  baseId: VehicleBaseId,
  slot: VehiclePartSlot,
  slug: string,
  name: string,
  description: string,
  massKg = 0,
): VehiclePartOption {
  return {
    id: `${baseId}.${slot.replace(/Id$/, '')}.${slug}`,
    slot,
    name,
    description,
    priceLabel: 'FREE',
    massKg,
  };
}

function makeCatalog(baseId: VehicleBaseId): VehiclePartCatalog {
  const tune = BASE_TUNING[baseId];
  if (baseId === 'dustback-rs') {
    return {
      baseId,
      suspension: [
        part(baseId, 'suspensionId', 'factory', 'Factory road suspension', 'Compliant road setup with the standard low ride height.'),
        part(baseId, 'suspensionId', 'gravel-rally', 'Gravel rally suspension', 'More travel and compliance for broken gravel stages.', 12),
        part(baseId, 'suspensionId', 'tarmac-sprint', 'Tarmac sprint suspension', 'Lower, firmer springs for sharp sealed-road response.', 8),
      ],
      axles: [
        part(baseId, 'axleId', 'factory', 'Factory track', 'Original narrow track and quick period steering.'),
        part(baseId, 'axleId', 'widened-rally', 'Widened rally axle', 'A broader stance for high-speed gravel stability.', 22),
        part(baseId, 'axleId', 'reinforced-wide', 'Reinforced wide axle', 'Maximum rally track with stronger housings.', 46),
      ],
      tires: [
        part(baseId, 'tireId', 'factory', 'Period road tyres', 'Progressive road compound with modest loose-surface bite.'),
        part(baseId, 'tireId', 'gravel-rally', 'Gravel rally tyres', 'Loose-surface tread with the strongest gravel grip.', 18),
        part(baseId, 'tireId', 'tarmac-rally', 'Tarmac rally tyres', 'Firm sealed-stage compound with reduced mud and gravel grip.', 14),
      ],
      wheels: [
        part(baseId, 'wheelId', 'factory', 'Factory steel wheels', 'Narrow original steel wheel package.'),
        part(baseId, 'wheelId', 'reinforced-rally-steel', 'Reinforced rally steel', 'Strong period steel wheels for rough stages.', 16),
        part(baseId, 'wheelId', 'period-alloy', 'Period alloy wheels', 'Lightweight eighties-style competition alloys.', -6),
      ],
      frontBars: [
        part(baseId, 'frontBarId', 'factory', 'Factory bumper', 'Close-fitting black factory bumper.'),
        part(baseId, 'frontBarId', 'sump-guard', 'Sump guard', 'Underbody protection without a heavy bullbar.', 14),
        part(baseId, 'frontBarId', 'lamp-pod', 'Auxiliary lamp pod', 'Four forward rally lamps for night stages.', 9),
      ],
      winches: [part(baseId, 'winchId', 'none', 'No winch', 'Recovery winches are not supported by this car.')],
      snorkels: [part(baseId, 'snorkelId', 'none', 'Factory intake', 'No raised intake is available for this car.')],
      roofs: [
        part(baseId, 'roofId', 'none', 'Bare roof', 'Clean factory roofline.'),
        part(baseId, 'roofId', 'rally-vent', 'Roof vent', 'Period competition cabin vent.', 3),
        part(baseId, 'roofId', 'rally-antenna', 'Rally antenna', 'Long flexible rally communications antenna.', 2),
      ],
      rearBodies: [
        part(baseId, 'rearBodyId', 'factory', 'Factory hatch', 'Unmodified three-door rear hatch.'),
        part(baseId, 'rearBodyId', 'option-a', tune.rearNames[0], 'Compact period ducktail spoiler.', tune.rearMasses[0]),
        part(baseId, 'rearBodyId', 'option-b', tune.rearNames[1], 'Internal stage spare and compact tool pack.', tune.rearMasses[1]),
      ],
    };
  }
  return {
    baseId,
    suspension: [
      part(baseId, 'suspensionId', 'factory', 'Factory suspension', 'Factory ride height and road manners.'),
      part(baseId, 'suspensionId', 'touring-50', '50 mm touring lift', 'More clearance with a modest stability trade-off.', 18),
      part(baseId, 'suspensionId', 'flex-100', '100 mm flex lift', 'Maximum droop and articulation; noticeably more body roll.', 32),
    ],
    axles: [
      part(baseId, 'axleId', 'factory', 'Factory-width axles', 'Original track width and road manners.'),
      part(baseId, 'axleId', 'wide-160', '160 mm wider axles', '80 mm wider per side for a broader, more stable stance.', 48),
      part(baseId, 'axleId', 'portal-240', '240 mm portal axles', 'Maximum track width plus 80 mm of portal ground clearance.', 92),
    ],
    tires: [
      part(baseId, 'tireId', 'factory', 'Factory tyres', 'Quick steering and low rolling resistance.'),
      part(baseId, 'tireId', 'at-33', '33-inch all-terrain', 'Predictable mixed-surface touring tyre.', 28),
      part(baseId, 'tireId', 'at-33-wide', '33-inch wide all-terrain', 'A wider footprint for extra flotation and mixed-surface grip.', 38),
      part(baseId, 'tireId', 'mt-33', '33-inch mud-terrain', 'More mud bite with extra road noise and drag.', 36),
      part(baseId, 'tireId', 'mt-35', '35-inch mud-terrain', 'More clearance and mud grip; slower steering.', 52),
      part(baseId, 'tireId', 'mt-35-wide', '35-inch wide mud-terrain', 'A broad 35-inch footprint for deep mud and soft terrain.', 64),
      part(baseId, 'tireId', 'mt-37', '37-inch mud-terrain', 'Serious obstacle clearance and mud grip with heavier steering.', 78),
      part(baseId, 'tireId', 'xt-40-wide', '40-inch wide extreme-terrain', 'The largest tyre package; built for portals and extreme trails.', 108),
    ],
    wheels: [
      part(baseId, 'wheelId', 'factory', 'Factory wheels', 'Original lightweight wheel package.'),
      part(baseId, 'wheelId', 'classic-steel', 'Classic steel wheels', 'Strong steel wheel with extra unsprung mass.', 18),
      part(baseId, 'wheelId', 'beadlock-alloy', 'Beadlock-style alloys', 'Trail-focused alloy with a broad stance.', 10),
    ],
    frontBars: [
      part(baseId, 'frontBarId', 'factory', 'Factory bumper', 'Light and close-fitting.'),
      part(baseId, 'frontBarId', 'alloy-hoop', 'Alloy hoop bar', 'Light frontal protection; no winch cradle.', 34),
      part(baseId, 'frontBarId', 'steel-winch', 'Steel winch bullbar', 'Winch-ready and strongly protects the engine.', 82),
    ],
    winches: [
      part(baseId, 'winchId', 'none', 'No winch', 'No winch fitted.'),
      part(baseId, 'winchId', 'fitted', 'Fitted recovery winch', 'Physics-driven recovery from strong scenery and other vehicles.', 38),
    ],
    snorkels: [
      part(baseId, 'snorkelId', 'none', 'Factory intake', 'Standard wading intake point.'),
      part(baseId, 'snorkelId', 'fitted', 'Raised snorkel', 'Raises the real engine flooding point.', 7),
    ],
    roofs: [
      part(baseId, 'roofId', 'none', 'Bare roof', 'No roof load.'),
      part(baseId, 'roofId', 'basket', 'Touring basket', 'Compact basket with a small high-mounted mass penalty.', 34),
      part(baseId, 'roofId', 'platform-awning', 'Platform + awning', 'Wide touring platform and rolled awning.', 57),
    ],
    rearBodies: [
      part(baseId, 'rearBodyId', 'factory', 'Factory rear', 'Original rear body configuration.'),
      part(baseId, 'rearBodyId', 'option-a', tune.rearNames[0], 'Vehicle-specific rear touring configuration.', tune.rearMasses[0]),
      part(baseId, 'rearBodyId', 'option-b', tune.rearNames[1], 'Vehicle-specific heavy-duty rear configuration.', tune.rearMasses[1]),
    ],
  };
}

export const VEHICLE_PART_CATALOGS: Record<VehicleBaseId, VehiclePartCatalog> = {
  ridgeback: makeCatalog('ridgeback'),
  overlander: makeCatalog('overlander'),
  'stockman-single': makeCatalog('stockman-single'),
  'stockman-dual': makeCatalog('stockman-dual'),
  longreach: makeCatalog('longreach'),
  outclaw: makeCatalog('outclaw'),
  'dustback-rs': makeCatalog('dustback-rs'),
};

function factoryId(baseId: VehicleBaseId, slot: VehiclePartSlot): string {
  return `${baseId}.${slot.replace(/Id$/, '')}.factory`;
}

export function createStockBuild(base: VehicleBaseId = 'ridgeback'): VehicleBuild {
  return {
    version: VEHICLE_BUILD_VERSION,
    baseId: base,
    paintColor: '#c84c32',
    paintFinish: 'gloss',
    suspensionId: factoryId(base, 'suspensionId'),
    axleId: factoryId(base, 'axleId'),
    tireId: factoryId(base, 'tireId'),
    wheelId: factoryId(base, 'wheelId'),
    frontBarId: factoryId(base, 'frontBarId'),
    winchId: `${base}.winch.none`,
    snorkelId: `${base}.snorkel.none`,
    roofId: `${base}.roof.none`,
    rearBodyId: factoryId(base, 'rearBodyId'),
    frontLocker: base === 'outclaw',
    rearLocker: base === 'outclaw',
  };
}

export const DEFAULT_VEHICLE_BUILD: VehicleBuild = createStockBuild();

/** The one mapping from a build's slot field to the catalog list that fills
 *  it. Everything that walks the slots - normalisation, mass, the workshop
 *  panel and the wire codec - iterates this rather than restating the nine
 *  names, so a new slot is a compile error in the Record instead of a silent
 *  omission somewhere downstream. */
export const SLOT_OPTIONS: Record<VehiclePartSlot, keyof VehiclePartCatalog> = {
  suspensionId: 'suspension',
  axleId: 'axles',
  tireId: 'tires',
  wheelId: 'wheels',
  frontBarId: 'frontBars',
  winchId: 'winches',
  snorkelId: 'snorkels',
  roofId: 'roofs',
  rearBodyId: 'rearBodies',
};

/** Slot order for anything positional - above all the snapshot tuple, where
 *  pack and unpack disagreeing by one index would hand every remote truck
 *  somebody else's parts with nothing throwing. Frozen from the Record's own
 *  key order so the two sides cannot drift apart. */
export const VEHICLE_PART_SLOTS: readonly VehiclePartSlot[] =
  Object.freeze(Object.keys(SLOT_OPTIONS) as VehiclePartSlot[]);

/** The catalog lists for a base, in VEHICLE_PART_SLOTS order. */
export function partListsFor(baseId: VehicleBaseId): readonly (readonly VehiclePartOption[])[] {
  const catalog = VEHICLE_PART_CATALOGS[baseId];
  return VEHICLE_PART_SLOTS.map((slot) => catalog[SLOT_OPTIONS[slot]] as readonly VehiclePartOption[]);
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function optionFor(baseId: VehicleBaseId, slot: VehiclePartSlot, value: unknown): VehiclePartOption | null {
  const list = VEHICLE_PART_CATALOGS[baseId][SLOT_OPTIONS[slot]] as readonly VehiclePartOption[];
  return typeof value === 'string' ? list.find((entry) => entry.id === value) ?? null : null;
}

function paintColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '#c84c32';
}

function paintFinish(value: unknown): PaintFinish {
  return value === 'satin' || value === 'matte' ? value : 'gloss';
}

export interface BuildNormalizationResult {
  build: VehicleBuild;
  issues: string[];
}

/**
 * Deterministic trust-boundary normalizer used by storage, client and server.
 * Unknown IDs fall back to stock; incompatible combinations are made safe.
 */
export function normalizeVehicleBuild(value: unknown): VehicleBuild {
  return normalizeVehicleBuildDetailed(value).build;
}

export function normalizeVehicleBuildDetailed(value: unknown): BuildNormalizationResult {
  const raw = asObject(value);
  const baseId = normalizeVehicleBaseId(raw.baseId ?? raw.carKind ?? raw.kind);
  const stock = createStockBuild(baseId);
  const issues: string[] = [];
  const build: VehicleBuild = {
    ...stock,
    paintColor: paintColor(raw.paintColor ?? raw.color),
    paintFinish: paintFinish(raw.paintFinish ?? raw.finish),
    frontLocker: raw.frontLocker === true,
    rearLocker: raw.rearLocker === true,
  };
  for (const slot of VEHICLE_PART_SLOTS) {
    const selected = optionFor(baseId, slot, raw[slot]);
    if (selected) build[slot] = selected.id;
    else if (raw[slot] !== undefined) issues.push(`Unknown ${slot}: ${String(raw[slot])}`);
  }
  if (requiresFlexLift(build.tireId) && !build.suspensionId.endsWith('.flex-100')) {
    issues.push(`${tireSizeLabel(build.tireId)} tyres require the 100 mm flex lift`);
    build.tireId = stock.tireId;
  }
  if (build.tireId.endsWith('.xt-40-wide') && !build.axleId.endsWith('.portal-240')) {
    issues.push('40-inch tyres require the 240 mm portal axles');
    build.tireId = stock.tireId;
  }
  if (build.winchId.endsWith('.fitted') && !build.frontBarId.endsWith('.steel-winch')) {
    issues.push('A winch requires the steel winch bullbar');
    build.winchId = `${baseId}.winch.none`;
  }
  if (baseId === 'dustback-rs' && build.frontLocker) {
    issues.push('The Dustback RS has no front differential locker');
    build.frontLocker = false;
  }
  return { build, issues };
}

/** Stable identity string for a build: same parts -> same key, always.
 *
 *  Field order is spelled out here rather than delegated to
 *  JSON.stringify, whose output follows insertion order - two builds with
 *  identical parts assembled by different code paths would stringify
 *  differently and compare unequal. Callers use this both to compare
 *  builds and to key caches of build-derived data. */
export function vehicleBuildKey(build: VehicleBuild): string {
  return [
    build.version,
    build.baseId,
    build.paintColor,
    build.paintFinish,
    build.suspensionId,
    build.axleId,
    build.tireId,
    build.wheelId,
    build.frontBarId,
    build.winchId,
    build.snorkelId,
    build.roofId,
    build.rearBodyId,
    build.frontLocker ? 1 : 0,
    build.rearLocker ? 1 : 0,
  ].join('|');
}

export function buildsEqual(a: VehicleBuild, b: VehicleBuild): boolean {
  return vehicleBuildKey(a) === vehicleBuildKey(b);
}

export function isNormalizedVehicleBuild(value: unknown): value is VehicleBuild {
  const raw = asObject(value);
  if (raw.version !== VEHICLE_BUILD_VERSION || !VEHICLE_BASE_IDS.includes(raw.baseId as VehicleBaseId)) return false;
  const result = normalizeVehicleBuildDetailed(value);
  return result.issues.length === 0 && buildsEqual(result.build, value as VehicleBuild);
}

/** Requirement text used by the workshop before committing a selection. */
export function partCompatibility(
  current: VehicleBuild,
  slot: VehiclePartSlot,
  optionId: string,
): { enabled: boolean; reason?: string } {
  const baseId = current.baseId;
  if (!optionFor(baseId, slot, optionId)) return { enabled: false, reason: 'Not available for this vehicle.' };
  if (slot === 'tireId' && requiresFlexLift(optionId) && !current.suspensionId.endsWith('.flex-100')) {
    return { enabled: false, reason: 'Requires the 100 mm flex lift.' };
  }
  if (slot === 'tireId' && optionId.endsWith('.xt-40-wide') && !current.axleId.endsWith('.portal-240')) {
    return { enabled: false, reason: 'Requires the 240 mm portal axles.' };
  }
  if (slot === 'winchId' && optionId.endsWith('.fitted') && !current.frontBarId.endsWith('.steel-winch')) {
    return { enabled: false, reason: 'Requires the steel winch bullbar.' };
  }
  return { enabled: true };
}

export interface GripMultipliers {
  road: number;
  dirt: number;
  gravel: number;
  mud: number;
  deepMud: number;
  wet: number;
}

export interface ResolvedVehicleSpec {
  build: VehicleBuild;
  displayName: string;
  character: string;
  chassisHalfExtents: { x: number; y: number; z: number };
  wheelbase: number;
  track: number;
  wheelRadius: number;
  wheelWidth: number;
  massKg: number;
  powerMult: number;
  frontSpring: number;
  rearSpring: number;
  suspensionRestLength: number;
  droop: number;
  articulation: number;
  intakeHeight: number;
  damageResistance: number;
  bullbarEngineProtection: number;
  centerOfMass: { x: number; y: number; z: number };
  inertiaMult: number;
  rollingResistanceMult: number;
  steeringResponse: number;
  maxSteerMult: number;
  stability: number;
  groundClearance: number;
  wadingDepth: number;
  grip: GripMultipliers;
  lowRangeRatio: number;
  lowRangeMaxSpeed: number;
  drivetrain: 'selectable-4wd' | 'fixed-rwd';
  /** Continuous wheel-speed coupling for a fitted rear limited-slip diff. */
  rearDiffCoupling: number;
  collisionRoofY: number;
  finalDriveMult: number;
}

function selectedMass(build: VehicleBuild): number {
  const catalog = VEHICLE_PART_CATALOGS[build.baseId];
  let total = 0;
  for (const slot of VEHICLE_PART_SLOTS) {
    const item = (catalog[SLOT_OPTIONS[slot]] as readonly VehiclePartOption[]).find((p) => p.id === build[slot]);
    total += item?.massKg ?? 0;
  }
  return total;
}

function requiresFlexLift(tireId: string): boolean {
  return /\.(?:mt-35|mt-35-wide|mt-37|xt-40-wide)$/.test(tireId);
}

function tireSizeLabel(tireId: string): string {
  if (tireId.endsWith('.xt-40-wide')) return '40-inch';
  if (tireId.endsWith('.mt-37')) return '37-inch';
  return '35-inch';
}

/** Pure build -> render/physics specification. Never reads mutable runtime tuning. */
export function resolveVehicleSpec(value: VehicleBuild | unknown): ResolvedVehicleSpec {
  const build = normalizeVehicleBuild(value);
  const base = BASE_TUNING[build.baseId];
  const rally = build.baseId === 'dustback-rs';
  const rallyGravelSuspension = build.suspensionId.endsWith('.gravel-rally');
  const rallyTarmacSuspension = build.suspensionId.endsWith('.tarmac-sprint');
  const lift = rallyGravelSuspension ? 0.035 : rallyTarmacSuspension ? -0.018
    : build.suspensionId.endsWith('.flex-100') ? 0.10
    : build.suspensionId.endsWith('.touring-50') ? 0.05 : 0;
  const flex = build.suspensionId.endsWith('.flex-100');
  const touring = build.suspensionId.endsWith('.touring-50');
  const tire40 = build.tireId.endsWith('.xt-40-wide');
  const tire37 = build.tireId.endsWith('.mt-37');
  const tire35Wide = build.tireId.endsWith('.mt-35-wide');
  const tire35 = build.tireId.endsWith('.mt-35') || tire35Wide;
  const tire33Wide = build.tireId.endsWith('.at-33-wide');
  const tire33 = build.tireId.endsWith('.at-33') || tire33Wide || build.tireId.endsWith('.mt-33');
  const mud = build.tireId.endsWith('.mt-33') || tire35 || tire37 || tire40;
  const allTerrain = build.tireId.endsWith('.at-33') || tire33Wide;
  const wideTire = tire33Wide || tire35Wide || tire40;
  const rallyGravelTire = build.tireId.endsWith('.gravel-rally');
  const rallyTarmacTire = build.tireId.endsWith('.tarmac-rally');
  const wheelRadius = rallyGravelTire ? 0.305 : rallyTarmacTire ? 0.30
    : tire40 ? 0.508 : tire37 ? 0.4699 : tire35 ? 0.4445 : tire33 ? 0.4191 : base.stockWheelRadius ?? 0.39;
  const wheelWidth = rallyGravelTire ? 0.195 : rallyTarmacTire ? 0.205
    : tire40 ? 0.42 : tire37 ? 0.39 : tire35Wide ? 0.38 : tire35 ? 0.34
    : tire33Wide ? 0.35 : tire33 ? 0.31 : base.stockWheelWidth ?? 0.28;
  const tireMassPenalty = tire40 ? 0.28 : tire37 ? 0.22 : tire35 ? (tire35Wide ? 0.19 : 0.16)
    : tire33 ? (tire33Wide ? 0.11 : 0.08) : 0;
  const portalAxles = build.axleId.endsWith('.portal-240');
  const wideAxles = build.axleId.endsWith('.wide-160');
  const axleTrackGain = build.axleId.endsWith('.reinforced-wide') ? 0.14
    : build.axleId.endsWith('.widened-rally') ? 0.08
    : portalAxles ? 0.24 : wideAxles ? 0.16 : 0;
  const portalClearance = portalAxles ? 0.08 : 0;
  const roofMass = build.roofId.endsWith('.platform-awning') ? 57 : build.roofId.endsWith('.basket') ? 34
    : build.roofId.endsWith('.rally-vent') ? 3 : build.roofId.endsWith('.rally-antenna') ? 2 : 0;
  const frontMass = build.frontBarId.endsWith('.steel-winch') ? 82 : build.frontBarId.endsWith('.alloy-hoop') ? 34 : 0;
  const extraMass = selectedMass(build);
  const suspensionRollPenalty = flex ? 0.16 : touring ? 0.07 : 0;
  const grip: GripMultipliers = rally ? {
    road: rallyTarmacTire ? 1.28 : rallyGravelTire ? 0.98 : 1.14,
    dirt: rallyGravelTire ? 1.25 : rallyTarmacTire ? 0.91 : 1.06,
    gravel: rallyGravelTire ? 1.36 : rallyTarmacTire ? 0.88 : 1.08,
    mud: rallyGravelTire ? 0.82 : rallyTarmacTire ? 0.58 : 0.70,
    deepMud: rallyGravelTire ? 0.66 : rallyTarmacTire ? 0.44 : 0.54,
    wet: rallyTarmacTire ? 1.04 : rallyGravelTire ? 0.92 : 0.98,
  } : {
    road: mud ? (tire40 ? 0.78 : tire37 ? 0.82 : tire35 ? 0.86 : 0.89) : allTerrain ? (wideTire ? 0.93 : 0.95) : 1,
    dirt: mud ? 1.08 : allTerrain ? 1.06 : 1,
    gravel: mud ? 1.04 : allTerrain ? 1.09 : 1,
    mud: mud ? (tire40 ? 1.58 : tire37 ? 1.46 : tire35 ? (wideTire ? 1.43 : 1.35) : 1.24) : allTerrain ? (wideTire ? 1.18 : 1.12) : 1,
    deepMud: mud ? (tire40 ? 1.74 : tire37 ? 1.59 : tire35 ? (wideTire ? 1.56 : 1.46) : 1.30) : allTerrain ? (wideTire ? 1.20 : 1.12) : 1,
    wet: mud ? 0.93 : allTerrain ? 1.06 : 1,
  };
  const snorkel = build.snorkelId.endsWith('.fitted');
  return {
    build,
    displayName: base.name,
    character: base.character,
    chassisHalfExtents: { ...base.half },
    wheelbase: base.wheelbase,
    track: base.track + axleTrackGain + (build.wheelId.endsWith('.beadlock-alloy') ? 0.06 : 0),
    wheelRadius,
    wheelWidth,
    massKg: base.massKg + extraMass,
    powerMult: base.powerMult,
    frontSpring: base.frontSpring * (rallyGravelSuspension ? 0.88 : rallyTarmacSuspension ? 1.22 : flex ? 0.9 : touring ? 0.96 : 1),
    rearSpring: base.rearSpring * (rallyGravelSuspension ? 0.84 : rallyTarmacSuspension ? 1.18 : flex ? 0.86 : touring ? 0.94 : 1),
    suspensionRestLength: (base.suspensionRestLength ?? 0.50) + lift + portalClearance,
    droop: rally ? 0.13 + (rallyGravelSuspension ? 0.06 : rallyTarmacSuspension ? -0.025 : 0)
      : 0.27 + (flex ? 0.15 : touring ? 0.06 : 0),
    articulation: base.articulation * (rallyGravelSuspension ? 1.18 : rallyTarmacSuspension ? 0.78 : flex ? 1.32 : touring ? 1.12 : 1),
    intakeHeight: base.intakeHeight + (snorkel ? 0.86 : 0),
    damageResistance: base.damageResistance,
    bullbarEngineProtection: build.frontBarId.endsWith('.steel-winch') ? 0.56
      : build.frontBarId.endsWith('.alloy-hoop') ? 0.22 : 0,
    centerOfMass: {
      x: 0,
      y: -base.half.y * 0.58 + lift * 0.4 + roofMass / 1400,
      z: (frontMass * 1.35 - Math.max(0, extraMass - frontMass - roofMass) * 0.75) / (base.massKg + extraMass),
    },
    inertiaMult: 1 + tireMassPenalty + extraMass / Math.max(1800, base.massKg) * 0.35,
    rollingResistanceMult: rally ? (rallyGravelTire ? 1.09 : rallyTarmacTire ? 0.96 : 1)
      : 1 + (mud ? 0.13 : allTerrain ? 0.06 : 0) + tireMassPenalty,
    steeringResponse: base.steeringResponse * (tire40 ? 0.62 : tire37 ? 0.70 : tire35 ? 0.78 : tire33 ? 0.9 : 1),
    maxSteerMult: build.frontLocker ? 0.9 : 1,
    stability: Math.min(1, Math.max(0.35, base.stability - suspensionRollPenalty - roofMass / 500 + axleTrackGain * 0.45)),
    groundClearance: (base.groundClearance ?? 0.23) + lift
      + (wheelRadius - (base.stockWheelRadius ?? 0.39)) + portalClearance,
    wadingDepth: base.half.y + base.intakeHeight + (snorkel ? 0.86 : 0),
    grip,
    lowRangeRatio: base.lowRangeRatio ?? 2.65,
    lowRangeMaxSpeed: base.lowRangeMaxSpeed ?? 9.5,
    drivetrain: base.drivetrain ?? 'selectable-4wd',
    rearDiffCoupling: rally && build.rearLocker ? 0.36 : 0,
    collisionRoofY: base.collisionRoofY ?? 1.2,
    finalDriveMult: base.finalDriveMult ?? 1,
  };
}

export interface NamedVehicleBuild {
  id: string;
  name: string;
  build: VehicleBuild;
  updatedAt: number;
}

export interface VehicleGarage {
  version: 1;
  builds: NamedVehicleBuild[];
}

export const MAX_SAVED_BUILDS = 5;

/** Parses current storage plus older single-car/Falcon/bike envelopes. */
export function decodeVehicleGarage(value: unknown): VehicleGarage {
  let raw = value;
  if (typeof value === 'string') {
    try { raw = JSON.parse(value); } catch { raw = null; }
  }
  const obj = asObject(raw);
  const source = Array.isArray(obj.builds) ? obj.builds : [];
  const builds: NamedVehicleBuild[] = [];
  for (let i = 0; i < source.length && builds.length < MAX_SAVED_BUILDS; i++) {
    const entry = asObject(source[i]);
    builds.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 64) : `build-${i + 1}`,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 32) : `Build ${i + 1}`,
      build: normalizeVehicleBuild(entry.build ?? entry),
      updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
    });
  }
  // Some prototypes stored one active car directly. Migrate it as a named
  // build, but do not make it the applied multiplayer identity implicitly.
  if (builds.length === 0 && (obj.carKind !== undefined || obj.baseId !== undefined)) {
    builds.push({ id: 'migrated-build', name: 'Migrated build', build: normalizeVehicleBuild(obj), updatedAt: 0 });
  }
  return { version: 1, builds };
}

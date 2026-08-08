import { normalizeVehicleBaseId } from './types.js';
import type { PaintFinish, VehicleBaseId, VehicleBuild } from './types.js';

export const VEHICLE_BUILD_VERSION = 1 as const;
export const VEHICLE_BASE_IDS: readonly VehicleBaseId[] = [
  'ridgeback',
  'overlander',
  'stockman-single',
  'stockman-dual',
  'longreach',
] as const;

export type VehiclePartSlot =
  | 'suspensionId'
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
  return {
    baseId,
    suspension: [
      part(baseId, 'suspensionId', 'factory', 'Factory suspension', 'Factory ride height and road manners.'),
      part(baseId, 'suspensionId', 'touring-50', '50 mm touring lift', 'More clearance with a modest stability trade-off.', 18),
      part(baseId, 'suspensionId', 'flex-100', '100 mm flex lift', 'Maximum droop and articulation; noticeably more body roll.', 32),
    ],
    tires: [
      part(baseId, 'tireId', 'factory', 'Factory tyres', 'Quick steering and low rolling resistance.'),
      part(baseId, 'tireId', 'at-33', '33-inch all-terrain', 'Predictable mixed-surface touring tyre.', 28),
      part(baseId, 'tireId', 'mt-33', '33-inch mud-terrain', 'More mud bite with extra road noise and drag.', 36),
      part(baseId, 'tireId', 'mt-35', '35-inch mud-terrain', 'Maximum clearance and mud grip; slower steering.', 52),
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
      part(baseId, 'winchId', 'fitted', 'Fitted recovery winch', 'Visual winch installation; cable recovery is coming later.', 38),
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
    tireId: factoryId(base, 'tireId'),
    wheelId: factoryId(base, 'wheelId'),
    frontBarId: factoryId(base, 'frontBarId'),
    winchId: `${base}.winch.none`,
    snorkelId: `${base}.snorkel.none`,
    roofId: `${base}.roof.none`,
    rearBodyId: factoryId(base, 'rearBodyId'),
    frontLocker: false,
    rearLocker: false,
  };
}

export const DEFAULT_VEHICLE_BUILD: VehicleBuild = createStockBuild();

const SLOT_OPTIONS: Record<VehiclePartSlot, keyof VehiclePartCatalog> = {
  suspensionId: 'suspension',
  tireId: 'tires',
  wheelId: 'wheels',
  frontBarId: 'frontBars',
  winchId: 'winches',
  snorkelId: 'snorkels',
  roofId: 'roofs',
  rearBodyId: 'rearBodies',
};

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
  for (const slot of Object.keys(SLOT_OPTIONS) as VehiclePartSlot[]) {
    const selected = optionFor(baseId, slot, raw[slot]);
    if (selected) build[slot] = selected.id;
    else if (raw[slot] !== undefined) issues.push(`Unknown ${slot}: ${String(raw[slot])}`);
  }
  if (build.tireId.endsWith('.mt-35') && !build.suspensionId.endsWith('.flex-100')) {
    issues.push('35-inch tyres require the 100 mm flex lift');
    build.tireId = stock.tireId;
  }
  if (build.winchId.endsWith('.fitted') && !build.frontBarId.endsWith('.steel-winch')) {
    issues.push('A winch requires the steel winch bullbar');
    build.winchId = `${baseId}.winch.none`;
  }
  return { build, issues };
}

export function buildsEqual(a: VehicleBuild, b: VehicleBuild): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
  if (slot === 'tireId' && optionId.endsWith('.mt-35') && !current.suspensionId.endsWith('.flex-100')) {
    return { enabled: false, reason: 'Requires the 100 mm flex lift.' };
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
}

function selectedMass(build: VehicleBuild): number {
  const catalog = VEHICLE_PART_CATALOGS[build.baseId];
  let total = 0;
  for (const slot of Object.keys(SLOT_OPTIONS) as VehiclePartSlot[]) {
    const item = (catalog[SLOT_OPTIONS[slot]] as readonly VehiclePartOption[]).find((p) => p.id === build[slot]);
    total += item?.massKg ?? 0;
  }
  return total;
}

/** Pure build -> render/physics specification. Never reads mutable runtime tuning. */
export function resolveVehicleSpec(value: VehicleBuild | unknown): ResolvedVehicleSpec {
  const build = normalizeVehicleBuild(value);
  const base = BASE_TUNING[build.baseId];
  const lift = build.suspensionId.endsWith('.flex-100') ? 0.10
    : build.suspensionId.endsWith('.touring-50') ? 0.05 : 0;
  const flex = build.suspensionId.endsWith('.flex-100');
  const touring = build.suspensionId.endsWith('.touring-50');
  const tire35 = build.tireId.endsWith('.mt-35');
  const tire33 = build.tireId.endsWith('.at-33') || build.tireId.endsWith('.mt-33');
  const mud = build.tireId.endsWith('.mt-33') || tire35;
  const allTerrain = build.tireId.endsWith('.at-33');
  const wheelRadius = tire35 ? 0.4445 : tire33 ? 0.4191 : 0.39;
  const tireMassPenalty = tire35 ? 0.16 : tire33 ? 0.08 : 0;
  const roofMass = build.roofId.endsWith('.platform-awning') ? 57 : build.roofId.endsWith('.basket') ? 34 : 0;
  const frontMass = build.frontBarId.endsWith('.steel-winch') ? 82 : build.frontBarId.endsWith('.alloy-hoop') ? 34 : 0;
  const extraMass = selectedMass(build);
  const suspensionRollPenalty = flex ? 0.16 : touring ? 0.07 : 0;
  const grip: GripMultipliers = {
    road: mud ? (tire35 ? 0.86 : 0.89) : allTerrain ? 0.95 : 1,
    dirt: mud ? 1.08 : allTerrain ? 1.06 : 1,
    gravel: mud ? 1.04 : allTerrain ? 1.09 : 1,
    mud: mud ? (tire35 ? 1.35 : 1.24) : allTerrain ? 1.12 : 1,
    deepMud: mud ? (tire35 ? 1.46 : 1.30) : allTerrain ? 1.12 : 1,
    wet: mud ? 0.93 : allTerrain ? 1.06 : 1,
  };
  const snorkel = build.snorkelId.endsWith('.fitted');
  return {
    build,
    displayName: base.name,
    character: base.character,
    chassisHalfExtents: { ...base.half },
    wheelbase: base.wheelbase,
    track: base.track + (build.wheelId.endsWith('.beadlock-alloy') ? 0.06 : 0),
    wheelRadius,
    wheelWidth: tire35 ? 0.34 : tire33 ? 0.31 : 0.28,
    massKg: base.massKg + extraMass,
    powerMult: base.powerMult,
    frontSpring: base.frontSpring * (flex ? 0.9 : touring ? 0.96 : 1),
    rearSpring: base.rearSpring * (flex ? 0.86 : touring ? 0.94 : 1),
    suspensionRestLength: 0.50 + lift,
    droop: 0.27 + (flex ? 0.15 : touring ? 0.06 : 0),
    articulation: base.articulation * (flex ? 1.32 : touring ? 1.12 : 1),
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
    rollingResistanceMult: 1 + (mud ? 0.13 : allTerrain ? 0.06 : 0) + tireMassPenalty,
    steeringResponse: base.steeringResponse * (tire35 ? 0.78 : tire33 ? 0.9 : 1),
    maxSteerMult: build.frontLocker ? 0.9 : 1,
    stability: Math.max(0.35, base.stability - suspensionRollPenalty - roofMass / 500),
    groundClearance: 0.23 + lift + (wheelRadius - 0.39),
    wadingDepth: base.half.y + base.intakeHeight + (snorkel ? 0.86 : 0),
    grip,
    lowRangeRatio: 2.65,
    lowRangeMaxSpeed: 9.5,
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

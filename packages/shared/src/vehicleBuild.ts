import { normalizeVehicleBaseId } from './types.js';
import type { PaintFinish, VehicleBaseId, VehicleBuild } from './types.js';
import type { TireCarcassSpec } from './physics/tireCarcass.js';
import type { DifferentialSpec } from './physics/differential.js';

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

export interface GripMultipliers {
  road: number;
  dirt: number;
  gravel: number;
  mud: number;
  deepMud: number;
  wet: number;
}

const NEUTRAL_GRIP: GripMultipliers = { road: 1, dirt: 1, gravel: 1, mud: 1, deepMud: 1, wet: 1 };

/** What fitting a part does to the vehicle. Every field defaults to "no
 *  change", so a part declares only what it alters, and `resolveVehicleSpec`
 *  reads these rather than recognising parts by the suffix of their id - a
 *  typo in a suffix test compiled and silently did nothing. Fields are grouped
 *  by the slot that sets them; nothing stops another slot setting one, but
 *  `resolveVehicleSpec` reads each from the slot listed. */
export interface PartEffects {
  // suspensionId
  /** Ride-height change, m. Raises rest length, clearance and CoG. */
  lift?: number;
  frontSpringMult?: number;
  rearSpringMult?: number;
  /** Added droop travel, m. */
  droop?: number;
  articulationMult?: number;
  /** Subtracted from base stability: longer springs roll more. */
  rollPenalty?: number;
  // axleId, wheelId
  /** Added track width, m. */
  trackGain?: number;
  // axleId
  /** Portal hub drop, m: adds rest length and clearance. */
  portalClearance?: number;
  /** Scale of the axle tube and housing collision probes. */
  axleProbeScale?: number;
  // tireId
  /** Omitted on factory tyres, which use the base's stock size. */
  wheelRadius?: number;
  wheelWidth?: number;
  /** Rotating-mass penalty on chassis inertia and rolling resistance. */
  tireMassPenalty?: number;
  steeringMult?: number;
  /** Rolling resistance multiplier before `tireMassPenalty` is added. */
  rollingResistance?: number;
  grip?: GripMultipliers;
  // wheelId
  /** How far below the tyre's own minimum a beadlock lets you air down, psi. */
  pressureReliefPsi?: number;
  // frontBarId
  bullbarEngineProtection?: number;
  /** Mass hung ahead of the front axle for the CoG, kg. Not `massKg`: the
   *  Dustback's sump guard and lamp pod have mass but never moved the CoG,
   *  and folding them in would retune that car. */
  overhangMassKg?: number;
  // winchId
  /** A working recovery winch (still subject to its `requires`). */
  winch?: boolean;
  // snorkelId
  /** Raise of the engine air intake, m. */
  intakeRaise?: number;
}

export interface VehiclePartOption {
  id: string;
  slot: VehiclePartSlot;
  name: string;
  description: string;
  priceLabel: 'FREE';
  massKg: number;
  /** Present on every tyre catalogue entry and no other part type. */
  tireCarcass?: TireCarcassSpec;
  effects: PartEffects;
  /** Parts that must be fitted alongside this one. The single statement of
   *  every compatibility rule: `normalizeVehicleBuildDetailed` enforces it and
   *  `partCompatibility` explains it from the same list. */
  requires: readonly VehiclePartOption[];
  /** Start of the normaliser's issue sentence when a requirement is unmet,
   *  e.g. "40-inch tyres require" + " the 240 mm portal axles". */
  ruleSubject?: string;
}

interface PartExtras {
  effects?: PartEffects;
  requires?: readonly VehiclePartOption[];
  ruleSubject?: string;
}

const ROAD_CARCASS: TireCarcassSpec = {
  staticDeflectionRatio: 0.04, radialDampingRatio: 0.7,
  sidewallDampingRatio: 0.5, sidewallFrictionRatio: 0.35,
  nominalPressurePsi: 34, minPressurePsi: 20, maxPressurePsi: 42,
};
const GRAVEL_CARCASS: TireCarcassSpec = { ...ROAD_CARCASS, staticDeflectionRatio: 0.06, nominalPressurePsi: 28, minPressurePsi: 14, maxPressurePsi: 38 };
const MUD_CARCASS: TireCarcassSpec = { ...ROAD_CARCASS, staticDeflectionRatio: 0.08, nominalPressurePsi: 24, minPressurePsi: 10, maxPressurePsi: 34 };
const EXTREME_CARCASS: TireCarcassSpec = { ...ROAD_CARCASS, staticDeflectionRatio: 0.10, nominalPressurePsi: 18, minPressurePsi: 6, maxPressurePsi: 28 };

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
  suspensionRestLength?: number;
  groundClearance?: number;
  drivetrain?: 'selectable-4wd' | 'fixed-rwd';
  /** Stock droop travel, m. */
  droop?: number;
  /** Stock wheel + tyre assembly mass before part additions, kg. */
  wheelAssemblyMassKg?: number;
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
    rearNames: ['Rear recovery hoop', 'Crawler spare carrier'],
    rearMasses: [24, 58],
  },
  'dustback-rs': {
    name: 'Dustback RS',
    character: 'Lightweight rear-drive gravel trail hatch',
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
    droop: 0.13,
    wheelAssemblyMassKg: 24,
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
  extras: PartExtras = {},
): VehiclePartOption {
  return {
    id: `${baseId}.${slot.replace(/Id$/, '')}.${slug}`,
    slot,
    name,
    description,
    priceLabel: 'FREE',
    massKg,
    effects: extras.effects ?? {},
    requires: extras.requires ?? [],
    ...(extras.ruleSubject !== undefined ? { ruleSubject: extras.ruleSubject } : {}),
  };
}

function tirePart(
  baseId: VehicleBaseId,
  slug: string,
  name: string,
  description: string,
  carcass: TireCarcassSpec,
  massKg = 0,
  extras: PartExtras = {},
): VehiclePartOption {
  return { ...part(baseId, 'tireId', slug, name, description, massKg, extras), tireCarcass: carcass };
}

function makeCatalog(baseId: VehicleBaseId): VehiclePartCatalog {
  const tune = BASE_TUNING[baseId];
  if (baseId === 'dustback-rs') {
    return {
      baseId,
      suspension: [
        part(baseId, 'suspensionId', 'factory', 'Factory road suspension', 'Compliant road setup with the standard low ride height.'),
        part(baseId, 'suspensionId', 'gravel-rally', 'Gravel trail suspension', 'More travel and compliance for broken gravel trails.', 12, {
          effects: { lift: 0.035, frontSpringMult: 0.88, rearSpringMult: 0.84, droop: 0.06, articulationMult: 1.18 },
        }),
        part(baseId, 'suspensionId', 'tarmac-sprint', 'Tarmac sprint suspension', 'Lower, firmer springs for sharp sealed-road response.', 8, {
          effects: { lift: -0.018, frontSpringMult: 1.22, rearSpringMult: 1.18, droop: -0.025, articulationMult: 0.78 },
        }),
      ],
      axles: [
        part(baseId, 'axleId', 'factory', 'Factory track', 'Original narrow track and quick period steering.'),
        part(baseId, 'axleId', 'widened-rally', 'Widened trail axle', 'A broader stance for high-speed gravel stability.', 22, {
          effects: { trackGain: 0.08 },
        }),
        part(baseId, 'axleId', 'reinforced-wide', 'Reinforced wide axle', 'Maximum off-road track with stronger housings.', 46, {
          effects: { trackGain: 0.14 },
        }),
      ],
      tires: [
        tirePart(baseId, 'factory', 'Period road tyres', 'Progressive road compound with modest loose-surface bite.', ROAD_CARCASS, 0, {
          effects: { grip: { road: 1.14, dirt: 1.06, gravel: 1.08, mud: 0.70, deepMud: 0.54, wet: 0.98 } },
        }),
        tirePart(baseId, 'gravel-rally', 'Gravel trail tyres', 'Loose-surface tread with the strongest gravel grip.', GRAVEL_CARCASS, 18, {
          effects: {
            wheelRadius: 0.305, wheelWidth: 0.195, rollingResistance: 1.09,
            grip: { road: 0.98, dirt: 1.25, gravel: 1.36, mud: 0.82, deepMud: 0.66, wet: 0.92 },
          },
        }),
        tirePart(baseId, 'tarmac-rally', 'Tarmac tyres', 'Firm sealed-road compound with reduced mud and gravel grip.', ROAD_CARCASS, 14, {
          effects: {
            wheelRadius: 0.30, wheelWidth: 0.205, rollingResistance: 0.96,
            grip: { road: 1.28, dirt: 0.91, gravel: 0.88, mud: 0.58, deepMud: 0.44, wet: 1.04 },
          },
        }),
      ],
      wheels: [
        part(baseId, 'wheelId', 'factory', 'Factory steel wheels', 'Narrow original steel wheel package.'),
        part(baseId, 'wheelId', 'reinforced-rally-steel', 'Reinforced trail steel', 'Strong period steel wheels for rough trails.', 16),
        part(baseId, 'wheelId', 'period-alloy', 'Period alloy wheels', 'Lightweight eighties-style competition alloys.', -6),
      ],
      frontBars: [
        part(baseId, 'frontBarId', 'factory', 'Factory bumper', 'Close-fitting black factory bumper.'),
        part(baseId, 'frontBarId', 'sump-guard', 'Sump guard', 'Underbody protection without a heavy bullbar.', 14),
        part(baseId, 'frontBarId', 'lamp-pod', 'Auxiliary lamp pod', 'Four forward lamps for night trails.', 9),
      ],
      winches: [part(baseId, 'winchId', 'none', 'No winch', 'Recovery winches are not supported by this car.')],
      snorkels: [part(baseId, 'snorkelId', 'none', 'Factory intake', 'No raised intake is available for this car.')],
      roofs: [
        part(baseId, 'roofId', 'none', 'Bare roof', 'Clean factory roofline.'),
        part(baseId, 'roofId', 'rally-vent', 'Roof vent', 'Period competition cabin vent.', 3),
        part(baseId, 'roofId', 'rally-antenna', 'Trail antenna', 'Long flexible communications antenna.', 2),
      ],
      rearBodies: [
        part(baseId, 'rearBodyId', 'factory', 'Factory hatch', 'Unmodified three-door rear hatch.'),
        part(baseId, 'rearBodyId', 'option-a', tune.rearNames[0], 'Compact period ducktail spoiler.', tune.rearMasses[0]),
        part(baseId, 'rearBodyId', 'option-b', tune.rearNames[1], 'Internal stage spare and compact tool pack.', tune.rearMasses[1]),
      ],
    };
  }
  const flexLift = part(baseId, 'suspensionId', 'flex-100', '100 mm flex lift', 'Maximum droop and articulation; noticeably more body roll.', 32, {
    effects: { lift: 0.10, frontSpringMult: 0.9, rearSpringMult: 0.86, droop: 0.15, articulationMult: 1.32, rollPenalty: 0.16 },
  });
  const portalAxles = part(baseId, 'axleId', 'portal-240', '240 mm portal axles', 'Maximum track width plus 80 mm of portal ground clearance.', 92, {
    effects: { trackGain: 0.24, portalClearance: 0.08, axleProbeScale: 0.75 },
  });
  const steelWinchBar = part(baseId, 'frontBarId', 'steel-winch', 'Steel winch bullbar', 'Winch-ready and strongly protects the engine.', 82, {
    effects: { bullbarEngineProtection: 0.56, overhangMassKg: 82 },
  });
  const mudTerrain = (road: number, dirt: number, mud: number, deepMud: number): GripMultipliers =>
    ({ road, dirt, gravel: 1.04, mud, deepMud, wet: 0.93 });
  return {
    baseId,
    suspension: [
      part(baseId, 'suspensionId', 'factory', 'Factory suspension', 'Factory ride height and road manners.'),
      part(baseId, 'suspensionId', 'touring-50', '50 mm touring lift', 'More clearance with a modest stability trade-off.', 18, {
        effects: { lift: 0.05, frontSpringMult: 0.96, rearSpringMult: 0.94, droop: 0.06, articulationMult: 1.12, rollPenalty: 0.07 },
      }),
      flexLift,
    ],
    axles: [
      part(baseId, 'axleId', 'factory', 'Factory-width axles', 'Original track width and road manners.'),
      part(baseId, 'axleId', 'wide-160', '160 mm wider axles', '80 mm wider per side for a broader, more stable stance.', 48, {
        effects: { trackGain: 0.16 },
      }),
      portalAxles,
    ],
    tires: [
      tirePart(baseId, 'factory', 'Factory tyres', 'Quick steering and low rolling resistance.', ROAD_CARCASS),
      tirePart(baseId, 'at-33', '33-inch all-terrain', 'Predictable mixed-surface touring tyre.', GRAVEL_CARCASS, 28, {
        effects: {
          wheelRadius: 0.4191, wheelWidth: 0.31, tireMassPenalty: 0.08, steeringMult: 0.9, rollingResistance: 1.06,
          grip: { road: 0.95, dirt: 1.06, gravel: 1.09, mud: 1.12, deepMud: 1.12, wet: 1.06 },
        },
      }),
      tirePart(baseId, 'at-33-wide', '33-inch wide all-terrain', 'A wider footprint for extra flotation and mixed-surface grip.', GRAVEL_CARCASS, 38, {
        effects: {
          wheelRadius: 0.4191, wheelWidth: 0.35, tireMassPenalty: 0.11, steeringMult: 0.9, rollingResistance: 1.06,
          grip: { road: 0.93, dirt: 1.06, gravel: 1.09, mud: 1.18, deepMud: 1.20, wet: 1.06 },
        },
      }),
      tirePart(baseId, 'mt-33', '33-inch mud-terrain', 'More mud bite with extra road noise and drag.', MUD_CARCASS, 36, {
        effects: {
          wheelRadius: 0.4191, wheelWidth: 0.31, tireMassPenalty: 0.08, steeringMult: 0.9, rollingResistance: 1.13,
          grip: mudTerrain(0.89, 1.08, 1.24, 1.30),
        },
      }),
      tirePart(baseId, 'mt-35', '35-inch mud-terrain', 'More clearance and mud grip; slower steering.', MUD_CARCASS, 52, {
        effects: {
          wheelRadius: 0.4445, wheelWidth: 0.34, tireMassPenalty: 0.16, steeringMult: 0.78, rollingResistance: 1.13,
          grip: mudTerrain(0.86, 1.20, 1.35, 1.46),
        },
        requires: [flexLift],
        ruleSubject: '35-inch tyres require',
      }),
      tirePart(baseId, 'mt-35-wide', '35-inch wide mud-terrain', 'A broad 35-inch footprint for deep mud and soft terrain.', MUD_CARCASS, 64, {
        effects: {
          wheelRadius: 0.4445, wheelWidth: 0.38, tireMassPenalty: 0.19, steeringMult: 0.78, rollingResistance: 1.13,
          grip: mudTerrain(0.86, 1.20, 1.43, 1.56),
        },
        requires: [flexLift],
        ruleSubject: '35-inch tyres require',
      }),
      tirePart(baseId, 'mt-37', '37-inch mud-terrain', 'Serious obstacle clearance and mud grip with heavier steering.', MUD_CARCASS, 78, {
        effects: {
          wheelRadius: 0.4699, wheelWidth: 0.39, tireMassPenalty: 0.22, steeringMult: 0.70, rollingResistance: 1.13,
          grip: mudTerrain(0.82, 1.35, 1.46, 1.59),
        },
        requires: [flexLift],
        ruleSubject: '37-inch tyres require',
      }),
      tirePart(baseId, 'xt-40-wide', '40-inch wide extreme-terrain', 'The largest tyre package; built for portals and extreme trails.', EXTREME_CARCASS, 108, {
        effects: {
          wheelRadius: 0.508, wheelWidth: 0.42, tireMassPenalty: 0.28, steeringMult: 0.62, rollingResistance: 1.13,
          grip: mudTerrain(0.78, 1.78, 1.58, 1.74),
        },
        requires: [flexLift, portalAxles],
        ruleSubject: '40-inch tyres require',
      }),
    ],
    wheels: [
      part(baseId, 'wheelId', 'factory', 'Factory wheels', 'Original lightweight wheel package.'),
      part(baseId, 'wheelId', 'classic-steel', 'Classic steel wheels', 'Strong steel wheel with extra unsprung mass.', 18),
      part(baseId, 'wheelId', 'beadlock-alloy', 'Beadlock-style alloys', 'Trail-focused alloy with a broad stance.', 10, {
        effects: { trackGain: 0.06, pressureReliefPsi: 4 },
      }),
    ],
    frontBars: [
      part(baseId, 'frontBarId', 'factory', 'Factory bumper', 'Light and close-fitting.'),
      part(baseId, 'frontBarId', 'alloy-hoop', 'Alloy hoop bar', 'Light frontal protection; no winch cradle.', 34, {
        effects: { bullbarEngineProtection: 0.22, overhangMassKg: 34 },
      }),
      steelWinchBar,
    ],
    winches: [
      part(baseId, 'winchId', 'none', 'No winch', 'No winch fitted.'),
      part(baseId, 'winchId', 'fitted', 'Fitted recovery winch', 'Physics-driven recovery from strong scenery and other vehicles.', 38, {
        effects: { winch: true },
        requires: [steelWinchBar],
        ruleSubject: 'A winch requires',
      }),
    ],
    snorkels: [
      part(baseId, 'snorkelId', 'none', 'Factory intake', 'Standard wading intake point.'),
      part(baseId, 'snorkelId', 'fitted', 'Raised snorkel', 'Raises the real engine flooding point.', 7, {
        effects: { intakeRaise: 0.86 },
      }),
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

/** First prerequisite of `option` that `build` does not have fitted. */
function missingRequirement(build: VehicleBuild, option: VehiclePartOption): VehiclePartOption | undefined {
  return option.requires.find((needed) => build[needed.slot] !== needed.id);
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
  // Slot order, so a dependant is checked after the prerequisites it names
  // have been settled. Unmet -> back to stock, which never has requirements.
  for (const slot of VEHICLE_PART_SLOTS) {
    const option = selectedPart(build, slot);
    const missing = missingRequirement(build, option);
    if (!missing) continue;
    issues.push(`${option.ruleSubject ?? `${option.name} requires`} the ${missing.name.toLowerCase()}`);
    build[slot] = stock[slot];
  }
  const base = BASE_TUNING[baseId];
  if ((base.drivetrain ?? 'selectable-4wd') === 'fixed-rwd' && build.frontLocker) {
    issues.push(`The ${base.name} has no front differential locker`);
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

/** Requirement text used by the workshop before committing a selection.
 *  Reads the same `requires` lists the normaliser enforces. */
export function partCompatibility(
  current: VehicleBuild,
  slot: VehiclePartSlot,
  optionId: string,
): { enabled: boolean; reason?: string } {
  const option = optionFor(current.baseId, slot, optionId);
  if (!option) return { enabled: false, reason: 'Not available for this vehicle.' };
  const missing = missingRequirement(current, option);
  if (missing) return { enabled: false, reason: `Requires the ${missing.name.toLowerCase()}.` };
  return { enabled: true };
}

/** The catalog entry fitted in `slot`. Falls back to the base's stock part
 *  for an id the catalog does not know, so an unnormalised build still
 *  resolves to something real. */
export function selectedPart(build: VehicleBuild, slot: VehiclePartSlot): VehiclePartOption {
  return optionFor(build.baseId, slot, build[slot])
    ?? optionFor(build.baseId, slot, createStockBuild(build.baseId)[slot])!;
}

/** Whether the build carries a winch that can actually be used: a winch part
 *  with every prerequisite fitted. Room and client both gate on this. */
export function winchReady(build: VehicleBuild): boolean {
  const winch = selectedPart(build, 'winchId');
  return winch.effects.winch === true && !missingRequirement(build, winch);
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
  tireCarcass: TireCarcassSpec;
  wheelAssemblyMassKg: number;
  wheelInertiaKgM2: number;
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
  drivetrain: 'selectable-4wd' | 'fixed-rwd';
  differentials: { front: DifferentialSpec; rear: DifferentialSpec };
  collisionRoofY: number;
  finalDriveMult: number;
  /** Portal hub drop, m; already included in rest length and clearance. */
  portalClearance: number;
  /** Scale of the axle tube and housing collision probes. */
  axleProbeScale: number;
  /** Lowest pressure the driver may air down to, psi. */
  minPressurePsi: number;
}

function selectedMass(build: VehicleBuild): number {
  let total = 0;
  for (const slot of VEHICLE_PART_SLOTS) total += selectedPart(build, slot).massKg;
  return total;
}

/** Pure build -> render/physics specification. Never reads mutable runtime tuning. */
export function resolveVehicleSpec(value: VehicleBuild | unknown): ResolvedVehicleSpec {
  const build = normalizeVehicleBuild(value);
  const base = BASE_TUNING[build.baseId];
  const tirePart = selectedPart(build, 'tireId');
  const wheelPart = selectedPart(build, 'wheelId');
  const suspension = selectedPart(build, 'suspensionId').effects;
  const axle = selectedPart(build, 'axleId').effects;
  const tire = tirePart.effects;
  const wheel = wheelPart.effects;
  const frontBar = selectedPart(build, 'frontBarId').effects;
  const snorkel = selectedPart(build, 'snorkelId').effects;
  const tireCarcass = tirePart.tireCarcass ?? ROAD_CARCASS;
  const fixedRwd = (base.drivetrain ?? 'selectable-4wd') === 'fixed-rwd';
  const stockWheelRadius = base.stockWheelRadius ?? 0.39;
  const lift = suspension.lift ?? 0;
  const wheelRadius = tire.wheelRadius ?? stockWheelRadius;
  const wheelWidth = tire.wheelWidth ?? base.stockWheelWidth ?? 0.28;
  const tireMassPenalty = tire.tireMassPenalty ?? 0;
  const axleTrackGain = axle.trackGain ?? 0;
  const portalClearance = axle.portalClearance ?? 0;
  const roofMass = selectedPart(build, 'roofId').massKg;
  const frontMass = frontBar.overhangMassKg ?? 0;
  const extraMass = selectedMass(build);
  const intakeRaise = snorkel.intakeRaise ?? 0;
  const wheelAssemblyMassKg = Math.max(
    12,
    (base.wheelAssemblyMassKg ?? 36) + (tirePart.massKg + wheelPart.massKg) * 0.25,
  );
  return {
    build,
    displayName: base.name,
    character: base.character,
    chassisHalfExtents: { ...base.half },
    wheelbase: base.wheelbase,
    track: base.track + axleTrackGain + (wheel.trackGain ?? 0),
    wheelRadius,
    wheelWidth,
    tireCarcass,
    wheelAssemblyMassKg,
    wheelInertiaKgM2: 0.72 * wheelAssemblyMassKg * wheelRadius * wheelRadius,
    massKg: base.massKg + extraMass,
    powerMult: base.powerMult,
    frontSpring: base.frontSpring * (suspension.frontSpringMult ?? 1),
    rearSpring: base.rearSpring * (suspension.rearSpringMult ?? 1),
    suspensionRestLength: (base.suspensionRestLength ?? 0.50) + lift + portalClearance,
    droop: (base.droop ?? 0.27) + (suspension.droop ?? 0),
    articulation: base.articulation * (suspension.articulationMult ?? 1),
    intakeHeight: base.intakeHeight + intakeRaise,
    damageResistance: base.damageResistance,
    bullbarEngineProtection: frontBar.bullbarEngineProtection ?? 0,
    centerOfMass: {
      x: 0,
      y: -base.half.y * 0.58 + lift * 0.4 + roofMass / 1400,
      z: (frontMass * 1.35 - Math.max(0, extraMass - frontMass - roofMass) * 0.75) / (base.massKg + extraMass),
    },
    inertiaMult: 1 + tireMassPenalty + extraMass / Math.max(1800, base.massKg) * 0.35,
    rollingResistanceMult: (tire.rollingResistance ?? 1) + tireMassPenalty,
    steeringResponse: base.steeringResponse * (tire.steeringMult ?? 1),
    maxSteerMult: build.frontLocker ? 0.9 : 1,
    stability: Math.min(1, Math.max(0.35, base.stability - (suspension.rollPenalty ?? 0) - roofMass / 500 + axleTrackGain * 0.45)),
    groundClearance: (base.groundClearance ?? 0.23) + lift
      + (wheelRadius - stockWheelRadius) + portalClearance,
    wadingDepth: base.half.y + base.intakeHeight + intakeRaise,
    grip: { ...(tire.grip ?? NEUTRAL_GRIP) },
    lowRangeRatio: base.lowRangeRatio ?? 2.65,
    drivetrain: base.drivetrain ?? 'selectable-4wd',
    differentials: {
      front: fixedRwd
        ? { mode: 'open', torqueBiasRatio: 1, preloadNm: 0 }
        : { mode: 'selectable-locker', torqueBiasRatio: 1, preloadNm: 0 },
      rear: fixedRwd && build.rearLocker
        ? { mode: 'lsd', torqueBiasRatio: 2.5, preloadNm: 40 }
        : fixedRwd
          ? { mode: 'open', torqueBiasRatio: 1, preloadNm: 0 }
          : { mode: 'selectable-locker', torqueBiasRatio: 1, preloadNm: 0 },
    },
    collisionRoofY: base.collisionRoofY ?? 1.2,
    finalDriveMult: base.finalDriveMult ?? 1,
    portalClearance,
    axleProbeScale: axle.axleProbeScale ?? 1,
    minPressurePsi: Math.max(4, tireCarcass.minPressurePsi - (wheel.pressureReliefPsi ?? 0)),
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

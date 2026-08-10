// What an authored marker *is*: one table, keyed by kind.
//
// SURFACE_INFO and OBJECT_INFO's pattern applied to markers. Before it
// the kind union was a bare string list and everything downstream — the
// decoder's validation, the editor palette, the in-world visual — had to
// invent its own idea of what a "garageBay" was worth showing. Adding a
// sixth kind is now a compile error until this table is complete.
//
// Nothing here imports Rapier or three: the decoder, the editor panel and
// the client's marker meshes all read it.

/** Kinds of authored gameplay marker. `garageBay` is the only one the
 *  simulation currently reads (Room leases bays by marker id); the rest
 *  are carried for the cargo objective on the roadmap. */
export type MarkerKind = 'checkpoint' | 'objective' | 'cargoPickup' | 'cargoDropoff' | 'garageBay';

export interface MarkerInfo {
  label: string;
  /** Seeds the editor's radius slider, and is the radius a freshly placed
   *  marker of this kind carries. */
  defaultRadius: number;
  /** Slider bounds, in metres. */
  radiusLimits: [number, number];
  /** Whether `Marker.yaw` means anything for this kind. A garage bay is a
   *  parking pose, so it does; a checkpoint you can cross either way does
   *  not, and the editor hides the control rather than writing a number
   *  nothing reads. */
  usesYaw: boolean;
  /** Paint colour for the marker's world visual and its editor overlay.
   *  Shared so a bay you place in the editor is the colour it will be in
   *  game. */
  color: number;
  /** Label stamped on a freshly placed marker, numbered by the editor. */
  labelPrefix: string;
  /** One line of authoring guidance, shown under the editor's controls. */
  hint: string;
}

export const MARKER_INFO: Record<MarkerKind, MarkerInfo> = {
  garageBay: {
    label: 'Garage bay',
    // 1.65 m is the shipped workshop bay: half of the 3.3 m spacing that
    // fits three bays under the station canopy, and a tight enough trigger
    // that "in the bay" means centred in it rather than near it.
    defaultRadius: 1.65,
    radiusLimits: [1, 6],
    usesYaw: true,
    color: 0xffc93c,
    labelPrefix: 'Workshop bay',
    hint: 'drive in to open the workshop · yaw is the parked facing',
  },
  checkpoint: {
    label: 'Checkpoint',
    defaultRadius: 6,
    radiusLimits: [2, 30],
    usesYaw: false,
    color: 0x4fc3f7,
    labelPrefix: 'Checkpoint',
    hint: 'carried in the map, not yet simulated',
  },
  objective: {
    label: 'Objective',
    defaultRadius: 6,
    radiusLimits: [2, 30],
    usesYaw: false,
    color: 0xffb74d,
    labelPrefix: 'Objective',
    hint: 'carried in the map, not yet simulated',
  },
  cargoPickup: {
    label: 'Cargo pickup',
    defaultRadius: 4,
    radiusLimits: [2, 20],
    usesYaw: false,
    color: 0x81c784,
    labelPrefix: 'Pickup',
    hint: 'carried in the map, not yet simulated',
  },
  cargoDropoff: {
    label: 'Cargo dropoff',
    defaultRadius: 4,
    radiusLimits: [2, 20],
    usesYaw: false,
    color: 0xba68c8,
    labelPrefix: 'Dropoff',
    hint: 'carried in the map, not yet simulated',
  },
};

/** Every kind, in palette order. Derived from the table so it cannot fall
 *  behind it — the decoder validates against this list. */
export const MARKER_KINDS: readonly MarkerKind[] = Object.keys(MARKER_INFO) as MarkerKind[];

export function isMarkerKind(v: string): v is MarkerKind {
  return Object.prototype.hasOwnProperty.call(MARKER_INFO, v);
}

/** Table lookup with a fallback, matching surfaceInfo/objectInfo. A
 *  decoded document has already been validated, so the fallback only
 *  covers hand-built objects in tests. */
export function markerInfo(kind: MarkerKind): MarkerInfo {
  return MARKER_INFO[kind] ?? MARKER_INFO.checkpoint;
}

// Wrapper around a Rapier world that hosts the terrain + vehicles.
// Lives in the shared package so server and client run the same code.
//
// IMPORTANT: every consumer must `await initRapier()` once before constructing
// a World - Rapier is WASM and needs to load.

import RAPIER from '@dimforge/rapier3d-compat';
import { GRAVITY_Y } from '../constants.js';
import { SolidAxleVehicle } from './solidAxleVehicle.js';
import type { CarKind } from '../types.js';
import type { VehicleLike, VehicleSpawn } from './vehicleTypes.js';
import { generateTerrain, type TerrainData, type TerrainOptions } from './terrain.js';
import { generateObstacles, spawnObstacleColliders, type Obstacle } from './obstacles.js';
import { landmarksFor, spawnLandmarkColliders, type Landmarks } from './landmarks.js';
// Type-only: the map layer composes terrain from physics, so a value
// import here would close the cycle.
import type { MapWorld } from '../map/applyMapDoc.js';

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

export interface WorldOptions {
  /** A composed map document. Preferred over the two below: it carries
   *  the authored obstacles as well as the terrain, and regenerating
   *  obstacles from the terrain would silently drop the author's
   *  additions and resurrect their deletions. */
  map?: MapWorld;
  /** Either pre-built terrain data (e.g. received from the server) or
   *  generation options - the constructor will generate if needed.
   *  Both regenerate obstacles procedurally, so they describe the
   *  procedural world only. Kept for tests and fixtures. */
  terrain?: TerrainData;
  generate?: TerrainOptions;
}

export class World {
  readonly rapier: typeof RAPIER;
  readonly world: RAPIER.World;
  readonly vehicles = new Map<string, VehicleLike>();
  readonly terrain: TerrainData;
  readonly obstacles: Obstacle[];
  readonly landmarks: Landmarks;
  /** The static heightfield. Readonly now that ruts are gone - the
   *  terrain collider is built once and never swapped, which is what
   *  lets every consumer cache terrain-derived data for the session. */
  readonly terrainBody: RAPIER.RigidBody;
  readonly terrainCollider: RAPIER.Collider;
  private obstacleBodies: RAPIER.RigidBody[] = [];
  private landmarkBodies: RAPIER.RigidBody[] = [];

  constructor(opts: WorldOptions = {}) {
    this.rapier = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
    this.terrain = opts.map?.terrain ?? opts.terrain ?? generateTerrain(opts.generate);
    const built = this.buildTerrain(this.terrain);
    this.terrainBody = built.body;
    this.terrainCollider = built.collider;
    // Without a map the obstacles are deterministic from the terrain, so
    // every consumer reaches the same list from the seed alone. With one
    // they are whatever the author left, and only the document knows.
    this.obstacles = opts.map?.obstacles ?? generateObstacles(this.terrain);
    this.obstacleBodies = spawnObstacleColliders(this.world, this.obstacles);
    this.landmarks = opts.map?.landmarks ?? landmarksFor(this.terrain);
    this.landmarkBodies = spawnLandmarkColliders(this.world, this.landmarks);
  }

  private buildTerrain(t: TerrainData): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const n = t.resolution;
    const scale = { x: t.size, y: 1, z: t.size };
    // Rapier's heightfield expects a column-major (i.e. transposed) matrix:
    // index = col * nrows + row, where row indexes Z and col indexes X.
    // Our generator stores row-major, so transpose here.
    const transposed = new Float32Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        transposed[c * n + r] = t.heights[r * n + c]!;
      }
    }
    const colliderDesc = RAPIER.ColliderDesc.heightfield(
      n - 1,
      n - 1,
      transposed,
      scale,
    ).setFriction(1.0);
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0);
    const body = this.world.createRigidBody(bodyDesc);
    const collider = this.world.createCollider(colliderDesc, body);
    return { body, collider };
  }

  spawnVehicle(id: string, spawn: VehicleSpawn, kind: CarKind = 'patrol'): VehicleLike {
    const v: VehicleLike = new SolidAxleVehicle(this, id, spawn, kind);
    this.vehicles.set(id, v);
    return v;
  }

  removeVehicle(id: string): void {
    const v = this.vehicles.get(id);
    if (!v) return;
    v.dispose();
    this.vehicles.delete(id);
  }

  /** Advance the simulation by exactly one fixed step. */
  step(): void {
    for (const v of this.vehicles.values()) v.preStep();
    this.world.step();
    for (const v of this.vehicles.values()) v.postStep();
  }

  dispose(): void {
    for (const v of this.vehicles.values()) v.dispose();
    this.vehicles.clear();
    for (const b of this.obstacleBodies) this.world.removeRigidBody(b);
    this.obstacleBodies = [];
    for (const b of this.landmarkBodies) this.world.removeRigidBody(b);
    this.landmarkBodies = [];
    this.world.free();
  }
}

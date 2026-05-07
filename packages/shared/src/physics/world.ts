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

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

export interface WorldOptions {
  /** Either pre-built terrain data (e.g. received from the server) or
   *  generation options - the constructor will generate if needed. */
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
  private obstacleBodies: RAPIER.RigidBody[] = [];
  private landmarkBodies: RAPIER.RigidBody[] = [];

  constructor(opts: WorldOptions = {}) {
    this.rapier = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
    this.terrain = opts.terrain ?? generateTerrain(opts.generate);
    this.buildTerrain(this.terrain);
    // Obstacles are deterministic from the same seed - both client and
    // server generate identical lists, no network sync needed.
    this.obstacles = generateObstacles(this.terrain);
    this.obstacleBodies = spawnObstacleColliders(this.world, this.obstacles);
    this.landmarks = landmarksFor(this.terrain);
    this.landmarkBodies = spawnLandmarkColliders(this.world, this.landmarks);
  }

  private buildTerrain(t: TerrainData): void {
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
    this.world.createCollider(colliderDesc, body);
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

// Wrapper around a Rapier world that hosts the terrain + vehicles.
// Lives in the shared package so server and client run the same code.
//
// IMPORTANT: every consumer must `await initRapier()` once before constructing
// a World - Rapier is WASM and needs to load.

import RAPIER from '@dimforge/rapier3d-compat';
import { GRAVITY_Y } from '../constants.js';
import { Vehicle, type VehicleSpawn } from './vehicle.js';
import { generateTerrain, type TerrainData, type TerrainOptions } from './terrain.js';

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
  readonly vehicles = new Map<string, Vehicle>();
  readonly terrain: TerrainData;
  private terrainBody: RAPIER.RigidBody;
  private terrainCollider: RAPIER.Collider;

  constructor(opts: WorldOptions = {}) {
    this.rapier = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
    this.terrain = opts.terrain ?? generateTerrain(opts.generate);
    const built = this.buildTerrain(this.terrain);
    this.terrainBody = built.body;
    this.terrainCollider = built.collider;
  }

  private buildTerrain(t: TerrainData): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const n = t.resolution;
    const scale = { x: t.size, y: 1, z: t.size };
    const colliderDesc = RAPIER.ColliderDesc.heightfield(
      n - 1,
      n - 1,
      t.heights,
      scale,
    ).setFriction(1.0);
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0);
    const body = this.world.createRigidBody(bodyDesc);
    const collider = this.world.createCollider(colliderDesc, body);
    return { body, collider };
  }

  /** Replace the heightfield in place (used by deformable ruts). Existing
   *  vehicles stay attached to the world; only the static terrain swaps. */
  rebuildTerrain(): void {
    this.world.removeCollider(this.terrainCollider, true);
    this.world.removeRigidBody(this.terrainBody);
    const built = this.buildTerrain(this.terrain);
    this.terrainBody = built.body;
    this.terrainCollider = built.collider;
  }

  spawnVehicle(id: string, spawn: VehicleSpawn): Vehicle {
    const v = new Vehicle(this, id, spawn);
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
    this.world.free();
  }
}

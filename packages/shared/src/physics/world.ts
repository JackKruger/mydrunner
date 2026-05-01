// Wrapper around a Rapier world that hosts the terrain + vehicles.
// Lives in the shared package so server and client run the same code.
//
// IMPORTANT: every consumer must `await initRapier()` once before constructing
// a World - Rapier is WASM and needs to load.

import RAPIER from '@dimforge/rapier3d-compat';
import { GRAVITY_Y } from '../constants.js';
import { Vehicle, type VehicleSpawn } from './vehicle.js';

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

export interface WorldOptions {
  /** Heightmap size in world units (X/Z extent). */
  size?: number;
  /** Heightmap resolution (samples per side, must be power-of-two friendly). */
  resolution?: number;
  /** Optional seeded heights array (length = resolution * resolution). If
   *  omitted, a flat plane is used. */
  heights?: Float32Array;
}

export class World {
  readonly rapier: typeof RAPIER;
  readonly world: RAPIER.World;
  readonly vehicles = new Map<string, Vehicle>();
  readonly size: number;
  readonly resolution: number;
  readonly heights: Float32Array;

  constructor(opts: WorldOptions = {}) {
    this.rapier = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
    this.size = opts.size ?? 200;
    this.resolution = opts.resolution ?? 64;
    this.heights =
      opts.heights ?? new Float32Array(this.resolution * this.resolution);
    this.buildTerrain();
  }

  private buildTerrain(): void {
    const n = this.resolution;
    // Rapier's heightfield expects (n+1) x (n+1) samples for n cells, but the
    // compat build accepts an n x n Float32Array indexed col-major.
    const halfSize = this.size / 2;
    const scale = { x: this.size, y: 1, z: this.size };
    const colliderDesc = RAPIER.ColliderDesc.heightfield(
      n - 1,
      n - 1,
      this.heights,
      scale,
    ).setFriction(1.0);
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0);
    const body = this.world.createRigidBody(bodyDesc);
    this.world.createCollider(colliderDesc, body);
    void halfSize; // reserved for future bounds walls
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

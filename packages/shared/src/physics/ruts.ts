// Session-only rut deformation. This is deliberately separate from the
// coarse Rapier heightfield: wheel support samples this 25 cm field while
// the unchanged chassis collider remains the firm layer for belly-out.

import { RUT_MAX_DEPTH } from '../constants.js';

export const RUT_CELL_SIZE = 0.25;
export const RUT_TILE_CELLS = 16;
export const RUT_TILE_DEPTH_BYTES = RUT_TILE_CELLS * RUT_TILE_CELLS;

export interface RutStamp {
  ownerId: string;
  ownerSequence: number;
  globalSequence: number;
  x: number;
  z: number;
  heading: number;
  radiusLong: number;
  radiusLat: number;
  depth: number;
}

export interface PredictedRutStamp extends Omit<RutStamp, 'ownerId' | 'globalSequence'> {}

export interface RutTilePayload {
  tileX: number;
  tileZ: number;
  depths: Uint8Array;
}

export interface RutDirtyTile {
  tileX: number;
  tileZ: number;
}

export interface RutDepthField {
  sampleDepth(x: number, z: number): number;
}

/** Sparse, session-only 25 cm deformation field. */
export class SparseRutField {
  private readonly tiles = new Map<string, Uint8Array>();

  constructor(readonly worldSize: number) {}

  sampleDepth(x: number, z: number): number {
    const gx = (x + this.worldSize * 0.5) / RUT_CELL_SIZE;
    const gz = (z + this.worldSize * 0.5) / RUT_CELL_SIZE;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const tx = gx - x0;
    const tz = gz - z0;
    const a = this.depthAtCell(x0, z0);
    const b = this.depthAtCell(x0 + 1, z0);
    const c = this.depthAtCell(x0, z0 + 1);
    const d = this.depthAtCell(x0 + 1, z0 + 1);
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
  }

  applyStamp(stamp: Pick<RutStamp, 'x' | 'z' | 'heading' | 'radiusLong' | 'radiusLat' | 'depth'>): RutDirtyTile[] {
    const longRadius = clamp(stamp.radiusLong, RUT_CELL_SIZE, 1.5);
    const latRadius = clamp(stamp.radiusLat, RUT_CELL_SIZE * 0.5, 0.8);
    const maxRadius = Math.max(longRadius, latRadius);
    const minX = this.worldToCell(stamp.x - maxRadius);
    const maxX = this.worldToCell(stamp.x + maxRadius);
    const minZ = this.worldToCell(stamp.z - maxRadius);
    const maxZ = this.worldToCell(stamp.z + maxRadius);
    const sin = Math.sin(stamp.heading);
    const cos = Math.cos(stamp.heading);
    const dirty = new Map<string, RutDirtyTile>();
    for (let gz = minZ; gz <= maxZ; gz++) {
      const z = gz * RUT_CELL_SIZE - this.worldSize * 0.5;
      for (let gx = minX; gx <= maxX; gx++) {
        const x = gx * RUT_CELL_SIZE - this.worldSize * 0.5;
        const dx = x - stamp.x;
        const dz = z - stamp.z;
        const along = dx * sin + dz * cos;
        const across = dx * cos - dz * sin;
        const q = (along * along) / (longRadius * longRadius)
          + (across * across) / (latRadius * latRadius);
        if (q > 1) continue;
        const falloff = (1 - q) * (1 - q);
        if (this.addDepthAtCell(gx, gz, stamp.depth * falloff)) {
          const tileX = floorDiv(gx, RUT_TILE_CELLS);
          const tileZ = floorDiv(gz, RUT_TILE_CELLS);
          dirty.set(tileKey(tileX, tileZ), { tileX, tileZ });
        }
      }
    }
    return [...dirty.values()].sort((a, b) => a.tileZ - b.tileZ || a.tileX - b.tileX);
  }

  applyTile(tile: RutTilePayload): RutDirtyTile[] {
    if (tile.depths.length !== RUT_TILE_DEPTH_BYTES) throw new Error('rut tile: invalid byte length');
    this.tiles.set(tileKey(tile.tileX, tile.tileZ), new Uint8Array(tile.depths));
    return [{ tileX: tile.tileX, tileZ: tile.tileZ }];
  }

  clear(): void { this.tiles.clear(); }

  exportTiles(): RutTilePayload[] {
    const result: RutTilePayload[] = [];
    for (const [key, depths] of this.tiles) {
      const comma = key.indexOf(',');
      result.push({
        tileX: Number(key.slice(0, comma)),
        tileZ: Number(key.slice(comma + 1)),
        depths: new Uint8Array(depths),
      });
    }
    result.sort((a, b) => a.tileZ - b.tileZ || a.tileX - b.tileX);
    return result;
  }

  private worldToCell(value: number): number {
    return Math.floor((value + this.worldSize * 0.5) / RUT_CELL_SIZE);
  }

  private depthAtCell(gx: number, gz: number): number {
    const tileX = floorDiv(gx, RUT_TILE_CELLS);
    const tileZ = floorDiv(gz, RUT_TILE_CELLS);
    const tile = this.tiles.get(tileKey(tileX, tileZ));
    if (!tile) return 0;
    const localX = positiveMod(gx, RUT_TILE_CELLS);
    const localZ = positiveMod(gz, RUT_TILE_CELLS);
    return tile[localZ * RUT_TILE_CELLS + localX]! / 255 * RUT_MAX_DEPTH;
  }

  private addDepthAtCell(gx: number, gz: number, depth: number): boolean {
    if (depth <= 0) return false;
    const tileX = floorDiv(gx, RUT_TILE_CELLS);
    const tileZ = floorDiv(gz, RUT_TILE_CELLS);
    const key = tileKey(tileX, tileZ);
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = new Uint8Array(RUT_TILE_DEPTH_BYTES);
      this.tiles.set(key, tile);
    }
    const index = positiveMod(gz, RUT_TILE_CELLS) * RUT_TILE_CELLS
      + positiveMod(gx, RUT_TILE_CELLS);
    const increment = Math.max(1, Math.round(depth / RUT_MAX_DEPTH * 255));
    const before = tile[index]!;
    tile[index] = Math.min(255, before + increment);
    return tile[index] !== before;
  }
}

/** Owner-side authoritative + pending-prediction replica. Physics and
 * rendering both sample `combined`; accepting or rejecting one proposal
 * rebuilds from authoritative bytes so saturation can never make a rollback
 * subtract depth belonging to another stamp. */
export class RutSessionReplica implements RutDepthField {
  private readonly authoritative: SparseRutField;
  private readonly combined: SparseRutField;
  private readonly pending = new Map<number, PredictedRutStamp>();
  private readonly applied = new Set<string>();

  constructor(readonly worldSize: number, private readonly localOwnerId: string) {
    this.authoritative = new SparseRutField(worldSize);
    this.combined = new SparseRutField(worldSize);
  }

  get pendingCount(): number { return this.pending.size; }

  sampleDepth(x: number, z: number): number { return this.combined.sampleDepth(x, z); }

  predict(stamp: PredictedRutStamp): RutDirtyTile[] {
    this.pending.set(stamp.ownerSequence, { ...stamp });
    return this.combined.applyStamp(stamp);
  }

  applyTile(tile: RutTilePayload): RutDirtyTile[] {
    const dirty = this.authoritative.applyTile(tile);
    this.rebuildCombined();
    return dirty;
  }

  applyAuthoritative(stamps: readonly RutStamp[]): RutDirtyTile[] {
    const dirty = new Map<string, RutDirtyTile>();
    for (const stamp of stamps) {
      const id = stampKey(stamp.ownerId, stamp.ownerSequence);
      if (this.applied.has(id)) continue;
      this.applied.add(id);
      if (stamp.ownerId === this.localOwnerId) this.pending.delete(stamp.ownerSequence);
      for (const tile of this.authoritative.applyStamp(stamp)) {
        dirty.set(tileKey(tile.tileX, tile.tileZ), tile);
      }
    }
    if (dirty.size > 0) this.rebuildCombined();
    return [...dirty.values()].sort((a, b) => a.tileZ - b.tileZ || a.tileX - b.tileX);
  }

  resolve(ownerSequence: number, accepted: boolean, globalSequence?: number): RutDirtyTile[] {
    const proposal = this.pending.get(ownerSequence);
    if (!proposal) return [];
    this.pending.delete(ownerSequence);
    const dirty = stampTiles(proposal, this.worldSize);
    if (accepted) {
      if (!Number.isSafeInteger(globalSequence) || (globalSequence ?? 0) <= 0) {
        throw new Error('accepted rut result requires a positive global sequence');
      }
      const stamp: RutStamp = {
        ...proposal,
        ownerId: this.localOwnerId,
        globalSequence: globalSequence!,
      };
      const id = stampKey(stamp.ownerId, stamp.ownerSequence);
      if (!this.applied.has(id)) {
        this.applied.add(id);
        this.authoritative.applyStamp(stamp);
      }
    }
    this.rebuildCombined();
    return dirty;
  }

  exportTiles(): RutTilePayload[] { return this.combined.exportTiles(); }
  exportAuthoritativeTiles(): RutTilePayload[] { return this.authoritative.exportTiles(); }

  private rebuildCombined(): void {
    this.combined.clear();
    for (const tile of this.authoritative.exportTiles()) this.combined.applyTile(tile);
    const ordered = [...this.pending.values()].sort((a, b) => a.ownerSequence - b.ownerSequence);
    for (const stamp of ordered) this.combined.applyStamp(stamp);
  }
}

function stampTiles(
  stamp: Pick<RutStamp, 'x' | 'z' | 'radiusLong' | 'radiusLat'>,
  worldSize: number,
): RutDirtyTile[] {
  const radius = Math.max(stamp.radiusLong, stamp.radiusLat);
  const minX = Math.floor(((stamp.x - radius) + worldSize * 0.5) / RUT_CELL_SIZE);
  const maxX = Math.floor(((stamp.x + radius) + worldSize * 0.5) / RUT_CELL_SIZE);
  const minZ = Math.floor(((stamp.z - radius) + worldSize * 0.5) / RUT_CELL_SIZE);
  const maxZ = Math.floor(((stamp.z + radius) + worldSize * 0.5) / RUT_CELL_SIZE);
  const result: RutDirtyTile[] = [];
  for (let tileZ = floorDiv(minZ, RUT_TILE_CELLS); tileZ <= floorDiv(maxZ, RUT_TILE_CELLS); tileZ++) {
    for (let tileX = floorDiv(minX, RUT_TILE_CELLS); tileX <= floorDiv(maxX, RUT_TILE_CELLS); tileX++) {
      result.push({ tileX, tileZ });
    }
  }
  return result;
}

function stampKey(ownerId: string, ownerSequence: number): string {
  return `${ownerId}:${ownerSequence}`;
}

function tileKey(x: number, z: number): string { return `${x},${z}`; }
function floorDiv(value: number, divisor: number): number { return Math.floor(value / divisor); }
function positiveMod(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }
function clamp(value: number, min: number, max: number): number { return value < min ? min : value > max ? max : value; }

import { describe, expect, it } from 'vitest';
import { RUT_TILE_DEPTH_BYTES, RutSessionReplica, SparseRutField } from '../physics/ruts.js';
import { RUT_MAX_DEPTH } from '../constants.js';

describe('SparseRutField', () => {
  it('quantizes elliptical stamps into sparse 16x16 tiles', () => {
    const field = new SparseRutField(100);
    field.applyStamp({ x: 0, z: 0, heading: 0, radiusLong: 0.8, radiusLat: 0.25, depth: 0.03 });
    expect(field.sampleDepth(0, 0)).toBeGreaterThan(0);
    const tiles = field.exportTiles();
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((tile) => tile.depths.length === RUT_TILE_DEPTH_BYTES)).toBe(true);
  });

  it('round-trips late-join tiles with bilinear support depth', () => {
    const owner = new SparseRutField(100);
    owner.applyStamp({ x: 1, z: -2, heading: 0.4, radiusLong: 1, radiusLat: 0.3, depth: 0.02 });
    const joiner = new SparseRutField(100);
    for (const tile of owner.exportTiles()) joiner.applyTile(tile);
    expect(joiner.sampleDepth(1, -2)).toBeCloseTo(owner.sampleDepth(1, -2), 8);
  });

  it('saturates accumulated stamps at the 8-bit depth limit', () => {
    const field = new SparseRutField(100);
    const stamp = { x: 0, z: 0, heading: 0, radiusLong: 0.8, radiusLat: 0.25, depth: 0.04 };
    for (let i = 0; i < 100; i++) field.applyStamp(stamp);
    expect(field.sampleDepth(0, 0)).toBeCloseTo(RUT_MAX_DEPTH, 8);
  });

  it('reports deterministic dirty tiles for incremental consumers', () => {
    const field = new SparseRutField(100);
    const dirty = field.applyStamp({
      x: 0, z: 0, heading: 0, radiusLong: 0.8, radiusLat: 0.25, depth: 0.03,
    });
    expect(dirty).toEqual([...dirty].sort((a, b) => a.tileZ - b.tileZ || a.tileX - b.tileX));
    expect(dirty.length).toBeGreaterThan(0);
  });
});

describe('RutSessionReplica', () => {
  const proposal = {
    ownerSequence: 1, x: 0, z: 0, heading: 0,
    radiusLong: 0.8, radiusLat: 0.25, depth: 0.03,
  };

  it('samples prediction immediately and removes it on rejection', () => {
    const replica = new RutSessionReplica(100, 'owner');
    replica.predict(proposal);
    expect(replica.sampleDepth(0, 0)).toBeGreaterThan(0);
    expect(replica.exportAuthoritativeTiles()).toEqual([]);
    replica.resolve(1, false);
    expect(replica.sampleDepth(0, 0)).toBe(0);
    expect(replica.pendingCount).toBe(0);
  });

  it('deduplicates an accepted prediction against its authoritative batch', () => {
    const replica = new RutSessionReplica(100, 'owner');
    replica.predict(proposal);
    const predictedDepth = replica.sampleDepth(0, 0);
    replica.resolve(1, true, 7);
    replica.applyAuthoritative([{ ...proposal, ownerId: 'owner', globalSequence: 7 }]);
    expect(replica.sampleDepth(0, 0)).toBe(predictedDepth);
    expect(replica.pendingCount).toBe(0);
  });

  it('rolls back one pending stamp without altering authoritative bytes', () => {
    const replica = new RutSessionReplica(100, 'owner');
    replica.applyAuthoritative([{ ...proposal, ownerId: 'peer', globalSequence: 1 }]);
    const before = replica.exportAuthoritativeTiles();
    replica.predict({ ...proposal, ownerSequence: 2, x: 0.25 });
    replica.resolve(2, false);
    expect(replica.exportAuthoritativeTiles()).toEqual(before);
  });
});

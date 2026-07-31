// The production world, at the size and resolution players actually get.
//
// Every other physics test builds a small custom world (size 100-200,
// resolution 32-64) or a synthetic flat/ramp arena. That is right for
// isolating a force, but it meant the shipped map had no coverage at all -
// and for a long time it could not have had any, because room.ts passed a
// hardcoded 320/128 while TERRAIN.defaultSize said 200. The mountain, the
// petrol pad and the map edges are all ratios of size, so those were two
// different worlds and the constants described the one nobody drove on.
//
// This test constructs the world exactly as Room does (no overrides) and
// drives the real spawn path, so a regression in terrain generation or in
// spawn placement fails here rather than on the deployed site.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, TERRAIN } from '@mydrunner/shared';
import { Room, type PlayerHandle } from '../room.js';

beforeAll(async () => {
  await Physics.initRapier();
});

/** Room's spawn grid is 8 columns x 2 lanes. */
const SPAWN_SLOTS = 16;

function makeRoom(): Room {
  return new Room();
}

/** A handle that swallows every message - we read state off the world
 *  directly rather than decoding snapshots. */
function handle(id: string): PlayerHandle {
  return { id, name: id, carKind: 'patrol', send: () => {} };
}

describe('production world', () => {
  it('is the size and resolution the constants advertise', () => {
    const room = makeRoom();
    try {
      expect(room.world.terrain.size).toBe(TERRAIN.defaultSize);
      expect(room.world.terrain.resolution).toBe(TERRAIN.defaultResolution);
      expect(room.world.terrain.seed).toBe(TERRAIN.defaultSeed);
    } finally {
      room.world.dispose();
    }
  });

  it('spawns all 16 players onto drivable road surface', () => {
    const room = makeRoom();
    try {
      for (let i = 0; i < SPAWN_SLOTS; i++) room.addPlayer(handle(`p${i}`));

      const drivable = new Set<number>([
        Physics.Surface.Road,
        Physics.Surface.Concrete,
        Physics.Surface.Dirt,
      ]);
      for (const [id, v] of room.world.vehicles) {
        const t = v.body.translation();
        const surf = Physics.sampleSurface(room.world.terrain, t.x, t.z);
        expect(drivable.has(surf), `${id} spawned on surface ${surf} at x=${t.x.toFixed(1)} z=${t.z.toFixed(1)}`).toBe(true);
      }
    } finally {
      room.world.dispose();
    }
  });

  it('settles a full grid of 16 spawns without falling through or colliding out', () => {
    const room = makeRoom();
    try {
      for (let i = 0; i < SPAWN_SLOTS; i++) room.addPlayer(handle(`p${i}`));

      const startPos = new Map<string, { x: number; y: number; z: number }>();
      for (const [id, v] of room.world.vehicles) {
        const t = v.body.translation();
        startPos.set(id, { x: t.x, y: t.y, z: t.z });
      }

      // 3 s with no input: long enough for suspension to reach equilibrium.
      for (let i = 0; i < 3 * 60; i++) room.world.step();

      for (const [id, v] of room.world.vehicles) {
        const t = v.body.translation();
        const start = startPos.get(id)!;
        const ground = Physics.sampleHeightBilinear(room.world.terrain, t.x, t.z);

        // Above the heightfield, not through it.
        expect(t.y, `${id} fell through the terrain (y=${t.y.toFixed(2)}, ground=${ground.toFixed(2)})`)
          .toBeGreaterThan(ground - 0.5);
        // Slots are 5 m apart; anything that moved further than half that
        // was shoved by a neighbour it spawned inside of.
        const moved = Math.hypot(t.x - start.x, t.z - start.z);
        expect(moved, `${id} was pushed ${moved.toFixed(2)} m from its spawn slot`).toBeLessThan(2.5);
        // And it should be at rest, not still being squeezed out.
        const s = v.getState();
        const speed = Math.hypot(s.linVel.x, s.linVel.y, s.linVel.z);
        expect(speed, `${id} still moving at ${speed.toFixed(3)} m/s after 3 s`).toBeLessThan(0.5);
      }
    } finally {
      room.world.dispose();
    }
  });

  it('keeps the mountain trail climbing and no steeper than it is today', () => {
    // Bounds are measured-from-reality regression guards, NOT the design
    // target. getHillClimbSegments' docstring claims every traverse was
    // verified at <= 30 % grade; against the shipped 320 m heightmap the
    // median is 39 % and the 90th percentile 87 %. That claim was worked
    // out analytically against a bare Gaussian, for a different world
    // size, and before the bench-cut and trail-feature layers ran on top
    // of it - so it never described the map anyone drives. The trail IS
    // climbable (INCLINE_ASSIST_MAX is what pays for it), so this test
    // pins the current shape rather than asserting a number the terrain
    // has never met. A single max-grade bound is useless here: the
    // trailhead junction and the rocky-step feature spike past 500 % over
    // one 2 m sample by design.
    const room = makeRoom();
    try {
      const t = room.world.terrain;
      const segments = Physics.getHillClimbSegments(t.mountain);
      expect(segments.length).toBeGreaterThan(0);

      const grades: number[] = [];
      for (const seg of segments) {
        const len = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
        const steps = Math.max(2, Math.ceil(len / 2)); // sample every ~2 m
        for (let i = 0; i < steps; i++) {
          const t0 = i / steps;
          const t1 = (i + 1) / steps;
          const x0 = seg.ax + (seg.bx - seg.ax) * t0;
          const z0 = seg.az + (seg.bz - seg.az) * t0;
          const x1 = seg.ax + (seg.bx - seg.ax) * t1;
          const z1 = seg.az + (seg.bz - seg.az) * t1;
          const run = Math.hypot(x1 - x0, z1 - z0);
          if (run < 0.01) continue;
          const rise =
            Physics.sampleHeightBilinear(t, x1, z1) - Physics.sampleHeightBilinear(t, x0, z0);
          grades.push(Math.abs(rise) / run);
        }
      }
      grades.sort((a, b) => a - b);
      const pct = (q: number): number => grades[Math.floor(q * (grades.length - 1))]!;
      const p50 = pct(0.5);
      const p90 = pct(0.9);

      expect(p50, `median trail grade ${(p50 * 100).toFixed(0)} % (was 39 %)`).toBeLessThan(0.6);
      expect(p90, `p90 trail grade ${(p90 * 100).toFixed(0)} % (was 87 %)`).toBeLessThan(1.2);

      // The trail has to actually reach the top: a generation bug that
      // flattened the mountain or moved the switchbacks off its face would
      // leave the grades looking fine while the climb went nowhere.
      const head = Physics.sampleHeightBilinear(t, segments[0]!.ax, segments[0]!.az);
      const summit = Physics.sampleHeightBilinear(
        t,
        segments[segments.length - 1]!.bx,
        segments[segments.length - 1]!.bz,
      );
      expect(summit - head, `trail elevation gain ${(summit - head).toFixed(1)} m (was 51.3)`)
        .toBeGreaterThan(45);
    } finally {
      room.world.dispose();
    }
  });
});

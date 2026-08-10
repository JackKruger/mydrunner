// Production client world coverage. The server now distributes map identity
// and spawn poses; each owner constructs this Rapier world in the browser.

import { describe, it, expect, beforeAll } from 'vitest';
import { Maps, Physics, TERRAIN } from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

const SPAWN_SLOTS = Maps.SPAWN_SLOTS;

function makeWorld(): { map: Maps.MapWorld; world: Physics.World } {
  const map = Maps.applyMapDoc(Maps.proceduralDoc());
  return { map, world: new Physics.World({ map }) };
}

function spawnGrid(map: Maps.MapWorld, world: Physics.World): void {
  for (let i = 0; i < SPAWN_SLOTS; i++) {
    world.spawnVehicle(`p${i}`, Maps.resolveSpawn(map, i, 'patrol'), 'patrol');
  }
}

describe('production client world', () => {
  it('is the size and resolution the constants advertise', () => {
    const { world } = makeWorld();
    expect(world.terrain.size).toBe(TERRAIN.defaultSize);
    expect(world.terrain.resolution).toBe(TERRAIN.defaultResolution);
    expect(world.terrain.seed).toBe(TERRAIN.defaultSeed);
    world.dispose();
  });

  it('places all 16 spawn slots on drivable surface', () => {
    const { map, world } = makeWorld();
    const drivable = new Set<number>([
      Physics.Surface.Road,
      Physics.Surface.Concrete,
      Physics.Surface.Dirt,
    ]);
    for (let i = 0; i < SPAWN_SLOTS; i++) {
      const spawn = Maps.resolveSpawn(map, i, 'patrol');
      const surf = Physics.sampleSurface(world.terrain, spawn.position.x, spawn.position.z);
      expect(drivable.has(surf), `slot ${i} spawned on surface ${surf}`).toBe(true);
    }
    world.dispose();
  });

  // 16 vehicles x 180 steps of real Rapier is the heaviest test in the suite,
  // and the compliant tyre model made preStep ~50% dearer. It runs in ~1.7s
  // locally but CI shares a runner between three packages' vitest pools, where
  // it overran the 5s default. Explicit timeout rather than a thinner grid:
  // the whole point is a full spawn grid settling against its neighbours.
  it('settles a full grid without falling through or pushing neighbours', () => {
    const { map, world } = makeWorld();
    spawnGrid(map, world);
    const startPos = new Map<string, { x: number; y: number; z: number }>();
    for (const [id, v] of world.vehicles) {
      const t = v.body.translation();
      startPos.set(id, { x: t.x, y: t.y, z: t.z });
    }
    for (let i = 0; i < 3 * 60; i++) world.step();
    for (const [id, v] of world.vehicles) {
      const t = v.body.translation();
      const start = startPos.get(id)!;
      const ground = Physics.sampleHeightBilinear(world.terrain, t.x, t.z);
      expect(t.y, `${id} fell through`).toBeGreaterThan(ground - 0.5);
      expect(Math.hypot(t.x - start.x, t.z - start.z), `${id} moved from spawn`).toBeLessThan(2.5);
      const s = v.getState();
      expect(Math.hypot(s.linVel.x, s.linVel.y, s.linVel.z), `${id} still moving`).toBeLessThan(0.5);
    }
    world.dispose();
  }, 30000);

  it('keeps the mountain trail climbing and within its current grade envelope', () => {
    const { world } = makeWorld();
    const t = world.terrain;
    const segments = Physics.getHillClimbSegments(t.mountain);
    expect(segments.length).toBeGreaterThan(0);
    const grades: number[] = [];
    for (const seg of segments) {
      const len = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
      const steps = Math.max(2, Math.ceil(len / 2));
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        const x0 = seg.ax + (seg.bx - seg.ax) * t0;
        const z0 = seg.az + (seg.bz - seg.az) * t0;
        const x1 = seg.ax + (seg.bx - seg.ax) * t1;
        const z1 = seg.az + (seg.bz - seg.az) * t1;
        const run = Math.hypot(x1 - x0, z1 - z0);
        if (run < 0.01) continue;
        const rise = Physics.sampleHeightBilinear(t, x1, z1) - Physics.sampleHeightBilinear(t, x0, z0);
        grades.push(Math.abs(rise) / run);
      }
    }
    grades.sort((a, b) => a - b);
    const pct = (q: number): number => grades[Math.floor(q * (grades.length - 1))]!;
    expect(pct(0.5)).toBeLessThan(0.6);
    expect(pct(0.9)).toBeLessThan(1.2);
    const head = Physics.sampleHeightBilinear(t, segments[0]!.ax, segments[0]!.az);
    const summit = Physics.sampleHeightBilinear(
      t,
      segments.at(-1)!.bx,
      segments.at(-1)!.bz,
    );
    expect(summit - head).toBeGreaterThan(45);
    world.dispose();
  });
});

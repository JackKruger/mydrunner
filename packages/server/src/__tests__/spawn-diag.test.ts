import { describe, it, beforeAll } from 'vitest';
import { Physics } from '@mydrunner/shared';

beforeAll(async () => { await Physics.initRapier(); });

describe('spawn movement diagnostic', () => {
  it('prints per-axis movement breakdown', () => {
    const n = 32, size = 100;
    const heights = new Float32Array(n * n);
    const surfaces = new Uint8Array(n * n);
    surfaces.fill(Physics.Surface.Road);
    const world = new Physics.World({
      terrain: { size, resolution: n, heights, surfaces, seed: 0,
        mountain: Physics.mountainFor(size), petrolStation: Physics.petrolStationPadFor(size), bogs: [], roads: [] },
    });

    const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });
    for (let i = 0; i < 3 * 60; i++) world.step();

    const s0 = v.getState();
    console.log(`\nAfter 3s settle:`);
    console.log(`  pos   = (${s0.position.x.toFixed(5)}, ${s0.position.y.toFixed(5)}, ${s0.position.z.toFixed(5)})`);
    console.log(`  linVel= (${s0.linVel.x.toFixed(5)}, ${s0.linVel.y.toFixed(5)}, ${s0.linVel.z.toFixed(5)})`);
    console.log(`  angVel= (${s0.angVel.x.toFixed(5)}, ${s0.angVel.y.toFixed(5)}, ${s0.angVel.z.toFixed(5)})`);

    let maxX = 0, maxY = 0, maxZ = 0;
    console.log('\n tick |  linVel.x  |  linVel.z  |  pos.x delta | pos.z delta');
    for (let i = 0; i < 5 * 60; i++) {
      world.step();
      const s = v.getState();
      const dx = s.position.x - s0.position.x;
      const dy = s.position.y - s0.position.y;
      const dz = s.position.z - s0.position.z;
      maxX = Math.max(maxX, Math.abs(dx));
      maxY = Math.max(maxY, Math.abs(dy));
      maxZ = Math.max(maxZ, Math.abs(dz));
      if (i % 30 === 0)
        console.log(
          `${String(i).padStart(5)} |` +
          ` ${s.linVel.x.toFixed(5).padStart(10)} |` +
          ` ${s.linVel.z.toFixed(5).padStart(10)} |` +
          ` ${(dx * 100).toFixed(2).padStart(11)}cm |` +
          ` ${(dz * 100).toFixed(2).padStart(10)}cm`,
        );
    }
    console.log(`\nMax drift from rest: x=${(maxX*100).toFixed(2)}cm  y=${(maxY*100).toFixed(2)}cm  z=${(maxZ*100).toFixed(2)}cm`);
    world.dispose();
  });
});

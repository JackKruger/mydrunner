import { describe, expect, it, vi } from 'vitest';
import { TUNING } from '@mydrunner/shared';
import { ChaseCamera } from '../camera.js';

describe('ChaseCamera modes', () => {
  it('cycles through the farther chase view before the existing cameras', () => {
    const camera = new ChaseCamera(16 / 9);

    expect(camera.mode).toBe('chase');
    camera.cycleMode();
    expect(camera.mode).toBe('far');
    camera.cycleMode();
    expect(camera.mode).toBe('suspension');
    camera.cycleMode();
    expect(camera.mode).toBe('hood');
    camera.cycleMode();
    expect(camera.mode).toBe('free');
    camera.cycleMode();
    expect(camera.mode).toBe('chase');
  });

  it('keeps the chase framing while positioning the far view farther away', () => {
    const camera = new ChaseCamera(16 / 9);
    camera.target.set(10, 2, 20);
    camera.yaw = 0;

    camera.apply();
    expect(camera.camera.position.toArray()).toEqual([10, 5, 12]);

    camera.cycleMode();
    camera.apply();
    expect(camera.camera.position.toArray()).toEqual([10, 7, 6]);
    expect(camera.camera.position.distanceTo(camera.target)).toBeGreaterThan(14);
  });

  it('places the suspension view low and close behind the vehicle', () => {
    const camera = new ChaseCamera(16 / 9);
    camera.target.set(10, 2, 20);
    camera.yaw = 0;

    camera.cycleMode();
    camera.cycleMode();
    camera.apply();

    expect(camera.mode).toBe('suspension');
    expect(camera.camera.position.toArray()).toEqual([10, 1.4, 14.5]);
    const forward = camera.camera.getWorldDirection(camera.target.clone());
    expect(forward.y).toBeGreaterThan(0);
  });

  it('smooths terrain clearance changes while retaining a hard collision floor', () => {
    let now = 1;
    let groundY = 0;
    const nowMock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const camera = new ChaseCamera(16 / 9);
    camera.setTerrain({ heightAt: () => groundY });
    camera.beginDrag();
    camera.drag(0, 0.25);

    camera.apply();
    const flatY = camera.camera.position.y;
    expect(flatY).toBeCloseTo(1.5);

    groundY = 0.6;
    now += 1000 / 60;
    camera.apply();
    expect(camera.camera.position.y).toBeGreaterThan(flatY);
    expect(camera.camera.position.y).toBeLessThan(groundY + 1.5);

    for (let frame = 0; frame < 60; frame++) {
      now += 1000 / 60;
      camera.apply();
    }
    expect(camera.camera.position.y).toBeCloseTo(groundY + 1.5, 2);

    groundY = 4;
    now += 1000 / 60;
    camera.apply();
    expect(camera.camera.position.y).toBeGreaterThanOrEqual(groundY + 0.35);

    nowMock.mockRestore();
  });

  it('reads chase response from live tuning', () => {
    const saved = TUNING.cameraChaseYawStiffness;
    const nowMock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      TUNING.cameraChaseYawStiffness = 0;
      const camera = new ChaseCamera(16 / 9);
      camera.follow({ x: 0, y: 0, z: 0 }, { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 });
      expect(camera.yaw).toBe(0);
    } finally {
      TUNING.cameraChaseYawStiffness = saved;
      nowMock.mockRestore();
    }
  });
});

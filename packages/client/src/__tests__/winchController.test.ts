import { createStockBuild } from '@mydrunner/shared';
import { Vector2 } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene, WinchPick } from '../scene.js';
import { WinchController } from '../winchController.js';

function harness(pick: WinchPick | null) {
  const canvas = document.createElement('canvas');
  const scene = {
    renderer: { domElement: canvas },
    pickWinchTarget: vi.fn(() => pick),
    setWinchTarget: vi.fn(),
    setLocalWinchLinks: vi.fn(),
  } as unknown as Scene;
  const sendWinchCommand = vi.fn();
  const controller = new WinchController(scene, {
    simulation: () => null,
    net: () => ({ sendWinchCommand }) as never,
    online: () => true,
    blocked: () => false,
  });
  const build = createStockBuild();
  build.frontBarId = `${build.baseId}.frontBar.steel-winch`;
  build.winchId = `${build.baseId}.winch.fitted`;
  controller.reset('local', build);
  return { controller, scene, sendWinchCommand };
}

describe('WinchController pointer targeting', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('passes pointer NDC to the ray and sends the existing attach command', () => {
    const pick: WinchPick = { target: { kind: 'obstacle', obstacleId: 'tree' }, point: { x: 1, y: 2, z: 3 }, label: 'tree' };
    const { controller, scene, sendWinchCommand } = harness(pick);
    controller.toggle();
    const ndc = new Vector2(0.4, -0.25);
    controller.pointerMove(ndc);
    expect(scene.pickWinchTarget).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0.4, y: -0.25 }));
    expect(controller.primaryClick(ndc)).toBe(true);
    expect(sendWinchCommand).toHaveBeenCalledWith(1, 'attach', pick.target);
    expect(controller.isTargeting()).toBe(false);
  });

  it('rejects an invalid click and remains in selection mode', () => {
    const { controller, sendWinchCommand } = harness(null);
    controller.toggle();
    controller.primaryClick(new Vector2(0.7, 0.2));
    expect(sendWinchCommand).not.toHaveBeenCalled();
    expect(controller.isTargeting()).toBe(true);
  });

  it('cancels selection with Escape', () => {
    const { controller } = harness(null);
    controller.toggle();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    expect(controller.isTargeting()).toBe(false);
  });

  it('retains the center-screen ray when keyboard activation attaches', () => {
    const pick: WinchPick = { target: { kind: 'obstacle', obstacleId: 'rock' }, point: { x: 1, y: 0, z: 1 }, label: 'rock' };
    const { controller, scene } = harness(pick);
    controller.toggle();
    controller.toggle();
    expect(scene.pickWinchTarget).toHaveBeenLastCalledWith();
  });
});

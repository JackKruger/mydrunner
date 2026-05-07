// Slice 3: button → Winch wiring inside Room.tickOnce.
//
// Drives the winch entirely through PlayerInput.buttons, the same
// path the real client uses. Confirms:
//   - rising-edge detection on prevButtons (held edge actions don't
//     repeat tick-after-tick),
//   - reel-in/out bits are sampled every tick,
//   - winch deploy toggle flips phase,
//   - WINCH_REEL_IN with a static anchor actually shrinks the spool.
//
// tickOnce is private on Room; we go through a type cast so the test
// exercises the real dispatch path rather than re-implementing it.

import { describe, it, expect, beforeAll } from 'vitest';
import { BUTTONS, EMPTY_INPUT, Physics, WINCH } from '@mydrunner/shared';
import { Room } from '../room.js';

beforeAll(async () => {
  await Physics.initRapier();
});

interface Tickable {
  tickOnce(): void;
}

function makeRoom() {
  const room = new Room();
  const handle = {
    id: 'p1',
    name: 'tester',
    carKind: 'patrol' as const,
    send: () => {},
  };
  room.addPlayer(handle);
  // Settle the chassis on the road. Applies idle input + ticks.
  const tickable = room as unknown as Tickable;
  for (let s = 1; s <= 60; s++) {
    room.applyInput('p1', { ...EMPTY_INPUT, seq: s });
    tickable.tickOnce();
  }
  const vehicle = room.world.vehicles.get('p1')!;
  return { room, vehicle, tickable, handle };
}

describe('Winch — Room button wiring (slice 3)', () => {
  it('WINCH_DEPLOY_TOGGLE on rising edge flips phase exactly once per press', () => {
    const { room, vehicle, tickable } = makeRoom();
    expect(vehicle.winch.phase).toBe('stowed');

    // Press: phase → deployed.
    room.applyInput('p1', {
      ...EMPTY_INPUT, seq: 100, buttons: BUTTONS.WINCH_DEPLOY_TOGGLE,
    });
    tickable.tickOnce();
    expect(vehicle.winch.phase).toBe('deployed');

    // Hold the button across 5 more ticks: edge already fired, phase
    // must not flip back-and-forth.
    for (let s = 101; s <= 105; s++) {
      room.applyInput('p1', {
        ...EMPTY_INPUT, seq: s, buttons: BUTTONS.WINCH_DEPLOY_TOGGLE,
      });
      tickable.tickOnce();
    }
    expect(vehicle.winch.phase).toBe('deployed');

    // Release, then press again: should toggle back to stowed.
    room.applyInput('p1', { ...EMPTY_INPUT, seq: 106, buttons: 0 });
    tickable.tickOnce();
    room.applyInput('p1', {
      ...EMPTY_INPUT, seq: 107, buttons: BUTTONS.WINCH_DEPLOY_TOGGLE,
    });
    tickable.tickOnce();
    expect(vehicle.winch.phase).toBe('stowed');

    room.stop();
    room.world.dispose();
  });

  it('WINCH_REEL_IN held while attached shrinks the spool', () => {
    const { room, vehicle, tickable } = makeRoom();
    const t = vehicle.body.translation();
    // Anchor near the chassis to keep tension low so the motor doesn't
    // stall. 0.05 m of stretch → ~10 kN, well below the 80 kN cap.
    vehicle.winch.setStaticAnchor(
      { x: t.x, y: t.y, z: t.z + 10 },
      9.95,
    );
    const spoolBefore = vehicle.winch.spoolLength;

    // Hold reel-in for 60 ticks (1 s).
    for (let s = 200; s < 260; s++) {
      room.applyInput('p1', {
        ...EMPTY_INPUT, seq: s, buttons: BUTTONS.WINCH_REEL_IN,
      });
      tickable.tickOnce();
    }
    // 1 s × 0.8 m/s = 0.8 m of cable consumed. Loose tolerance to allow
    // for the tick or two where chassis motion bumps tension.
    const consumed = spoolBefore - vehicle.winch.spoolLength;
    expect(consumed).toBeGreaterThan(0.5);
    expect(consumed).toBeLessThan(WINCH.spoolSpeed * 1.0 + 0.05);
    room.stop();
    room.world.dispose();
  });

  it('WINCH_REEL_OUT held while attached grows the spool', () => {
    const { room, vehicle, tickable } = makeRoom();
    const t = vehicle.body.translation();
    vehicle.winch.setStaticAnchor(
      { x: t.x, y: t.y, z: t.z + 10 },
      5,
    );
    const spoolBefore = vehicle.winch.spoolLength;

    for (let s = 300; s < 360; s++) {
      room.applyInput('p1', {
        ...EMPTY_INPUT, seq: s, buttons: BUTTONS.WINCH_REEL_OUT,
      });
      tickable.tickOnce();
    }
    expect(vehicle.winch.spoolLength).toBeGreaterThan(spoolBefore + 0.5);
    room.stop();
    room.world.dispose();
  });

  it('RESET still works alongside the new button bits', () => {
    // Regression: the reset bit was bit 0 before; this confirms the
    // refactor onto BUTTONS.RESET didn't break it. Spawn position is
    // chosen by Room.nextSpawn() against generated terrain (not
    // origin), so we capture it after settle and compare back to it.
    const { room, vehicle, tickable } = makeRoom();
    const spawn = vehicle.body.translation();

    for (let s = 400; s < 520; s++) {
      room.applyInput('p1', { ...EMPTY_INPUT, seq: s, throttle: 1, steer: 0.4 });
      tickable.tickOnce();
    }
    const moved = vehicle.body.translation();
    const drift = Math.hypot(moved.x - spawn.x, moved.z - spawn.z);
    expect(drift).toBeGreaterThan(1);

    room.applyInput('p1', { ...EMPTY_INPUT, seq: 521, buttons: BUTTONS.RESET });
    tickable.tickOnce();
    const after = vehicle.body.translation();
    const resetDrift = Math.hypot(after.x - spawn.x, after.z - spawn.z);
    expect(resetDrift).toBeLessThan(0.2);
    room.stop();
    room.world.dispose();
  });
});

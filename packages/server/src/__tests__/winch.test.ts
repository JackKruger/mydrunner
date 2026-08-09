import { describe, expect, it } from 'vitest';
import { Net, VEHICLE_PART_CATALOGS, createStockBuild, type VehicleBuild } from '@mydrunner/shared';
import { Room } from '../room.js';

function equippedBuild(): VehicleBuild {
  const catalog = VEHICLE_PART_CATALOGS.ridgeback;
  return {
    ...createStockBuild('ridgeback'),
    frontBarId: catalog.frontBars.find((part) => part.id.endsWith('.steel-winch'))!.id,
    winchId: catalog.winches.find((part) => part.id.endsWith('.fitted'))!.id,
  };
}

function add(room: Room, id: string, build: VehicleBuild) {
  const messages: Net.ServerMessage[] = [];
  room.addPlayer({ id, name: id, build, send: (bytes) => messages.push(Net.decodeServer(bytes)) });
  return messages;
}

function latest<T extends Net.ServerMessage['t']>(messages: Net.ServerMessage[], type: T) {
  return [...messages].reverse().find((message) => message.t === type) as Extract<Net.ServerMessage, { t: T }>;
}

describe('room winch authority', () => {
  it('gates equipment, creates a vehicle link, relays runtime, and cleans up the target', () => {
    const room = new Room();
    const ownerMessages = add(room, 'owner', equippedBuild());
    add(room, 'target', createStockBuild('ridgeback'));

    room.requestWinchCommand('owner', {
      t: 'winch-command', seq: 1, action: 'attach',
      target: { kind: 'vehicle', playerId: 'target', point: 'rear' },
    });
    const ack = latest(ownerMessages, 'winch-ack');
    expect(ack).toMatchObject({ ok: true, seq: 1 });
    expect(ack.link?.target).toEqual({ kind: 'vehicle', playerId: 'target', point: 'rear' });

    room.broadcastSnapshot();
    const snap = latest(ownerMessages, 'snapshot').snap;
    const owner = snap.players.find((player) => player.id === 'owner')!;
    const link = snap.winches![0]!;
    room.applyVehicleState('owner', {
      seq: 1,
      vehicle: owner.vehicle,
      winch: { linkId: link.id, cableLength: link.cableLength, motor: 1, tension: 55_000 },
    });
    room.broadcastSnapshot();
    expect(latest(ownerMessages, 'snapshot').snap.winches![0]).toMatchObject({ motor: 1, status: 'stalled' });

    room.removePlayer('target');
    expect(latest(ownerMessages, 'winch-event')).toMatchObject({ linkId: link.id, reason: 'target-lost' });
    room.broadcastSnapshot();
    expect(latest(ownerMessages, 'snapshot').snap.winches).toEqual([]);
  });

  it('rejects an unequipped owner', () => {
    const room = new Room();
    const messages = add(room, 'owner', createStockBuild('ridgeback'));
    add(room, 'target', createStockBuild('ridgeback'));
    room.requestWinchCommand('owner', {
      t: 'winch-command', seq: 1, action: 'attach',
      target: { kind: 'vehicle', playerId: 'target', point: 'rear' },
    });
    expect(latest(messages, 'winch-ack')).toMatchObject({ ok: false });
  });
});

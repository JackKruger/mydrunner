import { describe, expect, it } from 'vitest';
import {
  Net,
  VEHICLE_PART_CATALOGS,
  createStockBuild,
  type PlayerId,
  type VehicleState,
} from '@mydrunner/shared';
import { Room } from '../room.js';

interface TestPlayer {
  id: PlayerId;
  messages: Net.ServerMessage[];
}

function addPlayer(room: Room, id: PlayerId): TestPlayer {
  const messages: Net.ServerMessage[] = [];
  room.addPlayer({
    id,
    name: id,
    build: createStockBuild('ridgeback'),
    send: (bytes) => messages.push(Net.decodeServer(bytes)),
  });
  return { id, messages };
}

function latestSnapshot(player: TestPlayer): Extract<Net.ServerMessage, { t: 'snapshot' }> {
  return [...player.messages].reverse().find(
    (message): message is Extract<Net.ServerMessage, { t: 'snapshot' }> => message.t === 'snapshot',
  )!;
}

function latestAck(player: TestPlayer): Extract<Net.ServerMessage, { t: 'workshop-ack' }> {
  return [...player.messages].reverse().find(
    (message): message is Extract<Net.ServerMessage, { t: 'workshop-ack' }> => message.t === 'workshop-ack',
  )!;
}

function parkInBay(room: Room, player: TestPlayer, bayId = 'service-bay-1', seq = 1): VehicleState {
  room.broadcastSnapshot();
  const current = latestSnapshot(player).snap.players.find((entry) => entry.id === player.id)!.vehicle;
  const bay = room.map.markers.find((marker) => marker.id === bayId)!;
  const parked: VehicleState = {
    ...current,
    position: { x: bay.x, y: current.position.y, z: bay.z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linVel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    throttle: 0,
  };
  room.applyVehicleState(player.id, { seq, vehicle: parked });
  return parked;
}

describe('workshop bay leases', () => {
  it('leases a bay, atomically applies a complete build, then exits', () => {
    const room = new Room();
    const player = addPlayer(room, 'owner');
    parkInBay(room, player);

    room.requestWorkshopEnter(player.id, 'service-bay-1');
    const entered = latestAck(player);
    expect(entered).toMatchObject({ action: 'enter', ok: true, bayId: 'service-bay-1', buildRevision: 1 });
    expect(entered.leaseId).toBeTruthy();

    const catalog = VEHICLE_PART_CATALOGS.overlander;
    const touringBuild = {
      ...createStockBuild('overlander'),
      suspensionId: catalog.suspension[2]!.id,
      tireId: catalog.tires[3]!.id,
      wheelId: catalog.wheels[2]!.id,
      frontBarId: catalog.frontBars[2]!.id,
      winchId: catalog.winches[1]!.id,
      snorkelId: catalog.snorkels[1]!.id,
      roofId: catalog.roofs[2]!.id,
      rearBodyId: catalog.rearBodies[2]!.id,
      frontLocker: true,
      rearLocker: true,
    };
    room.requestBuildUpdate(player.id, entered.leaseId!, touringBuild);
    const applied = latestAck(player);
    expect(applied).toMatchObject({
      action: 'apply', ok: true, build: touringBuild, buildRevision: 2,
    });

    room.broadcastSnapshot();
    const leased = latestSnapshot(player).snap.players[0]!;
    expect(leased.workshopMode).toBe(true);
    expect(leased.build).toEqual(touringBuild);
    expect(leased.buildRevision).toBe(2);
    expect(leased.vehicle.linVel).toEqual({ x: 0, y: 0, z: 0 });

    room.requestWorkshopExit(player.id, entered.leaseId!);
    expect(latestAck(player)).toMatchObject({ action: 'exit', ok: true });
    room.broadcastSnapshot();
    expect(latestSnapshot(player).snap.players[0]!.workshopMode).toBe(false);
  });

  it('rejects an occupied bay and releases it when its owner disconnects', () => {
    const room = new Room();
    const first = addPlayer(room, 'first');
    const second = addPlayer(room, 'second');
    parkInBay(room, first, 'service-bay-1', 1);
    parkInBay(room, second, 'service-bay-1', 1);

    room.requestWorkshopEnter(first.id, 'service-bay-1');
    expect(latestAck(first).ok).toBe(true);
    room.requestWorkshopEnter(second.id, 'service-bay-1');
    expect(latestAck(second)).toMatchObject({
      action: 'enter', ok: false, reason: 'That workshop bay is occupied.',
    });

    room.removePlayer(first.id);
    room.requestWorkshopEnter(second.id, 'service-bay-1');
    expect(latestAck(second)).toMatchObject({ action: 'enter', ok: true });
  });

  it('rejects movement, invalid builds and uploads made while leased', () => {
    const room = new Room();
    const player = addPlayer(room, 'owner');
    const parked = parkInBay(room, player);

    room.applyVehicleState(player.id, {
      seq: 2,
      vehicle: { ...parked, linVel: { x: 2, y: 0, z: 0 } },
    });
    room.requestWorkshopEnter(player.id, 'service-bay-1');
    expect(latestAck(player)).toMatchObject({
      action: 'enter', ok: false, reason: 'Stop the vehicle before opening the workshop.',
    });

    room.applyVehicleState(player.id, { seq: 3, vehicle: parked });
    room.requestWorkshopEnter(player.id, 'service-bay-1');
    const entered = latestAck(player);
    expect(entered.ok).toBe(true);

    room.requestBuildUpdate(
      player.id,
      entered.leaseId!,
      createStockBuild('ridgeback'),
      ['35-inch tyres require the 100 mm flex lift'],
    );
    expect(latestAck(player)).toMatchObject({
      action: 'apply', ok: false, reason: '35-inch tyres require the 100 mm flex lift',
    });

    room.applyVehicleState(player.id, {
      seq: 4,
      vehicle: { ...parked, position: { x: 999, y: 999, z: 999 } },
    });
    room.broadcastSnapshot();
    const authoritative = latestSnapshot(player).snap.players[0]!;
    expect(authoritative.stateSeq).toBe(3);
    expect(authoritative.vehicle.position.x).not.toBe(999);
  });
});

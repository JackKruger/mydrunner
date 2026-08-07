// A Room owns multiplayer membership and relays client-owned vehicle state.
// It deliberately has no Rapier world: each browser is authoritative for
// its own truck, while the room aggregates the latest owner states into the
// snapshot stream consumed by remote interpolation.

import {
  SNAPSHOT_INTERVAL_MS,
  PROTOCOL_VERSION,
  Maps,
  Net,
  type PlayerId,
  type PlayerSnapshot,
  type VehicleState,
  type VehicleStateUpdate,
  type WorldSnapshot,
  type CarKind,
} from '@mydrunner/shared';

export interface PlayerHandle {
  id: PlayerId;
  name: string;
  carKind: CarKind;
  send(msg: Uint8Array): void;
}

interface InternalPlayer {
  handle: PlayerHandle;
  state: VehicleState;
  stateSeq: number;
  spawn: { position: { x: number; y: number; z: number }; yaw: number };
  slot: number;
  lastChatAtMs: number;
}

export class Room {
  readonly map: Maps.MapWorld;
  /** Content hash of the loaded document in this build. */
  readonly mapRev: number;
  private readonly players = new Map<PlayerId, InternalPlayer>();
  private tick = 0;
  private readonly startedAtMs = performance.now();
  private loopHandle: NodeJS.Timeout | null = null;
  private nextSnapshotAtMs = 0;
  private relayUpdates = 0;
  private snapshotBytes = 0;
  private snapshotMaxBytes = 0;
  private perfStartedAtMs = performance.now();

  constructor(map: string | Maps.MapDoc = Maps.DEFAULT_MAP_ID) {
    const doc = typeof map === 'string' ? Maps.getMap(map) : map;
    if (!doc) throw new Error(`Room: unknown map "${String(map)}"`);
    this.map = Maps.applyMapDoc(doc);
    this.mapRev = Maps.mapDocRev(doc);
  }

  start(): void {
    if (this.loopHandle) return;
    this.nextSnapshotAtMs = performance.now();
    this.runLoop();
  }

  private runLoop(): void {
    const now = performance.now();
    if (now >= this.nextSnapshotAtMs) {
      this.broadcastSnapshot();
      this.tick += 1;
      this.nextSnapshotAtMs += SNAPSHOT_INTERVAL_MS;
      // Do not burst stale snapshots after a long event-loop pause.
      if (now - this.nextSnapshotAtMs > 250) this.nextSnapshotAtMs = now + SNAPSHOT_INTERVAL_MS;
    }
    if (now - this.perfStartedAtMs >= PERF_WINDOW_MS) this.flushPerf(now);
    const wait = Math.max(0, this.nextSnapshotAtMs - performance.now());
    this.loopHandle = setTimeout(() => this.runLoop(), wait) as unknown as NodeJS.Timeout;
  }

  stop(): void {
    if (this.loopHandle) clearTimeout(this.loopHandle);
    this.loopHandle = null;
  }

  private nowMs(): number {
    return performance.now() - this.startedAtMs;
  }

  private nextSpawn(
    kind: CarKind,
  ): { position: { x: number; y: number; z: number }; yaw: number; slot: number } {
    const slot = this.takeSpawnSlot();
    return { ...Maps.resolveSpawn(this.map, slot, kind), slot };
  }

  private takeSpawnSlot(): number {
    const used = new Set<number>();
    for (const p of this.players.values()) used.add(p.slot);
    for (let s = 0; s < SPAWN_SLOTS; s++) {
      if (!used.has(s)) return s;
    }
    return this.players.size % SPAWN_SLOTS;
  }

  addPlayer(handle: PlayerHandle): void {
    const { slot, ...spawn } = this.nextSpawn(handle.carKind);
    this.players.set(handle.id, {
      handle,
      state: initialVehicleState(spawn),
      stateSeq: 0,
      spawn,
      slot,
      lastChatAtMs: 0,
    });
    handle.send(
      Net.encode({
        t: 'welcome',
        you: handle.id,
        tick: this.tick,
        serverTimeMs: this.nowMs(),
        protocolVersion: PROTOCOL_VERSION,
        map: { id: this.map.doc.id, rev: this.mapRev },
        spawn: { position: spawn.position, yaw: spawn.yaw },
      }),
    );
  }

  removePlayer(id: PlayerId): void {
    this.players.delete(id);
  }

  /** Accept the newest canonical state from a vehicle's owning client. */
  applyVehicleState(id: PlayerId, update: VehicleStateUpdate): void {
    const p = this.players.get(id);
    if (!p || !Number.isSafeInteger(update.seq) || update.seq <= p.stateSeq) return;
    if (!isFiniteVehicleState(update.vehicle)) return;
    p.state = update.vehicle;
    p.stateSeq = update.seq;
    this.relayUpdates += 1;
  }

  /** Exposed for deterministic tests; production calls it from runLoop. */
  broadcastSnapshot(): void {
    const players: PlayerSnapshot[] = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.handle.id,
        name: p.handle.name,
        carKind: p.handle.carKind,
        vehicle: p.state,
        stateSeq: p.stateSeq,
      });
    }
    const snap: WorldSnapshot = {
      tick: this.tick,
      serverTimeMs: this.nowMs(),
      players,
    };
    const msg = Net.encode({ t: 'snapshot', snap });
    for (const p of this.players.values()) p.handle.send(msg);
    this.snapshotBytes += msg.length;
    if (msg.length > this.snapshotMaxBytes) this.snapshotMaxBytes = msg.length;
  }

  broadcastChat(handle: PlayerHandle, text: string): void {
    const p = this.players.get(handle.id);
    if (!p) return;
    const now = this.nowMs();
    if (now - p.lastChatAtMs < CHAT_MIN_INTERVAL_MS || !text) return;
    p.lastChatAtMs = now;
    const msg = Net.encode({
      t: 'chat',
      from: handle.id,
      fromName: handle.name,
      text,
      serverTimeMs: now,
    });
    for (const peer of this.players.values()) peer.handle.send(msg);
  }

  get playerCount(): number {
    return this.players.size;
  }

  private flushPerf(now: number): void {
    const elapsedS = (now - this.perfStartedAtMs) / 1000;
    console.log(
      `[mydrunner-server] relay ${elapsedS.toFixed(1)}s ` +
        `players=${this.players.size} updates=${this.relayUpdates} ` +
        `bytes=${this.snapshotBytes} maxSnapshot=${this.snapshotMaxBytes}`,
    );
    this.relayUpdates = 0;
    this.snapshotBytes = 0;
    this.snapshotMaxBytes = 0;
    this.perfStartedAtMs = now;
  }
}

function initialVehicleState(
  spawn: { position: { x: number; y: number; z: number }; yaw: number },
): VehicleState {
  const half = spawn.yaw * 0.5;
  return {
    position: { ...spawn.position },
    rotation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
    linVel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    rpm: 0,
    gear: 0,
    throttle: 0,
    wheels: Array.from({ length: 4 }, () => ({
      steer: 0,
      spin: 0,
      contact: false,
      suspensionLength: 0,
      angVel: 0,
    })),
    axles: [
      { rideY: 0, rollAngle: 0 },
      { rideY: 0, rollAngle: 0 },
    ],
  };
}

function isFiniteVehicleState(v: VehicleState): boolean {
  const numbers = [
    v.position.x, v.position.y, v.position.z,
    v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w,
    v.linVel.x, v.linVel.y, v.linVel.z,
    v.angVel.x, v.angVel.y, v.angVel.z,
    v.rpm, v.gear, v.throttle,
  ];
  for (const wheel of v.wheels) {
    numbers.push(wheel.steer, wheel.spin, wheel.suspensionLength, wheel.angVel);
  }
  if (v.axles) {
    for (const axle of v.axles) numbers.push(axle.rideY, axle.rollAngle);
  }
  return v.wheels.length === 4 && numbers.every(Number.isFinite);
}

const CHAT_MIN_INTERVAL_MS = 800;
const SPAWN_SLOTS = Maps.SPAWN_SLOTS;
const PERF_WINDOW_MS = 5000;

// A Room owns one World, all connected players, and the fixed-step loop.
// Single-room MVP. Sharding into multiple rooms is a later concern.

import {
  FIXED_DT,
  TICK_RATE,
  SNAPSHOT_INTERVAL_MS,
  RUT_REBUILD_INTERVAL_TICKS,
  RUTS_ENABLED,
  EMPTY_INPUT,
  Net,
  Physics,
  type PlayerId,
  type PlayerInput,
  type PlayerSnapshot,
  type WorldSnapshot,
  type CarKind,
} from '@mydrunner/shared';

export interface PlayerHandle {
  id: PlayerId;
  name: string;
  carKind: CarKind;
  send(msg: string): void;
}

interface InternalPlayer {
  handle: PlayerHandle;
  vehicle: Physics.Vehicle;
  pendingInput: PlayerInput;
  lastAckSeq: number;
  spawn: { position: { x: number; y: number; z: number }; yaw: number };
}

export class Room {
  readonly world: Physics.World;
  private readonly players = new Map<PlayerId, InternalPlayer>();
  private tick = 0;
  private startedAtMs = Date.now();
  private snapAccumMs = 0;
  private loopHandle: NodeJS.Timeout | null = null;
  private rutBuffer: Physics.RutBuffer;
  private rutVersion = 0;
  private ticksSinceRutFlush = 0;

  constructor(seed = 1337) {
    this.world = new Physics.World({ generate: { size: 320, resolution: 96, seed } });
    this.rutBuffer = new Physics.RutBuffer(this.world.terrain);
  }

  start(): void {
    if (this.loopHandle) return;
    const intervalMs = 1000 / TICK_RATE;
    this.loopHandle = setInterval(() => this.tickOnce(), intervalMs);
  }

  stop(): void {
    if (this.loopHandle) clearInterval(this.loopHandle);
    this.loopHandle = null;
  }

  private nowMs(): number {
    return Date.now() - this.startedAtMs;
  }

  /** Spawn on the flat road strip (z near 0), facing along the road (+X)
   *  so the chase camera looks down the road instead of into a hill.
   *  Y clearance is generous: chassis-center must clear chassis half-extent
   *  + suspension + wheel radius. */
  private nextSpawn(): { position: { x: number; y: number; z: number }; yaw: number } {
    const n = this.players.size;
    const slot = n % 16;
    const col = slot % 8;
    const row = Math.floor(slot / 8);
    const x = (col - 3.5) * 4; // -14 .. +14 along the road
    const z = row === 0 ? -1.2 : 1.2; // two lanes
    // yaw = pi/2 rotates local +Z (vehicle forward) to world +X (road direction).
    const yaw = Math.PI / 2;
    const idx = Physics.worldToTerrainIndex(this.world.terrain, x, z);
    const ground = idx >= 0 ? (this.world.terrain.heights[idx] ?? 0) : 0;
    return { position: { x, y: ground + 1.5, z }, yaw };
  }

  addPlayer(handle: PlayerHandle): void {
    const spawn = this.nextSpawn();
    const vehicle = this.world.spawnVehicle(handle.id, spawn);
    this.players.set(handle.id, {
      handle,
      vehicle,
      pendingInput: { ...EMPTY_INPUT },
      lastAckSeq: 0,
      spawn,
    });
    handle.send(
      Net.encode({
        t: 'welcome',
        you: handle.id,
        tick: this.tick,
        serverTimeMs: this.nowMs(),
        terrain: {
          seed: this.world.terrain.seed,
          size: this.world.terrain.size,
          resolution: this.world.terrain.resolution,
          rutVersion: this.rutVersion,
        },
        spawn: { position: spawn.position, yaw: spawn.yaw },
      }),
    );
  }

  removePlayer(id: PlayerId): void {
    const p = this.players.get(id);
    if (!p) return;
    this.world.removeVehicle(id);
    this.players.delete(id);
  }

  applyInput(id: PlayerId, input: PlayerInput): void {
    const p = this.players.get(id);
    if (!p) return;
    if (input.seq <= p.lastAckSeq) return;
    p.pendingInput = {
      seq: input.seq,
      throttle: clamp(input.throttle, -1, 1),
      steer: clamp(input.steer, -1, 1),
      brake: clamp(input.brake, 0, 1),
      handbrake: clamp(input.handbrake, 0, 1),
      buttons: input.buttons | 0,
    };
    p.lastAckSeq = input.seq;
  }

  private tickOnce(): void {
    for (const p of this.players.values()) {
      if ((p.pendingInput.buttons & 1) !== 0) {
        p.vehicle.resetTo(p.spawn);
      }
      p.vehicle.setInput(p.pendingInput);
    }
    this.world.step();
    this.tick += 1;

    // Rut accumulation + flush. Gated on RUTS_ENABLED - currently off
    // because per-cell footprint is much wider than a tire and the
    // client prediction world doesn't receive deltas, causing periodic
    // reconcile snaps. Buffer machinery is left wired so it can flip
    // back on without touching this loop.
    if (RUTS_ENABLED) {
      for (const p of this.players.values()) {
        for (const w of p.vehicle.wheelSamples()) {
          this.rutBuffer.recordWheel(w.x, w.z, w.slip, w.contact);
        }
      }
      this.ticksSinceRutFlush += 1;
      if (this.ticksSinceRutFlush >= RUT_REBUILD_INTERVAL_TICKS) {
        this.ticksSinceRutFlush = 0;
        const deltas = this.rutBuffer.flush();
        if (deltas.length > 0) {
          this.world.rebuildTerrain();
          this.rutVersion += 1;
          const msg = Net.encode({
            t: 'rut',
            version: this.rutVersion,
            cells: deltas,
          });
          for (const p of this.players.values()) p.handle.send(msg);
        }
      }
    }

    this.snapAccumMs += FIXED_DT * 1000;
    if (this.snapAccumMs >= SNAPSHOT_INTERVAL_MS) {
      this.snapAccumMs = 0;
      this.broadcastSnapshot();
    }
  }

  private broadcastSnapshot(): void {
    const players: PlayerSnapshot[] = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.handle.id,
        name: p.handle.name,
        carKind: p.handle.carKind,
        vehicle: p.vehicle.getState(),
        lastAckSeq: p.lastAckSeq,
      });
    }
    const snap: WorldSnapshot = {
      tick: this.tick,
      serverTimeMs: this.nowMs(),
      players,
    };
    const msg = Net.encode({ t: 'snapshot', snap });
    for (const p of this.players.values()) p.handle.send(msg);
  }

  get playerCount(): number {
    return this.players.size;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

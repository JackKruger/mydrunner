// A Room owns one World, all connected players, and the fixed-step loop.
// Single-room MVP. Sharding into multiple rooms is a later concern.

import {
  FIXED_DT,
  TICK_RATE,
  SNAPSHOT_INTERVAL_MS,
  EMPTY_INPUT,
  Net,
  Physics,
  type PlayerId,
  type PlayerInput,
  type PlayerSnapshot,
  type WorldSnapshot,
} from '@mydrunner/shared';

export interface PlayerHandle {
  id: PlayerId;
  name: string;
  send(msg: string): void;
}

interface InternalPlayer {
  handle: PlayerHandle;
  vehicle: Physics.Vehicle;
  pendingInput: PlayerInput;
  lastAckSeq: number;
  /** Spawn pose remembered for resets. */
  spawn: { position: { x: number; y: number; z: number }; yaw: number };
}

export class Room {
  readonly world: Physics.World;
  private readonly players = new Map<PlayerId, InternalPlayer>();
  private tick = 0;
  private startedAtMs = Date.now();
  private snapAccumMs = 0;
  private loopHandle: NodeJS.Timeout | null = null;
  private rutVersion = 0;

  constructor(seed = 1337) {
    this.world = new Physics.World({ generate: { size: 200, resolution: 64, seed } });
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

  /** Find a safe spawn position: ring around the road strip, snapped to
   *  terrain height + clearance. */
  private nextSpawn(): { position: { x: number; y: number; z: number }; yaw: number } {
    const n = this.players.size;
    const lane = (n % 4) - 1.5; // -1.5, -0.5, 0.5, 1.5
    const back = -20 - Math.floor(n / 4) * 6;
    const x = lane * 2.5;
    const z = back;
    // Sample terrain height at this point to avoid spawning underground.
    const idx = Physics.worldToTerrainIndex(this.world.terrain, x, z);
    const ground = idx >= 0 ? (this.world.terrain.heights[idx] ?? 0) : 0;
    return { position: { x, y: ground + 1.5, z }, yaw: 0 };
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
    // Clamp out-of-range inputs (anti-cheat / bad client).
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
      // Reset request: button bit 0.
      if ((p.pendingInput.buttons & 1) !== 0) {
        p.vehicle.resetTo(p.spawn);
      }
      p.vehicle.setInput(p.pendingInput);
    }
    this.world.step();
    this.tick += 1;

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

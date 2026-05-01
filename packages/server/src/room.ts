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
  send(msg: ReturnType<typeof Net.encode> extends string ? string : never): void;
}

interface InternalPlayer {
  handle: PlayerHandle;
  vehicle: Physics.Vehicle;
  pendingInput: PlayerInput;
  lastAckSeq: number;
}

export class Room {
  readonly world: Physics.World;
  private readonly players = new Map<PlayerId, InternalPlayer>();
  private tick = 0;
  private startedAtMs = Date.now();
  private snapAccumMs = 0;
  private loopHandle: NodeJS.Timeout | null = null;
  private lastTickAtMs = 0;

  constructor() {
    this.world = new Physics.World({ size: 200, resolution: 64 });
  }

  start(): void {
    if (this.loopHandle) return;
    this.lastTickAtMs = Date.now();
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

  addPlayer(handle: PlayerHandle): void {
    // Stagger spawns in a small ring so cars don't pile up at origin.
    const n = this.players.size;
    const angle = (n * Math.PI * 2) / 8;
    const r = 4;
    const vehicle = this.world.spawnVehicle(handle.id, {
      position: { x: Math.cos(angle) * r, y: 2, z: Math.sin(angle) * r },
      yaw: angle + Math.PI,
    });
    this.players.set(handle.id, {
      handle,
      vehicle,
      pendingInput: { ...EMPTY_INPUT },
      lastAckSeq: 0,
    });
    handle.send(
      Net.encode({
        t: 'welcome',
        you: handle.id,
        tick: this.tick,
        serverTimeMs: this.nowMs(),
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
    // Drop out-of-order inputs (very simple - replace with reorder buffer later).
    if (input.seq <= p.lastAckSeq) return;
    p.pendingInput = input;
    p.lastAckSeq = input.seq;
  }

  private tickOnce(): void {
    const now = Date.now();
    const dt = (now - this.lastTickAtMs) / 1000;
    this.lastTickAtMs = now;

    for (const p of this.players.values()) {
      p.vehicle.setInput(p.pendingInput);
    }
    this.world.step();
    this.tick += 1;

    this.snapAccumMs += FIXED_DT * 1000;
    if (this.snapAccumMs >= SNAPSHOT_INTERVAL_MS) {
      this.snapAccumMs = 0;
      this.broadcastSnapshot();
    }
    void dt;
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

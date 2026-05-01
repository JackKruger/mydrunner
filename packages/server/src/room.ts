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
  vehicle: Physics.VehicleLike;
  pendingInput: PlayerInput;
  lastAckSeq: number;
  spawn: { position: { x: number; y: number; z: number }; yaw: number };
  /** Last chat broadcast time (server clock ms). Used for rate-limiting. */
  lastChatAtMs: number;
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

  /** Spawn at the start of the road (the -X end of the world), facing
   *  along +X so pressing W drives toward the petrol station and then
   *  the mountain. Y clearance is generous: chassis-center must clear
   *  chassis half-extent + suspension + wheel radius. */
  private nextSpawn(): { position: { x: number; y: number; z: number }; yaw: number } {
    const n = this.players.size;
    const slot = n % 16;
    const col = slot % 8;
    const row = Math.floor(slot / 8);
    const startX = -this.world.terrain.size / 2 + 24; // 24m in from the world edge
    // 5m spacing between slots: trucks are 3.8m long, so anything tighter
    // means two players in adjacent slots spawn overlapping each other,
    // which can push one through the heightfield and trip the off-map
    // ejector. 5m gives about 1m of clearance.
    const x = startX + col * 5;
    const z = row === 0 ? -1.2 : 1.2;                 // two lanes
    // yaw = pi/2 rotates local +Z (vehicle forward) to world +X.
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
      lastChatAtMs: 0,
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

    this.ejectOffMapPlayers();

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

  /** MX-Unleashed-style off-map ejector. If a player gets past the
   *  perimeter cliff wall (clipping, edge cases, fell through the
   *  floor, etc.) they're fired into the air toward the world centre.
   *  Cheap safety net: prevents players from escaping the world while
   *  also being slightly entertaining when triggered. */
  private ejectOffMapPlayers(): void {
    const half = this.world.terrain.size / 2;
    const margin = 6; // start ejecting once they're past the wall + a bit
    for (const p of this.players.values()) {
      const t = p.vehicle.body.translation();
      const offX = Math.abs(t.x) > half - margin;
      const offZ = Math.abs(t.z) > half - margin;
      const fellThrough = t.y < -8;
      if (!offX && !offZ && !fellThrough) continue;
      // Aim at the world centre on the horizontal plane plus a strong
      // upward component. Speed is fixed so the trajectory is
      // predictable; the player will hopefully laugh and try not to
      // do it again.
      const dx = -t.x;
      const dz = -t.z;
      const len = Math.hypot(dx, dz) || 1;
      const horizSpeed = 40;
      const upSpeed = 35;
      p.vehicle.body.setLinvel(
        { x: (dx / len) * horizSpeed, y: upSpeed, z: (dz / len) * horizSpeed },
        true,
      );
      // Reset angular velocity so they don't tumble out of control.
      p.vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      // If they really fell through, also lift their position a bit
      // so they aren't stuck below the heightfield.
      if (fellThrough) {
        p.vehicle.body.setTranslation({ x: t.x, y: 5, z: t.z }, true);
      }
    }
  }

  /** Sanitise + rate-limit + relay a chat message. Strips control chars
   *  and clamps length; drops messages from a sender that chatted within
   *  CHAT_MIN_INTERVAL_MS of their last broadcast. */
  broadcastChat(handle: PlayerHandle, raw: string): void {
    const p = this.players.get(handle.id);
    if (!p) return;
    const now = this.nowMs();
    if (now - p.lastChatAtMs < CHAT_MIN_INTERVAL_MS) return;
    const text = raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .trim()
      .slice(0, CHAT_MAX_LEN);
    if (!text) return;
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
}

const CHAT_MAX_LEN = 200;
const CHAT_MIN_INTERVAL_MS = 800;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

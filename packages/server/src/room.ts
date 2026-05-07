// A Room owns one World, all connected players, and the fixed-step loop.
// Single-room MVP. Sharding into multiple rooms is a later concern.

import {
  FIXED_DT,
  TICK_RATE,
  SNAPSHOT_INTERVAL_MS,
  RUT_REBUILD_INTERVAL_TICKS,
  RUTS_ENABLED,
  BUTTONS,
  EMPTY_INPUT,
  VEHICLE,
  AXLE,
  GRAVITY_Y,
  TERRAIN,
  Net,
  Physics,
  type PlayerId,
  type PlayerInput,
  type PlayerSnapshot,
  type WorldSnapshot,
  type CarKind,
} from '@mydrunner/shared';

// Spawn chassis at suspension equilibrium so there is no free-fall and the
// springs are already at their loaded rest position.  Derived from:
//   comp_eq = weight / (k_front + k_rear)
//   chassis_y = restLength + wheelRadius + |wheel_local_y| - comp_eq
const SPAWN_Y_ABOVE_GROUND =
  VEHICLE.suspensionRestLength +
  VEHICLE.wheelRadius +
  Math.abs(VEHICLE.wheelPositions[0]!.y) -
  (VEHICLE.mass * Math.abs(GRAVITY_Y)) / (AXLE.front.rideStiffness + AXLE.rear.rideStiffness);

export interface PlayerHandle {
  id: PlayerId;
  name: string;
  carKind: CarKind;
  send(msg: Uint8Array): void;
}

interface InternalPlayer {
  handle: PlayerHandle;
  vehicle: Physics.VehicleLike;
  pendingInput: PlayerInput;
  lastAckSeq: number;
  /** Last tick's PlayerInput.buttons. Edge-triggered actions (RESET,
   *  WINCH_DEPLOY_TOGGLE, WINCH_ATTACH) fire only on the rising edge
   *  computed from `pendingInput.buttons & ~prevButtons`. */
  prevButtons: number;
  spawn: { position: { x: number; y: number; z: number }; yaw: number };
  /** Last chat broadcast time (server clock ms). Used for rate-limiting. */
  lastChatAtMs: number;
  /** Latency trace state. Populated when input.steer transitions from
   *  ~0 to a clear deflection; tickOnce() then records when the
   *  vehicle's currentSteer and yaw rate cross diagnostic thresholds
   *  and emits a one-shot stdout line. Used by tests/latency.spec.ts to
   *  see the server-side budget unaffected by Playwright's CDP gap. */
  trace: SteerTrace | null;
}

interface SteerTrace {
  startMs: number;
  startSteer: number;
  startAngVelY: number;
  t25Ms: number;
  t50Ms: number;
  tAngVelMs: number;
  done: boolean;
}

export class Room {
  readonly world: Physics.World;
  private readonly players = new Map<PlayerId, InternalPlayer>();
  private tick = 0;
  private startedAtMs = Date.now();
  private snapAccumMs = 0;
  private loopHandle: NodeJS.Timeout | null = null;
  /** Wall-clock deadline for the next tick. The loop catches up by running
   *  multiple tickOnce() calls in a row when behind, instead of slipping
   *  one full tick on every overrun like the older
   *  `setTimeout(loop, max(0, target-work))` did. Without this the
   *  snapshot rate slipped from 30 Hz to ~20 Hz under load, which the
   *  client reported as `gap mean=50ms` and growing prediction queue. */
  private nextTickAtMs = 0;
  private rutBuffer: Physics.RutBuffer;
  private rutVersion = 0;
  private ticksSinceRutFlush = 0;
  private perf: PerfBucket = newPerfBucket();
  private lastTickStartMs = 0;

  constructor(seed = 1337) {
    this.world = new Physics.World({ generate: { size: 320, resolution: 128, seed } });
    this.rutBuffer = new Physics.RutBuffer(this.world.terrain);
  }

  start(): void {
    if (this.loopHandle) return;
    this.nextTickAtMs = performance.now();
    this.runLoop();
  }

  private runLoop(): void {
    // Catch up any ticks whose deadlines have passed. Cap the catch-up at
    // 4 ticks per loop iteration so a single Node GC pause or a long tick
    // doesn't burn the event loop replaying half a second of physics in
    // one go - we'd rather drop the difference and resync than freeze.
    let caught = 0;
    let now = performance.now();
    while (now >= this.nextTickAtMs && caught < 4) {
      this.tickOnce();
      this.nextTickAtMs += TARGET_TICK_MS;
      caught += 1;
      now = performance.now();
    }
    // If we're more than 250 ms behind real time even after the catch-up
    // budget, give up on the lost ticks and resync the deadline. Better
    // to skip than to spiral.
    if (now - this.nextTickAtMs > 250) {
      this.nextTickAtMs = now;
    }
    const wait = Math.max(0, this.nextTickAtMs - now);
    // setTimeout has ~1 ms minimum on Linux; that's fine because the
    // deadline arithmetic above corrects for it. setImmediate would burn
    // CPU when ahead of schedule.
    this.loopHandle = setTimeout(() => this.runLoop(), wait) as unknown as NodeJS.Timeout;
  }

  stop(): void {
    if (this.loopHandle) clearTimeout(this.loopHandle);
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
    const z = TERRAIN.roadZ + (row === 0 ? -1.2 : 1.2); // two lanes on the main road
    // yaw = pi/2 rotates local +Z (vehicle forward) to world +X.
    const yaw = Math.PI / 2;
    const idx = Physics.worldToTerrainIndex(this.world.terrain, x, z);
    const ground = idx >= 0 ? (this.world.terrain.heights[idx] ?? 0) : 0;
    return { position: { x, y: ground + SPAWN_Y_ABOVE_GROUND, z }, yaw };
  }

  addPlayer(handle: PlayerHandle): void {
    const spawn = this.nextSpawn();
    const vehicle = this.world.spawnVehicle(handle.id, spawn);
    this.players.set(handle.id, {
      handle,
      vehicle,
      pendingInput: { ...EMPTY_INPUT },
      lastAckSeq: 0,
      prevButtons: 0,
      trace: null,
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
    // Latency trace: detect a clear 0 -> deflection transition. Only
    // arms when no trace is in flight, so a held input doesn't keep
    // re-firing.
    if (
      p.trace === null &&
      Math.abs(p.pendingInput.steer) < 0.05 &&
      Math.abs(input.steer) >= 0.5
    ) {
      const st = p.vehicle.getState();
      p.trace = {
        startMs: performance.now(),
        startSteer: st.wheels[0]?.steer ?? 0,
        startAngVelY: st.angVel.y,
        t25Ms: 0,
        t50Ms: 0,
        tAngVelMs: 0,
        done: false,
      };
    }
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
    const tickStart = performance.now();
    if (this.lastTickStartMs > 0) {
      const interval = tickStart - this.lastTickStartMs;
      const drift = Math.abs(interval - TARGET_TICK_MS);
      this.perf.driftCount += 1;
      this.perf.driftSumMs += drift;
      if (drift > this.perf.driftMaxMs) this.perf.driftMaxMs = drift;
      if (interval > TARGET_TICK_MS * 2) this.perf.lateFires += 1;
    }
    this.lastTickStartMs = tickStart;

    for (const p of this.players.values()) {
      const buttons = p.pendingInput.buttons | 0;
      // Rising-edge mask: bits set this tick but not last tick. The
      // unsigned shift coerces back to a non-negative 32-bit int.
      const pressed = (buttons & ~p.prevButtons) >>> 0;

      if (pressed & BUTTONS.RESET) p.vehicle.resetTo(p.spawn);
      if (pressed & BUTTONS.WINCH_DEPLOY_TOGGLE) p.vehicle.winch.toggleDeploy();
      if (pressed & BUTTONS.WINCH_ATTACH) p.vehicle.winch.tryAttach(this.world);
      p.vehicle.winch.setReelInput({
        in:  (buttons & BUTTONS.WINCH_REEL_IN)  !== 0,
        out: (buttons & BUTTONS.WINCH_REEL_OUT) !== 0,
      });

      p.prevButtons = buttons;
      p.vehicle.setInput(p.pendingInput);
    }
    this.world.step();
    this.tick += 1;

    // Latency trace: for any player whose trace is armed, record when
    // server-side currentSteer crosses 25%/50% of maxSteer and when
    // |angVel.y| crosses 0.1 rad/s, then emit a one-line summary.
    for (const p of this.players.values()) {
      const tr = p.trace;
      if (!tr || tr.done) continue;
      const elapsed = performance.now() - tr.startMs;
      const st = p.vehicle.getState();
      // Measure deltas from the trace's baseline so existing yaw drift
      // (suspension oscillation while driving straight) doesn't trip the
      // angVel threshold immediately.
      const dSteer = Math.abs((st.wheels[0]?.steer ?? 0) - tr.startSteer);
      const dAngVelY = Math.abs(st.angVel.y - tr.startAngVelY);
      if (tr.t25Ms === 0 && dSteer > 0.25 * VEHICLE.maxSteer) tr.t25Ms = elapsed;
      if (tr.t50Ms === 0 && dSteer > 0.5 * VEHICLE.maxSteer) tr.t50Ms = elapsed;
      if (tr.tAngVelMs === 0 && dAngVelY > 0.3) tr.tAngVelMs = elapsed;
      if (tr.t25Ms > 0 && tr.t50Ms > 0 && tr.tAngVelMs > 0) {
        console.log(
          `[mydrunner-server] [trace] steer25=${tr.t25Ms.toFixed(0)}ms ` +
            `steer50=${tr.t50Ms.toFixed(0)}ms ` +
            `dAngVelY>0.3=${tr.tAngVelMs.toFixed(0)}ms`,
        );
        tr.done = true;
      } else if (elapsed > 1500) {
        console.log(
          `[mydrunner-server] [trace] player=${p.handle.id} INCOMPLETE ` +
            `t25=${tr.t25Ms.toFixed(0)} t50=${tr.t50Ms.toFixed(0)} angVel=${tr.tAngVelMs.toFixed(0)}`,
        );
        tr.done = true;
      }
    }

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
      // Subtract the interval rather than resetting to 0 so the fractional
      // remainder carries forward; otherwise we lose ~0.5 ms per cycle
      // and the broadcast cadence drifts off the intended 30 Hz over
      // the course of a session.
      this.snapAccumMs -= SNAPSHOT_INTERVAL_MS;
      this.broadcastSnapshot();
    }

    const tickMs = performance.now() - tickStart;
    this.perf.ticks += 1;
    this.perf.tickSumMs += tickMs;
    if (tickMs > this.perf.tickMaxMs) this.perf.tickMaxMs = tickMs;
    if (tickMs > TARGET_TICK_MS) this.perf.tickOverBudget += 1;
    if (tickMs > TARGET_TICK_MS * 2) this.perf.tickOver2x += 1;
    if (tickStart - this.perf.startedAtMs >= PERF_WINDOW_MS) this.flushPerf();
  }

  private flushPerf(): void {
    if (process.env.NODE_ENV === 'test') {
      this.perf = newPerfBucket();
      return;
    }
    const p = this.perf;
    const meanTick = p.ticks > 0 ? p.tickSumMs / p.ticks : 0;
    const meanDrift = p.driftCount > 0 ? p.driftSumMs / p.driftCount : 0;
    const meanSnap = p.snaps > 0 ? p.snapSumBytes / p.snaps : 0;
    const elapsedS = (performance.now() - p.startedAtMs) / 1000;
    console.log(
      `[mydrunner-server] perf ${elapsedS.toFixed(1)}s ` +
        `players=${this.players.size} ` +
        `tick mean=${meanTick.toFixed(2)}ms max=${p.tickMaxMs.toFixed(2)}ms ` +
        `over16=${p.tickOverBudget} over33=${p.tickOver2x} ` +
        `drift mean=${meanDrift.toFixed(2)}ms max=${p.driftMaxMs.toFixed(2)}ms ` +
        `lateFires=${p.lateFires} ` +
        `snaps=${p.snaps} meanBytes=${meanSnap.toFixed(0)} maxBytes=${p.snapMaxBytes}`,
    );
    this.perf = newPerfBucket();
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
    this.perf.snaps += 1;
    this.perf.snapSumBytes += msg.length;
    if (msg.length > this.perf.snapMaxBytes) this.perf.snapMaxBytes = msg.length;
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

const TARGET_TICK_MS = 1000 / TICK_RATE;
const PERF_WINDOW_MS = 5000;

interface PerfBucket {
  startedAtMs: number;
  ticks: number;
  tickSumMs: number;
  tickMaxMs: number;
  tickOverBudget: number;
  tickOver2x: number;
  driftCount: number;
  driftSumMs: number;
  driftMaxMs: number;
  lateFires: number;
  snaps: number;
  snapSumBytes: number;
  snapMaxBytes: number;
}

function newPerfBucket(): PerfBucket {
  return {
    startedAtMs: performance.now(),
    ticks: 0,
    tickSumMs: 0,
    tickMaxMs: 0,
    tickOverBudget: 0,
    tickOver2x: 0,
    driftCount: 0,
    driftSumMs: 0,
    driftMaxMs: 0,
    lateFires: 0,
    snaps: 0,
    snapSumBytes: 0,
    snapMaxBytes: 0,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

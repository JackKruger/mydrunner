// A Room owns multiplayer membership and relays client-owned vehicle state.
// It deliberately has no Rapier world: each browser is authoritative for
// its own truck, while the room aggregates the latest owner states into the
// snapshot stream consumed by remote interpolation.

import {
  SNAPSHOT_INTERVAL_MS,
  WINCH,
  PROTOCOL_VERSION,
  Maps,
  Net,
  Physics,
  UNDAMAGED_VEHICLE,
  createStockBuild,
  normalizeVehicleBuildDetailed,
  type PlayerId,
  type PlayerSnapshot,
  type VehicleState,
  type VehicleStateUpdate,
  type WorldSnapshot,
  type WinchLinkSnapshot,
  type CarKind,
  type VehicleBuild,
} from '@mydrunner/shared';

export interface PlayerHandle {
  id: PlayerId;
  name: string;
  /** Complete current identity. carKind is accepted for old test fixtures. */
  build?: VehicleBuild;
  carKind?: CarKind;
  send(msg: Uint8Array): void;
}

interface InternalPlayer {
  handle: PlayerHandle;
  state: VehicleState;
  stateSeq: number;
  spawn: { position: { x: number; y: number; z: number }; yaw: number };
  slot: number;
  lastChatAtMs: number;
  build: VehicleBuild;
  buildRevision: number;
  workshopMode: boolean;
  leaseId: string | null;
  winchCommandSeq: number;
  winchRevision: number;
  lastWinchAttachAtMs: number;
  rutSequence: number;
  lastRutAtMs: number;
}

interface InternalWinch extends WinchLinkSnapshot {
  lastRuntimeAtMs: number;
}

interface BayLease {
  bayId: string;
  playerId: PlayerId;
  leaseId: string;
  expiresAtMs: number;
  pose: { position: { x: number; y: number; z: number }; yaw: number };
}

export class Room {
  readonly map: Maps.MapWorld;
  /** Content hash of the loaded document in this build. */
  readonly mapRev: number;
  private readonly players = new Map<PlayerId, InternalPlayer>();
  private readonly bayLeases = new Map<string, BayLease>();
  private readonly winches = new Map<PlayerId, InternalWinch>();
  private tick = 0;
  private readonly startedAtMs = performance.now();
  private loopHandle: NodeJS.Timeout | null = null;
  private nextSnapshotAtMs = 0;
  private relayUpdates = 0;
  private snapshotBytes = 0;
  private snapshotMaxBytes = 0;
  private perfStartedAtMs = performance.now();
  private readonly ruts: Physics.SparseRutField;
  private rutGlobalSequence = 0;

  constructor(map: string | Maps.MapDoc = Maps.DEFAULT_MAP_ID) {
    const doc = typeof map === 'string' ? Maps.getMap(map) : map;
    if (!doc) throw new Error(`Room: unknown map "${String(map)}"`);
    this.map = Maps.applyMapDoc(doc);
    this.mapRev = Maps.mapDocRev(doc);
    this.ruts = new Physics.SparseRutField(this.map.terrain.size);
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
    kind: CarKind | VehicleBuild,
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
    const build = normalizeVehicleBuildDetailed(handle.build ?? { carKind: handle.carKind }).build;
    const { slot, ...spawn } = this.nextSpawn(build);
    this.players.set(handle.id, {
      handle,
      state: initialVehicleState(spawn, build),
      stateSeq: 0,
      spawn,
      slot,
      lastChatAtMs: 0,
      build,
      buildRevision: 1,
      workshopMode: false,
      leaseId: null,
      winchCommandSeq: 0,
      winchRevision: 0,
      lastWinchAttachAtMs: Number.NEGATIVE_INFINITY,
      rutSequence: 0,
      lastRutAtMs: Number.NEGATIVE_INFINITY,
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
        build,
      }),
    );
    this.sendRutSync(handle);
  }

  private sendRutSync(handle: PlayerHandle): void {
    const tiles = this.ruts.exportTiles();
    handle.send(Net.encode({
      t: 'rut-sync-start',
      globalSequence: this.rutGlobalSequence,
      tileCount: tiles.length,
    }));
    for (const tile of tiles) handle.send(Net.encode({ t: 'rut-tile', tile }));
    handle.send(Net.encode({ t: 'rut-sync-end', globalSequence: this.rutGlobalSequence }));
  }

  applyRutStamp(id: PlayerId, proposed: Physics.PredictedRutStamp): boolean {
    const player = this.players.get(id);
    if (!player) return false;
    const reject = (): false => {
      player.handle.send(Net.encode({
        t: 'rut-result', ownerSequence: proposed.ownerSequence, accepted: false,
      }));
      return false;
    };
    if (proposed.ownerSequence <= player.rutSequence) return reject();
    const now = this.nowMs();
    if (now - player.lastRutAtMs < 100) return reject();
    if (Math.hypot(proposed.x - player.state.position.x, proposed.z - player.state.position.z) > 4) return reject();
    if (proposed.radiusLong < 0.25 || proposed.radiusLong > 1.5
      || proposed.radiusLat < 0.125 || proposed.radiusLat > 0.8
      || proposed.depth <= 0 || proposed.depth > 0.04) return reject();
    const surface = Physics.sampleSurface(this.map.terrain, proposed.x, proposed.z);
    if (surface !== Physics.Surface.Mud && surface !== Physics.Surface.DeepMud) return reject();

    player.rutSequence = proposed.ownerSequence;
    player.lastRutAtMs = now;
    const stamp: Physics.RutStamp = {
      ...proposed,
      ownerId: id,
      globalSequence: ++this.rutGlobalSequence,
    };
    this.ruts.applyStamp(stamp);
    player.handle.send(Net.encode({
      t: 'rut-result',
      ownerSequence: proposed.ownerSequence,
      accepted: true,
      globalSequence: stamp.globalSequence,
    }));
    const message = Net.encode({ t: 'rut-batch', stamps: [stamp] });
    for (const peer of this.players.values()) peer.handle.send(message);
    return true;
  }

  removePlayer(id: PlayerId): void {
    this.removeWinchesForPlayer(id, 'target-lost');
    this.releaseLease(id);
    this.players.delete(id);
  }

  /** Accept the newest canonical state from a vehicle's owning client. */
  applyVehicleState(id: PlayerId, update: VehicleStateUpdate): void {
    const p = this.players.get(id);
    if (!p || !Number.isSafeInteger(update.seq) || update.seq <= p.stateSeq) return;
    if (!isFiniteVehicleState(update.vehicle)) return;
    if ((update.vehicle.drivetrain.frontLocked && !p.build.frontLocker)
      || (update.vehicle.drivetrain.rearLocked && !p.build.rearLocker)) return;
    if (Physics.geomFor(p.build).spec.drivetrain === 'fixed-rwd'
      && (update.vehicle.drivetrain.transferCase !== '2h'
        || update.vehicle.drivetrain.frontLocked
        || update.vehicle.drivetrain.rearLocked)) return;
    // While leased, the server's authored bay pose is canonical. Ignoring
    // owner uploads prevents a modified client from driving its collision
    // proxy through the workshop while everyone else sees customization.
    if (p.workshopMode) return;
    p.state = update.vehicle;
    p.stateSeq = update.seq;
    this.applyWinchRuntime(id, update.winch);
    this.relayUpdates += 1;
  }

  requestWorkshopEnter(id: PlayerId, bayId: string): void {
    const p = this.players.get(id);
    if (!p) return;
    const marker = this.map.markers.find((m) => m.kind === 'garageBay' && m.id === bayId);
    if (!marker) return this.sendWorkshopAck(p, 'enter', false, 'Unknown workshop bay.');
    this.expireLeases();
    const occupied = this.bayLeases.get(bayId);
    if (occupied && occupied.playerId !== id) {
      return this.sendWorkshopAck(p, 'enter', false, 'That workshop bay is occupied.');
    }
    const pos = p.state.position;
    const distance = Math.hypot(pos.x - marker.x, pos.z - marker.z);
    const speed = Math.hypot(p.state.linVel.x, p.state.linVel.y, p.state.linVel.z);
    const upY = 1 - 2 * (p.state.rotation.x ** 2 + p.state.rotation.z ** 2);
    if (distance > marker.radius) return this.sendWorkshopAck(p, 'enter', false, 'Drive fully into the marked bay.');
    if (speed > 0.8) return this.sendWorkshopAck(p, 'enter', false, 'Stop the vehicle before opening the workshop.');
    if (upY < 0.65) return this.sendWorkshopAck(p, 'enter', false, 'The vehicle must be upright.');
    this.removeWinchesForPlayer(id, 'invalid');
    this.releaseLease(id);
    const ground = Physics.sampleHeightBilinear(this.map.terrain, marker.x, marker.z);
    const pose = {
      position: {
        x: marker.x,
        y: ground + Physics.spawnYAboveGround(p.build),
        z: marker.z,
      },
      yaw: marker.yaw ?? 0,
    };
    const leaseId = `${id}:${bayId}:${Math.round(performance.now())}`;
    this.bayLeases.set(bayId, {
      bayId, playerId: id, leaseId,
      expiresAtMs: performance.now() + WORKSHOP_LEASE_MS,
      pose,
    });
    p.workshopMode = true;
    p.leaseId = leaseId;
    p.state = initialVehicleState(pose, p.build);
    this.sendWorkshopAck(p, 'enter', true, undefined, { leaseId, bayId, pose, build: p.build, buildRevision: p.buildRevision });
  }

  requestWorkshopExit(id: PlayerId, leaseId: string): void {
    const p = this.players.get(id);
    if (!p) return;
    if (!p.leaseId || p.leaseId !== leaseId) {
      return this.sendWorkshopAck(p, 'exit', false, 'Workshop lease expired.');
    }
    this.releaseLease(id);
    this.sendWorkshopAck(p, 'exit', true);
  }

  requestBuildUpdate(id: PlayerId, leaseId: string, build: VehicleBuild, issues: readonly string[] = []): void {
    const p = this.players.get(id);
    if (!p) return;
    if (!p.workshopMode || !p.leaseId || p.leaseId !== leaseId) {
      return this.sendWorkshopAck(p, 'apply', false, 'Enter a workshop bay before applying a build.');
    }
    if (issues.length > 0) return this.sendWorkshopAck(p, 'apply', false, issues[0]);
    const result = normalizeVehicleBuildDetailed(build);
    if (result.issues.length > 0) return this.sendWorkshopAck(p, 'apply', false, result.issues[0]);
    p.build = result.build;
    p.buildRevision += 1;
    const lease = [...this.bayLeases.values()].find((entry) => entry.leaseId === leaseId);
    if (lease) {
      const ground = Physics.sampleHeightBilinear(this.map.terrain, lease.pose.position.x, lease.pose.position.z);
      lease.pose.position.y = ground + Physics.spawnYAboveGround(p.build);
      p.state = initialVehicleState(lease.pose, p.build);
    }
    // workshopMode remains true until the client receives this confirmed
    // revision, rebuilds owner physics, then requests exit.
    this.broadcastSnapshot();
    this.sendWorkshopAck(p, 'apply', true, undefined, {
      leaseId, build: p.build, buildRevision: p.buildRevision,
      pose: lease?.pose,
    });
  }

  requestWinchCommand(id: PlayerId, message: Extract<Net.ClientMessage, { t: 'winch-command' }>): void {
    const player = this.players.get(id);
    if (!player || message.seq <= player.winchCommandSeq) return;
    player.winchCommandSeq = message.seq;
    if (!('target' in message)) {
      const link = this.winches.get(id);
      if (!link) return this.sendWinchAck(player, message.seq, false, 'No winch cable is attached.');
      this.winches.delete(id);
      this.sendWinchAck(player, message.seq, true);
      return;
    }
    const now = performance.now();
    if (now - player.lastWinchAttachAtMs < 100) {
      return this.sendWinchAck(player, message.seq, false, 'Winch request rate limited.');
    }
    player.lastWinchAttachAtMs = now;
    if (player.workshopMode) return this.sendWinchAck(player, message.seq, false, 'Leave the workshop before using the winch.');
    if (!player.build.winchId.endsWith('.fitted') || !player.build.frontBarId.endsWith('.steel-winch')) {
      return this.sendWinchAck(player, message.seq, false, 'Fit a recovery winch and steel winch bar first.');
    }
    if (this.winches.has(id)) return this.sendWinchAck(player, message.seq, false, 'A cable is already attached.');

    const source = Physics.transformPoint(
      Physics.geomFor(player.build).recoveryPoints.fairlead,
      player.state.position,
      player.state.rotation,
    );
    let target: WinchLinkSnapshot['target'];
    let targetPoint: { x: number; y: number; z: number };
    if (message.target.kind === 'obstacle') {
      const obstacleId = message.target.obstacleId;
      const obstacle = this.map.obstacles.find((entry) => entry.id === obstacleId);
      const anchor = obstacle ? Physics.winchAnchorForObstacle(obstacle, source) : null;
      if (!obstacle || !anchor) return this.sendWinchAck(player, message.seq, false, 'That object is not a recovery anchor.');
      target = { kind: 'obstacle', obstacleId: obstacle.id, anchor };
      targetPoint = anchor;
    } else {
      const targetPlayer = this.players.get(message.target.playerId);
      if (!targetPlayer || targetPlayer.handle.id === id || targetPlayer.workshopMode) {
        return this.sendWinchAck(player, message.seq, false, 'That vehicle is unavailable.');
      }
      const duplicate = [...this.winches.values()].some((link) =>
        link.target.kind === 'vehicle'
        && ((link.ownerId === id && link.target.playerId === targetPlayer.handle.id)
          || (link.ownerId === targetPlayer.handle.id && link.target.playerId === id)));
      if (duplicate) return this.sendWinchAck(player, message.seq, false, 'Those vehicles are already linked.');
      const incoming = [...this.winches.values()].filter((link) =>
        link.target.kind === 'vehicle' && link.target.playerId === targetPlayer.handle.id).length;
      if (incoming >= WINCH.maxIncomingLinks) return this.sendWinchAck(player, message.seq, false, 'That vehicle has no free recovery point.');
      const local = Physics.geomFor(targetPlayer.build).recoveryPoints[message.target.point];
      targetPoint = Physics.transformPoint(local, targetPlayer.state.position, targetPlayer.state.rotation);
      target = { kind: 'vehicle', playerId: targetPlayer.handle.id, point: message.target.point };
    }
    const distance = Math.hypot(targetPoint.x - source.x, targetPoint.y - source.y, targetPoint.z - source.z);
    if (!Number.isFinite(distance) || distance > WINCH.maxAttachDistance) {
      return this.sendWinchAck(player, message.seq, false, 'The recovery point is out of range.');
    }
    const link: InternalWinch = {
      id: `${id}:${++player.winchRevision}`,
      ownerId: id,
      target,
      cableLength: Math.max(WINCH.minCableLength, Math.min(WINCH.maxCableLength, distance + WINCH.attachSlack)),
      motor: 0,
      tension: 0,
      status: 'attached',
      lastRuntimeAtMs: performance.now(),
    };
    this.winches.set(id, link);
    this.sendWinchAck(player, message.seq, true, undefined, link);
  }

  private applyWinchRuntime(id: PlayerId, runtime: VehicleStateUpdate['winch']): void {
    const link = this.winches.get(id);
    if (!link || !runtime || runtime.linkId !== link.id) return;
    if (!Number.isFinite(runtime.cableLength) || !Number.isFinite(runtime.tension)
      || runtime.cableLength < WINCH.minCableLength || runtime.cableLength > WINCH.maxCableLength
      || runtime.tension < 0 || runtime.tension > WINCH.breakForce
      || ![-1, 0, 1].includes(runtime.motor)) return;
    const now = performance.now();
    const elapsed = Math.max(0, (now - link.lastRuntimeAtMs) / 1000);
    const maxChange = WINCH.reelOutSpeed * elapsed + 0.1;
    if (Math.abs(runtime.cableLength - link.cableLength) > maxChange) return;
    link.cableLength = runtime.cableLength;
    link.motor = runtime.motor;
    link.tension = runtime.tension;
    link.status = runtime.tension >= WINCH.breakForce * 0.99
      ? 'overload'
      : runtime.motor === 1 && runtime.tension >= WINCH.ratedPull * 0.98
        ? 'stalled' : 'attached';
    link.lastRuntimeAtMs = now;
  }

  private sendWinchAck(player: InternalPlayer, seq: number, ok: boolean, reason?: string, link?: WinchLinkSnapshot): void {
    const message: Extract<Net.ServerMessage, { t: 'winch-ack' }> = { t: 'winch-ack', seq, ok };
    if (reason) message.reason = reason;
    if (link) message.link = link;
    player.handle.send(Net.encode(message));
  }

  private removeWinchesForPlayer(id: PlayerId, reason: 'target-lost' | 'invalid'): void {
    for (const [ownerId, link] of [...this.winches]) {
      if (ownerId !== id && !(link.target.kind === 'vehicle' && link.target.playerId === id)) continue;
      this.winches.delete(ownerId);
      const owner = this.players.get(ownerId);
      if (owner) owner.handle.send(Net.encode({ t: 'winch-event', linkId: link.id, reason }));
    }
  }

  private sendWorkshopAck(
    p: InternalPlayer,
    action: 'enter' | 'exit' | 'apply',
    ok: boolean,
    reason?: string,
    extra: Partial<Extract<Net.ServerMessage, { t: 'workshop-ack' }>> = {},
  ): void {
    const ack: Extract<Net.ServerMessage, { t: 'workshop-ack' }> = {
      t: 'workshop-ack', action, ok, ...extra,
    };
    if (reason !== undefined) ack.reason = reason;
    p.handle.send(Net.encode(ack));
  }

  private releaseLease(id: PlayerId): void {
    const p = this.players.get(id);
    for (const [bayId, lease] of this.bayLeases) {
      if (lease.playerId === id) this.bayLeases.delete(bayId);
    }
    if (p) {
      p.workshopMode = false;
      p.leaseId = null;
    }
  }

  private expireLeases(): void {
    const now = performance.now();
    for (const lease of [...this.bayLeases.values()]) {
      if (lease.expiresAtMs <= now) this.releaseLease(lease.playerId);
    }
  }

  /** Exposed for deterministic tests; production calls it from runLoop. */
  broadcastSnapshot(): void {
    this.expireLeases();
    const now = performance.now();
    for (const [ownerId, link] of [...this.winches]) {
      if (now - link.lastRuntimeAtMs > 250) link.motor = 0;
      if (now - link.lastRuntimeAtMs > 500) {
        link.tension = 0;
        link.status = 'attached';
      }
      const endpoints = this.winchEndpoints(link);
      if (!endpoints || Math.hypot(
        endpoints.target.x - endpoints.source.x,
        endpoints.target.y - endpoints.source.y,
        endpoints.target.z - endpoints.source.z,
      ) > WINCH.maxCableLength + WINCH.separationGrace) {
        this.winches.delete(ownerId);
        const owner = this.players.get(ownerId);
        owner?.handle.send(Net.encode({ t: 'winch-event', linkId: link.id, reason: 'target-lost' }));
      }
    }
    const players: PlayerSnapshot[] = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.handle.id,
        name: p.handle.name,
        build: p.build,
        buildRevision: p.buildRevision,
        workshopMode: p.workshopMode,
        vehicle: p.state,
        stateSeq: p.stateSeq,
      });
    }
    const snap: WorldSnapshot = {
      tick: this.tick,
      serverTimeMs: this.nowMs(),
      players,
      winches: [...this.winches.values()].map(({ lastRuntimeAtMs: _ignored, ...link }) => link),
    };
    const msg = Net.encode({ t: 'snapshot', snap });
    for (const p of this.players.values()) p.handle.send(msg);
    this.snapshotBytes += msg.length;
    if (msg.length > this.snapshotMaxBytes) this.snapshotMaxBytes = msg.length;
  }

  private winchEndpoints(link: InternalWinch): { source: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } } | null {
    const owner = this.players.get(link.ownerId);
    if (!owner) return null;
    const source = Physics.transformPoint(Physics.geomFor(owner.build).recoveryPoints.fairlead, owner.state.position, owner.state.rotation);
    if (link.target.kind === 'obstacle') return { source, target: link.target.anchor };
    const targetPlayer = this.players.get(link.target.playerId);
    if (!targetPlayer) return null;
    const local = Physics.geomFor(targetPlayer.build).recoveryPoints[link.target.point];
    return { source, target: Physics.transformPoint(local, targetPlayer.state.position, targetPlayer.state.rotation) };
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
  build: VehicleBuild = createStockBuild(),
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
    drivetrain: {
      transferCase: Physics.geomFor(build).spec.drivetrain === 'fixed-rwd' ? '2h' : '4h',
      frontLocked: false,
      rearLocked: false,
    },
    damage: { ...UNDAMAGED_VEHICLE },
    wheels: Array.from({ length: 4 }, () => ({
      steer: 0,
      spin: 0,
      contact: false,
      suspensionLength: 0,
      angVel: 0,
      tireDeflection: 0,
      tireContactNormal: { x: 0, y: 1, z: 0 },
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
    v.damage.body, v.damage.engine, v.damage.steering,
  ];
  for (const wheel of v.wheels) {
    numbers.push(wheel.steer, wheel.spin, wheel.suspensionLength, wheel.angVel);
  }
  for (const axle of v.axles) numbers.push(axle.rideY, axle.rollAngle);
  const damageValid = v.damage.body >= 0 && v.damage.body <= 1
    && v.damage.engine >= 0 && v.damage.engine <= 1
    && v.damage.steering >= 0 && v.damage.steering <= 1
    && (v.damage.stoppedCause === 'none' || v.damage.stoppedCause === 'collision' || v.damage.stoppedCause === 'flooding');
  const drivetrainValid = (
    v.drivetrain.transferCase === '2h'
    || v.drivetrain.transferCase === '4h'
    || v.drivetrain.transferCase === '4l'
  )
    && typeof v.drivetrain.frontLocked === 'boolean'
    && typeof v.drivetrain.rearLocked === 'boolean';
  return v.wheels.length === 4 && numbers.every(Number.isFinite) && damageValid && drivetrainValid;
}

const CHAT_MIN_INTERVAL_MS = 800;
const SPAWN_SLOTS = Maps.SPAWN_SLOTS;
const PERF_WINDOW_MS = 5000;
const WORKSHOP_LEASE_MS = 120_000;

# Winching System — Design

Recovery winch for stuck vehicles. Cable to a static anchor (tree, rock,
post) or to another player's vehicle; spool in to drag yourself out.

This design fits the existing mydrunner architecture: Rapier physics in
`packages/shared/src/physics/`, server-authoritative 60 Hz tick in
`packages/server/src/room.ts`, client prediction in
`packages/client/src/prediction.ts`. No new physics engine, no new tick loop.

## 1. Scope

- **v1**: deploy → attach to anchor → reel in → release. Cable can snap.
  Works against static obstacles and against other vehicles.
- **Out of v1**: cable wrapping around terrain/objects, multi-pulley rigging,
  cable-cable collision, dragging the hook through the world (we use a
  point-and-click attach).

## 2. Architecture overview

```
PlayerInput.buttons  ──►  Room.tickOnce  ──►  SolidAxleVehicle.preStep
   (bits 1..3)               (server)             (winch.applyForces)
                                │
                                ├──►  Winch (per vehicle)
                                │       state, spoolLength, anchorRef
                                │
                                └──►  VehicleState.winch  ──►  snapshot
                                                                  │
                                          client prediction ◄─────┤
                                          client visual    ◄──────┘
```

The `Winch` is a small per-vehicle component owned by `SolidAxleVehicle`.
Forces are applied inside `SolidAxleVehicle.preStep()` (between
`resetForces()` and `world.step()`) — same place wheel forces go in
`packages/shared/src/physics/solidAxleVehicle.ts:189`.

## 3. Data model

### 3.1 Winch state (shared)

New file: `packages/shared/src/physics/winch.ts`.

```ts
export type WinchPhase =
  | 'stowed'      // hook on bumper, no cable
  | 'deployed'    // hook out, no anchor (visual only)
  | 'attached'    // anchor bound, constraint active
  | 'broken';     // cooldown after snap

export type WinchAnchor =
  | { kind: 'world'; obstacleId: number; localPoint: Vec3 }
  | { kind: 'vehicle'; playerId: PlayerId; localPoint: Vec3 };

export interface WinchSnap {       // wire shape for VehicleState
  phase: WinchPhase;
  spoolLength: number;             // metres, 0..MAX
  tension: number;                 // last-tick force magnitude, N
  anchor: WinchAnchor | null;
}
```

Add `winch?: WinchSnap` to `VehicleState`
(`packages/shared/src/types.ts:50`). Optional so old clients ignore it.

### 3.2 Tunables

Lives next to the rest of `VEHICLE` in shared constants:

```ts
export const WINCH = {
  maxLength:    25,        // m
  spoolSpeed:   0.8,       // m/s reel rate
  stiffness:    200_000,   // N/m  (≈7 cm stretch per 1 G of pull on 2500 kg)
  damping:      8_000,     // N·s/m (~0.3 critical for 2500 kg)
  motorMaxForce: 80_000,   // N — stalls when pulling more than this
  breakForce:  120_000,    // N — cable snaps above this
  brokenCooldown: 2.0,     // s before auto-stow
  mountLocal:  { x: 0, y: 0.4, z: 1.7 }, // chassis-local fairlead point
};
```

Vehicle mass is 2500 kg (`solidAxleVehicle.ts:133`), so a 0.5 G drag needs
~12 kN — well within `motorMaxForce`. `breakForce` is set to ~5× the
expected steady pull so violent yanks (vehicle launched off a cliff at the
end of a taut cable) snap rather than physics-explode.

### 3.3 Anchors on the world

Extend `Obstacle` in `packages/shared/src/physics/obstacles.ts:32` with:

```ts
winchable?: boolean;          // default true for trees, false for rocks <1m
winchAnchorOffset?: Vec3;     // local offset; default = obstacle centre
```

Trees and large rocks become winch anchors automatically because of
their kind. We do **not** need a new collider — the obstacle's existing
static rigidbody is the constraint partner.

## 4. Inputs

`PlayerInput.buttons` is a bitfield; bit 0 is already reset
(`room.ts:239`). Reserve:

| bit | name              | client trigger                          |
|-----|-------------------|-----------------------------------------|
| 0   | RESET             | KeyR (existing)                         |
| 1   | WINCH_DEPLOY_TOGGLE | KeyF — single-press; toggles deploy/stow |
| 2   | WINCH_REEL_IN     | KeyV held                               |
| 3   | WINCH_REEL_OUT    | KeyB held                               |
| 4   | WINCH_ATTACH      | KeyG — attach to aimed anchor           |

Edge-triggered actions (deploy toggle, attach) need rising-edge detection
on the server because the bit can stay set across multiple ticks if the
player holds the key. Track `prevButtons` per player in `Room`.

```ts
const pressed = (input.buttons & ~p.prevButtons) >>> 0;   // rising edges
if (pressed & WINCH_DEPLOY_TOGGLE) p.vehicle.winch.toggleDeploy();
if (pressed & WINCH_ATTACH)        p.vehicle.winch.tryAttach(this.world);
p.vehicle.winch.setReelInput({
  in:  (input.buttons & WINCH_REEL_IN)  !== 0,
  out: (input.buttons & WINCH_REEL_OUT) !== 0,
});
p.prevButtons = input.buttons;
```

Touch input (`packages/client/src/touchInput.ts`) gets a winch HUD button
that sets bit 1; reel in/out can share an on-screen joystick.

## 5. Force model

Pure spring–damper between two world points, applied via Rapier's
`addForceAtPoint`. **Pull-only** — never push.

```ts
applyForces(dt: number, world: World) {
  if (this.phase !== 'attached') return;

  const a = this.body.translation();
  const aW = worldFromLocal(this.body, WINCH.mountLocal);
  const bW = this.resolveAnchorWorldPoint(world);   // see 5.2
  const d  = sub(bW, aW);
  const L  = len(d);
  if (L < 1e-4) return;
  const n  = scale(d, 1 / L);

  const stretch = L - this.spoolLength;
  if (stretch <= 0) { this.tension = 0; return; }     // slack

  // Relative velocity along cable, including angular contribution.
  const vA = pointVel(this.body, aW);
  const vB = this.anchor.kind === 'vehicle'
    ? pointVel(world.vehicleBody(this.anchor.playerId), bW)
    : { x: 0, y: 0, z: 0 };
  const vRel = sub(vB, vA);
  const vAlong = dot(vRel, n);

  let Fmag = WINCH.stiffness * stretch + WINCH.damping * vAlong;
  if (Fmag < 0) Fmag = 0;

  if (Fmag > WINCH.breakForce) { this.snap(); return; }
  this.tension = Fmag;

  const F = scale(n, Fmag);
  this.body.addForceAtPoint(F, aW, true);             // pulls A toward B
  if (this.anchor.kind === 'vehicle') {
    world.vehicleBody(this.anchor.playerId)
         .addForceAtPoint(neg(F), bW, true);          // equal & opposite
  }
}
```

`pointVel(body, p)` is `linvel + angvel × (p - translation)` — same
formula already needed for tire contact patches; promote to
`physics/util.ts` if not already there.

### 5.1 Spooling under load

The motor isn't a teleporter. Cap reel-in by a force budget:

```ts
setReelInput({in, out}) { this.reelIn = in; this.reelOut = out; }

stepSpool(dt: number) {
  if (this.phase !== 'attached') return;
  if (this.reelIn && this.tension < WINCH.motorMaxForce) {
    this.spoolLength = Math.max(0, this.spoolLength - WINCH.spoolSpeed * dt);
  }
  if (this.reelOut) {
    this.spoolLength = Math.min(WINCH.maxLength,
                                this.spoolLength + WINCH.spoolSpeed * dt);
  }
}
```

This naturally stalls on impossible loads instead of producing infinite
torque on the chassis.

### 5.2 Anchor resolution

```ts
resolveAnchorWorldPoint(world): Vec3 {
  if (this.anchor.kind === 'vehicle') {
    const b = world.vehicleBody(this.anchor.playerId);
    return worldFromLocal(b, this.anchor.localPoint);
  }
  // 'world' obstacle — static, world-fixed
  const ob = world.obstacle(this.anchor.obstacleId);
  return add(ob.position, this.anchor.localPoint);
}
```

`obstacleId` is a stable index into the deterministic obstacle list
(`generateObstacles()` is seeded), so the id is safe to send over the wire.

## 6. Attach flow

`tryAttach()` is called once on rising-edge of `WINCH_ATTACH` while
`phase === 'deployed'`.

```ts
tryAttach(world): void {
  // Aim ray from fairlead, forward in chassis frame, length = maxLength.
  const origin = worldFromLocal(this.body, WINCH.mountLocal);
  const dir    = chassisForward(this.body);
  const hit    = world.raycastWinchable(origin, dir, WINCH.maxLength);
  if (!hit) return;

  this.anchor = hit.kind === 'vehicle'
    ? { kind: 'vehicle', playerId: hit.playerId, localPoint: hit.localPoint }
    : { kind: 'world',   obstacleId: hit.obstacleId, localPoint: hit.localPoint };
  this.spoolLength = Math.min(hit.distance, WINCH.maxLength);
  this.phase = 'attached';
}
```

`world.raycastWinchable` filters Rapier hits to colliders flagged
`winchable` (set in `spawnObstacleColliders` from
`obstacles.ts:481`) plus other vehicle bodies.

## 7. Snap & cooldown

```ts
snap(): void {
  this.phase = 'broken';
  this.brokenAt = this.now;
  this.anchor = null;
  this.tension = 0;
  // Visual recoil is client-side; server just emits the phase change.
}

postStep(dt) {
  if (this.phase === 'broken' && this.now - this.brokenAt > WINCH.brokenCooldown) {
    this.phase = 'stowed';
    this.spoolLength = 0;
  }
}
```

A 2 s cooldown lets the audio and visual recoil play out and prevents
spamming `tryAttach` after a snap.

## 8. Networking & prediction

### 8.1 Server-authoritative state

Winch lives entirely server-side for force computation. The full
`WinchSnap` rides in each `PlayerSnapshot.vehicle.winch`. Snapshot rate
is 30 Hz (existing); winch state is small (~40 bytes), and most fields
only change on transition.

### 8.2 Client prediction

`prediction.ts` replays unacked inputs over the last server snapshot.
For replay to match the server we need:

1. **Determinism.** Winch math is pure float arithmetic over Rapier
   state — same as the existing wheel/engine code. No RNG.
2. **State snap on reconcile.** When applying a server snapshot, copy
   `winch.phase`, `winch.spoolLength`, `winch.anchor` onto the local
   prediction's `Winch` *before* replaying inputs. Add to the
   `VehicleLike` interface alongside `applyAxleSnaps`:

```ts
applyWinchSnap?(snap: WinchSnap): void;
```

3. **Anchor body identity.** During replay, the prediction world must
   resolve `vehicleBody(playerId)` and `obstacle(id)` consistently — the
   prediction already mirrors the obstacle list (deterministic from
   seed) and the player set, so `WinchAnchor` references replay cleanly.

### 8.3 Why we don't use a Rapier ImpulseJoint

A `SphericalImpulseJoint` would handle the "rope" naturally with rigid
length, but:

- Rapier's prismatic/distance joints are **two-way** (push and pull). A
  rope only pulls. Faking one-way with a distance joint and `limits`
  works in single-player but interacts badly with prediction reconcile
  because joint internal state isn't part of the snapshot.
- Snapping a joint mid-step means destroying and recreating it; that
  introduces an order-dependence between players in the same tick.
- A spring–damper force is one method call per tick on the same bodies
  the wheel forces already touch — trivially deterministic and
  reconcile-safe.

So we apply explicit forces. If we later want true rope-stiff behaviour
we can revisit by stacking many short spring segments (PBD-style), but
v1 doesn't need it.

## 9. Visuals (client only)

`packages/client/src/` gains a `cable.ts` module driven from the
incoming `WinchSnap`:

- **Stowed**: nothing rendered.
- **Deployed**: a short cable from fairlead to a "carried hook" mesh
  parented to the bumper.
- **Attached, taut** (`L >= spoolLength`): straight `LineSegments` from
  fairlead to anchor world point. Colour shifts from grey toward red as
  `tension / breakForce` approaches 1.
- **Attached, slack** (`L < spoolLength`): quadratic bezier with a
  midpoint sagged by `(spoolLength - L) * 0.5` along world-down.
  16 segments is fine.
- **Broken**: spawn a one-shot detached-hook particle with impulse
  `-F·n` and play SFX.

Audio: motor loop pitched by reel state, creak/groan layer mixed by
`tension / breakForce`.

## 10. Failure modes & edge cases

| case                                | handling                                       |
|-------------------------------------|------------------------------------------------|
| Attached vehicle leaves world (eject) | `room.ts:ejectOffMapPlayers` calls `winch.detachAll(playerId)` on every other player |
| Anchor obstacle removed (future)    | listener on obstacle list; auto-release        |
| Player disconnects while winching   | release all winches that target them           |
| Reel-out past `maxLength`           | clamp; nothing rendered past max               |
| Two players winch the same anchor   | allowed; forces sum naturally on the static    |
| Both endpoints are vehicles, both reel in | both motors stall when tension exceeds `motorMaxForce`; net behaviour is "whichever has more grip drags the other" |
| Cable through terrain (v1)          | ignored; force still pulls. Will look bad on heavy terrain blockage; v2 adds raycast pulley |

## 11. Implementation order

1. **Force-only attached**: add `Winch` class with `applyForces`; harness
   it in a unit test (server package, alongside `axle-wire.test.ts`)
   that spawns a stuck vehicle, attaches a cable to a fixed point, and
   asserts the chassis translates toward the anchor when `spoolLength`
   shrinks.
2. **Spool input + motor cap**: drive `spoolLength` from `setReelInput`,
   verify motor stall via the same test fixture loaded with a heavier
   pull.
3. **Buttons + Room wiring**: rising-edge detection on `prevButtons`,
   call winch from `Room.tickOnce`.
4. **Vehicle-to-vehicle**: extend `applyForces` to call `addForceAtPoint`
   on both bodies; add an integration test in the server package.
5. **Snap + cooldown**: add `WINCH.breakForce` enforcement with a test
   that yanks the cable past threshold.
6. **VehicleState snap field + prediction**: add `applyWinchSnap` to
   `VehicleLike`, copy field in `prediction.ts` reconcile.
7. **Client visuals**: `cable.ts`, hook mesh, HUD tension bar.
8. **Mobile HUD button**: `touchInput.ts` adds winch overlay.

Each step is independently testable; force-only attached is the
biggest physics commit, everything else is scaffolding.

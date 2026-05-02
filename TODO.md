# TODO — handoff state

This document is the snapshot of where the project is right now and what's
next. Pair with `CLAUDE.md` (architecture + conventions) and the git log.

Last commit at handoff: `d93a396 Fix wheel shake: rotation order was XYZ`.
Branch: `claude/add-claude-documentation-b6LkY`.
Tests: 22 shared + 18 server + 9 e2e = 49 green. Run `pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build` to verify.

## What's working (user-confirmed)

- Drives forward on W, backward on S
- Turns left on A, right on D, no wheel shake
- Camera follows behind without bouncing or sluggishness
- Hill climbs cleanly with the new torque numbers
- Cars sit at realistic ride height (no hover)
- Multiplayer (snapshot interp + client prediction + reconcile)
- Mud carves persistent ruts in the heightfield
- Mud splatter particles fly off spinning wheels
- Rocks + trees as drivable obstacles
- Engine audio defaults muted (procedural synth was deemed not great yet)

## Open questions / unverified

- **Stutter** — user mentioned earlier movement felt stuttery. Likely fixed
  alongside the YXZ wheel-rotation bug since both were rendering issues
  with the same root cause class. Confirm with the user on next session.
- **Wheel sinking into mud** — implemented in `Scene.wheelSinkAt` but
  hasn't been visually verified end-to-end. Drive into deep mud and see
  if the wheels visibly drop.
- **Multiplayer feel under real network latency** — local tests have
  ~zero RTT. Get two real clients connected to Railway and watch for
  reconcile pops, wheel jitter on remote vehicles, etc.

## Solid-axle suspension overhaul (active)

Working branch: `claude/suspension-overhaul-plan-qpjiX`. Mirrored to
`claude/add-claude-documentation-b6LkY` (the deployment branch) after
each commit. Original plan lives in
`/root/.claude/plans/the-claude-review-documentation-tidy-pelican.md`
(session-local, may not be present in a new session — the relevant
state is captured below).

### What's shipped

- New `SolidAxleVehicle` class in `packages/shared/src/physics/`:
  - `axle.ts` — kinematic axle (rideY tracks avgComp; rollAngle tracks
    terrain slope, clamped at maxArticulation; surplus past cap dumps
    torque on chassis).
  - `wheelDynamics.ts` — pure wheel angVel integrator (drive + brake +
    rolling resistance + ground-reaction torque).
  - `solidAxleVehicle.ts` — chassis body + 2 axles + 4 wheels. Per-tick:
    reset Rapier force accumulators (Rapier accumulates across `step()`
    until reset — this was a real bug), capture chassis pose ONCE,
    raycast wheel-ends from chassis-fixed positions, apply per-wheel
    ride forces (NOT at axle center — applying at wheel-ends is what
    gives roll-restoring torque), apply chassis anti-roll bar, apply
    tire long+lat forces at contact patches, integrate wheel spins.
  - `vehicleGeom.ts` — per-CarKind axle geometry (Patrol = Hilux for
    now; differentiation deferred to Phase 3).
  - `vehicleTypes.ts` — `VehicleLike` interface that both legacy
    `Vehicle` and `SolidAxleVehicle` satisfy. `World.spawnVehicle`
    returns it.
- `VEHICLE_MODEL` flag in `constants.ts` controls which model
  `World.spawnVehicle` instantiates. **Currently set to `'solidAxle'`
  on both branches** — the new model is live in production. Flipping
  back to `'raycast'` is a one-line revert if the new model misbehaves.
- Tests: `packages/shared/src/__tests__/axle.test.ts` (12 pure-math
  unit tests) + `solidAxleVehicle.test.ts` (8 Rapier integration tests
  including settle, drive forward, directional steering, two-worlds
  determinism, axle-snap round-trip, rollover-stability regression).
  All 53 shared + server tests green at last commit.

### Tunables exposed for playtest (no rebuild needed for first three)

Hardcoded near the top of `packages/shared/src/physics/solidAxleVehicle.ts`:
- `LONG_FRICTION` (1.0) — effective tire friction coefficient. Bigger
  = more grip, faster acceleration, sharper braking.
- `ANTI_ROLL_STIFFNESS` (120000 N·m/rad) — sway bar. Bigger = flatter
  cornering. Goes against rock-crawl articulation feel — too stiff and
  the chassis stays level when one axle articulates over a rock.
- `ANTI_ROLL_DAMPING` (14000 N·m·s/rad) — bigger = roll motion settles
  faster, less bounce on uneven terrain. ~70% critical for I_z=900.

In `constants.ts` `AXLE.front` / `AXLE.rear`:
- `rideStiffness` (80k front, 90k rear) — vertical spring rate per axle.
- `rideDamping` (12k / 13k) — ~75% critical for the chassis-spring
  system, so bounce settles in roughly one cycle.
- `rollStiffness` (35k front / 28k rear) — torque applied to chassis
  when axle articulation hits its cap.
- `maxArticulation` (0.45 / 0.50 rad ≈ 26° / 28°) — how far the axle
  can flex before dumping load into the chassis.
- `axleMass` / `axleRollInertia` — currently unused (kinematic axle).
  Kept on the type for a future dynamic axle model.

### Phase 2 — wire format + multiplayer reconcile (DONE)

The new model now ships axle DOFs on the wire so remote vehicles
animate the flex pose and the local player reconciles axle state from
the server.

- [x] `AxleSnapWire { rideY, rollAngle }` added to
      `packages/shared/src/types.ts`; `axles?: [AxleSnapWire, AxleSnapWire]`
      hangs off `VehicleState` (optional so legacy raycast snapshots
      still parse).
- [x] `SolidAxleVehicle.getState()` populates `axles` from the live
      `axleSnaps()` values.
- [x] `Prediction.reconcile` calls `applyAxleSnaps` on the snap and
      replays the queue from there, so the local truck's flex pose
      tracks the server.
- [x] `axleVisualOffset` mirrors the existing position `visualOffset`:
      pre-snap vs post-replay axle delta is captured, capped at
      ±0.2 m / ±0.2 rad, and decays at 0.82/step (~80ms half-life).
- [x] Wire round-trip is covered by
      `server/__tests__/axle-wire.test.ts` (3 cases: getState matches
      axleSnaps, JSON encode/decode preserves values, applyAxleSnaps
      restores the pose end-to-end).

### Phase 3 — visuals (DONE)

Wheels are now children of axle groups, so the rigid-beam articulation
shows in the mesh: hit a rock with one wheel and the partner is
visibly pulled with it, axle tilts, chassis can lean.

- [x] `packages/client/src/carMesh.ts` builds an axle group per axle
      (`buildAxles`): black-painted beam (`CylinderGeometry` along
      chassis-X), diff pumpkin in the middle, two wheel groups at
      `(±trackHalf, 0, 0)` as children. Initial Y is
      `centerLocalY - suspensionRestLength` so the rest pose puts
      wheel centres at correct ground-clearance height. `CarMesh`
      gained `axles: [Group, Group]`.
- [x] `packages/client/src/scene.ts` `poseAxles()` sets each axle
      group to `(0, centerLocalY - suspensionRestLength + rideY - sink,
      centerLocalZ)` with rotation `(0, 0, rollAngle)`. Per-wheel
      arithmetic is gone; wheels just receive steer/spin via local
      rotation. Mud sink moved to the axle (`axleSinkAt`) so both
      wheels of a beam axle drop into mud together.
- [x] `vehicleGeom.ts` differentiates Hilux: rear axle 0.1m further
      back, softer rideStiffness (75k vs Patrol's 90k), softer damping,
      and a touch more articulation (0.55 rad vs 0.50). Patrol unchanged.
- [x] `landmarks.ts` no longer reads `VEHICLE.wheelPositions`. The
      parked Hilux just keeps its axle groups at rest pose; `buildAxles`
      now positions wheels at the correct height with no extra logic.

### Phase 4 — cleanup (after Phase 3 has been live one release)

- [ ] Delete `packages/shared/src/physics/vehicle.ts` (legacy raycast
      model).
- [ ] Rename `solidAxleVehicle.ts` → `vehicle.ts`, update imports.
- [ ] Strip `VEHICLE_MODEL` flag from `constants.ts` and the branch
      in `World.spawnVehicle`.
- [ ] Remove legacy `Tuning` fields (`suspensionStiffness`,
      `suspensionDamping`, `suspensionCompression`, `maxSuspensionForce`,
      `maxSuspensionTravel`) from `tuning.ts`.

### Open follow-ups discovered during playtest

- [ ] **`LONG_FRICTION` magic number** — currently hardcoded 1.0 at the
      top of `solidAxleVehicle.ts`. Move to `constants.ts` once tuning
      stabilises, exposed via `TUNING` so the debug panel can tweak
      it.
- [ ] **A/B characterisation harness** — `shared/__tests__/modelCompare.test.ts`
      that drives both legacy and solid-axle models through identical
      input sequences (settle → throttle → straight 5s → brake → tight
      circle 5s) on the same terrain and asserts top-speed,
      stopping-distance, and turn-radius all within 30% of legacy.
      Catches regressions when tuning the new model.
- [ ] **Diff-lock UI hookup** — `TUNING.diffLockFront` / `diffLockRear`
      exist but no key bind. Consider Q for front lock, E for rear (or
      a combined lockall). Useful for rock crawling demos.
- [ ] **Live debug overlay** — print per-axle rideY/rollAngle each
      frame next to the existing surface HUD so playtest tuning is
      data-driven. Hook into the existing debug-user code path
      (`isDebugUser('jack')` in `main.ts`).
- [ ] **Lateral force model** — currently `F_lat = clamp(-latStiff*latV,
      ±latMax)`. Linear in slip speed, capped at friction circle. A
      slip-angle-based curve (cornering stiffness up to peak then
      falloff) would feel more like a real tyre. Couples with the P0
      "slip-angle component" item below.
- [ ] **Axle inertia model** — the kinematic axle model snaps
      `rideY = avgComp` instantaneously each tick. Real axles have
      mass; the unsprung-mass "thump" over washboards is missing.
      Either (a) replace with a sub-stepped dynamic integrator using
      the real `axleMass` field, or (b) low-pass `rideY` toward the
      target with a short tau (~30ms). (a) is more correct, (b) is
      simpler.
- [ ] **CoG and inertia tuning** — solid-axle physics behaves
      differently than the legacy raycast model under hard cornering.
      Current CoM at `-0.6 * chassisHalfY` (matching legacy) may not
      be the sweet spot for the new force profile. Try `-0.85` if
      rollover still feels too easy after the anti-roll bar.

### Resuming this work in a new session

1. `git checkout claude/suspension-overhaul-plan-qpjiX && pnpm install`.
2. Read `packages/shared/src/physics/solidAxleVehicle.ts` end-to-end
   and the comment at the top — it documents the determinism rules
   and the per-wheel-end ride force decision.
3. `pnpm test` — should be 53 green. If anything's failing, that's the
   starting point.
4. `pnpm dev` and drive — feel for tipiness, spongy ride, weird
   articulation. Tune the constants block at the top of
   `solidAxleVehicle.ts`.
5. Pick from Phase 2 / Phase 3 / open-follow-ups above. Phase 2
   (wire format) is the next logical step before Phase 3 visuals,
   because the visuals depend on `AxleSnap` being on the snapshot
   for remote players to render flex correctly.

## Prioritized next work

### P0 — physics feel polish (small, high payoff)
- [ ] Slip-angle component to tire grip. The new solid-axle model has a
      simple linear+clamp lateral force; a proper slip-angle curve
      (peak at ~6-10 deg, falls off past) would make under/oversteer
      feel right and let "drifting in mud" be a thing.
- [ ] Better engine braking on downhills - currently coasts faster than
      it should. Tune `ENGINE.engineBrakeCoef` or sample from chassis
      velocity not just RPM.
- [x] ~~Anti-roll bar emulation~~ — done as part of the solid-axle
      overhaul (`ANTI_ROLL_STIFFNESS` / `ANTI_ROLL_DAMPING` at the top
      of `solidAxleVehicle.ts`). Tunable from playtest feel.

### P1 — make the world feel less empty
- [ ] Skybox / cloud layer (procedural, no external assets). Sky is
      currently flat color.
- [ ] Multiple roads or a real "course" with stretches of dirt, mud
      pits, water crossings. Generate from a higher-level layout
      function in `terrain.ts` rather than the current single straight
      strip.
- [ ] Better surface visuals - the road and mud read "average". Two
      cheap wins:
        - Per-vertex noise color jitter (so each surface isn't
          monochrome).
        - A `THREE.CanvasTexture` per surface tiled across the mesh.
          Procedural - generated at startup, no asset deps.
- [ ] Minimap (top-down render of the terrain mesh + player dots) in a
      corner of the HUD. Three.js render-to-target is straightforward.

### P1 — mobile + accessibility
- [ ] Touch controls. The user explicitly asked for these. Layout:
      throttle/brake on right, steering joystick on left, camera-cycle
      button. Two HTML overlays with `pointer` events that translate
      to the same `PlayerInput` shape. The hard part is steering
      analog-feel - a joystick (touch starts at center, drag returns
      vector).

### P2 — multiplayer depth
- [ ] Lobby / room codes. Currently one global room.
- [ ] Lag compensation server-side: timestamp inputs and rewind on the
      server when applying.
- [ ] Voice / text chat.

### P2 — wire format optimization
- [ ] msgpack snapshots (one-file change in `shared/src/net/messages.ts`).
- [ ] Snapshot deltas (only send changed players / fields).
- [ ] Quantize positions/quaternions for snapshots (1cm position, 0.001
      rad rotation are plenty).
- [ ] Coalesce rut deltas into one message per flush.

### P3 — stretch
- [ ] Winch (rope constraint between vehicles for recovery).
- [ ] Destructible terrain features (knock down trees with the bullbar).
- [ ] Water bodies the chassis floats in / bogs down in.
- [ ] Day/night cycle + headlight illumination (headlight cones already
      modeled visually but not as actual `THREE.SpotLight`s).
- [ ] Better damage model - cosmetic dents, performance loss when rolled.

## Testing improvements

- [ ] **Test against the deployed URL.** The Playwright config currently
      boots local servers. Add a `live.spec.ts` (or environment override)
      that hits `https://jackkruger.github.io/mydrunner/` so we can catch
      real-network-latency bugs before the user does. The wheel-shake
      bug was a rendering bug that existed locally too - the user
      caught it because they saw rendered output, my tests watched
      prediction state. Don't trust state-only assertions.
- [ ] **Network-throttled e2e tests.** Use Chromium DevTools Protocol
      (`page.context().route()` won't work for WebSockets, but
      `client.send('Network.emulateNetworkConditions', ...)` does).
      Add 100ms RTT + 1% packet loss and re-run drive tests.
- [ ] **Multi-client jitter test.** Boot two browser contexts, each
      driving in a different direction. Read the rendered position of
      each client's view of the other vehicle, assert it's smooth (no
      teleports, no oscillation).

## Bugs / paper cuts

- The `wheels still flicker` ticket — fixed by YXZ rotation order in
  `carMesh.ts`. The original `holding A produces a stable left steer
  angle` test passed despite the bug because it watched
  `prediction.state().wheels[0].steer` (always smooth) instead of the
  rendered mesh's `rotation.x` / `rotation.y`. The new
  `rendered wheel rotations are stable while driving + turning` test
  watches the actual mesh and would have caught it. Treat this as a
  **principle**: test the layer where the bug would manifest, not the
  layer that's easiest to access.
- `setWheelRollInfluence` is in the Rapier 0.14 TS types but throws at
  runtime. Don't use it; tune via CoM offset, track width, friction
  multipliers, and steer rate.
- Rapier heightfield is column-major. `World.buildTerrain()` transposes
  our row-major heights. If you change the generator's indexing, update
  the transpose.

## How to debug live

The client exposes `window.__scene` and `window.__prediction` in dev
builds (guarded by `import.meta.env.DEV`). From a browser console:

```js
__prediction.state()           // current predicted vehicle state
__scene.cameraYaw              // smoothed camera follow yaw
__scene.cameraTarget.toArray() // current camera lookat target
[...__scene.vehicles.keys()]   // all visible player ids
```

The screenshot test (`packages/e2e/tests/screenshot.spec.ts`) writes
the same shape via `page.evaluate` and logs as `DIAG@01 {...}`. Useful
for diffing physics state across commits.

## Deploy

- **Server** auto-deploys to Railway from the configured branch. Service
  config is `railway.json` at repo root. After a commit lands you'll
  have a new container in ~2 min.
- **Client** auto-deploys to GitHub Pages via `.github/workflows/deploy.yml`.
- **Client → server URL** is `PUBLIC_SERVER_URL` GitHub secret. Set to
  the Railway-generated `wss://` domain.

If a commit doesn't seem to have deployed, check:
1. Railway dashboard → service → deployments — is the latest sha there?
2. GitHub Actions → Deploy Client → did it succeed?
3. Browser hard-reload (Cmd-Shift-R) — Pages caches aggressively.

## Where features live (cheat sheet)

- Tunables: `packages/shared/src/constants.ts` (single source of truth).
- Wire types: `packages/shared/src/types.ts`.
- Wire encode/decode: `packages/shared/src/net/messages.ts`.
- Physics step (the heart of the game): `packages/shared/src/physics/vehicle.ts`.
- Engine + gearbox: `packages/shared/src/physics/engine.ts`.
- Tire slip curve: `packages/shared/src/physics/tire.ts`.
- Terrain generator (heights + surfaces): `packages/shared/src/physics/terrain.ts`.
- Rut accumulator: `packages/shared/src/physics/ruts.ts`.
- Obstacle generator: `packages/shared/src/physics/obstacles.ts`.
- Server room: `packages/server/src/room.ts`.
- Client renderer: `packages/client/src/scene.ts`.
- Client prediction: `packages/client/src/prediction.ts`.
- Procedural car visual: `packages/client/src/carMesh.ts`.
- Mud particles: `packages/client/src/particles.ts`.
- Engine audio: `packages/client/src/engineAudio.ts`.

## Resuming this work

If you (future Claude or human) are picking this up cold:

1. Read `CLAUDE.md` - architecture, conventions, gotchas.
2. Read this file (`TODO.md`) - state and next steps.
3. `pnpm install && pnpm dev` - start it locally.
4. Open the deployed URL alongside to compare.
5. Pick the top P0 item or address whatever the user reports.
6. Always: write a test that would catch the bug before you fix it.
   The wheel-shake saga is the cautionary tale - 4 commits and three
   "fix" attempts because the test was looking at the wrong layer.

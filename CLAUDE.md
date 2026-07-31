# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

mydrunner is a browser-based, multiplayer, physics-driven off-road 4x4 game inspired by MudRunner. The fun comes from the physics: suspension, slip, mud, deformable terrain, and getting unstuck. Treat the physics as the product — gameplay, content, and polish all live downstream of it feeling good.

Vehicles are procedural Three.js silhouettes with per-kind physics geometry (`vehicleGeom.ts`: axle placement, mass and power multipliers). Four kinds today (more is just adding a geom entry + body builder + palette + picker entry):
- **Patrol** — Nissan-Patrol-GQ-style boxy SUV (AWD, roof rack, bullbar, snorkel, rear spare).
- **Hilux** — Toyota-Hilux-style ute with a hardtop canopy; rear axle 0.1 m further back, softer rear springs.
- **Ute** — Falcon-style flat-tray ute (Patrol physics, different silhouette).
- **Motorbike** — dual-sport bike silhouette; half the mass, 1.4× power (still simulated as a 4-wheel chassis).

The player's chosen kind is spawned on the server (`Room.addPlayer` passes `handle.carKind`) **and** in the client's local prediction world — the two must stay in sync or the soft corrections fight the local sim.

Rollover is intentionally a real risk on slopes and at-speed turns into ruts — it's tuned to be controllable on the road but punishing off it. There is also an incline-traction assist (`INCLINE_ASSIST_MAX`) so the truck can actually climb the rocky path up the mountain.

## Stack

- **TypeScript everywhere**, ESM, Node 22+, pnpm workspaces.
- **Physics:** Rapier (`@dimforge/rapier3d-compat`, WASM). Lives in `packages/shared/src/physics/`. The server is authoritative; the client ALSO runs a local Rapier world for the local truck's prediction (see below).
- **Client:** Vite + Three.js. No React. Render loop is `requestAnimationFrame` driving `Scene.render()` in `packages/client/src/scene.ts`. Remote vehicles interpolate from snapshots ~100 ms behind the server clock; the local truck renders from the prediction sim so it responds within one tick.
- **Server:** Node + `ws` + `http`. Single authoritative `Room` running a fixed 60Hz physics loop, broadcasting 30Hz snapshots. Lives in `packages/server/src/`.
- **Wire format:** MessagePack binary with quantized snapshots (cm positions, int16 quats, millirad angles — see the scale constants in `packages/shared/src/net/messages.ts`). All encode/decode is centralised there; bump the `s` schema version if the per-player tuple changes. Wheel `spin` crosses the wire wrapped mod 2π — consumers must lerp along the shortest wrapped arc.
- **Tests:** Vitest for unit + Rapier integration; Playwright for browser smoke + multiplayer.

## Common commands

Run from the repo root unless noted.

```bash
pnpm install                  # bootstrap (also re-run after editing any package.json)

pnpm dev                      # client + server in parallel (client on :5173, server on :2567)
pnpm dev:server               # server only
pnpm dev:client               # client only

pnpm typecheck                # tsc --noEmit across all workspace packages
pnpm test                     # vitest across shared + server + e2e (client has --passWithNoTests)
pnpm test:e2e                 # playwright (boots both servers itself)
pnpm build                    # tsc + vite build for client; tsc for server
pnpm lint                     # alias for typecheck (no separate linter yet)
```

Single test file:

```bash
pnpm --filter @mydrunner/server exec vitest run src/__tests__/physics.test.ts
pnpm --filter @mydrunner/server exec vitest run -t "drives forward"
pnpm --filter @mydrunner/e2e exec playwright test tests/smoke.spec.ts
```

Generate a fresh visual changelog:

```bash
pnpm --filter @mydrunner/e2e exec playwright test tests/screenshot.spec.ts
```

This drives the car through a short scripted sequence and writes PNGs to `packages/e2e/screenshots/`. They are committed to the repo so each commit's screenshots reflect the game state at that point in history.

Playwright browsers: in sandboxed environments without internet, the config auto-points at `/opt/pw-browsers` if it exists. Otherwise: `pnpm --filter @mydrunner/e2e exec playwright install chromium`.

## Architecture

### Monorepo layout

```
packages/
  shared/   types, constants, net protocol, World+Vehicle+terrain+ruts+obstacles physics
  server/   WS+HTTP entry point, Room (one world, all players, fixed loop, rut buffer)
  client/   Vite app: input + touch -> NetClient -> Scene (Three.js) + ChaseCamera
            + Prediction (local Rapier sim for the local truck)
  e2e/      Playwright tests + screenshot capture (boots client + server via webServer config)
```

`shared` is consumed via TypeScript source (`"main": "./src/index.ts"`) — no build step needed for inter-package use during dev.

### Server-authoritative + soft-correction local prediction

The server is the source of truth for physics. Each tick (60 Hz):

1. Read pending input for each player.
2. `vehicle.preStep()` applies steer/throttle/brake, performs **per-wheel surface lookup** (sample terrain texel under each wheel → modulate friction slip), applies spring/tire forces to the chassis.
3. `world.step()` advances Rapier.
4. `vehicle.postStep()` accumulates wheel spin for visuals.
5. (Disabled) Each driven wheel's pass would be recorded into the **rut buffer** when `RUTS_ENABLED=true`. Currently off — the heightfield resolution is too coarse for tyre-width tracks. Buffer + flush + collider-rebuild plumbing is intact in `room.ts` for when the underlying issues are fixed.
6. Every other tick (30 Hz), broadcast a `WorldSnapshot` to every player.

The client samples input at 60 Hz, ships each `PlayerInput` to the server, AND steps a local Rapier sim (`packages/client/src/prediction.ts`) with the same input so the local truck responds within one tick. Snapshots are treated as **soft corrections**: each one nudges the local body 12 % toward the (velocity-extrapolated) server pose, with the delta absorbed by a decaying visual offset — there is no input queue, no snap-and-replay reconcile, no replay death spiral. Divergences > 5 m hard-snap. Remote vehicles have no local sim; `Scene.render()` interpolates them from the snapshot pair surrounding `now - RENDER_DELAY_MS`.

History: v1 prediction was snap-and-replay and caused every netcode bug we hit (reconcile heartbeat, partial-replay drift, replay spiral); it was removed entirely for a while (pure interpolation, ~100 ms input lag), then re-introduced as the current soft-correction model. If prediction misbehaves, the pure-interpolation fallback is: don't construct `Prediction` in `main.ts` — the scene falls back to snapshot extrapolation for the local truck automatically.

### Key files

Shared:

- `packages/shared/src/constants.ts` — every compile-time tunable: tick rate, vehicle mass / axle springs / drive split, surface friction, anti-roll bar, rut rate, camera spring, incline assist. Tuning lives here, code does not.
- `packages/shared/src/tuning.ts` — `TUNING`: the live-mutable runtime surface the physics actually reads for tunable values, seeded from `constants.ts`. Client and server each have their own instance; the client debug panel mutates only the client's (divergence absorbed by soft corrections until values are baked back into constants).
- `packages/shared/src/types.ts` — `PlayerInput`, `VehicleState`, `WorldSnapshot`, `CarKind` (+ `normalizeCarKind`). Wire-shape contract.
- `packages/shared/src/net/messages.ts` — `ClientMessage` / `ServerMessage` discriminated unions, `encode` / `decode*`. `decodeClient` strictly validates shape and rejects non-finite numbers — it is the trust boundary for everything a client can send. Welcome carries terrain seed + spawn pose; `hello` carries name + carKind; snapshots include each player's `carKind`; `rut` messages carry per-cell deltas (currently never emitted).
- `packages/shared/src/physics/world.ts` — `World` wraps a `RAPIER.World`, owns the heightfield collider + map of vehicles + obstacles + landmarks. **Note: heights are transposed before being handed to Rapier** (Rapier reads column-major; our generator is row-major).
- `packages/shared/src/physics/solidAxleVehicle.ts` — `SolidAxleVehicle`: custom solid-axle vehicle model (the only vehicle model; legacy raycast path was deleted in Phase 4). `preStep` does per-wheel-end raycasts, spring/damper forces, anti-roll bar, engine + gearbox, diff lock, and friction-circle tire forces.
- `packages/shared/src/physics/axle.ts` — kinematic axle state (rideY + rollAngle DOFs, articulation cap). Pure functions, no Rapier handles.
- `packages/shared/src/physics/wheelDynamics.ts` — per-wheel angular-velocity integrator (drive/brake/ground/rolling torques on wheel inertia). Pure functions.
- `packages/shared/src/physics/engine.ts` — engine + automatic gearbox: torque curve, RPM smoothing, chassis-speed-based shift logic (immune to wheel-slip gear hunting).
- `packages/shared/src/physics/vehicleGeom.ts` — per-`CarKind` physics identity: axle placement, spring rates, mass/power multipliers, `spawnYAboveGround`, `restWheelPositions`.
- `packages/shared/src/physics/tire.ts` — slip-curve helpers. NOT used by the live model (which uses the friction circle); kept as a tested building block.
- `packages/shared/src/physics/terrain.ts` — deterministic FBM-noise heightmap + Surface enum + hill-climb trail layers. Rolling hills, one Gaussian mountain peak, scattered mud bogs, graded switchback trail. Multiple roads: main asphalt strip, north loop (dirt circuit), south bog trail, east gravel connector, plus the mountain-trail dirt connector.
- `packages/shared/src/physics/obstacles.ts` — deterministic rock + tree placement. Three passes: medium scatter, dense small-rock detail, and a corridor of boulders along the rocky hill climb up the mountain.
- `packages/shared/src/physics/landmarks.ts` — deterministic landmark spec (petrol station, flagpoles, summit lookout) + colliders.
- `packages/shared/src/physics/ruts.ts` — `RutBuffer` accumulates per-cell erosion, capped at `RUT_MAX_DEPTH`. Only Mud / DeepMud cells erode. Plumbing is in place but disabled via `RUTS_ENABLED`.
- `packages/shared/src/physics/util.ts` — small shared helpers (currently `rotateVecByQuat`).

Server:

- `packages/server/src/room.ts` — owns `World`, 60Hz deadline-based tick loop with catch-up, 30Hz snapshots, per-kind spawns on the road grid, off-map ejector, chat relay, perf counters. World is 320×320 at heightfield resolution 128.
- `packages/server/src/index.ts` — HTTP+WS bootstrap, route messages into `Room`, heartbeat ghost-cleanup, expose `/health`.

Client:

- `packages/client/src/main.ts` — entry point: join screen, net wiring, 60 Hz input accumulator, generates the shared `TerrainData` once per welcome, owns the `Prediction` instance, HUD.
- `packages/client/src/scene.ts` — Three.js scene, snapshot interpolation (remote) + prediction override (local), terrain replication, mud splatter particles, minimap feed. Exposes `localPosition()` / `localSteer()` / `localAxles()` for HUD + debug + e2e to read the rendered local-truck state. Camera state is delegated to `ChaseCamera`.
- `packages/client/src/prediction.ts` — local Rapier sim for the local truck; soft-correction model (see architecture section above).
- `packages/client/src/net.ts` — thin WebSocket wrapper around the shared protocol; reconnect-safe socket identity checks.
- `packages/client/src/input.ts` / `touchInput.ts` — keyboard (+ handbrake toggle) and on-screen analog steer pad / pedals; both merge in `sampleInput()`.
- `packages/client/src/camera.ts` — `ChaseCamera`: chase-cam yaw spring with corner swing, pitch-aware lookAt for hill driving, hood cam, sky cam.
- `packages/client/src/carMesh.ts` — `buildCarMesh(kind, isLocal, idHash)` for all four `CarKind`s. Shared materials + wheel builder, per-kind body builders. Wheels have visible spokes + tread lugs so rotation direction reads.
- `packages/client/src/terrain.ts` — Three.js terrain mesh + surface-ID shader, built from the shared `TerrainData`; `applyRut(i, dy)` deforms it (currently unused since ruts are off).
- `packages/client/src/obstacles.ts` / `landmarks.ts` / `sky.ts` (procedural sky dome: gradient + clouds + sun) / `particles.ts` / `nameplate.ts` / `minimap.ts` — world + HUD visuals, all deterministic from the terrain handshake.
- `packages/client/src/joinScreen.ts` — first-load name + car picker. Persists name + carKind to localStorage; subsequent visits pre-fill the picker. `?auto=1` URL bypass for e2e (`?car=` accepts any `CarKind`).
- `packages/client/src/chat.ts` — text chat UI (T to open); server relays with rate-limiting + sanitisation in `Room.broadcastChat`.
- `packages/client/src/engineAudio.ts` — RPM-driven engine sound via `AudioContext`.
- `packages/client/src/debugPanel.ts` — live TUNING sliders for the player named "jack"; copy-to-clipboard serialiser for baking values into constants.

### Determinism note

Rapier in single-threaded mode is deterministic given identical inputs and step order. The shared physics package is the only physics path now (server-only), but the determinism property still matters: it means the same inputs replayed against the same seed produce the same trajectory, which is what makes server-side recording / replay / regression tests viable. Do not introduce non-deterministic state (`Date.now()` inside `step`, unseeded `Math.random()`, floating-point reductions across non-deterministic iteration order) inside `World.step()` or `Vehicle.preStep()/postStep()`.

`packages/server/src/__tests__/prediction.test.ts` enforces this with a "two worlds, same seed, same inputs → same state" assertion. (Name is a leftover from when the client also ran a sim; the test is still valid as a determinism guard.)

## Conventions

- **Tunables in `constants.ts`.** Magic numbers in physics or networking code are bugs in waiting. Values a tester might twist at runtime are mirrored onto `TUNING` (`tuning.ts`), seeded from the constants — physics code reads `TUNING` for those.
- **Shared types are the wire contract.** When you change `PlayerInput` or `VehicleState`, both client and server pick it up via TypeScript.
- **No comments that restate code.** Comments explain *why*: a constraint, a tradeoff, a workaround.
- **Tests use real components.** Server tests use real Rapier. Browser tests use real Playwright. There is no mocked physics or socket — bugs love mocks.
- **Diagnostic hooks are dev-only.** `window.__scene` is guarded by `import.meta.env.DEV`. Production bundles do not expose it.
- **Branching:** there is no `main`. The repository's default branch is `claude/add-claude-documentation-b6LkY` — the user deploys off it. Feature/review work happens on per-session `claude/...` branches which the user merges into the default branch via PR.
- **No PRs unless asked.**
- **Commit screenshots with each visual milestone** (`packages/e2e/screenshots/` is tracked) so the repo carries a visual changelog alongside the code one.

## Periodic architecture review

The codebase grows fastest in the first weeks of a feature game. To keep it from sprawling:

- After every ~5 feature commits, do a structural pass:
  - Are any single files trending past ~250 lines? If so, look for a natural split (e.g. camera vs. scene).
  - Are there constants leaking into code? Promote them to `constants.ts`.
  - Are there parallel switches/lookups for the same concept (e.g. surface → grip)? Consolidate into a helper.
  - Has any module grown a "miscellaneous" responsibility? Either rename it to reflect what it actually does, or extract.
  - Is the wire protocol still the only crossing point between client and server? If something else has snuck across, name it.
- Stop and refactor when:
  - Two changes in the same week needed parallel edits in three files. That's coupling — find the missing abstraction.
  - A bug took longer to find than to fix. Usually means responsibility is unclear in the affected module.
  - Tests are slow because they boot too much of the world. Carve out a smaller fixture.
- Don't refactor when:
  - It's premature (a single instance of a pattern is not a pattern).
  - You don't have tests covering the area you're changing — write them first.

This file should be updated when the architecture changes. If you (future Claude) make a structural change without updating CLAUDE.md, you've created drift.

## Roadmap

The MVP loop is **complete**: connect → pick name + rig → drive a lifted 4x4 with AWD physics on procedural terrain → cross mud at low traction → climb the rocky hill route up the mountain → see every truck (yours and remotes') interpolated smoothly from the same authoritative snapshot stream. The local truck responds within one tick via the soft-correction prediction sim; remotes render ~100 ms behind. Next priorities, roughly in order:

### Shipped
- Surface-name HUD.
- Engine sound (RPM-driven via `AudioContext`).
- Mud splatter particles in deep mud.
- Player nameplate above each remote vehicle.
- Pitch-aware chase camera + corner swing + sky cam follow.
- Hilux / Ute / Motorbike variants + name/car localStorage persistence.
- Touch / mobile controls (analog steer pad + pedals + aux).
- Hill-climb traction assist, wider surface friction contrast.
- Minimap / map overview.
- Text chat (T to open; rate-limited + sanitised server-side).
- Soft-correction client prediction for the local truck.
- Mountain switchback trail with per-traverse features (whoops, rocky step, mud puddle).
- Multiple roads: north loop (dirt circuit), south bog trail, east gravel connector.
- Procedural sky dome: gradient + warm horizon band + 5-octave FBM clouds + sun disc with glow.

### Content
- Cargo objective: spawn a crate to deliver from A to B; mass affects vehicle handling.
- Multiple truck loadouts (light, heavy, winch-equipped).

### Multiplayer depth
- Lobby / room codes (currently single global room).
- Lag compensation for inputs the server processes (server interpolates back).
- Voice chat (scoped and shelved — WebRTC P2P + WS signaling is the chosen approach).

### Wire-format optimisation
- ~~Move snapshots to msgpack~~ / ~~quantize positions/quaternions~~ — shipped (see `messages.ts`).
- Binary deltas — only changed players, only changed fields.

### Stretch
- Winch (rope constraint between vehicles, physics-driven recovery).
- Destructible terrain features (trees, fences) on top of mud-deformation.
- Physics-driven water bodies that the chassis floats in / bogs down in.
- Day/night cycle + headlight illumination.
- Re-enable ruts: needs higher heightfield resolution (or a sub-cell visual deformation overlay decoupled from the collider). Note the client prediction world must also receive rut deltas, or the local sim drives on stale terrain and rubber-bands on mud (this was one of the reasons ruts were disabled).

## How to add a feature, end to end

1. **Touch types first.** Add fields to `PlayerInput` / `VehicleState` / `WorldSnapshot` in `packages/shared/src/types.ts`. TypeScript will tell you everywhere that needs to change.
2. **Update the simulator.** Modify `Vehicle` / `World` / `RutBuffer` in `packages/shared/src/physics/`.
3. **Tune in constants.** Don't hardcode in step code.
4. **Update the renderer.** `Scene.render()` reads from snapshots — make sure it interpolates new fields correctly. If the field needs to be exposed for HUD/debug/e2e, add a getter alongside `localPosition()` / `localSteer()` / `localAxles()`.
5. **Write a test.** Server-side: `vitest` against the real `World`. Client-side: Playwright if it's user-visible.
6. **Run the gauntlet:** `pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`.
7. **Re-run the screenshot capture** if the change is visual: `pnpm --filter @mydrunner/e2e exec playwright test tests/screenshot.spec.ts`. Commit the new PNGs alongside the code.

## Known limitations / gotchas

- **`@dimforge/rapier3d-compat 0.14` exposes `setWheelRollInfluence` in TypeScript types but the WASM binding throws at runtime.** Don't use it; tune via CoM offset, track width, friction multipliers, and steer rate instead.
- **Rapier heightfield is column-major.** `World.buildTerrain()` transposes our row-major heights before calling `ColliderDesc.heightfield`. If you change the generator's indexing, update the transpose.
- **Single global room.** `Room` is instantiated once in `index.ts`. Sharding requires a `RoomManager` — straightforward but unbuilt.
- **Tick loop is deadline-based `setTimeout` with catch-up** (up to 4 ticks per iteration, resync past 250 ms behind). Snapshot cadence carries its fractional remainder so 30 Hz doesn't drift. If perf logs show `lateFires` climbing, look at GC pressure before touching the loop.
- **Inputs are shape-validated at decode (`decodeClient`) and clamped server-side** (`Room.applyInput`), but otherwise trusted. No anti-cheat beyond range clamping.
- **Rapier `compat` build bundles WASM as base64.** This is why `optimizeDeps.exclude` is set in `vite.config.ts`. Don't switch to `@dimforge/rapier3d` (non-compat) without revisiting Vite config.
- **The local truck's kind must match on server and prediction sim.** `Room.addPlayer` and `main.ts` both spawn from the same `choice.carKind`; a mismatch means different mass/power/geometry and the soft corrections permanently fight the local sim.
- **Prediction fallback:** if the soft-correction model misbehaves, don't construct `Prediction` in `main.ts` — the scene automatically falls back to snapshot extrapolation for the local truck (~100 ms input lag, but rock-solid).

## Operating notes

- **Server logs** go to stdout. There is no logger abstraction yet; use `console.log` with a `[mydrunner-server]` prefix to match existing style.
- **Client errors** surface in the browser console. The Playwright smoke test asserts there are zero `pageerror` events — keep that bar.
- **Ports:** server `2567` (env `PORT` overrides), client `5173`. Override server URL on the client with `VITE_SERVER_URL`.
- **Health endpoint:** `GET /health` on the server returns `{ ok, players }`. Used by Playwright's `webServer` probe.

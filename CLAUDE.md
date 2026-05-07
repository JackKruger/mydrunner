# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

mydrunner is a browser-based, multiplayer, physics-driven off-road 4x4 game inspired by MudRunner. The fun comes from the physics: suspension, slip, mud, and getting unstuck. Treat the physics as the product — gameplay, content, and polish all live downstream of it feeling good.

Vehicles are procedural Three.js silhouettes; physics is shared, only the mesh varies. Four kinds today (adding more is a body builder + palette + picker entry + `CarKind` literal + a `VEHICLE_GEOM` row):
- **Patrol** — Nissan-Patrol-GQ-style boxy SUV (AWD, roof rack, bullbar, snorkel, rear spare).
- **Hilux** — Toyota-Hilux-style ute with a hardtop canopy on the bed.
- **Ute** — open-tray ute variant.
- **Motorbike** — two-wheeler. `vehicleGeom.ts` carries kind-specific axle geometry, mass multiplier, and torque multiplier so the bike feels lighter and quicker without forking the physics path.

Rollover is intentionally a real risk on slopes and at-speed turns into ruts — it's tuned to be controllable on the road but punishing off it. There is also an incline-traction assist (`INCLINE_ASSIST_MAX`) so the truck can actually climb the rocky path up the mountain.

## Stack

- **TypeScript everywhere**, ESM, Node 22+, pnpm workspaces.
- **Physics:** Rapier (`@dimforge/rapier3d-compat`, WASM). Both server and client run the same shared world; the server is authoritative, the client runs a soft-corrected prediction sim for local-input responsiveness. Lives in `packages/shared/src/physics/`.
- **Client:** Vite + Three.js. No React. Render loop is `requestAnimationFrame` driving `Scene.render()` in `packages/client/src/scene.ts`. Remote vehicles render from interpolated snapshots ~100 ms behind the server clock; the local vehicle's pose is overridden each frame from the prediction sim's state.
- **Server:** Node + `ws` + `http`. Single authoritative `Room` running a fixed 60Hz physics loop, broadcasting 30Hz MessagePack snapshots. Lives in `packages/server/src/`.
- **Wire format:** MessagePack with snapshot quantization (cm/millirad). Encode/decode is centralised in `packages/shared/src/net/messages.ts` so swapping schemas is a one-file change.
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
  shared/   types, constants, net protocol, World+Vehicle+terrain+obstacles physics
  server/   WS+HTTP entry point, Room (one world, all players, fixed loop)
  client/   Vite app: input + touch -> NetClient -> Prediction (local Rapier sim) -> Scene (Three.js) + ChaseCamera
  e2e/      Playwright tests + screenshot capture (boots client + server via webServer config)
```

`shared` is consumed via TypeScript source (`"main": "./src/index.ts"`) — no build step needed for inter-package use during dev.

### Server-authoritative with soft-corrected client prediction

The server is the source of truth for physics. Each tick (60 Hz):

1. Read pending input for each player.
2. `vehicle.preStep()` does steering smoothing, per-wheel raycasts, suspension/anti-roll, engine + gearbox, and per-wheel tire forces (per-wheel surface lookup modulates grip).
3. `world.step()` advances Rapier.
4. `vehicle.postStep()` accumulates wheel spin for visuals.
5. Every other tick (30 Hz), broadcast a `WorldSnapshot` to every player.

The client runs the same shared physics in `client/src/prediction.ts` lockstep with input — local body responds within one tick (~16 ms). Each server snapshot is treated as a **soft correction**, not authority: the body is nudged a small fraction toward the server's extrapolated pose, with the residual absorbed by a decaying visual offset so the rendered pose stays continuous. Big divergences (>5 m) hard-snap and accept a visible pop. Internal state (steer, wheel angVels, RPM, gear) integrates identically to the server given the same inputs and is not reset; axle ride/roll is snapped from each snapshot because terrain contact is the dominant drift source.

Remote vehicles render from the snapshot pair around `now - RENDER_DELAY_MS` (`Scene.render()`). The local truck's pose is overridden each frame from the prediction sim via `Scene.setLocalVehiclePose()`, so the chase camera and HUD see input-responsive state.

This is v2. The earlier prediction layer ran a local sim, queued unacked inputs, and on every snapshot snapped the body to the server pose then **replayed** the queue — the replay loop was the source of the rubberbanding / reconcile heartbeat / death-spiral bugs. Soft correction throws away the replay (constant ~0.2 ms cost per snapshot, no queue, no spiral). The wire protocol still carries `lastAckSeq` so the prediction can extrapolate the server's snapshot forward to "now" before comparing.

### Key files

- `packages/shared/src/constants.ts` — every tunable: tick rate, vehicle mass / suspension / drive split, surface friction, camera spring, incline assist. Tuning lives here, code does not.
- `packages/shared/src/types.ts` — `PlayerInput`, `VehicleState`, `WorldSnapshot`, `CarKind`. Wire-shape contract.
- `packages/shared/src/net/messages.ts` — `ClientMessage` / `ServerMessage` discriminated unions, `encode` / `decode*`. MessagePack with quantized snapshots. Welcome carries terrain seed + spawn pose; `hello` carries name + carKind; snapshots include each player's `carKind`.
- `packages/shared/src/physics/world.ts` — `World` wraps a `RAPIER.World`, owns the heightfield collider + map of vehicles + obstacles. **Note: heights are transposed before being handed to Rapier** (Rapier reads column-major; our generator is row-major).
- `packages/shared/src/physics/solidAxleVehicle.ts` — `SolidAxleVehicle`: custom solid-axle vehicle model. `preStep` does per-wheel-end raycasts, spring/damper forces, anti-roll bar, engine + gearbox, and tire slip forces.
- `packages/shared/src/physics/vehicleGeom.ts` — per-`CarKind` axle geometry, mass multiplier, torque multiplier. The single source of truth for "what makes a bike feel different from a Patrol".
- `packages/shared/src/physics/terrain.ts` — deterministic FBM-noise heightmap + Surface enum, built as a pipeline of `HeightLayer` and `SurfaceRule` functions. Rolling hills, one Gaussian mountain peak, scattered mud bogs, road + hill-climb corridor.
- `packages/shared/src/physics/obstacles.ts` — deterministic rock + tree placement. Three passes: medium scatter, dense small-rock detail, and a corridor of boulders along the rocky hill climb up the mountain.
- `packages/shared/src/physics/util.ts` — small shared helpers (`rotateVecByQuat`, `mulberry32`).
- `packages/server/src/room.ts` — owns `World`, 60Hz tick, 30Hz snapshots, player spawns on the road grid. World is 320×320 at heightfield resolution 128.
- `packages/server/src/index.ts` — HTTP+WS bootstrap, route messages into `Room`, expose `/health`.
- `packages/client/src/prediction.ts` — local Rapier sim driven lockstep with input; soft-correction model on each server snapshot.
- `packages/client/src/scene.ts` — Three.js scene, snapshot interpolation for remote vehicles, local-pose override from prediction, terrain replication, mud splatter particles. Camera state is delegated to `ChaseCamera`.
- `packages/client/src/camera.ts` — `ChaseCamera`: chase-cam yaw spring with corner swing, pitch-aware lookAt for hill driving, hood cam, sky cam.
- `packages/client/src/carMesh.ts` — `buildCarMesh(kind, isLocal, idHash)` for all four `CarKind`s. Shared materials + wheel builder, per-kind body builders. Wheels have visible spokes + tread lugs so rotation direction reads.
- `packages/client/src/joinScreen.ts` — first-load name + car picker. Persists name + carKind to localStorage; subsequent visits pre-fill the picker. `?auto=1` URL bypass for e2e.
- `packages/client/src/touchInput.ts` — on-screen analog steer pad + gas/brake/handbrake/aux buttons for mobile. State merges into `sampleInput()` alongside keyboard.
- `packages/client/src/terrain.ts` — Three.js terrain mesh built from the same generator the server uses.

### Determinism note

Rapier in single-threaded mode is deterministic given identical inputs and step order. The client and server run the same shared physics package against the same seed, so identical inputs produce the same trajectory — that's what makes the soft-correction model work (the local sim and the server slowly converge instead of slowly diverging) and what makes server-side regression tests viable. Do not introduce non-deterministic state (`Date.now()` inside `step`, unseeded `Math.random()`, floating-point reductions across non-deterministic iteration order) inside `World.step()` or `Vehicle.preStep()/postStep()`.

`packages/server/src/__tests__/prediction.test.ts` enforces this with a "two worlds, same seed, same inputs → same state" assertion.

## Conventions

- **Tunables in `constants.ts`.** Magic numbers in physics or networking code are bugs in waiting.
- **Shared types are the wire contract.** When you change `PlayerInput` or `VehicleState`, both client and server pick it up via TypeScript.
- **No comments that restate code.** Comments explain *why*: a constraint, a tradeoff, a workaround.
- **Tests use real components.** Server tests use real Rapier. Browser tests use real Playwright. There is no mocked physics or socket — bugs love mocks.
- **Diagnostic hooks are dev-only.** `window.__scene` is guarded by `import.meta.env.DEV`. Production bundles do not expose it.
- **Branching:** the user runs Claude on a per-task `claude/<slug>` branch (e.g. `claude/codebase-review-refactor-D4S6H`). Develop and push there; do not push to `main` and do not assume any specific mirror branch unless the current task spec names one.
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

The MVP loop is **complete**: connect → pick name + rig → drive a 4x4 (Patrol/Hilux/Ute) or motorbike with shared physics on procedural terrain → cross mud at low traction → climb the rocky hill route up the mountain → see every truck interpolated from the authoritative snapshot stream while your own truck responds to input within one tick via the local prediction sim. Next priorities, roughly in order:

### Shipped
- Surface-name HUD.
- Engine sound (RPM-driven via `AudioContext`).
- Mud splatter particles in deep mud.
- Player nameplate above each remote vehicle.
- Pitch-aware chase camera + corner swing + sky cam follow.
- Hilux + Ute + Motorbike variants on top of Patrol; name/car localStorage persistence.
- Touch / mobile controls (analog steer pad + pedals + aux).
- Hill-climb traction assist, wider surface friction contrast.
- MessagePack snapshots with cm/millirad quantization.
- Soft-correction client prediction (v2).

### Polish (small, valuable)
- Minimap / map overview.

### Content
- More than one road. A real "course" with stretches of dirt, mud, water crossings.
- Cargo objective: spawn a crate to deliver from A to B; mass affects vehicle handling.
- Multiple truck loadouts (light, heavy, winch-equipped).

### Multiplayer depth
- Lobby / room codes (currently single global room).
- Lag compensation for inputs the server processes (server interpolates back).
- Text chat (voice was scoped and shelved — WebRTC P2P + WS signaling is the chosen approach).

### Wire-format optimisation
- Snapshot deltas — only changed players, only changed fields. (Quantization + msgpack already shipped.)

### Stretch
- Winch (rope constraint between vehicles, physics-driven recovery).
- Destructible terrain features (trees, fences).
- Physics-driven water bodies that the chassis floats in / bogs down in.
- Day/night cycle + headlight illumination.
- Deformable ruts. Earlier `RutBuffer` plumbing was deleted as dead code; the constraints that killed it remain — heightfield cells (~2.5 m at the current 320×320 / 128 resolution) are much wider than a tire so wheel passes sink large patches, and the client prediction world would diverge from the server's deformed collider. Re-introducing needs either a much higher resolution heightfield or a sub-cell visual overlay decoupled from physics, plus a way to keep the prediction sim's collider in sync (or accept that ruts only affect the server world and the client's prediction will pop on contact).

## How to add a feature, end to end

1. **Touch types first.** Add fields to `PlayerInput` / `VehicleState` / `WorldSnapshot` in `packages/shared/src/types.ts`. TypeScript will tell you everywhere that needs to change. If the wire layout changes, update `packSnapshot`/`unpackSnapshot` in `packages/shared/src/net/messages.ts` together (and bump the schema version literal).
2. **Update the simulator.** Modify `Vehicle` / `World` in `packages/shared/src/physics/`. Both the server's `Room` and the client's `Prediction` consume it — write the change once.
3. **Tune in constants.** Don't hardcode in step code.
4. **Update the renderer.** `Scene.render()` interpolates remote vehicles from snapshots, and `Scene.setLocalVehiclePose()` overrides the local truck from the prediction state — make sure both paths read new fields correctly. Expose getters for HUD/debug/e2e via the existing `localPosition()` / `localSteer()` / `localAxles()` shape.
5. **Write a test.** Server-side: `vitest` against the real `World`. Client-side: Playwright if it's user-visible.
6. **Run the gauntlet:** `pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`.
7. **Re-run the screenshot capture** if the change is visual: `pnpm --filter @mydrunner/e2e exec playwright test tests/screenshot.spec.ts`. Commit the new PNGs alongside the code.

## Known limitations / gotchas

- **`@dimforge/rapier3d-compat 0.14` exposes `setWheelRollInfluence` in TypeScript types but the WASM binding throws at runtime.** Don't use it; tune via CoM offset, track width, friction multipliers, and steer rate instead.
- **Rapier heightfield is column-major.** `World.buildTerrain()` transposes our row-major heights before calling `ColliderDesc.heightfield`. If you change the generator's indexing, update the transpose.
- **Single global room.** `Room` is instantiated once in `index.ts`. Sharding requires a `RoomManager` — straightforward but unbuilt.
- **Tick on `setInterval`.** Will drift under Node GC pauses. Acceptable for MVP; move to `setImmediate`-driven loop with sleep-to-deadline if drift becomes visible.
- **Inputs are clamped server-side** (`Room.applyInput`) but otherwise trusted. No anti-cheat beyond range clamping.
- **Rapier `compat` build bundles WASM as base64.** This is why `optimizeDeps.exclude` is set in `vite.config.ts`. Don't switch to `@dimforge/rapier3d` (non-compat) without revisiting Vite config.
- **Prediction is soft-correction, not replay.** `client/src/prediction.ts` integrates a local Rapier sim each input tick and nudges the body toward the server's extrapolated pose on each snapshot (12 % position blend, 8 % velocity blend, 4 % rotation blend, with a 5 m hard-snap fallback). It does NOT replay queued inputs after a snapshot. Don't add a queue/replay loop without rereading the comment block at the top of `prediction.ts` first — the previous replay-based prediction was the source of every "rubberbanding" / "reconcile heartbeat" / "drift while moving" bug we hit.
- **Determinism contract spans client + server now.** Both run the same shared physics. Anything non-deterministic added to `World.step()` or `Vehicle.preStep()/postStep()` (timestamps, unseeded RNG, iteration over a `Map` whose insertion order varies) breaks soft correction's convergence guarantee.

## Operating notes

- **Server logs** go to stdout. There is no logger abstraction yet; use `console.log` with a `[mydrunner-server]` prefix to match existing style.
- **Client errors** surface in the browser console. The Playwright smoke test asserts there are zero `pageerror` events — keep that bar.
- **Ports:** server `2567` (env `PORT` overrides), client `5173`. Override server URL on the client with `VITE_SERVER_URL`.
- **Health endpoint:** `GET /health` on the server returns `{ ok, players }`. Used by Playwright's `webServer` probe.

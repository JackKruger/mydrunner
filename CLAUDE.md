# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

mydrunner is a browser-based, multiplayer, physics-driven off-road 4x4 game inspired by MudRunner. The fun comes from the physics: suspension, slip, mud, deformable terrain, and getting unstuck. Treat the physics as the product — gameplay, content, and polish all live downstream of it feeling good.

Vehicles are procedural Three.js silhouettes; physics is shared, only the mesh varies. Two kinds today (more is just adding a body builder + palette + picker entry):
- **Patrol** — Nissan-Patrol-GQ-style boxy SUV (AWD, roof rack, bullbar, snorkel, rear spare).
- **Hilux** — Toyota-Hilux-style ute with a hardtop canopy on the bed.

Rollover is intentionally a real risk on slopes and at-speed turns into ruts — it's tuned to be controllable on the road but punishing off it. There is also an incline-traction assist (`INCLINE_ASSIST_MAX`) so the truck can actually climb the rocky path up the mountain.

## Stack

- **TypeScript everywhere**, ESM, Node 22+, pnpm workspaces.
- **Physics:** Rapier (`@dimforge/rapier3d-compat`, WASM). Server-only — the client does not run a physics simulation. Lives in `packages/shared/src/physics/` (the package is still loaded on the client for terrain generation and `sampleSurface()` lookups).
- **Client:** Vite + Three.js. No React. Render loop is `requestAnimationFrame` driving `Scene.render()` in `packages/client/src/scene.ts`. Render is purely server-authoritative: snapshots arrive at 30 Hz and `Scene.render()` interpolates everything (local truck included) ~100 ms behind the server clock.
- **Server:** Node + `ws` + `http`. Single authoritative `Room` running a fixed 60Hz physics loop, broadcasting 30Hz JSON snapshots. Lives in `packages/server/src/`.
- **Wire format:** JSON for now. Encode/decode is centralised in `packages/shared/src/net/messages.ts` so swapping to msgpack/binary is a one-file change.
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
  client/   Vite app: input + touch -> NetClient -> Scene (Three.js) + ChaseCamera (no local physics)
  e2e/      Playwright tests + screenshot capture (boots client + server via webServer config)
```

`shared` is consumed via TypeScript source (`"main": "./src/index.ts"`) — no build step needed for inter-package use during dev.

### Server-authoritative, no client prediction

The server is the only source of truth for physics. Each tick (60 Hz):

1. Read pending input for each player.
2. `vehicle.preStep()` applies steer/throttle/brake to the Rapier vehicle controller, performs **per-wheel surface lookup** (sample terrain texel under each wheel → modulate friction slip), then `controller.updateVehicle(dt)`.
3. `world.step()` advances Rapier.
4. `vehicle.postStep()` accumulates wheel spin for visuals.
5. (Disabled) Each driven wheel's pass would be recorded into the **rut buffer** when `RUTS_ENABLED=true`. Currently off — the heightfield resolution is too coarse for tyre-width tracks. Buffer + flush + collider-rebuild plumbing is intact in `room.ts` for when the underlying issues are fixed.
6. Every other tick (30 Hz), broadcast a `WorldSnapshot` to every player.

The client samples input at 60 Hz and ships each `PlayerInput` to the server — it does NOT simulate physics locally. `Scene.render()` interpolates every vehicle (the local truck included) from the snapshot pair surrounding `now - RENDER_DELAY_MS`. The chase camera reads its target from the local truck's interpolated pose each frame.

This was a deliberate trade after a long fight with prediction artifacts (rubberbanding, reconcile heartbeat, partial-replay drift while moving). The vehicle has 2.5 t of inertia and the gameplay is "intentions, not twitch reflexes", so ~100 ms of input lag is well-tolerated. Removing the prediction layer made every "the truck pops/drifts/stutters" bug architecturally impossible.

If sub-100 ms input response ever becomes a hard requirement (twitch driving content, or a competitive mode), the way back is to re-introduce a local Rapier sim — the server-side physics package is unchanged, and the wire protocol (inputs in, snapshots out, `lastAckSeq` for reconcile) is already shaped for it.

### Key files

- `packages/shared/src/constants.ts` — every tunable: tick rate, vehicle mass / suspension / drive split, surface friction, rut rate, camera spring, incline assist. Tuning lives here, code does not.
- `packages/shared/src/types.ts` — `PlayerInput`, `VehicleState`, `WorldSnapshot`, `CarKind`. Wire-shape contract.
- `packages/shared/src/net/messages.ts` — `ClientMessage` / `ServerMessage` discriminated unions, `encode` / `decode*`. Welcome carries terrain seed + spawn pose; `hello` carries name + carKind; snapshots include each player's `carKind`; `rut` messages carry per-cell deltas (currently never emitted).
- `packages/shared/src/physics/world.ts` — `World` wraps a `RAPIER.World`, owns the heightfield collider + map of vehicles + obstacles. **Note: heights are transposed before being handed to Rapier** (Rapier reads column-major; our generator is row-major).
- `packages/shared/src/physics/solidAxleVehicle.ts` — `SolidAxleVehicle`: custom solid-axle vehicle model (the only vehicle model; legacy raycast path was deleted in Phase 4). `preStep` does per-wheel-end raycasts, spring/damper forces, anti-roll bar, engine + gearbox, and tire slip forces.
- `packages/shared/src/physics/terrain.ts` — deterministic FBM-noise heightmap + Surface enum + `mountainFor(size)` landmark spec. `roadCore=5` strict-flat, `roadCore..roadShoulder=8` smoothstep into natural terrain. Rolling hills, one Gaussian mountain peak, scattered mud bogs.
- `packages/shared/src/physics/obstacles.ts` — deterministic rock + tree placement. Three passes: medium scatter, dense small-rock detail, and a corridor of boulders along the rocky hill climb up the mountain.
- `packages/shared/src/physics/ruts.ts` — `RutBuffer` accumulates per-cell erosion, capped at `RUT_MAX_DEPTH`. Only Mud / DeepMud cells erode. Plumbing is in place but disabled via `RUTS_ENABLED`.
- `packages/shared/src/physics/util.ts` — small shared helpers (currently `rotateVecByQuat`).
- `packages/server/src/room.ts` — owns `World`, 60Hz tick, 30Hz snapshots, player spawns on the road grid. World is 320×320 at heightfield resolution 96.
- `packages/server/src/index.ts` — HTTP+WS bootstrap, route messages into `Room`, expose `/health`.
- `packages/client/src/scene.ts` — Three.js scene, snapshot interpolation (local + remote), terrain replication, mud splatter particles. Exposes `localPosition()` / `localSteer()` / `localAxles()` for HUD + debug + e2e to read the rendered local-truck state without a local sim. Camera state is delegated to `ChaseCamera`.
- `packages/client/src/camera.ts` — `ChaseCamera`: chase-cam yaw spring with corner swing, pitch-aware lookAt for hill driving, hood cam, sky cam.
- `packages/client/src/carMesh.ts` — `buildCarMesh(kind, isLocal, idHash)` for `'patrol' | 'hilux'`. Shared materials + wheel builder, per-kind body builders. Wheels have visible spokes + tread lugs so rotation direction reads.
- `packages/client/src/joinScreen.ts` — first-load name + car picker. Persists name + carKind to localStorage; subsequent visits pre-fill the picker. `?auto=1` URL bypass for e2e.
- `packages/client/src/touchInput.ts` — on-screen analog steer pad + gas/brake/handbrake/aux buttons for mobile. State merges into `sampleInput()` alongside keyboard.
- `packages/client/src/terrain.ts` — Three.js terrain mesh built from the same generator the server uses; `applyRut(i, dy)` deforms it (currently unused since ruts are off).

### Determinism note

Rapier in single-threaded mode is deterministic given identical inputs and step order. The shared physics package is the only physics path now (server-only), but the determinism property still matters: it means the same inputs replayed against the same seed produce the same trajectory, which is what makes server-side recording / replay / regression tests viable. Do not introduce non-deterministic state (`Date.now()` inside `step`, unseeded `Math.random()`, floating-point reductions across non-deterministic iteration order) inside `World.step()` or `Vehicle.preStep()/postStep()`.

`packages/server/src/__tests__/prediction.test.ts` enforces this with a "two worlds, same seed, same inputs → same state" assertion. (Name is a leftover from when the client also ran a sim; the test is still valid as a determinism guard.)

## Conventions

- **Tunables in `constants.ts`.** Magic numbers in physics or networking code are bugs in waiting.
- **Shared types are the wire contract.** When you change `PlayerInput` or `VehicleState`, both client and server pick it up via TypeScript.
- **No comments that restate code.** Comments explain *why*: a constraint, a tradeoff, a workaround.
- **Tests use real components.** Server tests use real Rapier. Browser tests use real Playwright. There is no mocked physics or socket — bugs love mocks.
- **Diagnostic hooks are dev-only.** `window.__scene` is guarded by `import.meta.env.DEV`. Production bundles do not expose it.
- **Branching:** development happens on `main`. After committing, mirror to `claude/add-claude-documentation-b6LkY` (fast-forward + push) so both branches stay at the same tip — the user runs deployments off both.
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

The MVP loop is **complete**: connect → pick name + rig → drive a lifted 4x4 with AWD physics on procedural terrain → cross mud at low traction → climb the rocky hill route up the mountain → see every truck (yours and remotes') interpolated smoothly from the same authoritative snapshot stream. Input runs ~100 ms ahead of what's on screen; the heavy chassis makes that the right trade. Next priorities, roughly in order:

### Shipped
- Surface-name HUD.
- Engine sound (RPM-driven via `AudioContext`).
- Mud splatter particles in deep mud.
- Player nameplate above each remote vehicle.
- Pitch-aware chase camera + corner swing + sky cam follow.
- Hilux variant + name/car localStorage persistence.
- Touch / mobile controls (analog steer pad + pedals + aux).
- Hill-climb traction assist, wider surface friction contrast.

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
- Move snapshots to msgpack or binary deltas — only changed players, only changed fields.
- Quantize positions/quaternions for snapshots (1cm position, ~0.001 rad rotation are plenty).

### Stretch
- Winch (rope constraint between vehicles, physics-driven recovery).
- Destructible terrain features (trees, fences) on top of mud-deformation.
- Physics-driven water bodies that the chassis floats in / bogs down in.
- Day/night cycle + headlight illumination.
- Re-enable ruts: needs higher heightfield resolution (or a sub-cell visual deformation overlay decoupled from the collider). With prediction gone the client just needs to replay deltas into its terrain mesh — the collider rebuild is server-side only.

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
- **Tick on `setInterval`.** Will drift under Node GC pauses. Acceptable for MVP; move to `setImmediate`-driven loop with sleep-to-deadline if drift becomes visible.
- **Inputs are clamped server-side** (`Room.applyInput`) but otherwise trusted. No anti-cheat beyond range clamping.
- **Rapier `compat` build bundles WASM as base64.** This is why `optimizeDeps.exclude` is set in `vite.config.ts`. Don't switch to `@dimforge/rapier3d` (non-compat) without revisiting Vite config.
- **Local input lag is structural.** With no client-side prediction, the local truck renders ~100 ms behind input. Acceptable for a heavy off-road sim, not for twitch driving. If gameplay ever demands tighter response, the prediction layer needs to be reintroduced (the wire protocol still carries `lastAckSeq` and inputs already include `seq` — the hooks are there).

## Operating notes

- **Server logs** go to stdout. There is no logger abstraction yet; use `console.log` with a `[mydrunner-server]` prefix to match existing style.
- **Client errors** surface in the browser console. The Playwright smoke test asserts there are zero `pageerror` events — keep that bar.
- **Ports:** server `2567` (env `PORT` overrides), client `5173`. Override server URL on the client with `VITE_SERVER_URL`.
- **Health endpoint:** `GET /health` on the server returns `{ ok, players }`. Used by Playwright's `webServer` probe.

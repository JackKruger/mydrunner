# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

mydrunner is a browser-based, multiplayer, physics-driven off-road truck game inspired by MudRunner. The fun comes from the physics: suspension, slip, mud, and getting unstuck. Treat the physics as the product — gameplay, content, and polish all live downstream of it feeling good.

## Stack

- **TypeScript everywhere**, ESM, Node 22+, pnpm workspaces.
- **Physics:** Rapier (`@dimforge/rapier3d-compat`, WASM). Same library on client and server, same fixed timestep, same `World` / `Vehicle` classes — they live in `packages/shared/src/physics/`.
- **Client:** Vite + Three.js. No React. The render loop is a plain `requestAnimationFrame` driving `Scene.render()` in `packages/client/src/scene.ts`.
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
pnpm test                     # vitest across shared + server (client has --passWithNoTests)
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

Playwright browsers: in sandboxed environments without internet, the config auto-points at `/opt/pw-browsers` if it exists. Otherwise: `pnpm --filter @mydrunner/e2e exec playwright install chromium`.

## Architecture

### Monorepo layout

```
packages/
  shared/   types, constants, net protocol, fixed-step runner, World+Vehicle physics
  server/   WS+HTTP entry point, Room (one world, all players, fixed loop)
  client/   Vite app: input -> NetClient -> Scene (Three.js render + interpolation buffer)
  e2e/      Playwright tests (boots client + server via webServer config)
```

`shared` is consumed via TypeScript source (`"main": "./src/index.ts"`) — no build step needed for inter-package use during dev. Only when `tsc -b` runs for distribution.

### Authoritative server, interpolated client (current design)

The server is the only source of truth for physics. Each tick:

1. Read pending input for each player (last received `PlayerInput`).
2. `vehicle.preStep()` applies steer/throttle/brake to the Rapier vehicle controller and calls `controller.updateVehicle(dt)`.
3. `world.step()` advances Rapier.
4. `vehicle.postStep()` accumulates wheel spin for visuals.
5. Every other tick (30Hz), broadcast a `WorldSnapshot` to every player.

Clients **do not run physics yet**. They:

1. Sample keyboard input each frame, send it as a `ClientMessage.input` at ~60Hz.
2. Receive snapshots, push into a buffer keyed by client receive time.
3. Render at `now - INTERPOLATION_DELAY_MS` (100ms) by linearly interpolating between the two straddling snapshots — both for chassis transform and wheel suspension/spin.

This is intentionally simple. It feels slightly laggy (input → server → snapshot → render = ~100ms+ RTT/2). The next milestone is **client-side prediction with reconciliation** — see roadmap.

### Key files

- `packages/shared/src/constants.ts` — every tunable: tick rate, vehicle mass, suspension, engine force, surface friction. Tuning lives here, code does not.
- `packages/shared/src/types.ts` — `PlayerInput`, `VehicleState`, `WorldSnapshot`. Wire-shape contract between client and server.
- `packages/shared/src/net/messages.ts` — `ClientMessage` / `ServerMessage` discriminated unions, `encode` / `decodeClient` / `decodeServer`. **Change format here only.**
- `packages/shared/src/physics/world.ts` — `World` wraps a `RAPIER.World`, owns the heightfield collider, and the map of vehicles. `initRapier()` must be awaited once before constructing.
- `packages/shared/src/physics/vehicle.ts` — `Vehicle` wraps `RAPIER.DynamicRayCastVehicleController`. This is where mud/surface friction will be modulated per-wheel using raycast hits in the future.
- `packages/shared/src/physics/fixedStep.ts` — Glenn-Fiedler style accumulator. Used for any future client-side prediction loop.
- `packages/server/src/room.ts` — owns `World`, `setInterval` driven 60Hz tick, broadcasts snapshots at 30Hz, manages players.
- `packages/server/src/index.ts` — HTTP+WS bootstrap, route messages into `Room`, expose `/health`.
- `packages/client/src/scene.ts` — Three.js scene, snapshot buffer, render-time interpolation, camera follow.
- `packages/client/src/net.ts` — thin `WebSocket` wrapper.
- `packages/client/src/input.ts` — keyboard → `PlayerInput`.

### Determinism note

Rapier in single-threaded mode is **deterministic given the same inputs and step order**. We do not yet rely on this, but the physics package is structured so client and server can run the exact same simulation — required for prediction/rollback. Do not introduce non-deterministic state (`Date.now()` in step, `Math.random()` outside seeded RNG, floating-point reductions across iteration order) inside `World.step()` or `Vehicle.preStep()/postStep()`.

## Conventions

- **Tunables in `constants.ts`.** Magic numbers in physics or networking code are bugs in waiting.
- **Shared types are the wire contract.** When you change `PlayerInput` or `VehicleState`, both client and server pick it up via TypeScript — but you still need to confirm the JSON shape is compatible (or bump a protocol version).
- **No comments that restate code.** Comments explain *why*: a constraint, a tradeoff, a workaround. The vehicle controller has several — read them before changing tuning.
- **Tests as feedback loop.** Server tests use real Rapier. Browser tests use real Playwright. There is no mocked physics or mocked socket — it's not worth the maintenance, and bugs love mocks. If you need to test something new, prefer a real integration test over a mock.
- **Branching:** all development goes on `claude/add-claude-documentation-b6LkY` until told otherwise. Do not push to other branches without explicit user approval.
- **No PRs unless asked.** The user has not requested one.

## Roadmap

The MVP loop (client connects, drives a truck on terrain, sees other players) **works today** as of this CLAUDE.md. Next priorities, roughly in order:

### 1. Make the physics actually feel like mud (high value, contained)
- Per-wheel surface lookup: raycast result → terrain texel → `SURFACE_FRICTION` → `setWheelFrictionSlip`. Needs a `SurfaceMap` (Uint8Array of surface IDs, same resolution as heightmap) in `World`.
- Wheel slip ratio → reduce engine force, lengthen acceleration. Tune via `constants.VEHICLE`.
- Visible deep-tread differentiation: front wheels lock-able, rear wheels drive.
- *Test:* extend `physics.test.ts` with a "vehicle on mud surface accelerates slower than on road" assertion.

### 2. Heightmap replication + real terrain on the client
- Server seeds a heightmap (Perlin / FBM) at world start, sends it to clients in `welcome`.
- Client builds a `THREE.PlaneGeometry` displaced by those heights, replaces the placeholder ground.
- *Test:* Playwright check that there's no shadow flicker / vehicle-sinks-through-floor regressions.

### 3. Client-side prediction with server reconciliation
- Client runs its own `World` (just for the local player) using `createFixedStep`.
- On each input, store `(seq, input)` in a queue.
- On snapshot: snap the local vehicle to authoritative state, replay all unacknowledged inputs.
- Other players continue to use snapshot interpolation.
- *Test:* a deterministic integration test that asserts predicted state == authoritative state when no packets are dropped.

### 4. Deformable mud / ruts (the "MudRunner" feel)
- Maintain a per-cell "rut depth" array on the server.
- Each tick, for each contacting wheel, increase rut depth at that texel by a function of normal force and slip.
- Modify the heightmap collider locally (Rapier supports heightfield mutation) and broadcast deltas.
- This is the hardest piece. Keep behind a feature flag in `constants.ts` until it's stable.

### 5. Polish / UX
- Camera modes (chase, hood, free).
- Engine sound (`AudioContext`, RPM-driven).
- Reset / respawn (`buttons & 1` already wired in input).
- Trucks list / lobby / room codes.

### 6. Wire format optimisation
- Move snapshots to msgpack or a custom binary format. Keep the JSON path for debug logging.
- Snapshot delta compression: send only changed players.
- All of this lives in `messages.ts`; do not bleed binary concerns into `Room` or `Scene`.

## How to add a feature, end to end

1. **Touch types first.** Add fields to `PlayerInput` / `VehicleState` / `WorldSnapshot` in `packages/shared/src/types.ts`. TypeScript will tell you everywhere that needs to change.
2. **Update the simulator.** Modify `Vehicle` or `World` in `packages/shared/src/physics/`.
3. **Tune in constants.** Don't hardcode in step code.
4. **Update the renderer.** `Scene.render()` reads from snapshots — make sure it interpolates new fields correctly.
5. **Write a test.** Server-side: `vitest` against the real `World`. Client-side: Playwright if it's user-visible.
6. **Run the gauntlet:** `pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`.

## Known limitations / gotchas

- **No client-side physics yet.** Local player driving feels ~100-150ms laggy. This is the first-priority fix, see roadmap step 3.
- **Heightmap is flat zeroes.** `World` accepts a `heights: Float32Array` but nothing seeds one. Terrain feels boring until step 2.
- **Tick on `setInterval`.** Will drift under Node GC pauses. Acceptable for MVP; move to `setImmediate`-driven loop if drift becomes visible.
- **No anti-cheat.** Inputs are trusted — clamp them in `Room.applyInput` if cheating becomes a real concern. The throttle/steer fields are not currently bounded.
- **Single global room.** `Room` is instantiated once in `index.ts`. Sharding requires a `RoomManager` — straightforward but unbuilt.
- **Rapier `compat` build bundles WASM as base64.** This is why `optimizeDeps.exclude` is set in `vite.config.ts`. Don't switch to `@dimforge/rapier3d` (non-compat) without revisiting Vite config.

## Operating notes

- **Server logs** go to stdout. There is no logger abstraction yet; use `console.log` with a `[mydrunner-server]` prefix to match existing style.
- **Client errors** surface in the browser console. The Playwright smoke test asserts there are zero `pageerror` events — keep that bar.
- **Ports:** server `2567` (env `PORT` overrides), client `5173`. Override server URL on the client with `VITE_SERVER_URL`.
- **Health endpoint:** `GET /health` on the server returns `{ ok, players }`. Used by Playwright's `webServer` probe and is fine for any future load balancer.

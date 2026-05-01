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

## Prioritized next work

### P0 — physics feel polish (small, high payoff)
- [ ] Slip-angle component to tire grip. Current `tire.ts` only models
      longitudinal slip ratio. Lateral slip (sideways slide) would make
      under/oversteer feel right - and would make "drifting in mud"
      actually a thing.
- [ ] Better engine braking on downhills - currently coasts faster than
      it should. Tune `ENGINE.engineBrakeCoef` or sample from chassis
      velocity not just RPM.
- [ ] Anti-roll bar emulation - cross-couple the suspension forces of
      paired wheels (FL+FR, RL+RR) so cornering doesn't lift the
      inside wheels as easily. Reduces tippy feel without making the
      car immune to rollover on rough ground.

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

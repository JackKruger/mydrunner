# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

mydrunner is a browser-based, multiplayer, physics-driven off-road 4x4 game inspired by MudRunner. The fun comes from the physics: suspension, slip, mud, deformable terrain, and getting unstuck. Treat the physics as the product — gameplay, content, and polish all live downstream of it feeling good.

Vehicles are complete, persistent workshop builds with procedural Three.js silhouettes and build-resolved physics geometry (`vehicleBuild.ts`, `vehicleGeom.ts`, `vehicleVisualLayout.ts`). Seven fictional bases ship: two wagons, two Stockman utilities, the Longreach troop carrier, the Outclaw tube crawler, and the Dustback RS classic rally hatch. The first six have selectable 4WD transfer cases and lockers; the Dustback is fixed rear-wheel drive and reuses the persisted rear-locker bit as its fitted continuous rear LSD option.

The owning client constructs the chosen kind in its local Rapier world. The server keeps the kind as relay metadata so every remote client builds the matching mesh and collision proxy.

Water is the second real hazard after rollover. A truck in a river loses tyre grip, is pushed downstream by an authored current, gets light as buoyancy unloads the springs, and floods its engine if the air intake goes under — which is per-`CarKind`, so the Patrol's snorkel is a stat rather than a decoration. Deep enough and it floats free and is swept away, gradually swamps, and settles onto the bed.

Rollover is intentionally a real risk on slopes and at-speed turns into ruts — it's tuned to be controllable on the road but punishing off it. There is also an incline-traction assist (`INCLINE_ASSIST_MAX`) so the truck can actually climb the rocky path up the mountain.

## Stack

- **TypeScript everywhere**, ESM, Node 22+, pnpm workspaces.
- **Physics:** Rapier (`@dimforge/rapier3d-compat`, WASM). Lives in `packages/shared/src/physics/` and runs in each owning browser. The server does not simulate vehicles.
- **Client:** Vite + Three.js. No React. `requestAnimationFrame` drives fixed-step owner physics plus `Scene.render()`. Remote vehicles interpolate from relayed snapshots ~100 ms behind; the local truck interpolates its two latest 60 Hz physics poses at display rate.
- **Server:** Node + `ws` + `http`. A single `Room` allocates spawns, stores the newest owner state and broadcasts 30 Hz aggregate snapshots. Lives in `packages/server/src/`.
- **Wire format:** MessagePack binary with quantized snapshots (cm positions, int16 quats, millirad angles — see the scale constants in `packages/shared/src/net/messages.ts`). All encode/decode is centralised there; bump `SNAPSHOT_SCHEMA` if the per-player tuple changes (`decodeServer` throws on an unknown one — the tuple is positional, so a stale decoder would otherwise read every field as its neighbour). Wheel `spin` crosses the wire wrapped mod 2π — consumers must lerp along the shortest wrapped arc.
- **Protocol version:** `PROTOCOL_VERSION` (`constants.ts`) rides on `hello` and `welcome`. Client and server deploy independently, so `index.ts` refuses incompatible wire versions with a visible `bye`. Bump it for wire/message-layout changes. Map content compatibility is guarded separately by the map revision.
- **Map revision:** the second half of that guard, and the one `PROTOCOL_VERSION` cannot cover — *editing a map changes no code either side compiles*. `welcome` carries `{ id, rev }`; the client resolves the id in its own compiled-in registry and compares revisions (`client/src/mapLoad.ts`), refusing the session on a mismatch. Bump nothing by hand: `rev` is the document's content hash.
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

Re-cut the default map's river (after changing its centreline, depths or flow):

```bash
pnpm --filter @mydrunner/shared exec tsx scripts/carveRiver.ts
```

It rewrites `map/maps/defaultMap.ts` in place and is idempotent — the carve (`map/riverCarve.ts`) resets the river's whole *footprint* before recutting, so running it twice produces the same file. The reset must span the footprint, not the previous run's water: the graded bank is carved and stays dry, so a water-keyed reset re-cut the shoulders on top of themselves and the valley crept deeper on every run. `defaultMapRiver.test.ts` pins the committed map at the carve's fixed point, so that drift is now a red test rather than a silent content change.

This drives the car through a short scripted sequence and writes PNGs to `packages/e2e/screenshots/`. They are committed to the repo so each commit's screenshots reflect the game state at that point in history.

Playwright browsers: in sandboxed environments without internet, the config auto-points at `/opt/pw-browsers` if it exists. Otherwise: `pnpm --filter @mydrunner/e2e exec playwright install chromium`.

## Architecture

### Monorepo layout

```
packages/
  shared/   types, constants, net protocol, World+Vehicle+terrain+obstacles physics
  server/   WS+HTTP entry point, Room (membership, spawns, state relay)
  client/   Vite app: input + touch -> NetClient -> Scene (Three.js) + ChaseCamera
            + LocalSimulation (canonical owner Rapier sim + remote proxies)
  e2e/      Playwright tests + screenshot capture (boots client + server via webServer config)
```

`shared` is consumed via TypeScript source (`"main": "./src/index.ts"`) — no build step needed for inter-package use during dev.

### Client-owned vehicle physics + state relay

Each browser is the sole authority for its own truck:

1. Sample input and advance `LocalSimulation` at a fixed 60 Hz.
2. Keep the previous/current completed physics poses and interpolate between them at display rate.
3. Upload the canonical `VehicleState` at 30 Hz using the quantized `state` message.
4. `Room` keeps only the newest sequence per owner and broadcasts aggregate snapshots at 30 Hz.
5. `Scene` interpolates remote vehicles from the snapshot buffer. The pose it draws is also fed back to `LocalSimulation` as a kinematic chassis proxy, so player collisions happen immediately in owner physics with no server round trip.

Snapshots never mutate the locally owned body. Remote proxies collide only with the owner chassis; collision groups exclude terrain, scenery, other proxies and suspension rays. A proxy older than 500 ms is disabled so a stalled connection cannot leave an invisible wall.

### Key files

Shared:

- `packages/shared/src/constants.ts` — every compile-time tunable: protocol/tick rates, vehicle mass / axle springs / drive split, surface friction, anti-roll bar, camera spring, incline assist, and the `TERRAIN.default*` that define the production world. Tuning lives here, code does not.
- `packages/shared/src/tuning.ts` — `TUNING`: live-mutable values read by owner physics and seeded from `constants.ts`. The client debug panel mutates its local instance immediately. Suspension rates are per-`CarKind`, so `TUNING.axleFront` / `axleRear` are multipliers rather than absolutes.
- `packages/shared/src/types.ts` — `PlayerInput`, `VehicleState`, `WorldSnapshot`, `CarKind` (+ `normalizeCarKind`). Wire-shape contract.
- `packages/shared/src/net/messages.ts` — `ClientMessage` / `ServerMessage` discriminated unions, `encode` / `decode*`. `decodeClient` strictly validates shape and rejects non-finite numbers — it is the trust boundary for everything a client can send. Welcome carries a `MapHandshake { id, rev }` + spawn pose + `protocolVersion`; `hello` carries name + carKind + `v`; snapshots include each player's `carKind`. A version mismatch is *not* thrown in `decodeClient` — it decodes normally and `index.ts` answers with a `bye`, because a throw there is swallowed by the ws handler and the player would sit on a dead socket with nothing on screen.
- `packages/shared/src/physics/world.ts` — `World` wraps a `RAPIER.World`, owns the heightfield collider + map of vehicles + obstacles + landmarks. **Note: heights are transposed before being handed to Rapier** (Rapier reads column-major; our generator is row-major).
- `packages/shared/src/physics/solidAxleVehicle.ts` — `SolidAxleVehicle`: custom solid-axle vehicle model (the only vehicle model; legacy raycast path was deleted in Phase 4). `preStep` does per-wheel-end support rays plus hybrid ledge contacts, spring/damper forces, anti-roll bar, engine + gearbox, diff lock, and friction-circle tire forces.
- `packages/shared/src/physics/wheelContact.ts` — exact tyre-cylinder queries for sharp faces, reachable-top probing, corner contact frames, and the face-to-top climb direction used by the controlled-crawl path. Ordinary terrain support remains ray-based.
- `packages/shared/src/physics/axle.ts` — kinematic axle state (rideY + rollAngle DOFs, articulation cap). Pure functions, no Rapier handles.
- `packages/shared/src/physics/wheelDynamics.ts` — per-wheel angular-velocity integrator (drive/brake/ground/rolling torques on wheel inertia). Pure functions.
- `packages/shared/src/physics/engine.ts` — engine + automatic gearbox: torque curve, RPM smoothing, chassis-speed-based shift logic (immune to wheel-slip gear hunting), plus the flood/restart state machine (`stepEngineFlooding`). A drowned engine short-circuits `stepEngine` before the RPM floor and winds down to zero, which fades the audio and reads as 0 on the tacho with no wire change.
- `packages/shared/src/physics/vehicleGeom.ts` — per-`CarKind` physics identity: axle placement, spring rates, mass/power multipliers, `airIntakeY` (chassis-local; what makes the Patrol's snorkel matter and the bike drown first), `spawnYAboveGround`, `restWheelPositions`.
- `packages/shared/src/physics/tire.ts` — slip-curve helpers. Half-live: `slipAngle` + `lateralGripFromSlipAngle` feed the friction-circle model's lateral force; `gripFromSlip` / `slipRatio` and the `TIRE` slip constants are unused, kept as tested building blocks.
- `packages/shared/src/physics/terrain.ts` — deterministic FBM-noise heightmap + Surface enum + `SURFACE_INFO` (the single label/friction-key/minimap-colour table; `surfaceInfo(id)` falls back to Dirt) + hill-climb trail layers. Rolling hills, one Gaussian mountain peak, scattered mud bogs, graded switchback trail. Multiple roads: main asphalt strip, north loop (dirt circuit), south bog trail, east gravel connector, plus the mountain-trail dirt connector.
- `packages/shared/src/physics/objectCatalog.ts` — `OBJECT_INFO`: one source of truth for placeable object metadata and collider parts. Every owner client builds these independently, so collider-layout changes require a protocol bump to keep connected client builds compatible.
- `packages/shared/src/physics/obstacles.ts` — deterministic rock + tree placement. Three passes: medium scatter, dense small-rock detail, and a corridor of boulders along the rocky hill climb up the mountain. `spawnObstacleColliders` is a loop over the catalog, and leaves each body at the origin with the colliders carrying full world transforms: Rapier stores both as f32, so anchor-plus-offset rounds twice and moved a dozen rocks 0.1 mm off the pre-table behaviour.
- `packages/shared/src/map/spawn.ts` — `gridSpawn` / `resolveSpawn`: where a player starts. Extracted from `Room` so the multiplayer relay and the editor's offline preview cannot answer differently. Slot *allocation* stays in `Room` — who is parked where is not the map's business.
- `packages/shared/src/physics/landmarks.ts` — deterministic landmark spec (petrol station, flagpoles, summit lookout) + colliders.
- `packages/shared/src/physics/ruts.ts` — `RutBuffer` accumulates per-cell erosion, capped at `RUT_MAX_DEPTH`. Only Mud / DeepMud cells erode. **Not wired into anything** — the wire message, `World.rebuildTerrain`, the client apply path and Room's flush loop were deleted; this class plus its unit test survive as the building block for a re-implementation. See the RUT_RATE comment in `constants.ts` for the two problems to solve first.
- `packages/shared/src/physics/water.ts` — water sampling (`sampleWaterLevel` / `sampleWaterDepth` / `sampleWaterFlow` / `hasWater`) and the whole force model in `computeWaterLoad`. There is no water collider: buoyancy, drag and current are forces computed from the grids. Buoyancy is four corner forces rather than one resultant, so the righting moment falls out with no second torque term. Drag and current are **one equation** taken against velocity *relative to the water* — a parked truck is pushed, one drifting at the flow speed feels nothing, and the flow speed is a fixed point. Swamping is driven by hull submersion, **not** the air intake: they are different holes, and gating both on the intake let a floating Patrol (snorkel clear, as designed) drift forever.
- `packages/shared/src/physics/damage.ts` — collision + flooding damage accumulation (`body` / `engine` / `steering`, and the `stoppedCause` the HUD shows). Bullbar choice feeds `bullbarEngineProtection`, so what you bolted on in the workshop is what absorbs the hit.
- `packages/shared/src/physics/winch.ts` — cable mechanics: load-limited reeling, tension, and the overload threshold that snaps it. The *attachment* is server-authoritative (`Room`); the mechanics run in owner physics and are relayed back.
- `packages/shared/src/physics/vehicleTypes.ts` — `VehicleLike`, `VehicleSpawn`, `ExternalPointLoad`, `WaterStatus`: the interface owner physics is consumed through, so callers do not import `SolidAxleVehicle` for its type.
- `packages/shared/src/physics/collisionGroups.ts` — the membership/filter bitmasks. One place, because a proxy that accidentally collides with terrain or with a suspension ray is invisible until somebody drives into it.
- `packages/shared/src/physics/util.ts` — small shared helpers (currently `rotateVecByQuat`).
- `packages/shared/src/vehicleBuild.ts` — the workshop's data model and the one place a build becomes physics: `VEHICLE_PART_CATALOGS` (parts per base), `SLOT_OPTIONS` / `VEHICLE_PART_SLOTS` (the single slot list everything positional walks, the wire tuple included), `normalizeVehicleBuildDetailed` (trust boundary for storage, client and server), `vehicleBuildKey` (stable identity, used to compare builds and to key caches), and `resolveVehicleSpec` (build → `ResolvedVehicleSpec`, which `vehicleGeom.ts` turns into collider and axle geometry). **Known wart:** part *effects* are a ladder of `build.tireId.endsWith('.mt-35')` suffix tests sitting apart from the catalog that declares the parts. A typo compiles and silently does nothing. Adding a part means editing two unrelated places — fold the effects onto `VehiclePartOption` when this next gets touched.
- `packages/shared/src/hash.ts` / `generateMaps.ts` — content hashing for the map revision, and a hand-run ASCII terrain dump for eyeballing the generator.

Map (`packages/shared/src/map/`) — the level format. The relay composes it for identity/spawns; the game client composes it for visuals and owner physics; the editor and tests use the same path.

- `mapDoc.ts` — the `MapDoc` type: a procedural base (`{ seed, size, resolution }` plus the road / bog / pad data that used to be hardcoded) with a height delta, surface override, a `water` block (level + flow grids), and object / spawn / marker lists layered on top. Placed objects omit both Y fields to sit on terrain, use `yOffset` to follow it at a relative height, or use `y` for an absolute world-space base; the two fields are mutually exclusive. Water is **authored-only** — no generator layer makes any — which is what keeps it out of `baseChecksum`, out of the drift check and out of `bake`. Delta form is what makes generator improvements flow into existing maps for free, and it is the format's one hazard — a delta only means anything against the base it was cut on. `decodeMapDoc` is a trust boundary in the same posture as `decodeClient`: documents come from files a user picked.
- `applyMapDoc.ts` — composes a document into a `MapWorld { terrain, obstacles, landmarks, spawns, markers }`. `applyMapDoc(proceduralDoc())` reproduces `generateTerrain()` byte for byte, which is what let the document path replace the old one without moving the map anyone drives on. Throws `BaseDriftError` when the generator has moved under a document's edits; the editor passes `onBaseDrift: 'ignore'` to open it anyway and offer a rebase or a bake.
- `tileGrid.ts` — one sparse 16×16 tile codec for both grids. Only tiles differing from the default are stored, so a localised sculpt is ~10 KB rather than ~43 KB and its git diff is local to the edit.
- `riverCarve.ts` — the valley river as a pure `MapDoc -> MapDoc` transform, and a **fixed point**: the reset spans the river's whole footprint, so re-carving a carved map reproduces it byte for byte. It lives in `src/` rather than in `scripts/` precisely so that property is testable.
- `registry.ts` — the maps this build knows about, compiled into *both* bundles. The wire carries an id + revision because a baked map is ~65 KB against a 4 KiB message cap. Authored maps are committed as `.ts` modules, not JSON: Node 22 ESM needs an import attribute for JSON and a malformed map should be a `pnpm typecheck` failure. JSON stays the editor's interchange format.

Server:

- `packages/server/src/room.ts` — composes the selected map, allocates spawn slots, accepts increasing owner-state sequences, broadcasts aggregate snapshots, relays chat and records relay diagnostics. It owns no Rapier world.
- `packages/server/src/index.ts` — HTTP+WS bootstrap, route messages into `Room`, heartbeat ghost-cleanup, expose `/health`.

Client:

- `packages/client/src/main.ts` — entry point: join screen, net wiring, 60 Hz input accumulator, 30 Hz owner-state uploader, composes one shared `MapWorld`, owns `LocalSimulation`, HUD.
- `packages/client/src/mapLoad.ts` — resolves the welcome's `MapHandshake` against the compiled-in registry. Split out of `main.ts` so the two refusal paths (unknown id, revision mismatch) are testable without a socket.
- `packages/client/src/quality.ts` — `QUALITY`: the graphics tier table (`high` = everything that shipped before it existed, `low` = the mobile preset). Resolved once per page load from `?q=low|high`, then the saved `graphics` option, then a device heuristic that wants a coarse pointer **and** a small viewport — `(pointer: coarse)` alone matches touchscreen laptops, which are not fill-bound. It resolves at module scope because `main.ts` builds the `Scene` there, and `antialias` is a context-creation flag, so changing the option applies on the next load. Reaches the render code as a defaulted constructor parameter on `WorldView` / `Sky` / `TerrainMesh` / `WaterMesh` / `Obstacles` / `ParticleSystem` / `VehicleEffects`; the editor pins `QUALITY.high` explicitly *and* calls `setQualityTier('high')`, because `editor/ghost.ts` builds `Obstacles` with no `WorldView` in the path. Three hazards are written into the file: **never lower these shaders to `mediump`** (the noise hashes reach ~1.3e6, which overflows fp16 on mobile while desktop GL silently treats `mediump` as fp32); `obstacleCullFloorM` is a gameplay invariant, not a tunable (see `obstacles/cull.ts`); and the GLSL cuts go through `#define`s so a bad gate is a shader link error rather than a wrong branch.
- `packages/client/src/obstacles/cull.ts` — which scenery may be hidden at distance. Pure, no Three. `Scene.pickWinchTarget` raycasts the obstacle group and `THREE.Raycaster` skips `visible === false` subtrees, so hiding something winchable would change what the player can *do* — the policy therefore asks `winchAnchorForObstacle` itself rather than restating its rules, and a test pins the floor above `WINCH.maxAttachDistance` plus the chase camera's set-back. Culling is visual only; colliders live in the physics world, so a hidden rock is still a rock you hit.
- `packages/client/src/scene.ts` — snapshot interpolation (remote) + owner override (local), per-player visuals, surface-aware wheelspin particles and minimap. It exports the exact drawn remote chassis poses for collision proxies.
- `packages/client/src/worldView.ts` — renderer, lighting, fog, sky, terrain mesh, obstacles, landmarks: the world as seen, with no camera and no render loop of its own (both callers pass their own camera to `render()`). Exists so the level editor renders the world the game actually ships rather than a lookalike — `terrainShader.ts` re-implements Lambert and fog with its own copies of the sun direction and fog range, so a hand-built second scene would light the ground differently from everything standing on it and only a screenshot would catch it.
- `packages/client/src/three/dispose.ts` — `disposeObject3D` / `disposeMaterial`. Three frees nothing on `scene.remove()`, and `Material.dispose()` does not touch textures.
- `packages/client/src/localSimulation.ts` — canonical owner Rapier world, fixed-step render interpolation, off-map ejector and kinematic remote chassis proxies.
- `packages/client/src/net.ts` — thin WebSocket wrapper around the shared protocol; reconnect-safe socket identity checks.
- `packages/client/src/input.ts` / `touchInput.ts` — keyboard (+ handbrake toggle) and on-screen analog steer pad / pedals; both merge in `sampleInput()`.
- `packages/client/src/camera.ts` — `ChaseCamera`: chase-cam yaw spring with corner swing, pitch-aware lookAt for hill driving, hood cam, sky cam.
- `packages/client/src/carMesh.ts` — `buildCarMesh(build, _isLocal, _idHash)`: a mesh for a resolved `VehicleBuild`, across all seven bases. Shared materials + wheel builder, per-base body builders, build-resolved bars / winches / snorkels / roof loads / rear bodies. Wheels have visible spokes + tread lugs so rotation direction reads. The trailing two parameters are vestigial — appearance is hashed from the build, not the player.
- `packages/client/src/terrain.ts` — `TerrainMesh`: geometry only. Heights go straight into the vertex Y component, row-major and **not** transposed (unlike the Rapier collider — Rapier wants column-major). `updateHeights(rect)` / `updateSurfaces(rect)` push a dirty region without rebuilding, which is what makes editor brushes viable; the game never calls them and treats `TerrainData` as immutable for the session.
- `packages/client/src/terrainShader.ts` — the GLSL and `makeTerrainMaterial`. The per-surface branches are procedural textures, not colours, so they stay in GLSL rather than folding into `SURFACE_INFO` — but the branch IDs are interpolated from `Physics.Surface` so renumbering the enum can't desync them. Sun direction and fog range are duplicated from `WorldView`'s light and fog on purpose: this is a raw `ShaderMaterial`, so scene lights never reach it. Retune one, retune the other.
- `packages/client/src/obstacles/` — one mesh builder per object kind. `registry.ts`'s `Record<ObstacleKind, ObjectMeshBuilder>` is the point of the folder: it turns "added a kind to the catalog, forgot the client" into a compile error, where the old per-kind chain ended in an unlabelled `else` that quietly built a tree. The table lives client-side because `shared` must not import three. Builders work in the **local frame** — origin at the ground point, +X facing, no yaw — and `Obstacles` places and yaws one tagged root group per object; that is what makes the editor's ghost movable without a rebuild, and it fixed clicking a tree's canopy (only the trunk used to carry the id). `prims.ts` is the shared shape vocabulary, `materials.ts` the palettes plus a per-instance material cache. Colour/scale variation is hashed from `Obstacle.id` — `Math.random()` there meant the scenery reshuffled on every rebuild and no two clients saw the same forest.
- `packages/client/src/previewHandoff.ts` — the editor→game document handoff, via `sessionStorage`. A tab opened with `window.open` inherits a copy of its opener's session storage, which is both the mechanism and the trap: `noopener` would hand the new tab a blank one. The read path runs the same strict `decodeMapDoc` a picked file does, because storage is user-editable.
- `packages/client/src/water.ts` / `waterShader.ts` — `WaterMesh` mirrors `TerrainMesh` (full-grid plane, level in vertex Y, rect-scoped `updateWater`), with a per-vertex `aWet` attribute so dry cells are discarded in the fragment shader rather than rebuilt out of the geometry on every stroke. Dry vertices sit on the bed, never at the `WATER_NONE` sentinel — a vertex at -1e9 blows up the bounding sphere and breaks culling and editor raycasts. Two things in the shader are gameplay, not decoration: the **depth tint** is the readout a player picks a line by, and the ripples **advect along the flow field** so a river visibly moves and a pond does not. `uTime` self-ticks from `performance.now()` like `sky.ts`, so `WorldView.render(camera)` keeps its signature.
- `packages/client/src/vehicleEffects.ts` / `tyreTracks.ts` — surface-aware wheelspin plumes, water spray, bow wave, soft-ground axle sink, and cosmetic tyre tracks. Tracks are one fixed-size dynamic mesh that fades on the GPU; they deliberately do not reconnect heightfield ruts, because mutable collision terrain would diverge between client-owned physics worlds. The snapshot-arrival gate lives **inside** `spawnFromSnapshot`: emission must track snapshots, not frames, or a 120 Hz client throws 4x the effects of a 30 Hz one. `spawnLocal` covers offline preview, which has no snapshot stream at all.
- `packages/client/src/landmarks.ts` / `sky.ts` (procedural sky dome: gradient + clouds + sun) / `particles.ts` / `nameplate.ts` / `minimap.ts` — world + HUD visuals, all deterministic from the terrain handshake.
Asset designer (`packages/client/src/asset-editor/`) — a third Vite page at `/asset-editor.html`. It is a small low-poly modeller built around the same procedural vocabulary as the game. `library.ts` constructs every current obstacle and stock vehicle through their production builders, then flattens their primitive meshes into an editable versioned asset document; this makes shipped content a real starting point without coupling the designer's document format to the obstacle catalog. `viewport.ts` owns orbit/pick/transform controls, `mesh.ts` is the document-to-Three renderer, and `document.ts` is the strict JSON trust boundary. The designer supports primitive creation, transform and material editing, undo/redo, and JSON import/export. Exported asset JSON is authoring interchange, not part of the multiplayer map or object wire contract.

Level editor (`packages/client/src/editor/`) — a second Vite page at `/editor.html`, listed explicitly in `vite.config.ts` because the default single-entry build would drop it from the deploy. It renders through `WorldView`, so the ground you sculpt is lit and textured exactly as the game will show it, and it never calls `initRapier`: it edits a document, it does not simulate one.

- `editor/editSession.ts` — the map being edited. The authoritative state is the **centimetre delta**, and metre heights are derived from it, so what you sculpt is exactly what reloads; deriving the other way on save would requantise every cell. Undo snapshots the whole edit state per action (~48 KB at 128², 60 steps) rather than journalling touched cells. `toDoc()` re-stamps `baseChecksum` from the base the session composed against, which is what makes saving a drifted map a rebase.
- `editor/brush.ts` — pure brush geometry (which cells, what weight). `cellCenter` must stay the inverse of `worldToTerrainIndex` or every stroke lands off to one side.
- `editor/tools.ts` — tool ids, defaults, keyboard bindings. The paint palette derives from `SURFACE_INFO` and the object palette from `OBJECT_INFO`, so a new surface or kind appears without anyone remembering to add it. `applyKindDefaults` reseeds the dimension sliders from the kind — one global 1.6 / 2 used to size a traffic cone like a boulder.
- `editor/ghost.ts` — the translucent preview of the object about to be placed, built by the *same* `Obstacles` path as the real thing (a lookalike is the failure mode `worldView.ts` exists to prevent, one layer down). Materials are **cloned** before being made transparent, never mutated. The spec carries the id `EditSession.previewId()` minted for the next placement, because appearance is hashed from the id — a throwaway id previews a different-looking rock from the one that lands.
- `editor/waterLayer.ts` — the authored water of the map being edited: raise / erase / flow brushes, `autoFlowFromSlope`, and the document encode. Its own module because water is **absolute**, not a delta over a generated base, so it shares none of `editSession.ts`'s rebase/checksum/drift rules. The raise brush measures depth once at the *stroke centre* — per-cell would follow the bumps underneath, which is wet ground rather than a body of water. Auto-flow derives from the slope of the **water surface**, not the bed, so a flat pond comes out still.
- `editor/flyCamera.ts` / `pick.ts` / `gizmos.ts` / `dom.ts` / `ui.ts` / `main.ts` — camera, raycasting, brush ring + spawn markers, the panel's DOM vocabulary, the panel, and the wiring. Brush strokes **and gizmo placement** run from the render loop, not from `pointermove`: a brush is a rate, so applying per event made strength depend on the pointer's report rate and holding still did nothing — and a gizmo seated only on pointer events goes stale the moment the fly camera moves, which for the ghost means it visibly hangs in mid-air. The re-raycast is gated on the pointer or camera having actually moved.

Authored maps are committed as `.ts` modules and added to `AUTHORED` in `map/registry.ts` — the editor's "Copy .ts" button emits exactly that module. "Save .json" is the interchange format for round-tripping a work in progress.

- `packages/client/src/startScreen.ts` — the first screen: saved games (`GameSave`, five slots in localStorage) plus audio / control-guide options. Sits in front of `joinScreen.ts`, which it delegates to for a new save.
- `packages/client/src/joinScreen.ts` — name + base-vehicle picker for a new save, and the localStorage codec for the applied build. Persists name + carKind to localStorage; subsequent visits pre-fill the picker. `?auto=1` URL bypass for e2e (`?car=` accepts any `CarKind`). `?preview=1` is the third bypass: it skips the picker *and* the socket entirely and drives the map the editor stashed (see `previewHandoff.ts`). Chat, nameplates and the reconnect HUD are absent in preview without a single suppression check, because they are all wired inside the online path.
- `packages/client/src/playerUI.ts` — the in-world HUD: speed, tacho, gear + transfer-case sticks, damage and engine-status readouts, control guide.
- `packages/client/src/workshop.ts` — the workshop panel: part selection against `VEHICLE_PART_CATALOGS`, live before/after spec comparison, named build slots. Selections are validated by `partCompatibility` client-side and re-validated by `normalizeVehicleBuildDetailed` server-side — **the two state the same three rules separately**, so keep them in step until they are folded into one table.
- `packages/client/src/winchController.ts` / `winchView.ts` — winch input + target picking, and the replicated cable visual.
- `packages/client/src/suspensionVisual.ts` — links, dampers and arms hung off the two axle groups, so articulation reads as mechanism rather than as floating wheels.
- `packages/client/src/vehicleVisualLayout.ts` — build-resolved placement of body fittings, shared by `carMesh.ts` and the asset editor.
- `packages/client/src/chat.ts` — text chat UI (T to open); server relays with rate-limiting + sanitisation in `Room.broadcastChat`.
- `packages/client/src/engineAudio.ts` — RPM-driven engine sound via `AudioContext`.
- `packages/client/src/debugPanel.ts` / `vehicleDebugView.ts` — `?dev` physics lab (the legacy "jack" shortcut remains): live TUNING sliders; owner-only CoG, support polygon, suspension-cast, tire-force and water-force world visuals; tire friction/load/slip, driveline torque, tipping reserve and scrolling G/yaw telemetry; plus multi-run CSV recording with the active tuning values and the copy-to-clipboard serialiser for baking values into constants. The high-rate values come from `VehicleLike.debugTelemetry()` and never enter `VehicleState` or the network snapshot.

### Determinism note

Rapier in single-threaded mode is deterministic given identical inputs and step order. Owner physics is client-only, but determinism still matters for recording, replay and regression tests. Do not introduce non-deterministic state inside `World.step()` or `Vehicle.preStep()/postStep()`.

`packages/server/src/__tests__/owner-determinism.test.ts` enforces this with a “two worlds, same map, same inputs → same state” assertion.

## Conventions

- **Tunables in `constants.ts`.** Magic numbers in physics or networking code are bugs in waiting. Values a tester might twist at runtime are mirrored onto `TUNING`; owner physics reads those values directly. Every `TUNING` field needs a real reader **and** a test asserting the reader responds — the panel has twice grown sliders for fields nothing read (see `solidAxleVehicle.test.ts` and the water multiplier tests in `waterPhysics.test.ts`). `debugPanel.ts`'s slider table reads and writes `TUNING` through get/set closures, so adding a field there is one line — but its copy-to-clipboard **serialiser** is still a hand-written template of the constants block, and that does need updating alongside.
- **Measure the vehicle before authoring terrain for it.** The ford took four attempts because its depths were reasoned from a guessed ride height. The truck actually rests 1.36 m up with its hull bottom at 0.91 m, intakes at 1.36 / 1.56 / 1.65 / 2.41 m by kind, and buoyancy beats weight past 1.77 m — so "deep water" is a 0.4 m band, not a vibe. Print the numbers from a real `World` first.
- **One lookup per concept.** `SURFACE_INFO` (`terrain.ts`) is the model: label, friction key and minimap colour for every `Surface` in one `Record`, so a new surface is a compile error until it's complete. `QUALITY` (`quality.ts`) is the third instance — every device-dependent render decision is a named field there, which is why there is no `if (isMobile)` anywhere in the client. `OBJECT_INFO` (`objectCatalog.ts`) is the second instance, and the cautionary tale: the five object kinds were hand-copied into five places with the compiler checking one, and adding a sixth meant finding the other four from memory. If you find yourself adding a parallel switch keyed on an existing enum, extend the table instead.
- **Deploy:** exactly one workflow publishes to the `github-pages` environment (`deploy.yml`). Two of them raced for a while and the live site was whichever finished last. Don't add a second.
- **Shared types are the wire contract.** When you change `PlayerInput` or `VehicleState`, both client and server pick it up via TypeScript.
- **No comments that restate code.** Comments explain *why*: a constraint, a tradeoff, a workaround.
- **Tests use real components.** Server tests use real Rapier. Browser tests use real Playwright. There is no mocked physics or socket — bugs love mocks.
- **Diagnostic hooks are dev-only.** `window.__scene` is guarded by `import.meta.env.DEV`. Production bundles do not expose it.
- **Branching:** there is no `main`. The repository's default branch is `claude/add-claude-documentation-b6LkY` — the user deploys off it. Feature/review work happens on per-session `claude/...` branches which the user merges into the default branch via PR.
- **No PRs unless asked.**
- **Commit screenshots with each visual milestone** (`packages/e2e/screenshots/` is tracked) so the repo carries a visual changelog alongside the code one.

## Known structural debt

Named here so it stays visible rather than being rediscovered. In rough priority order:

1. **`SolidAxleVehicle.preStep()` is one ~850-line method** (171 locals, 7 levels of nesting) covering support raycasts, ledge contacts, spring/damper, anti-roll, water loads, engine/gearbox, diff locks, incline assist and tyre forces in a single scope. It is the core of the product and the hardest thing in the repo to change safely. Split it into per-phase pure functions with explicit inputs — `axle.ts` and `wheelDynamics.ts` already show the shape — keeping the call order explicit so determinism is unaffected. Do this before the next physics feature, not after.
2. **Part effects are string-suffix tests divorced from the catalog** (`resolveVehicleSpec`). See the `vehicleBuild.ts` entry above.
3. **Build compatibility rules are written twice** — `normalizeVehicleBuildDetailed` enforces them, `partCompatibility` restates them for UI copy. When they drift the workshop offers a part the server then refuses.
4. **`main.ts` (~900 lines)** keeps ~30 module-level `let`s shadowing the last snapshot's HUD fields, plus a ~275-line `start()`. Adding a HUD field costs four edits in one file.
5. **The server pulls Rapier in transitively.** `Room` imports the `Physics` barrel for `geomFor` / `spawnYAboveGround` / `sampleHeightBilinear`, which drags in `world.ts` and its base64 WASM. "The server does not simulate vehicles" is true of behaviour but not of the dependency graph; a Rapier-free spec entry point would make it structurally true.
6. **The full `VehicleBuild` tuple rides every snapshot at 30 Hz** (~18 of ~138 B/player) even though `buildRevision` already signals change and `Scene` already keys off it. Harmless at the current player counts; the first thing to fix if a room ever gets large.

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

The MVP loop is complete: connect → pick a rig → run canonical local physics → upload owner state → see remote trucks through buffered interpolation and collide through local kinematic proxies.

### Shipped
- Mobile graphics tier (`quality.ts`): auto-detected `high`/`low` preset covering pixel ratio, MSAA, shadows, three procedural shaders, a scenery distance cull, particle instancing and the menu panorama rate. Render-only — physics, tick rate and the wire protocol are untouched, and the determinism test still guards that.
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
- Client-owned vehicle physics with fixed-tick render interpolation.
- Local player-collision proxies aligned to rendered remote poses.
- Mountain switchback trail with per-traverse features (whoops, rocky step, mud puddle).
- Multiple roads: north loop (dirt circuit), south bog trail, east gravel connector.
- Procedural sky dome: gradient + warm horizon band + 5-octave FBM clouds + sun disc with glow.
- Physics-driven water: buoyancy, drag, authored current, per-kind engine drowning with a manual restart, depth-tinted surface with flow-scrolled ripples, wheel spray and bow wave, an editor water tool, and a river ford across the main road.
- Physics-driven winching: server-authoritative attachments to strong scenery or vehicle recovery points, load-limited reeling, overload cable failure, replicated cable visuals, HUD/audio feedback, and touch controls.

- Persistent workshop builds: seven fictional bases, nine part slots, paint, lockers, named build slots, server-leased garage bays and a build revision on the wire.
- Vehicle damage (body / engine / steering) with collision and flooding causes, and bullbar-dependent engine protection.
- Selectable transfer case (2H / 4H / 4L) + front/rear lockers, and an H-pattern manual gearbox alongside the automatic.
- Asset designer at `/asset-editor.html`: low-poly modelling over the same procedural vocabulary the game builds from.
- Main-menu live map panorama.
- Protocol-version handshake refusing mismatched client/server builds.
- Single Pages deploy workflow (the scaffold `static.yml` raced it and shipped the raw repo).
- `SURFACE_INFO`: one table replacing three parallel per-surface lookups.
- Production-world test coverage at the shipped 320 m / res-128 geometry.
- Map documents loaded by the relay, owner client and editor, with a revision handshake refusing mismatched bundles.
- Level editor at `/editor.html`: sculpt / smooth / flatten / paint brushes, ground-relative or exact-world-Y object placement, spawn placement, undo, and JSON / `.ts`-module export.
- `OBJECT_INFO`: one catalog replacing five hand-copied kind lists, and 40 placeable objects on top of it (natural, trail, props, markers).
- Placement ghost: a translucent copy of the object under the cursor, aimed with the wheel or `[` / `]`, built by the same mesh path as the real thing.
- Offline preview from the editor: **Preview in game** hands the live document to `/index.html?preview=1` in a new tab, which drives it on the local Rapier sim with no server.

### Content
- Cargo objective: spawn a crate to deliver from A to B; mass affects vehicle handling.
- Multiple truck loadouts (light, heavy, winch-equipped).

### Multiplayer depth
- Lobby / room codes (currently single global room).
- Tune adaptive remote interpolation delay for real-world jitter.
- Voice chat (scoped and shelved — WebRTC P2P + WS signaling is the chosen approach).

### Wire-format optimisation
- ~~Move snapshots to msgpack~~ / ~~quantize positions/quaternions~~ — shipped (see `messages.ts`).
- Binary deltas — only changed players, only changed fields.

### Stretch
- Destructible terrain features (trees, fences) on top of mud-deformation.
- Day/night cycle + headlight illumination.
- Re-enable ruts: needs higher heightfield resolution or a sub-cell visual deformation overlay. Each owner would need the same persistent rut deltas for collision consistency.

## How to add a feature, end to end

1. **Touch types first.** Add fields to `PlayerInput` / `VehicleState` / `WorldSnapshot` in `packages/shared/src/types.ts`. TypeScript will tell you everywhere that needs to change.
2. **Update the simulator.** Modify `SolidAxleVehicle` / `World` / the terrain layers in `packages/shared/src/physics/`.
3. **Tune in constants.** Don't hardcode in step code.
4. **Update the renderer.** `Scene.render()` reads from snapshots — make sure it interpolates new fields correctly. If the field needs to be exposed for HUD/debug/e2e, add a getter alongside `localPosition()` / `localSteer()` / `localAxles()`.
5. **Write a test.** Server-side: `vitest` against the real `World`. Client-side: Playwright if it's user-visible.
6. **Run the gauntlet:** `pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`.
7. **Re-run the screenshot capture** if the change is visual: `pnpm --filter @mydrunner/e2e exec playwright test tests/screenshot.spec.ts`. Commit the new PNGs alongside the code.

## Known limitations / gotchas

- **`@dimforge/rapier3d-compat 0.14` exposes `setWheelRollInfluence` in TypeScript types but the WASM binding throws at runtime.** Don't use it; tune via CoM offset, track width, friction multipliers, and steer rate instead.
- **Rapier heightfield is column-major.** `World.buildTerrain()` transposes our row-major heights before calling `ColliderDesc.heightfield`. If you change the generator's indexing, update the transpose.
- **Single global room.** `Room` is instantiated once in `index.ts`. Sharding requires a `RoomManager` — straightforward but unbuilt.
- **Relay loop is deadline-based `setTimeout` at 30 Hz.** It drops missed broadcasts after a long pause rather than bursting stale snapshots.
- **Owner state is quantized and shape-validated at decode.** The room ignores stale/non-finite direct updates; there is intentionally no anti-cheat simulation.
- **Rapier `compat` build bundles WASM as base64.** This is why `optimizeDeps.exclude` is set in `vite.config.ts`. Don't switch to `@dimforge/rapier3d` (non-compat) without revisiting Vite config.
- **Remote collision proxies use the drawn remote pose.** Do not add a second extrapolation path or collisions will occur away from visible trucks.

## Operating notes

- **Server logs** go to stdout. There is no logger abstraction yet; use `console.log` with a `[mydrunner-server]` prefix to match existing style.
- **Client errors** surface in the browser console. The Playwright smoke test asserts there are zero `pageerror` events — keep that bar.
- **Ports:** server `2567` (env `PORT` overrides), client `5173`. Override server URL on the client with `VITE_SERVER_URL`.
- **Health endpoint:** `GET /health` on the server returns `{ ok, players }`. Used by Playwright's `webServer` probe.

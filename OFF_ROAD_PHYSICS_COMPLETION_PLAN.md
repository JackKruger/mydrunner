# Off-Road Physics Completion Plan

## Verified baseline

- [x] Protocol 16 owner-authoritative rut reconciliation is implemented.
- [x] Exact locked-centre and corrected 2.5:1 LSD solvers are implemented.
- [x] Two-pass beam contact prediction and standard/portal probes are implemented.
- [x] Typecheck, production build, 402 shared tests, 83 server tests, and 240 client tests pass.
- [x] The instrumented 1,200-tick desktop benchmark passes at 1.59 ms p95.
- [ ] Playwright and visual evidence are pending a working Chromium installation.

## Milestone 1: allocation-free physics phases

- [ ] Split `SolidAxleVehicle.preStep()` into fixed-order contact, suspension,
  water, engine, driveline, and tyre/soil phases.
- [ ] Capture chassis pose and velocity once in a preallocated
  `VehicleStepContext`; pass the same capture and reusable scratch state to
  every phase.
- [ ] Remove per-tick arrays, objects, spreads, callbacks, and temporary result
  allocations from marked physics hot loops.
- [ ] Add a TypeScript-AST guard that rejects allocation syntax and allocating
  array helpers inside marked hot-loop methods.
- [ ] Preserve exact serialized determinism and desktop p95 below 2 ms.

## Milestone 2: complete axle reactions

- [ ] Apply the progressive rebound stop during the final 15% of droop.
- [ ] Apply bump/rebound as an internal chassis/beam reaction pair: chassis
  force at the final mount and equal/opposite generalized axle heave/roll
  reaction.
- [ ] Preserve the 0.025 m/tick positional correction and bounded contact-force
  limit.
- [ ] Add unsupported-droop, landing, articulation, alternating 0.6 m step,
  portal-clearance, and angular-momentum regressions.

## Milestone 3: sparse rut GPU ownership

- [ ] Give each non-empty 16x16 rut tile a reusable indexed 17x17 vertex mesh;
  its floor and stencil mask share the geometry.
- [ ] Make prediction, authoritative batches, acceptance, and rejection report
  the exact changed combined-field tiles.
- [ ] Update only dirty tiles and their eight boundary neighbours, mutating
  existing GPU attributes in place and disposing only removed/replaced tiles.
- [ ] Preserve immediate prediction, rollback, deduplication, late-join bytes,
  stencil displacement, feathered fallback, and normal scene occlusion.
- [ ] Test buffer identity reuse, seam updates, disposal, rollback, and
  late-join geometry equality.

## Milestone 4: physical acceptance rigs

- [ ] Add an identical-build six-second split-friction rig for open, LSD, and
  locked modes. Require LSD to beat open by 0.25 m, locked to beat open by
  1 m, and locked to beat LSD by 0.25 m.
- [ ] Add locked-wheel sliding-grip and exact centre/axle angular-momentum
  integration coverage.
- [ ] Add sealed-road low-pressure drag/steering, workshop replacement,
  reconnect, recovery-pressure, equal-load footprint/sinkage, mud-exit
  disturbance release, and remote bogged-pose coverage.
- [ ] Add exact serialized golden fixtures for Ridgeback, Dustback, and a
  prepared Outclaw on road, planar slopes, split friction, mud, and
  corrugations.
- [ ] Keep synthetic fixtures, rather than production routes, as physics gates.

## Milestone 5: browser evidence and closure

- [ ] Install the repository-compatible Playwright Chromium build.
- [ ] Add a CDP 4x CPU-throttled performance test with a test-only timing
  collector and require warmed fixed-step p95 below 4 ms.
- [ ] Run driving, multiplayer, pressure, workshop, and rut reconciliation
  browser scenarios.
- [ ] Refresh default-map screenshots and add crawler articulation, paired
  depressed ruts, vehicle occlusion, portal clearance, and belly-out evidence.
- [ ] Run `pnpm typecheck`, `pnpm test`, `pnpm build`, deterministic/golden
  scenarios, `pnpm benchmark:physics`, Playwright, screenshot capture, and
  `git diff --check`.

## Compatibility rules

- Keep `VehicleState` and the snapshot schema unchanged.
- Keep protocol version 16; no new wire message is required.
- Refine `RutSessionReplica` dirty-coordinate results only as an internal API.
- Expose browser timing only under the E2E query flag.
- Preserve owner-authoritative 60 Hz simulation and the no-assist tyre model.

The roadmap is complete only when every checkbox above is satisfied and the
full verification matrix is green.

# Off-Road Physics Completion Plan

## Verified baseline

- [x] Protocol 16 owner-authoritative rut reconciliation is implemented.
- [x] Exact locked-centre and corrected 2.5:1 LSD solvers are implemented.
- [x] Two-pass beam contact prediction and standard/portal probes are implemented.
- [x] Typecheck, production build, 457 shared tests, 84 server tests, and 269 client tests pass on Node 22.23.0.
- [x] The instrumented 1,200-tick benchmark remains below the documented ~3.2 ms container baseline; the Stage 5 runs are recorded below.
- [ ] Chromium build 1194 is installed and browser execution works, but clean-baseline Playwright closure is blocked by the repeatable workshop-entry relay race and two stale screenshot-route assumptions recorded below.

## Milestone 1: allocation-free physics phases

- [x] Split `SolidAxleVehicle.preStep()` into fixed-order contact, suspension,
  water, engine, driveline, and tyre/soil phases.
- [x] Capture chassis pose and velocity once in a preallocated
  `VehicleStepContext`; pass the same capture and reusable scratch state to
  every phase.
- [x] Remove per-tick arrays, objects, spreads, callbacks, and temporary result
  allocations from marked physics hot loops.
- [x] Add a TypeScript-AST guard that rejects allocation syntax and allocating
  array helpers inside marked hot-loop methods.
- [x] Preserve exact serialized determinism and desktop p95 below 2 ms.

Measured on the container this was completed on (slower than the box the
baseline above was taken on, so read these as before/after, not against the
2 ms bar): owner-tick garbage fell from ~6,770 B/tick to ~4,658 B/tick, a 31%
cut, with benchmark mean 2.27 ms -> 2.27 ms and p95 3.2 ms -> 3.2 ms — the
step is dominated by Rapier WASM calls, so this buys GC headroom rather than
mean throughput. The remaining ~4.7 KB is Rapier's own JS returns, which the
AST guard cannot see and an `out` parameter cannot reach. A five-vehicle,
1,920-tick serialized fingerprint over mixed terrain, water, braking,
lockers, manual gears and pressure changes is bit-exact against the
pre-refactor build.

## Milestone 2: complete axle reactions

- [x] Apply the progressive rebound stop during the final 15% of droop.
- [x] Apply bump/rebound as an internal chassis/beam reaction pair: chassis
  force at the final mount and equal/opposite generalized axle heave/roll
  reaction.
- [x] Preserve the 0.025 m/tick positional correction and bounded contact-force
  limit.
- [x] Add unsupported-droop, landing, articulation, alternating 0.6 m step,
  portal-clearance, and angular-momentum regressions.

`axleRegressions.test.ts` runs these against a real Rapier world rather than
the pure functions, because each is a property of how the contact and
suspension phases compose. The climbing follow-up is now complete through its
four physics stages:

- **Steep heightfield contact is implemented and isolated.** Ordinary and
  moderate heightfield slopes retain volumetric support. Steeper faces enter
  `LEDGE_CONTACT` only after a reachable upper surface is validated. Terrain
  reuses the cylinder cast's witness and reconstructs that contact
  analytically because Rapier 0.14 may return the cast while its follow-up
  `contactShape` returns null. The station metadata remains outside the
  synthetic course, and the existing one-sided 0.6 m prepared-Outclaw
  regression climbs while preserving finite, upright, articulation and
  no-launch assertions.
- **Pressure-dependent edge wrapping is implemented.** Low pressure increases
  ledge edge advance and transmitted tread impulse; high pressure reduces
  both. Focused tests pin the pressure ordering and the live tuning reader.
- **Anti-roll behavior is corrected and 4L disconnects only the front bar.**
  The more-compressed wheel end gains support and the opposite end loses the
  equal paired amount. In 4L the front share scales to zero while the rear bar
  is unchanged.
- **The 0.9 m belly diagnosis is closed without a chassis tune.** At the stable
  0.45-throttle stall, wheel ledge contacts and front axle tube/housing probes
  stop the crawler before any chassis manifold occurs. There are zero chassis
  contact ticks, points or impulses, so there is no belly snag or slider
  behavior to correct.
- **Angular momentum is covered in three places, not one.** The internal
  impulse pair is pinned per-axle in `travelStops.test.ts`, the driveline
  carriers in `differential.test.ts` (milestone 4), and the vehicle-level
  claim — an internal travel stop must not accelerate the chassis that
  already owns the beam's mass — by the free-fall test here.

Each of the five was verified by mutation: removing the travel-stop support
gate, pinning the corrected beam roll to zero, feeding the beam averaged
left/right depths, quartering the wheel-end ride force, and deleting the
portal housing lift each fail at least one test. The portal case is why the
assertion is a near-zero contact count rather than "fewer than standard" —
the weaker form passed with the lift deleted, because the smaller portal
probe alone still beats a standard axle.

### Post-Stage-4 ledge rebaseline

The isolated fixture was swept with the prepared Outclaw, nominal 18 psi,
4L, and either both axle lockers open or both engaged. Each run had ten
seconds available. Success means the existing upper-surface clearance
threshold (`z > -5.5`) was reached while the state remained finite,
`upY > 0.8`, both axle rolls stayed within their articulation limits, and
the chassis-height no-launch bound stayed below 3 m. `P` is a safe pass;
`U` reached the upper surface but failed that safety envelope.

Unlocked coarse matrix:

| Height (m) | 0.25 | 0.45 | 0.70 | 1.00 |
| ---: | :---: | :---: | :---: | :---: |
| 0.50 | P | P | P | P |
| 0.55 | P | P | P | P |
| 0.60 | P | P | P | P |
| 0.65 | P | P | P | P |
| 0.70 | P | P | P | P |
| 0.75 | P | P | P | P |
| 0.80 | P | P | P | P |
| 0.85 | P | P | P | P |
| 0.90 | P | P | P | P |

Locked coarse matrix:

| Height (m) | 0.25 | 0.45 | 0.70 | 1.00 |
| ---: | :---: | :---: | :---: | :---: |
| 0.50 | P | P | P | P |
| 0.55 | P | P | U | U |
| 0.60 | P | U | U | U |
| 0.65 | P | U | U | U |
| 0.70 | U | U | U | U |
| 0.75 | U | U | U | U |
| 0.80 | U | U | U | U |
| 0.85 | U | U | U | U |
| 0.90 | U | U | U | U |

The 0.01 m refinements put the highest safe locked results at 0.68, 0.56,
0.54 and 0.51 m for throttles 0.25, 0.45, 0.70 and 1.00 respectively:

| Locker state | Throttle | Refined samples above last coarse pass | Highest safe height |
| --- | ---: | --- | ---: |
| Open | 0.25 | sweep limit reached | at least 0.90 m |
| Open | 0.45 | sweep limit reached | at least 0.90 m |
| Open | 0.70 | sweep limit reached | at least 0.90 m |
| Open | 1.00 | sweep limit reached | at least 0.90 m |
| Both locked | 0.25 | 0.66 P, 0.67 P, 0.68 P, 0.69 U | 0.68 m |
| Both locked | 0.45 | 0.56 P, 0.57 U, 0.58 U, 0.59 U | 0.56 m |
| Both locked | 0.70 | 0.51 P, 0.52 P, 0.53 P, 0.54 P | 0.54 m |
| Both locked | 1.00 | 0.51 P, 0.52 U, 0.53 U, 0.54 U | 0.51 m |

The unlocked ceiling lies above the requested 0.90 m sweep limit; this run
does not claim a higher unmeasured number. Locking both axles lowers the safe
boundary because the upright gate, not upper-surface reach, becomes limiting
as throttle and face height rise.

## Milestone 3: sparse rut GPU ownership

- [x] Give each non-empty 16x16 rut tile a reusable indexed 17x17 vertex mesh;
  its floor and stencil mask share the geometry.
- [x] Make prediction, authoritative batches, acceptance, and rejection report
  the exact changed combined-field tiles.
- [x] Update only dirty tiles and their eight boundary neighbours, mutating
  existing GPU attributes in place and disposing only removed/replaced tiles.
- [x] Preserve immediate prediction, rollback, deduplication, late-join bytes,
  stencil displacement, feathered fallback, and normal scene occlusion.
- [x] Test buffer identity reuse, seam updates, disposal, rollback, and
  late-join geometry equality.

## Milestone 4: physical acceptance rigs

- [x] Add an identical-build six-second split-friction rig for open, LSD, and
  locked modes. Require LSD to beat open by 0.25 m, locked to beat open by
  1 m, and locked to beat LSD by 0.25 m.
- [x] Add locked-wheel sliding-grip and exact centre/axle angular-momentum
  integration coverage.
- [ ] Add sealed-road low-pressure drag/steering, workshop replacement,
  reconnect, recovery-pressure, equal-load footprint/sinkage, mud-exit
  disturbance release, and remote bogged-pose coverage.
- [x] Add exact serialized golden fixtures for Ridgeback, Dustback, and a
  prepared Outclaw on road, planar slopes, split friction, mud, and
  corrugations. All 15 match byte-for-byte on Node 22.23.0.
- [x] Keep synthetic fixtures, rather than production routes, as physics gates.

## Milestone 5: browser evidence and closure

- [x] Install the repository-compatible Playwright Chromium build.
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

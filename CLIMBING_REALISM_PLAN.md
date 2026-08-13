> Status: Stage 0 complete on the authoritative Node 22 runtime. Stage 1 was
> attempted on 2026-08-13 and stopped at its explicit no-scope-expansion
> condition: the two proposed geometry changes did not produce heightfield
> ledge contacts or meet the safety/golden acceptance bars. Stages 2–4 remain
> pending.

# Make tall obstacles climbable, the way a real crawler climbs them

## Current stage checklist

- [x] Stage 0 — lock Node 22 and verify all 15 exact golden fixtures.
- [ ] Stage 1 — redesign heightfield ledge contact and isolate the 0.6 m rig.
  The original two-line geometry proposal was attempted and reverted; see the
  measured blocker below.
- [ ] Stage 2 — pressure-dependent tread wrapping.
- [ ] Stage 3 — low-range sway-bar disconnect.
- [ ] Stage 4 — belly and slider diagnosis.
- [ ] Stage 5 — final rebaseline and documentation after the physics stages.

## Context

Writing the Milestone 2 regressions turned up that a prepared Outclaw (40-inch
tyres, 0.508 m radius, portal axles) cannot climb a **one-sided** 0.6 m terrain
face at any throttle or locker setting. A sweep put the ceiling between 0.45 m
(climbs, but only at 0.7 throttle) and 0.50 m (never climbs) — it tracks the
wheel radius. In reality that is an ordinary line for this kind of vehicle, so
the sim is under-modelling, and the current test asserts the stall as correct
behaviour.

Reading the contact path found the mechanism. In `phaseContact`:

```ts
let ledge = w.volumeSupport ? null : findSteepWheelContactInto(...)
```

`volumeSupport` is set only when the tyre shape-cast hits the **terrain**
collider, and `SUSPENSION.terrainSupportMinNormalY` is 0.05 — so almost any
terrain face, up to nearly vertical, counts as ordinary support and skips the
ledge system entirely. The consequence is an asymmetry: an authored rock gets
a validated `climbDirection`, the `LEDGE_CONTACT.tractionMultiplier` of 1.5
representing tread hooking a corner, and the `edgeAdvance` aim-over-the-edge;
an identically shaped piece of *terrain* gets none of it and must climb on
plain friction against a normal that needs μ ≥ tan(52°) ≈ 1.28 merely to hold
station.

That gate is deliberate — its comment explains it stops the slow ledge handoff
from overriding exact terrain support and leaving the visible axle behind the
ground. So it gets narrowed, not deleted.

Three further realism gaps sit alongside it, all of which real crawlers rely on
and the sim currently ignores:

- **Tyre pressure does nothing on a ledge.** The ledge traction path uses a
  fixed 1.5 multiplier and a fixed 0.08 m `edgeAdvance`. Airing down to climb
  a ledge is the single most common real technique, and the game already has
  full pressure controls that are inert here.
- **The anti-roll bar always fights articulation.** On a one-sided obstacle
  `computeAntiRollLoadTransfer` moves load *off* the climbing wheel. Real rock
  crawlers disconnect the front bar for exactly this.
- **Belly/slider behaviour is unverified.** The chassis collider exists at
  friction 0.1 (already skid-plate slippery), but nothing confirms whether it
  is contacting during a stalled climb or whether pivoting on it is possible.

The user has accepted a sim-wide behaviour change, so the shipped map's feel
will move and some physics tests will need re-baselining.

## Stage 0 — Golden fixtures first

Capture serialized goldens *before* touching physics, so every later stage
shows a reviewable diff rather than a silent drift. This also closes an open
Milestone 4 box ("exact serialized golden fixtures for Ridgeback, Dustback and
a prepared Outclaw").

- New `packages/shared/src/__tests__/golden/` fixtures plus a
  `physicsGolden.test.ts` runner. Model it on the ad-hoc harness used for the
  phase-split refactor: drive each build over mixed terrain, water, braking,
  lockers, manual gears and pressure changes; dump full `getState()` plus
  per-wheel `debugTelemetry()` at 17 significant digits every 20 ticks.
- Provide an `UPDATE_GOLDEN=1` env path to rewrite them, so each later stage
  regenerates deliberately and the diff is read before committing.

## Stage 1 — Steep-terrain climb parity

The core fix.

- **`solidAxleVehicle.ts`, `phaseContact`:** narrow the gate so volume support
  only suppresses the ledge query when it is genuinely *upward* support:
  skip the ledge path when `w.volumeSupport && w.contactNormal.y >=
  LEDGE_CONTACT.maxSupportNormalY`, otherwise run
  `findSteepWheelContactInto`. Ordinary and moderate terrain keeps today's
  exact volume support and today's numbers; only faces past ~49° gain the
  climb assist.
- **`wheelContact.ts`, `findClimbTargetInto`:** the top probe uses
  `probeInset = Math.max(0.04, prediction * 2)` = 0.04 m. On a heightfield
  whose cells are ~0.47 m that lands back on the same face, no upper surface
  is found, and the climb target is refused. Scale the inset with wheel radius
  (a new `LEDGE_CONTACT.probeInsetRadiusFraction`, ~0.25) so the probe clears
  the face for large tyres.
- Watch for double-counted normal load where a wheel now has both support and
  ledge contact. The rock path already handles that coexistence — reuse it,
  do not add a second branch.

### Stage 1 attempt — measured blocker

The original `axleRegressions.test.ts` course is not an isolated terrain rig.
At its `{ x: 0, z: -12 }` start, the prepared Outclaw first meets the petrol
station sign pole at approximately `{ x: -1, z: -11 }`. Instrumentation
identified the supposed ledge as a friction-0.7 collider with a top at 0 m,
not the friction-1 terrain heightfield. With the proposed gate and probe inset
applied, that contaminated run still advanced only 1.055 m.

Moving only the synthetic world's station metadata out of the course exposed
the terrain result: 20.755 m progress, chassis height below 2.148 m, axle roll
from -0.066 to +0.151 rad, but a minimum chassis-up value of 0.793. More
importantly, 260 ticks reported steep terrain volume support and zero reported
a validated ledge contact. Rapier 0.14's heightfield cylinder shape cast can
return a hit while the follow-up `contactShape` reconstruction used by
`findSteepWheelContactInto` returns null, so the radius-scaled top probe is
never reached for this terrain path.

The narrowed gate also changed the existing prepared-Outclaw road and
corrugation goldens, which are required to remain byte-identical. No fixtures
were regenerated. Completing Stage 1 therefore needs a separately approved
heightfield-contact design (and an isolated acceptance fixture), not force,
traction, pressure, sway-bar, or handoff tuning.

## Stage 2 — Pressure-dependent tread wrap

- **`tireCarcass.ts`:** add `pressureEdgeWrapScale(pressurePsi, nominalPsi)`
  beside the existing `pressureRadialScale` / `pressureRollingScale` /
  `pressureLateralScale` / `sealedRoadPressureGripScale`, returning >1 below
  nominal and <1 above, bounded like its siblings.
- Apply it in two places: `edgeAdvance` (a softer tyre wraps further over the
  corner) and the ledge `surfMult` in `phaseTyreSoil`, which currently reads
  `clamp(ledge.friction, 0, 2) * LEDGE_CONTACT.tractionMultiplier *
  treadFraction`.
- Mirror onto `TUNING` as `tireEdgeWrapMult`. Per the repo convention, every
  `TUNING` field needs a real reader **and** a test asserting the reader
  responds; also add the debug-panel slider and update its hand-written
  copy-to-clipboard serialiser.

## Stage 3 — Sway bar disconnect in low range

- **`constants.ts`:** `ANTI_ROLL.lowRangeFrontDisconnect` (front bar share
  scale, 0 for a true disconnect).
- **`solidAxleVehicle.ts`, `phaseSuspension`:** where `frontBarShare` and
  `barShare` are computed, scale the front bar down when
  `this.drivetrain.transferCase === '4l'`.
- Deriving it from the transfer case rather than a new persisted option is
  deliberate: `transferCase` is already on the wire, so this needs **no
  `SNAPSHOT_SCHEMA` or `PROTOCOL_VERSION` bump**. A workshop part with its own
  button is the natural follow-up, but it costs a wire-tuple change because
  `VEHICLE_PART_SLOTS` is what the positional build tuple walks.

## Stage 4 — Belly and slider contact (measure, then decide)

Unlike the others this has no confirmed defect yet, so it is diagnosis first:

- Instrument a stalled climb and record whether `chassis` contact manifolds
  fire at all (the machinery is already in `postStep`, which walks
  `contactPairsWith` for damage).
- If the belly never contacts, the obstacle stops the wheels before the
  chassis reaches it and there is nothing to fix — say so and stop.
- If it contacts and snags, the likely lever is collider shape rather than
  friction, which at 0.1 is already slider-like. Design only after the
  measurement; do not pre-commit to a change here.

## Stage 5 — Re-baseline and document

- **Flip the 0.6 m expectation** in `axleRegressions.test.ts`: it should now
  climb. Keep the upright/no-launch assertions — they are the ones guarding
  the failure mode the volumetric query exists to prevent. Rewrite the long
  comment, which currently explains a stall that will no longer happen.
- Re-sweep height × throttle and record the new ceiling in
  `OFF_ROAD_PHYSICS_COMPLETION_PLAN.md`, replacing the current note.
- Update `CLAUDE.md`: the `LEDGE_CONTACT` / steep-face description, the tyre
  pressure entry (pressure now affects climbing), and `ANTI_ROLL`.

## Verification

- `pnpm typecheck && pnpm test && pnpm build` — expect deliberate golden and
  physics-test updates; review every changed expectation rather than
  regenerating blind.
- `pnpm benchmark:physics` — **the main performance risk.** Stage 1 makes
  `findSteepWheelContactInto` run on steep terrain, adding a broadphase plus
  narrowphase query per wheel in those situations. Baseline on this container
  is mean ~2.27 ms / p95 ~3.2 ms; a material rise means the gate is too loose.
- `pnpm test:e2e`, then `pnpm --filter @mydrunner/e2e exec playwright test
  tests/screenshot.spec.ts` and commit the PNGs — this is a visual change.
- Mutation-check the new tests the same way the axle regressions were checked:
  revert each stage's core line and confirm at least one test fails.
- Manual: author a one-sided 0.6 m ledge in `/editor.html`, drive it via
  `?preview=1`, and confirm it climbs with a believable pitch/articulation
  rather than snapping over the edge.

## Risks

- **Steep faces are everywhere on the shipped map.** The mountain trail and
  rocky climb corridor will change feel. The normal.y gate keeps ordinary
  slopes untouched, but the trail is the thing to drive before calling it done.
- **Handoff instability.** The ledge system's `depthCatchupRate` handoff was
  written for discrete rock faces; applying it to continuous terrain may show
  up as axle judder on long steep slopes. If so, prefer gating on face
  steepness *and* a bounded face height over widening the catch-up rate.

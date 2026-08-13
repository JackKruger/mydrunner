> Status: All five stages are complete on the authoritative Node 22 runtime.
> Stage 5 rebaselined and documented the post-Stage-4 behavior; the known
> clean-baseline browser/screenshot failures and headless manual-drive
> limitations are retained below as follow-up evidence rather than blockers.

# Make tall obstacles climbable, the way a real crawler climbs them

## Current stage checklist

- [x] Stage 0 — lock Node 22 and verify all 15 exact golden fixtures.
- [x] Stage 1 — redesign heightfield ledge contact and isolate the 0.6 m rig.
- [x] Stage 2 — pressure-dependent tread wrapping.
- [x] Stage 3 — low-range sway-bar disconnect.
- [x] Stage 4 — belly and slider diagnosis.
- [x] Stage 5 — final rebaseline and documentation.

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
- **The anti-roll bar needs separate correctness and disconnect checks.** The
  interstage diagnosis found that its stiffness term had the wrong global
  force direction; Stage 3 remains the distinct low-range disconnect feature.
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

### Stage 1 completion after the measured blocker

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

The completed design reuses the heightfield cast's witness and reconstructs a
validated tread climb target directly instead of relying on Rapier's failing
`contactShape` reconstruction. The synthetic station remains outside the test
course. The isolated prepared Outclaw now crosses the one-sided 0.6 m ledge,
while the repeated 0.35 m course retains alternating-articulation coverage and
the hot contact path remains allocation-free.

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

Stage 2 is complete: low, nominal and high pressure now change the physical
wrap distance and ledge traction, with focused pressure, ledge, flat-terrain
invariance and live-tuning coverage.

## Interstage diagnosis — flat-road turning wheel tramp

After Stages 1–2, a separate Stockman Single rig exposed violent axle motion
on a flat sealed road despite continuous tread-only contact. The deterministic
script settles for 180 ticks, starts at 8 m/s, then holds 0.25 throttle and full
input through the normal progressive/speed-limited steering path for 240 ticks.

Owner-only telemetry was extended with axle ride/roll velocities, exact paired
anti-roll forces and wheel-centre vertical velocity. With the old production
sign, the low/nominal/high-pressure runs recorded 50/31/29 near-zero-load
entries in four seconds, large alternating tyre loads and elevated roll/lateral
acceleration. They recorded zero shoulder/sidewall samples, zero ledge handoffs
and zero tread-contact losses, ruling out the Stage 1–2 contact paths.

`computeAntiRollLoadTransfer` gave the stiffness term the opposite force
direction to its damping term: a more-compressed end lost support, amplifying
articulation. The global sign correction now adds support to that end and
removes the equal amount from the other. All three pressure runs have zero
near-zero-load entries after steering settles, no contact or handoff losses and
`minUpY > 0.997`. The approved trajectory change deliberately rebaselines all
15 exact goldens. This was a correctness fix only; at that point Stage 3's
low-range front-bar disconnect remained pending, with no new force, grip,
rollover or handoff tune.

## Stage 3 — Sway bar disconnect in low range

Complete. This remains separate from the interstage force-direction correction.

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

The front share is now scaled to zero only in 4L, leaving the rear bar and all
existing anti-roll calculation, gating, capping and force application intact.
A paired real-vehicle articulation regression pins the immediate 4H/4L force
relationship and verifies that sustained 4L articulation retains more travel
and load at the drooped front end without unstable chassis or axle motion.

## Stage 4 — Belly and slider contact (measure, then decide)

Complete. A deterministic real-vehicle diagnostic reuses the isolated
one-sided heightfield and prepared Outclaw from the climbing regressions, but
raises the face to 0.9 m so the truck reaches a sustained stall. At 0.45
throttle in 4L it advanced 3.0648 m over ten seconds, then only 0.0106 m in
the final second. All four wheels retained support for all 600 driven ticks;
the two front wheels retained ledge contact for 402 and 436 ticks, while the
front axle tube/housing probes reported contact for 399 and 403 ticks.

The existing `postStep`/damage manifold path reported zero chassis manifold
ticks, zero chassis contact points and zero accumulated or peak chassis
impulse. Two repeated measurement runs produced identical results. The truck
remained finite and upright (`min upY = 0.9387`), stayed within articulation
and the existing 45 kN suspension/ledge and 8 kN ledge-drive caps, and settled
to less than 0.05 m/s linear and 0.05 rad/s angular speed. The running gear
therefore stops at the face before the belly reaches it; the chassis is not
snagging and there is no slider behavior to correct. Stage 4 adds only the
focused regression and makes no production-physics or golden-fixture change.

## Stage 5 — Re-baseline and document

Measurement and documentation are complete. The existing isolated 0.6 m
regression was already in its intended post-Stage-1 form: it requires a safe
climb and retains finite, upright, articulation and no-launch checks. Its
comment describes the isolated fixture accurately, so neither the test nor
its comment changed.

The full nominal-pressure, 4L, 0.50–0.90 m by throttle sweep and its 0.01 m
refinements are recorded in `OFF_ROAD_PHYSICS_COMPLETION_PLAN.md`. With both
axle lockers open, every throttle safely cleared the 0.90 m top of the
requested range, so the actual unlocked ceiling was not reached. With both
lockers engaged, the highest safe heights were 0.68, 0.56, 0.54 and 0.51 m at
0.25, 0.45, 0.70 and 1.00 throttle. Those locked runs still reached the upper
surface above the safe boundary; the upright/no-launch envelope rejected
them. `CLAUDE.md` now documents ordinary versus steep heightfield contact,
heightfield witness reconstruction, pressure edge wrapping, corrected
anti-roll direction, the 4L-only front disconnect and the 0.9 m no-belly
conclusion.

Stage 5 and the overall five-stage climbing effort are complete. The measured
physics, focused and full regression suites, exact goldens, typecheck, build,
and repository-diff checks all pass. The repeatable clean-baseline browser
failures and the limits of headless straight-line manual driving remain
documented below for follow-up; neither is caused by the climbing physics/doc
diff.

## Stage 5 verification evidence

- The six focused files pass together: 46/46 tests, including all 15 exact
  golden scenarios. `pnpm typecheck`, `pnpm test` (457 shared, 84 server, 269
  client) and `pnpm build` pass on Node 22.23.0. The server suite needed the
  expected localhost socket permission; no test was modified.
- Three sequential benchmark runs measured mean/p95 of 1.345/1.861 ms,
  1.313/1.807 ms and 1.408/2.069 ms. All p95 values are below the documented
  ~3.2 ms container baseline, but the third exceeded the benchmark script's
  stricter 2.0 ms exit threshold. A later isolated confirmation passed at
  1.411/1.980 ms. The outlier is retained as a failed invocation rather than
  hidden.
- Chromium build 1194 was installed successfully. The full non-screenshot
  Playwright run passed 30/31 tests. The remaining Dustback workshop test
  failed twice before its assertions: its local teleport makes the bay prompt
  visible, then F is sent before that pose reaches the 30 Hz server relay, so
  no workshop overlay opens. The adjacent multiplayer workshop flow passes.
  This pre-existing synchronization race is outside the allowed Stage 5 test
  scope.
- The explicit screenshot file passed its drive and garage captures but failed
  the ford and motorbike routes: both timed out before reaching their expected
  water/flood states. All 11 PNGs touched by browser runs were hash-compared
  and visually inspected. They were timing/path recaptures, not reviewed
  Stage 5 visual changes, and were restored; no screenshot or golden changed.
- A temporary headless browser harness authored a 0.6 m one-sided ledge in
  `/editor.html` at the fixture's 0.47 m cell spacing and previewed the
  prepared Outclaw at nominal 18 psi in 4L. It cleared with 9 ledge-contact
  physics ticks, finite state, `minUpY = 0.955`, maximum axle roll 0.052 rad
  and no snap/launch. The harness and captures were removed afterward.
- Headless straight-line route checks are not a substitute for a driver
  choosing a line. The lower mountain connector run reached a water crossing,
  flooded and rolled back; the bounded T4 run observed 27 ledge-contact and 26
  front-axle-probe ticks but rolled after the rocky contact. Those captures
  were temporary. An interactive browser drive remains the follow-up for a
  qualitative handoff/judder and general-feel assessment.

## Risks

- **Steep faces are everywhere on the shipped map.** The mountain trail and
  rocky climb corridor will change feel. The normal.y gate keeps ordinary
  slopes untouched, and the trail remains the highest-value interactive
  follow-up drive.
- **Handoff instability.** The ledge system's `depthCatchupRate` handoff was
  written for discrete rock faces; applying it to continuous terrain may show
  up as axle judder on long steep slopes. If so, prefer gating on face
  steepness *and* a bounded face height over widening the catch-up rate.

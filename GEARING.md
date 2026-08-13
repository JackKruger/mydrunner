# Gearing and RPM review

This note records how the current drivetrain model works and the assumptions to
keep in mind when tuning it. The authoritative implementation is
`packages/shared/src/physics/engine.ts`; vehicle-specific ratios are resolved in
`vehicleBuild.ts` and supplied by `solidAxleVehicle.ts`.

## Ratio path

Engine torque reaches the wheels through:

```text
wheel torque = engine torque × gearbox ratio × effective final drive
effective final drive = 4.1 × vehicle final-drive multiplier × range multiplier
```

High range has a range multiplier of `1`. Selecting 4L applies the vehicle's
`lowRangeRatio` (normally `2.65`, or `3.35` for the Outclaw). Low range therefore
multiplies wheel torque and engine RPM at a given road speed by the same amount;
it does not add engine power. The Dustback has a `0.78` final-drive multiplier
and is fixed to high-range RWD.

The gearbox table is:

| Display | Ratio |
| --- | ---: |
| R | -2.50 |
| N | 0 |
| 1 | 4.00 |
| 2 | 2.30 |
| 3 | 1.50 |
| 4 | 1.05 |
| 5 | 0.60 |

Negative reverse ratio changes torque direction. Everywhere a ratio is used to
calculate RPM, its absolute value is used.

## RPM calculation

Wheel speed is converted to locked engine speed as:

```text
wheel RPM = abs(driven carrier rad/s) × 60 / (2π)
locked engine RPM = wheel RPM × abs(gear ratio) × effective final drive
```

The driven carrier is the mean wheel speed for the driven axle(s). In 4WD it is
the mean of the front and rear carriers; in 2H it is rear-only. This makes the
tachometer reflect driveline speed rather than one spinning wheel.

The coupling is deliberately softened below `8 rad/s` carrier speed to stand in
for an automatic torque converter. At rest, RPM moves toward a throttle target
between idle (`850 RPM`) and peak torque (`3500 RPM`). By `8 rad/s`, RPM is fully
locked to wheel speed. RPM is smoothed with an approximately 125 ms time
constant, clamped to at least idle while running, and capped at `6600 RPM`.

Neutral instead free-revs between idle and the `5800 RPM` redline. A flooded or
collision-stopped engine is a special case: it produces no torque and winds
down toward zero.

## Automatic shifting

Automatic shifts use **chassis forward speed**, converted to an equivalent
wheel angular speed using the selected tyre radius. They intentionally do not
use actual driven-wheel speed: wheelspin in mud would otherwise cause repeated
upshifts and downshifts while the truck remained stuck.

- Upshift above `3500 RPM` equivalent road speed.
- Downshift below `1700 RPM` equivalent road speed.
- Hold the selected gear for 90 physics ticks (1.5 seconds at 60 Hz) after an
  RPM-triggered shift.
- Positive throttle selects first from neutral/reverse; negative throttle
  selects reverse. Direction changes are allowed while rolling so the selected
  driveline opposes the unwanted motion.

Low range and tyre diameter both affect the road speeds corresponding to these
thresholds. Larger tyres raise the shift road speed; the low-range multiplier
lowers it.

Manual selection bypasses automatic shifts. In manual mode the input layer
treats reverse input as braking, while the selected gear provides direction.

## Torque and engine braking

The engine has a bell-shaped torque curve with a nominal `290 N·m` peak at
`3500 RPM` and a soft limiter beyond redline. Throttle torque is multiplied by
the active gearbox and final-drive ratios, then by the vehicle power and engine
health multipliers before it is split across the driven axles and wheel-side
differentials.

Off throttle, engine braking combines an RPM-dependent term with a
chassis-speed term. The second term prevents high-gear downhill coasting from
running away when the low top-gear ratio would otherwise produce little
compression braking. Its sign follows actual wheel travel, not the selected
gear, so it opposes rollback on a hill.

## Review findings and tuning cautions

1. **The model is internally consistent about effective gearing.** The same
   final-drive value, including build and low-range multipliers, feeds RPM,
   shift thresholds, and drive torque.
2. **Wheelspin is correctly isolated from automatic shift decisions.** It still
   raises displayed RPM once the converter is locked, as expected, but cannot
   by itself command an upshift.
3. **This is a game automatic, not a clutch simulation.** Gear changes are
   instantaneous and there is no shift torque interruption. The low-speed blend
   is the only torque-converter approximation.
4. **RPM is smoothed state, not a rigid kinematic invariant.** For a short time
   after a shift it can differ from the value implied by the current wheel speed.
   This is intentional for stable audio. Road-speed-triggered automatic shifts
   retarget RPM to the selected ratio on the same tick; engaging drive or reverse
   from neutral retains one tick of converter flare to preserve the tuned launch
   transient.
5. **Tune ratios and shift thresholds together.** A ratio change affects wheel
   torque, locked RPM, theoretical speed, and the road speed of both shift
   thresholds. Any such change should be checked in high and low range, with
   stock and largest tyres, and under wheelspin.

// Fixed-timestep accumulator (Glenn Fiedler "Fix Your Timestep").
// Caller supplies a step() callback; runner drains accumulated time in
// FIXED_DT chunks. Returns alpha [0,1] for render interpolation.

export interface FixedStepRunner {
  /** Advance the accumulator by `frameDt` seconds and run as many fixed
   *  steps as fit. Returns interpolation alpha for the leftover time. */
  advance(frameDt: number): number;
  /** Total fixed steps executed since construction. */
  readonly tick: number;
}

export function createFixedStep(
  fixedDt: number,
  step: (dt: number, tick: number) => void,
  opts: { maxStepsPerFrame?: number } = {},
): FixedStepRunner {
  const maxSteps = opts.maxStepsPerFrame ?? 5;
  let acc = 0;
  let tick = 0;

  return {
    advance(frameDt: number): number {
      // Clamp huge stalls (tab switch, GC) so we don't spiral.
      if (frameDt > 0.25) frameDt = 0.25;
      acc += frameDt;
      let steps = 0;
      while (acc >= fixedDt && steps < maxSteps) {
        step(fixedDt, tick);
        tick += 1;
        acc -= fixedDt;
        steps += 1;
      }
      // If we hit the cap, drop the remaining accumulated time so we don't
      // permanently lag behind real time.
      if (steps >= maxSteps) acc = 0;
      return acc / fixedDt;
    },
    get tick() {
      return tick;
    },
  };
}

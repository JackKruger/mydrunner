import { describe, expect, it } from 'vitest';
import { estimateContactArea, stepSoftGround, type SoftGroundState } from '../physics/soil.js';
import { TUNING } from '../tuning.js';

function state(): SoftGroundState {
  return { sinkDepth: 0, slipDisplacement: 0, soilCompaction: 0, bulldozingResistance: 0, slipWork: 0 };
}

describe('soft ground', () => {
  it('gives low-pressure and wide tyres a larger footprint', () => {
    const narrowHigh = estimateContactArea(4_000, 34, 0.25, 0.4);
    const wideLow = estimateContactArea(4_000, 12, 0.42, 0.4);
    expect(wideLow).toBeGreaterThan(narrowHigh);
  });

  it('sinks a low-pressure tyre less at equal load and zero slip work', () => {
    const high = state();
    const low = state();
    for (let i = 0; i < 240; i++) {
      stepSoftGround(high, 'deep-mud', 4_000, 34, 0.35, 0.45, 0, 0, 1 / 60);
      stepSoftGround(low, 'deep-mud', 4_000, 12, 0.35, 0.45, 0, 0, 1 / 60);
    }
    expect(low.sinkDepth).toBeLessThan(high.sinkDepth);
  });

  it('wheelspin progressively digs and raises bulldozing resistance', () => {
    const soft = state();
    let first = 0;
    for (let i = 0; i < 240; i++) {
      const result = stepSoftGround(soft, 'deep-mud', 4_000, 24, 0.35, 0.45, 0.8, 1, 1 / 60);
      if (i === 30) first = result.bulldozingForce;
    }
    expect(soft.sinkDepth).toBeGreaterThan(0);
    expect(soft.sinkDepth).toBeLessThanOrEqual(0.38);
    expect(soft.bulldozingResistance).toBeGreaterThan(first);
  });

  it('clears local disturbance and releases sink after leaving mud', () => {
    const soft = state();
    for (let i = 0; i < 60; i++) stepSoftGround(soft, 'mud', 4_000, 24, 0.35, 0.45, 1, 1, 1 / 60);
    const sunk = soft.sinkDepth;
    stepSoftGround(soft, 'none', 0, 24, 0.35, 0.45, 0, 0, 1 / 60);
    expect(soft.slipWork).toBe(0);
    expect(soft.sinkDepth).toBeLessThan(sunk);
  });

  it('applies the live sink, bearing, shear, and bulldozing multipliers', () => {
    const saved = {
      sink: TUNING.soilSinkDepthMult,
      bearing: TUNING.soilBearingStrengthMult,
      shear: TUNING.soilShearGripMult,
      bulldozing: TUNING.soilBulldozingDragMult,
    };
    try {
      TUNING.soilSinkDepthMult = 0.5;
      TUNING.soilBearingStrengthMult = 0.5;
      TUNING.soilShearGripMult = 0.5;
      TUNING.soilBulldozingDragMult = 0.25;
      const soft = state();
      let result = stepSoftGround(soft, 'deep-mud', 4_000, 24, 0.35, 0.45, 1, 1, 1 / 60);
      for (let i = 0; i < 239; i++) {
        result = stepSoftGround(soft, 'deep-mud', 4_000, 24, 0.35, 0.45, 1, 1, 1 / 60);
      }
      expect(result.targetSinkDepth).toBeLessThanOrEqual(0.19);
      expect(result.shearMultiplier).toBeLessThan(0.75);
      expect(result.bulldozingForce).toBeGreaterThan(0);
    } finally {
      TUNING.soilSinkDepthMult = saved.sink;
      TUNING.soilBearingStrengthMult = saved.bearing;
      TUNING.soilShearGripMult = saved.shear;
      TUNING.soilBulldozingDragMult = saved.bulldozing;
    }
  });
});

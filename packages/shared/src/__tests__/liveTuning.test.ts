import { afterEach, describe, expect, it } from 'vitest';
import { CAMERA, DRIVELINE, ENGINE, LOW_RANGE, WATER } from '../constants.js';
import { wetGripMult } from '../physics/water.js';
import { TUNING } from '../tuning.js';

const defaultWetGripFloor = TUNING.waterWheelGripFloor;

afterEach(() => {
  TUNING.waterWheelGripFloor = defaultWetGripFloor;
});

describe('extended live tuning defaults', () => {
  it('reproduces the shipped drivetrain, water, soil, and camera constants', () => {
    expect(TUNING.engineShiftUpRpm).toBe(ENGINE.shiftUpRpm);
    expect(TUNING.engineShiftDownRpm).toBe(ENGINE.shiftDownRpm);
    expect(TUNING.engineShiftHoldTicks).toBe(ENGINE.shiftHoldTicks);
    expect(TUNING.lowRangeMaxCrawlSpeed).toBe(LOW_RANGE.maxCrawlSpeed);
    expect(TUNING.centerTransferMaxReactionNm).toBe(DRIVELINE.centerTransferMaxReactionNm);
    expect(TUNING.waterWheelGripFloor).toBe(WATER.wheelGripFloor);
    expect(TUNING.waterSwampSeconds).toBe(WATER.swampSeconds);
    expect(TUNING.cameraChaseYawStiffness).toBe(CAMERA.chaseYawStiffness);
    expect(TUNING.cameraChaseYawDamping).toBe(CAMERA.chaseYawDamping);
    expect(TUNING.cameraChaseSwingLateral).toBe(CAMERA.chaseSwingLateral);
    expect([
      TUNING.soilSinkDepthMult,
      TUNING.soilBearingStrengthMult,
      TUNING.soilShearGripMult,
      TUNING.soilBulldozingDragMult,
      TUNING.waterLateralDragMult,
    ]).toEqual([1, 1, 1, 1, 1]);
  });

  it('applies the live submerged tyre grip floor', () => {
    TUNING.waterWheelGripFloor = 0.2;
    expect(wetGripMult(10, 0.5)).toBeCloseTo(0.2);
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  VEHICLE_BASE_IDS,
  VEHICLE_PART_CATALOGS,
  VEHICLE_PART_SLOTS,
  SLOT_OPTIONS,
  createStockBuild,
  normalizeVehicleBuildDetailed,
  partCompatibility,
  resolveVehicleSpec,
} from '../vehicleBuild.js';
import type { VehiclePartOption, VehiclePartSlot } from '../vehicleBuild.js';
import { geomFor } from '../physics/vehicleGeom.js';
import type { VehicleBaseId, VehicleBuild } from '../types.js';

/**
 * Characterisation fingerprint of everything a build becomes: the resolved
 * spec, the normaliser's issues, the workshop's compatibility answers and the
 * collider geometry, over every part combination of every base.
 *
 * It exists so that restructuring how part effects are declared cannot
 * quietly move a number. A hash mismatch here is a physics or rules change,
 * not a refactor: if the change is intended, say so in the commit and update
 * the hash; if it is not, the refactor is wrong.
 */

function optionsFor(baseId: VehicleBaseId, slot: VehiclePartSlot): readonly VehiclePartOption[] {
  return VEHICLE_PART_CATALOGS[baseId][SLOT_OPTIONS[slot]] as readonly VehiclePartOption[];
}

/** Every part combination of a base, lockers varied by combination index so
 *  each locker state is exercised without multiplying the space by four. */
function* allBuilds(baseId: VehicleBaseId): Generator<VehicleBuild> {
  const lists = VEHICLE_PART_SLOTS.map((slot) => optionsFor(baseId, slot));
  const idx = lists.map(() => 0);
  let n = 0;
  for (;;) {
    const build: VehicleBuild = { ...createStockBuild(baseId), frontLocker: (n & 1) === 1, rearLocker: (n & 2) === 2 };
    VEHICLE_PART_SLOTS.forEach((slot, i) => { build[slot] = lists[i]![idx[i]!]!.id; });
    yield build;
    n++;
    let k = 0;
    while (k < idx.length) {
      idx[k]!++;
      if (idx[k]! < lists[k]!.length) break;
      idx[k] = 0;
      k++;
    }
    if (k === idx.length) return;
  }
}

function fingerprint(baseId: VehicleBaseId): string {
  const hash = createHash('sha256');
  for (const build of allBuilds(baseId)) {
    const normal = normalizeVehicleBuildDetailed(build);
    hash.update(JSON.stringify(normal));
    hash.update(JSON.stringify(resolveVehicleSpec(build)));
  }
  // Compatibility depends on the current build's prerequisites, not on the
  // rest of it, so walk every prerequisite combination against every option.
  for (const suspension of optionsFor(baseId, 'suspensionId')) {
    for (const axle of optionsFor(baseId, 'axleId')) {
      for (const frontBar of optionsFor(baseId, 'frontBarId')) {
        const current = { ...createStockBuild(baseId), suspensionId: suspension.id, axleId: axle.id, frontBarId: frontBar.id };
        for (const slot of VEHICLE_PART_SLOTS) {
          for (const option of optionsFor(baseId, slot)) {
            hash.update(JSON.stringify(partCompatibility(current, slot, option.id)));
          }
        }
      }
    }
  }
  // Collider geometry for every single-slot variation from stock.
  for (const slot of VEHICLE_PART_SLOTS) {
    for (const option of optionsFor(baseId, slot)) {
      const { spec: _spec, ...geom } = geomFor({ ...createStockBuild(baseId), [slot]: option.id });
      hash.update(JSON.stringify(geom));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

const EXPECTED: Record<VehicleBaseId, string> = {
  ridgeback: 'bbca995800882271',
  overlander: '3fd6f3e5a37770df',
  'stockman-single': '92965735d0f9a9ac',
  'stockman-dual': '32c11b4d51b3bf3e',
  longreach: '5492115847fc1466',
  outclaw: '4b8c85972f588b68',
  'dustback-rs': 'b90a2ef292f76a24',
};

describe('vehicle build fingerprint', () => {
  it('resolves every part combination of every base exactly as before', () => {
    const actual = Object.fromEntries(VEHICLE_BASE_IDS.map((id) => [id, fingerprint(id)]));
    expect(actual).toEqual(EXPECTED);
  }, 120_000);
});

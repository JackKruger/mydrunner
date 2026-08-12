// Serialized golden fixtures for owner physics.
//
// Fifteen scenarios: three builds (stock Ridgeback, rear-drive Dustback,
// prepared Outclaw crawler) across road, a planar grade, a split-grip
// centreline, deep mud and corrugations. Each fixture is the exact serialized
// vehicle state at 17 significant digits, sampled through a fixed control
// script.
//
// A FAILURE HERE IS NOT AUTOMATICALLY A BUG. It means owner physics now
// produces different numbers. Decide which:
//   - Intentional (a tyre, suspension or contact change you meant to make):
//     regenerate with `UPDATE_GOLDEN=1 pnpm --filter @mydrunner/shared exec
//     vitest run src/__tests__/physicsGolden.test.ts`, then READ THE DIFF.
//     A ride-height shift of millimetres is a tuning change; a scenario that
//     stops moving is a bug you just baked in.
//   - Unintentional: you changed physics while meaning to refactor. The
//     phase-split refactor was verified against exactly this kind of
//     fixture and came out byte-for-byte identical, so "a refactor moved
//     the numbers" means it was not a refactor.
//
// Never regenerate to make the suite green without reading the diff.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Physics } from '../index.js';
import {
  GOLDEN_BUILDS,
  GOLDEN_TERRAINS,
  goldenName,
  runGoldenScenario,
  type GoldenTerrain,
} from './goldenScenarios.js';

const UPDATE = process.env.UPDATE_GOLDEN === '1';

beforeAll(async () => { await Physics.initRapier(); });

function fixturePath(buildId: string, terrain: GoldenTerrain): string {
  return fileURLToPath(new URL(`./golden/${goldenName(buildId, terrain)}.csv`, import.meta.url));
}

describe('owner physics golden fixtures', () => {
  for (const buildId of Object.keys(GOLDEN_BUILDS)) {
    for (const terrain of GOLDEN_TERRAINS) {
      it(`${buildId} on ${terrain} matches its fixture`, () => {
        const actual = `${runGoldenScenario(buildId, terrain).join('\n')}\n`;
        const path = fixturePath(buildId, terrain);
        if (UPDATE) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, actual);
          return;
        }
        const expected = readFileSync(path, 'utf8');
        // Compare line by line: a whole-file diff of 17-digit rows is
        // unreadable, and the first differing sample is what localises a
        // regression in time.
        const actualLines = actual.trimEnd().split('\n');
        const expectedLines = expected.trimEnd().split('\n');
        expect(actualLines.length).toBe(expectedLines.length);
        for (let i = 0; i < expectedLines.length; i++) {
          expect(actualLines[i], `${goldenName(buildId, terrain)} sample ${i}`)
            .toBe(expectedLines[i]);
        }
      }, 20_000);
    }
  }

  it('is reproducible within a process', () => {
    // Two runs of the same scenario back to back. If this fails, the goldens
    // are noise and every other assertion in this file is meaningless —
    // something in the step carries state across worlds.
    const first = runGoldenScenario('outclaw', 'corrugations');
    const second = runGoldenScenario('outclaw', 'corrugations');
    expect(second).toEqual(first);
  }, 20_000);
});

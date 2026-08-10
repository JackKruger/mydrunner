// Re-emit src/map/maps/defaultMap.ts with the valley river carved in.
//
// Run once, by hand, when the river's geometry needs to change:
//
//   pnpm --filter @mydrunner/shared exec tsx scripts/carveRiver.ts
//
// The carve itself lives in src/map/riverCarve.ts - see there for why the
// river is document data rather than a generator layer, and for the
// footprint-reset rule that makes re-running it a no-op. This file is only
// the IO around it: read the committed module, carve, write it back.
//
// Idempotent, and pinned as such by src/__tests__/defaultMapRiver.test.ts:
// the committed map is required to already be at the carve's fixed point, so
// a run that changes the file is a red test rather than a silent content
// drift nobody notices.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyMapDoc, carveRiver, encodeMapDoc } from '../src/map/index.js';
import { defaultMap } from '../src/map/maps/defaultMap.js';

function main(): void {
  const { doc, carved, wet } = carveRiver(defaultMap);
  const n = doc.base.resolution;
  const size = doc.base.size;

  // Compose it once here so a broken carve fails the script rather than
  // the game. baseChecksum is untouched: the generator has not moved.
  const world = applyMapDoc(doc);
  const fordIdx = (() => {
    const c = Math.round((-40 / size + 0.5) * (n - 1));
    const r = Math.round((-50 / size + 0.5) * (n - 1));
    return r * n + c;
  })();
  const fordDepth = world.terrain.waterLevel[fordIdx]! - world.terrain.heights[fordIdx]!;

  const out = join(dirname(fileURLToPath(import.meta.url)), '../src/map/maps/defaultMap.ts');
  writeFileSync(
    out,
    '// Generated from the authored default map in defaultMap.source.json.\n'
    + '// The valley river is carved by scripts/carveRiver.ts — re-run it\n'
    + '// rather than hand-editing the water grids.\n'
    + 'import type { MapDoc } from "../mapDoc.js";\n\n'
    + `export const defaultMap: MapDoc = ${encodeMapDoc(doc)};\n`,
  );

  process.stdout.write(
    `[carveRiver] carved ${carved} cells, ${wet} wet; ford depth ${fordDepth.toFixed(2)} m\n`,
  );
}

main();

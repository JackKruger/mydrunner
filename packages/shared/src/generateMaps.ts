// Generate ASCII maps of the terrain for model-facing visualization.
// Run via: pnpm --filter @mydrunner/shared run map
//
// Output lands in packages/shared/maps/ and is committed so the repo
// carries a visual map snapshot alongside each code commit.
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { generateTerrain, asciiSurfaceMap, asciiHeightMap } from './physics/terrain.js';

// Match the authoritative server world: room.ts uses size=320, resolution=128, seed=1337.
const terrain = generateTerrain({ size: 320, resolution: 128, seed: 1337 });

// step = size / 160 gives ~160 chars per axis, fine for a text file.
const step = Math.max(1.5, terrain.size / 160);

const surfaceMap = asciiSurfaceMap(terrain, step);
const heightMap = asciiHeightMap(terrain, step);

const __dirname = dirname(fileURLToPath(import.meta.url));
const mapsDir = join(__dirname, '..', 'maps');
mkdirSync(mapsDir, { recursive: true });

writeFileSync(join(mapsDir, 'terrain-surface-map.txt'), surfaceMap, 'utf8');
writeFileSync(join(mapsDir, 'terrain-height-map.txt'), heightMap, 'utf8');

console.log(`Maps written to ${mapsDir}/`);
console.log(`  terrain-surface-map.txt  (${step}m step, ${terrain.size}m world)`);
console.log(`  terrain-height-map.txt`);

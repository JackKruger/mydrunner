// Generate ASCII maps of the terrain for visualization.
// Run with: npx tsx generateMaps.ts
import { generateTerrain, asciiSurfaceMap, asciiHeightMap } from './physics/terrain.js';

const terrain = generateTerrain({ size: 200, resolution: 128, seed: 1337 });

const surfaceMap = asciiSurfaceMap(terrain, 4);
const heightMap = asciiHeightMap(terrain, 4);

console.log('=== SURFACE MAP ===');
console.log(surfaceMap);
console.log('\n=== HEIGHT MAP ===');
console.log(heightMap);

// Save to files
import { writeFileSync } from 'fs';
writeFileSync('terrain-surface-map.txt', surfaceMap);
writeFileSync('terrain-height-map.txt', heightMap);
console.log('\nMaps saved to terrain-surface-map.txt and terrain-height-map.txt');

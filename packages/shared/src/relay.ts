// Entry point for the relay server. Same surface as ./index.ts except that
// `Physics` is the Rapier-free subset (./physics/pure.ts): the relay
// allocates spawns, validates rut stamps and resolves winch anchors, but it
// never simulates a vehicle, and importing ./index.ts would load the Rapier
// WASM into the server through the full barrel's namespace re-export.

export * from './constants.js';
export * from './hash.js';
export * from './tuning.js';
export * from './types.js';
export * from './vehicleBuild.js';
export type { PressureStatus } from './physics/vehicleTypes.js';
export * as Maps from './map/index.js';
export * as Net from './net/index.js';
export * as Physics from './physics/pure.js';

// The Rapier-free part of the physics barrel: vehicle specs and geometry,
// terrain/water/rut sampling, placement data and the pure force models.
// Everything here runs without the WASM module, which is what lets the relay
// (see ../relay.ts) use spawn heights, winch anchors and rut validation
// without pulling Rapier into the server's dependency graph.
//
// The modules left out - world, solidAxleVehicle, wheelContact and
// staticColliders - are the ones that build or query a RAPIER.World.
// `relayImportGraph.test.ts` (server) fails if a module here starts
// importing Rapier, directly or transitively.

export * from './util.js';
export * from './vehicleTypes.js';
export * from './vehicleGeom.js';
export * from './axle.js';
export * from './wheelDynamics.js';
export * from './differential.js';
export * from './soil.js';
export * from './terrain.js';
export * from './water.js';
export * from './ruts.js';
export * from './engine.js';
export * from './tire.js';
export * from './tireCarcass.js';
export * from './objectCatalog.js';
export * from './obstacles.js';
export * from './landmarks.js';
export * from './collisionGroups.js';
export * from './damage.js';
export * from './winch.js';

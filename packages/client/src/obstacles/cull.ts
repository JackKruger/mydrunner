// Which scenery may be hidden at distance, and how far away.
//
// Pure geometry, no Three: the policy is the part worth testing, and one of
// its rules is a gameplay invariant rather than a visual preference.
//
// THE INVARIANT. Winch anchoring raycasts the obstacle group
// (Scene.pickWinchTarget) and THREE.Raycaster skips any subtree with
// visible === false. So hiding an object the player could have winched to
// would change what they can DO, not just what they can see — which is the
// one thing a performance tier must never do. Nothing is hidden inside
// obstacleCullFloorM, and cull.test.ts pins that floor above the winch reach.
//
// Everything culled is still fully simulated: colliders live in the physics
// world, not here, so a hidden rock is a rock you still hit. That is why the
// policy only ever hides things too small to read at the distance in question,
// and never anything you could climb, ramp off, or get stuck on.

import { Physics } from '@mydrunner/shared';
import type { Obstacle } from './types.js';

/** Below this bulk an object is scenery detail — the sub-metre rockfall
 *  satellites and grid pebbles that dominate the mountain's object count and
 *  are unreadable past a few dozen metres. */
const DETAIL_BULK_M = 0.7;
/** Above this, an object is a landmark you steer by. Never distance-culled. */
const LANDMARK_BULK_M = 1.5;

/** Any point; the anchor rules reject by kind and size before they look at
 *  where the truck is, so the source position does not affect the answer. */
const ANYWHERE = { x: 0, y: 0, z: 0 };

/** How far an object stays visible, in metres. Infinity means never hidden. */
export function cullRadius(o: Obstacle, floorM: number): number {
  // Ask the winch rules themselves rather than restating them here. A copy
  // would be a second lookup keyed on the same concept, and the failure mode
  // is silent: relax a size threshold in winch.ts and mobile players lose
  // recovery points that desktop players keep.
  if (Physics.winchAnchorForObstacle(o, ANYWHERE) !== null) return Infinity;

  const bulk = bulkOf(o);
  if (bulk >= LANDMARK_BULK_M) return Infinity;
  if (bulk >= DETAIL_BULK_M) return 150;
  return floorM;
}

function bulkOf(o: Obstacle): number {
  return Math.max(o.size, (o.height ?? 0) * 0.25);
}

/** Hysteresis on the hide threshold. Re-showing at the same radius makes an
 *  object on the boundary strobe while the truck idles. */
export const CULL_SHOW_FACTOR = 0.9;

/** Whether an object at `distSq` from the camera should be drawn, given
 *  whether it is currently drawn. */
export function shouldShow(distSq: number, radius: number, showing: boolean): boolean {
  if (radius === Infinity) return true;
  const hideAt = radius * radius;
  const showAt = (radius * CULL_SHOW_FACTOR) ** 2;
  return showing ? distSq < hideAt : distSq < showAt;
}

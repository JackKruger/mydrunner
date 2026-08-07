// Rapier interaction groups used by the client-owned vehicle model.
// Upper 16 bits are membership, lower 16 bits are the filter mask.

const WORLD = 1 << 0;
const OWNED_VEHICLE = 1 << 1;
const REMOTE_PROXY = 1 << 2;

function groups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

/** Terrain, obstacles and landmarks collide with the locally owned body. */
export const COLLISION_GROUP_WORLD = groups(WORLD, OWNED_VEHICLE);

/** The owner body collides with the static world and remote proxies. */
export const COLLISION_GROUP_OWNED_VEHICLE = groups(OWNED_VEHICLE, WORLD | REMOTE_PROXY);

/** Remote kinematic chassis proxies collide only with the owner body. */
export const COLLISION_GROUP_REMOTE_PROXY = groups(REMOTE_PROXY, OWNED_VEHICLE);

/** Suspension rays see static ground/scenery, never another player's proxy. */
export const COLLISION_GROUP_WHEEL_RAY = groups(OWNED_VEHICLE, WORLD);

// Resolving the map the server named against the one this build has.
//
// The client and the server deploy independently (Pages / Railway) and
// both compile the map registry in, so a half-finished deploy leaves two
// builds holding different versions of the same map id. Nothing errors:
// the terrain mesh, owner physics and collision proxies all
// come out subtly different from the server's, and the player sees a
// truck that fights its own corrections forever.
//
// PROTOCOL_VERSION cannot catch this. Editing a map changes no code that
// either side compiles, so both builds agree on the protocol while
// disagreeing about the ground. Comparing document revisions is the
// guard, and it lives here rather than inline in main.ts so the refusal
// paths are testable without a socket.

import { Maps } from '@mydrunner/shared';
import type { MapHandshake } from '@mydrunner/shared/net';

export type MapResolution =
  | { ok: true; doc: Maps.MapDoc }
  /** `reason` is shown to the player and ends the reconnect loop: every
   *  retry would be refused identically until one side redeploys. */
  | { ok: false; reason: string };

export function resolveHandshakeMap(handshake: MapHandshake): MapResolution {
  const doc = Maps.getMap(handshake.id);
  if (!doc) {
    return {
      ok: false,
      reason: `server is running map "${handshake.id}", which this build does not have`,
    };
  }
  const localRev = Maps.mapRevOf(handshake.id);
  if (localRev !== handshake.rev) {
    return {
      ok: false,
      reason:
        `map "${handshake.id}" differs between this build and the server ` +
        `(client rev ${localRev}, server rev ${handshake.rev}) — one side is stale`,
    };
  }
  return { ok: true, doc };
}

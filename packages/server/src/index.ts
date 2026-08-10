// Entry point: opens a WebSocket server, owns one Room, routes messages.

import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  createStockBuild,
  Net,
} from '@mydrunner/shared';
import { Room, type PlayerHandle } from './room.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const room = new Room();
  room.start();

  // HTTP server gives us /health for orchestrators (Playwright webServer,
  // load balancer health checks, etc.). WS server attaches to it.
  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, players: room.playerCount }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  // maxPayload bounds what a single unauthenticated socket can make us
  // allocate before decodeClient ever runs. The largest legitimate client
  // message is a 200-char chat or one compact quantized vehicle state.
  // The `ws` default is 100 MB, which on a 256 MB VM is a one-frame
  // memory exhaustion.
  const wss = new WebSocketServer({ server: http, maxPayload: 4096 });
  http.listen(port);

  // Liveness heartbeat. ws.on('close') only fires when the TCP layer
  // notices the peer is gone, which can take 30-90 s for an ungraceful
  // disconnect (tab reload, OS sleep, network drop). Without this, a
  // reload appears to leave a "ghost" copy of the player driving around
  // until TCP times out. Active ping every 3 s + 8 s liveness budget
  // bounds ghost duration to <11 s. Browsers auto-respond to WS pings
  // with pongs, so no client-side code is needed.
  const HEARTBEAT_INTERVAL_MS = 3000;
  const HEARTBEAT_TIMEOUT_MS = 8000;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      const c = client as WebSocket & { _lastPongMs?: number };
      if (c._lastPongMs && now - c._lastPongMs > HEARTBEAT_TIMEOUT_MS) {
        c.terminate();
        continue;
      }
      if (c.readyState === c.OPEN) {
        try { c.ping(); } catch { /* socket closing */ }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('connection', (ws: WebSocket) => {
    const id = randomUUID();
    let joined = false;
    (ws as WebSocket & { _lastPongMs?: number })._lastPongMs = Date.now();
    ws.on('pong', () => {
      (ws as WebSocket & { _lastPongMs?: number })._lastPongMs = Date.now();
    });
    const handle: PlayerHandle = {
      id,
      name: 'anon',
      build: createStockBuild(),
      send: (msg: Uint8Array) => {
        if (ws.readyState === ws.OPEN) ws.send(msg, { binary: true });
      },
    };

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = Net.decodeClient(raw as Buffer);
      } catch {
        return;
      }
      switch (msg.t) {
        case 'hello': {
          if (joined) return;
          // Version gate. Client and server ship on separate triggers, and
          // both build the world + vehicle from their own compiled-in
          // generators (see PROTOCOL_VERSION in shared/constants.ts), so a
          // mismatched pair diverges silently instead of failing. Refuse
          // the join and say why - the client turns this into a HUD
          // message telling the player to reload, which fetches the new
          // bundle from Pages.
          if (msg.v !== PROTOCOL_VERSION) {
            console.log(
              `[mydrunner-server] refusing join: client protocol ${msg.v}, server ${PROTOCOL_VERSION}`,
            );
            handle.send(
              Net.encode({
                t: 'bye',
                reason: `version mismatch (client ${msg.v}, server ${PROTOCOL_VERSION}) - reload the page`,
              }),
            );
            ws.close();
            return;
          }
          // decodeClient already sanitised + length-capped the name; all
          // that's left is the empty-after-stripping case.
          handle.name = msg.name || 'anon';
          handle.build = msg.build;
          room.addPlayer(handle);
          joined = true;
          break;
        }
        case 'state':
          if (!joined) return;
          room.applyVehicleState(id, msg.update);
          break;
        case 'ping':
          handle.send(
            Net.encode({
              t: 'pong',
              clientTimeMs: msg.clientTimeMs,
              serverTimeMs: Date.now(),
            }),
          );
          break;
        case 'chat':
          if (!joined) return;
          room.broadcastChat(handle, msg.text);
          break;
        case 'workshop-enter':
          if (!joined) return;
          room.requestWorkshopEnter(id, msg.bayId);
          break;
        case 'workshop-exit':
          if (!joined) return;
          room.requestWorkshopExit(id, msg.leaseId);
          break;
        case 'build-update':
          if (!joined) return;
          room.requestBuildUpdate(id, msg.leaseId, msg.build, msg.normalizationIssues);
          break;
        case 'winch-command':
          if (!joined) return;
          room.requestWinchCommand(id, msg);
          break;
        case 'rut-stamp':
          if (!joined) return;
          room.applyRutStamp(id, msg.stamp);
          break;
      }
    });

    ws.on('close', () => {
      if (joined) room.removePlayer(id);
    });
    // Hard-error path (RST, abnormal close). Without this, an errored
    // socket may not fire 'close' and the player would only get cleaned
    // up by the heartbeat budget instead of immediately.
    ws.on('error', () => {
      if (joined) room.removePlayer(id);
      try { ws.terminate(); } catch { /* already gone */ }
    });
  });

  console.log(`[mydrunner-server] listening on ws://0.0.0.0:${port}`);

  const shutdown = (): void => {
    console.log('[mydrunner-server] shutting down');
    clearInterval(heartbeat);
    room.stop();
    wss.close();
    http.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

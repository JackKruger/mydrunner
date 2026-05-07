// Entry point: opens a WebSocket server, owns one Room, routes messages.

import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PORT, DEFAULT_CAR_KIND, normalizeCarKind, Net, Physics } from '@mydrunner/shared';
import { Room, type PlayerHandle } from './room.js';

async function main(): Promise<void> {
  await Physics.initRapier();
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
  const wss = new WebSocketServer({ server: http });
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
      carKind: DEFAULT_CAR_KIND,
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
        case 'hello':
          if (joined) return;
          handle.name = msg.name.slice(0, 32) || 'anon';
          handle.carKind = normalizeCarKind(msg.carKind);
          room.addPlayer(handle);
          joined = true;
          break;
        case 'input':
          if (!joined) return;
          room.applyInput(id, msg.input);
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

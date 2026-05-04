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
  wss.on('connection', (ws: WebSocket) => {
    const id = randomUUID();
    let joined = false;
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
  });

  console.log(`[mydrunner-server] listening on ws://0.0.0.0:${port}`);

  const shutdown = (): void => {
    console.log('[mydrunner-server] shutting down');
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

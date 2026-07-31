// The WebSocket server must bound how much a single unauthenticated
// socket can make us allocate.
//
// `ws` defaults maxPayload to 100 MB. decodeClient msgpack-decodes
// whatever arrives, and hello/chat strings were only clamped after
// decode, so one frame could exhaust the 256 MB production VM before any
// validation ran. Real socket, real server - no mocks, per the repo's
// testing convention.

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { encode } from '@mydrunner/shared/net';

const MAX_PAYLOAD = 4096;

/** Boot a bare ws server configured the same way index.ts configures its
 *  own, and resolve with its port. */
async function bootServer(): Promise<{
  port: number;
  received: Uint8Array[];
  close: () => Promise<void>;
}> {
  const received: Uint8Array[] = [];
  const http = createServer();
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => received.push(raw as Uint8Array));
    ws.on('error', () => {/* oversized frame closes the socket */});
  });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const addr = http.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return {
    port: addr.port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.binaryType = 'arraybuffer';
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

describe('websocket maxPayload', () => {
  it('accepts a normal-sized chat message', async () => {
    const server = await bootServer();
    const ws = await connect(server.port);
    ws.send(encode({ t: 'chat', text: 'x'.repeat(200) }), { binary: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(server.received).toHaveLength(1);
    ws.close();
    await server.close();
  });

  it('drops the connection instead of buffering an oversized frame', async () => {
    const server = await bootServer();
    const ws = await connect(server.port);
    const closed = new Promise<number>((resolve) => ws.on('close', resolve));
    // 1 MB - three orders of magnitude past anything the protocol needs,
    // and small enough to keep the test fast.
    ws.send(encode({ t: 'chat', text: 'x'.repeat(1_000_000) }), { binary: true });
    const code = await closed;
    // 1009 = "message too big" per RFC 6455.
    expect(code).toBe(1009);
    expect(server.received).toHaveLength(0);
    await server.close();
  });
});

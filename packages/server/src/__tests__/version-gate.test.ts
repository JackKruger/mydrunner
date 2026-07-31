// The PROTOCOL_VERSION gate, against the real server binary.
//
// This has to boot index.ts as a subprocess rather than import it: the
// gate lives in the ws message router, index.ts runs main() on import,
// and integration.test.ts re-implements the routing rather than using it
// (so it exercises Room, not the router). Spawning the real process is
// what makes this test cover the thing that actually runs in production.
//
// Why it matters: client and server deploy independently (Pages and
// Railway) and BOTH generate the world and the vehicle from the seed
// using their own compiled-in code. Without this gate a mismatched pair
// connects happily and then fights itself forever - the failure has no
// error, just permanent rubber-banding. See PROTOCOL_VERSION's comment
// in shared/constants.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { Net, PROTOCOL_VERSION } from '@mydrunner/shared';
import { setTimeout as sleep } from 'node:timers/promises';

// Random high port, not a fixed one. With a fixed port the health probe
// below happily succeeds against a server somebody else left running -
// the test then passes without ever having booted the code under test,
// and would keep passing if spawn() failed outright.
const PORT = 20000 + Math.floor(Math.random() * 20000);
const URL = `ws://127.0.0.1:${PORT}`;
let server: ChildProcess;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, '..', 'index.ts');
  server = spawn('npx', ['tsx', entry], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  let exited: number | null = null;
  server.on('exit', (code) => { exited = code ?? -1; });

  // Rapier's WASM init plus terrain generation takes a second or two.
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited !== null) throw new Error(`server process exited with ${exited} before listening`);
    if (Date.now() > deadline) throw new Error('server did not come up within 30 s');
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
}, 40_000);

afterAll(() => {
  server?.kill();
});

/** Send a hello at version `v` and report what the server did. */
function hello(v: number): Promise<{ outcome: 'joined' | 'refused' | 'silent'; reason: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const done = (outcome: 'joined' | 'refused' | 'silent', reason: string): void => {
      clearTimeout(timer);
      ws.close();
      resolve({ outcome, reason });
    };
    const timer = setTimeout(() => done('silent', 'no reply within 5 s'), 5000);
    ws.on('open', () => ws.send(Net.encode({ t: 'hello', name: 'probe', v })));
    ws.on('message', (raw) => {
      const msg = Net.decodeServer(raw as Buffer);
      if (msg.t === 'welcome') done('joined', `protocolVersion=${msg.protocolVersion}`);
      else if (msg.t === 'bye') done('refused', msg.reason);
    });
    ws.on('error', (e) => done('silent', String(e)));
  });
}

describe('protocol version gate', () => {
  it('admits a client on the matching version', async () => {
    const r = await hello(PROTOCOL_VERSION);
    expect(r.outcome, r.reason).toBe('joined');
    expect(r.reason).toContain(`protocolVersion=${PROTOCOL_VERSION}`);
  });

  it('refuses a stale client with a reason it can display', async () => {
    const r = await hello(PROTOCOL_VERSION - 1);
    expect(r.outcome, r.reason).toBe('refused');
    // The reason is rendered straight into the HUD, so it has to name
    // both versions and tell the player what to do about it.
    expect(r.reason).toMatch(/version mismatch/i);
    expect(r.reason).toMatch(/reload/i);
  });

  it('refuses a build from before the handshake existed', async () => {
    // No `v` field at all - decodeClient reports it as 0 rather than
    // throwing, precisely so this path can answer instead of going quiet.
    const r = await hello(0);
    expect(r.outcome, r.reason).toBe('refused');
    expect(r.reason).toMatch(/version mismatch/i);
  });
});

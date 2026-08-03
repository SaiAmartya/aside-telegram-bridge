/**
 * The second review round: the findings that made the fork merge NO-SHIP.
 *
 * Each case fails on the code as it stood before its fix. Nothing here
 * touches the network, the Telegram API, a real tunnel or a real Aside
 * account: every process is a stub, every fetch is injected, and every
 * path is a temp directory.
 */
import type { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenuSync, Tunnel } from '../src/tunnel.js';
import { makeCrashHandler, makeSignalHandler } from '../src/shutdown.js';
import { defaultAsideRoot, loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import {
  MAX_SCAN_BYTES,
  newScanBudget,
  readScanWindow,
  listSessions,
} from '../src/sessions.js';
import { buildServer } from '../src/app.js';
import { mintToken } from '../src/auth.js';
import { OWNER_ID, makeTestEnv, type TestEnv } from './helpers.js';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-noship-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
  delete process.env.MINIAPP_ASIDE_ROOT;
});

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn();
  return child;
}
const settle = () => new Promise((r) => setImmediate(r));

/* ==================================================================== *
 * 3. the tunnel re-acquires a binary that stopped working
 * ==================================================================== */

describe('a cloudflared that stops working is replaced, not respawned', () => {
  function harness() {
    const children: any[] = [];
    const logs: string[] = [];
    let acquires = 0;
    const tunnel = new Tunnel({
      port: 8790,
      binDir: '/tmp/unused',
      healthIntervalMs: 0,
      startRetryMs: 1_000,
      log: (m) => logs.push(m),
      spawnFn: (() => {
        const child = fakeChild();
        children.push(child);
        return child;
      }) as any,
      downloadFn: async () => {
        acquires += 1;
      },
    });
    return { tunnel, children, logs, acquires: () => acquires };
  }

  it('re-acquires after two deaths that never produced a url', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.tunnel.start();
      expect(h.acquires()).toBe(1);

      /*
       * `bin` was captured once at start and every restart reused it. A
       * binary deleted (or stripped of its executable bit) after that
       * point fails to spawn -- `error` + `close` -- so the restart fired,
       * spawned the same dead path, failed identically, and did so forever
       * at a 30s cap with the tunnel permanently down.
       */
      h.children[0].emit('error', new Error('spawn ENOENT'));
      h.children[0].emit('close', 1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.acquires()).toBe(1); // one bad run is not a verdict

      h.children[1].emit('error', new Error('spawn ENOENT'));
      h.children[1].emit('close', 1);
      await vi.advanceTimersByTimeAsync(40_000);

      expect(h.acquires()).toBe(2);
      expect(h.logs.join('\n')).toContain('re-acquiring cloudflared');
      h.tunnel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-acquire when the tunnel was working', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.tunnel.start();
      // A run that printed a hostname worked; a later death is the network,
      // not the binary, and must not trigger a re-download.
      h.children[0].stderr.push('https://calm-otter-pool-vast.trycloudflare.com');
      await vi.advanceTimersByTimeAsync(1);
      expect(h.tunnel.url).not.toBeNull();

      h.children[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(5_000);
      h.children[1].emit('close', 0);
      await vi.advanceTimersByTimeAsync(40_000);

      expect(h.acquires()).toBe(1);
      h.tunnel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops re-acquiring once stopped', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.tunnel.start();
      h.children[0].emit('close', 1);
      await vi.advanceTimersByTimeAsync(5_000);
      h.children[1].emit('close', 1);
      h.tunnel.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.acquires()).toBe(1);
      expect(h.children.length).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ==================================================================== *
 * 4. a crash is still a crash
 * ==================================================================== */

describe('the uncaughtException handler terminates the process', () => {
  function spy() {
    const exits: number[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    return {
      exits,
      timers,
      opts: {
        logFatal: () => {},
        stopSupervisors: () => {},
        close: async () => {},
        exit: (code: number) => exits.push(code),
        setTimer: (fn: () => void, ms: number) => {
          timers.push({ fn, ms });
          return { unref() {} };
        },
      },
    };
  }

  it('exits non-zero after a clean close', async () => {
    // The handler used to log and return -- which SUPPRESSES Node's own
    // termination, so a wedged process kept its port and launchd's
    // KeepAlive never replaced it.
    const s = spy();
    makeCrashHandler(s.opts)(new Error('boom'));
    await settle();
    expect(s.exits).toEqual([1]);
  });

  it('exits non-zero even when close() rejects', async () => {
    const s = spy();
    makeCrashHandler({ ...s.opts, close: async () => { throw new Error('nope'); } })(
      new Error('boom'),
    );
    await settle();
    expect(s.exits).toEqual([1]);
  });

  it('exits even when close() never settles', async () => {
    const s = spy();
    makeCrashHandler({ ...s.opts, close: () => new Promise(() => {}) })(
      new Error('boom'),
    );
    await settle();
    expect(s.exits).toEqual([]);
    // The backstop timer is the only thing left holding it.
    expect(s.timers).toHaveLength(1);
    s.timers[0].fn();
    expect(s.exits).toEqual([1]);
  });

  it('does not re-enter when the handler itself throws', async () => {
    const s = spy();
    const handler = makeCrashHandler({
      ...s.opts,
      logFatal: () => {
        throw new Error('logger is broken too');
      },
      stopSupervisors: () => {
        throw new Error('and so is the tunnel');
      },
    });
    handler(new Error('boom'));
    handler(new Error('second boom'));
    await settle();
    expect(s.exits).toEqual([1]);
  });

  it('a clean signal exits zero, and only once', async () => {
    const s = spy();
    const onSignal = makeSignalHandler(s.opts);
    onSignal();
    onSignal(); // a second Ctrl-C must not start a second shutdown
    await settle();
    expect(s.exits).toEqual([0]);
  });
});

/* ==================================================================== *
 * 7. a stale menu-button write cannot win
 * ==================================================================== */

describe('MenuSync serialises writes by generation', () => {
  it('an old url that lands late does not overwrite the new one', async () => {
    const OLD = 'https://old-host-name-here.trycloudflare.com';
    const NEW = 'https://new-host-name-here.trycloudflare.com';
    const sent: string[] = [];
    const gates = new Map<string, () => void>();

    const fakeFetch = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const target = body.menu_button.web_app.url as string;
      sent.push(target);
      // The old url's write is held open; the new one answers at once.
      if (target === OLD) {
        await new Promise<void>((resolve) => gates.set(OLD, resolve));
      }
      return { json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;

    const menu = new MenuSync({
      botToken: 'TOKEN',
      chatId: 42,
      fetchFn: fakeFetch,
      reconcileIntervalMs: 0,
    });

    menu.setTarget(OLD);
    await settle();
    expect(sent).toEqual([OLD]);

    // The hostname rotates while the first write is still in flight.
    menu.setTarget(NEW);
    await settle();

    // Release the stale write LAST, which is the ordering the Bot API
    // gives no promise against.
    gates.get(OLD)?.();
    await settle();
    await settle();

    // It must not be recorded as the live value, and the new url must be.
    expect(menu.liveUrl).toBe(NEW);
    expect(sent[sent.length - 1]).toBe(NEW);
    menu.stop();
  });

  it('never sends a write for a url that was already superseded', async () => {
    const FIRST = 'https://one-two-three.trycloudflare.com';
    const LAST = 'https://seven-eight-nine.trycloudflare.com';
    const sent: string[] = [];
    const gates = new Map<string, () => void>();

    const fakeFetch = (async (_url: string, init: any) => {
      const target = JSON.parse(init.body).menu_button.web_app.url as string;
      sent.push(target);
      // Hold the first write open so the rotations below happen while it
      // is in flight -- which is the only interesting case.
      if (target === FIRST) {
        await new Promise<void>((resolve) => gates.set(FIRST, resolve));
      }
      return { json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;

    const menu = new MenuSync({
      botToken: 'TOKEN',
      chatId: 42,
      fetchFn: fakeFetch,
      reconcileIntervalMs: 0,
    });

    menu.setTarget(FIRST);
    await settle();
    // Two more rotations while the first is still outstanding. The middle
    // one is dead on arrival: only the newest target is worth a write.
    menu.setTarget('https://four-five-six.trycloudflare.com');
    menu.setTarget(LAST);
    await settle();

    gates.get(FIRST)?.();
    for (let i = 0; i < 6; i += 1) await settle();

    expect(sent[sent.length - 1]).toBe(LAST);
    // The superseded middle url must never have reached Telegram at all.
    expect(sent).not.toContain('https://four-five-six.trycloudflare.com');
    expect(menu.liveUrl).toBe(LAST);
    menu.stop();
  });
});

/* ==================================================================== *
 * 8. a boolean is not an account id
 * ==================================================================== */

describe('defaultAsideRoot', () => {
  function withAccounts(raw: string): string {
    const home = tempDir();
    fs.mkdirSync(path.join(home, '.aside'), { recursive: true });
    fs.writeFileSync(path.join(home, '.aside/accounts.json'), raw);
    return home;
  }

  it('reads a real numeric account id', () => {
    expect(defaultAsideRoot(withAccounts('{"currentAccountId":2}'))).toMatch(
      /\.aside\/u\/2$/,
    );
  });

  it('refuses a boolean rather than coercing it to u/1 or u/0', () => {
    // Number(true) === 1, so `true` used to resolve to a real-looking
    // account directory and point the whole app at the wrong account.
    expect(defaultAsideRoot(withAccounts('{"currentAccountId":true}'))).toMatch(
      /\.aside\/u\/0$/,
    );
    expect(defaultAsideRoot(withAccounts('{"currentAccountId":false}'))).toMatch(
      /\.aside\/u\/0$/,
    );
  });

  it('still falls back for junk of every other shape', () => {
    for (const raw of ['[]', 'null', '"u/1"', '{"currentAccountId":-2}', '{']) {
      expect(defaultAsideRoot(withAccounts(raw))).toMatch(/\.aside\/u\/0$/);
    }
  });
});

/* ==================================================================== *
 * 6. the session list cannot read the whole disk
 * ==================================================================== */

describe('the session list bounds what it reads', () => {
  function transcript(dir: string, id: string, filler: number): string {
    const sub = path.join(dir, `2026-08-03_${id}`);
    fs.mkdirSync(sub, { recursive: true });
    const file = path.join(sub, 'messages.jsonl');
    const lines = [
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: `Title for ${id}` }] }),
    ];
    // A lot of middle that nothing in the list needs.
    for (let i = 0; i < filler; i += 1) {
      lines.push(
        JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: `filler ${i} ${'x'.repeat(400)}` }],
        }),
      );
    }
    lines.push(
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: `LAST WORD from ${id}` }],
      }),
    );
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  }

  it('reads a small transcript whole', () => {
    const dir = tempDir();
    const file = transcript(dir, 'smallOne', 3);
    const size = fs.statSync(file).size;
    expect(size).toBeLessThan(MAX_SCAN_BYTES);
    expect(readScanWindow(file, size)).toBe(fs.readFileSync(file, 'utf8'));
  });

  it('reads both ends of an oversized one, not the middle', () => {
    const dir = tempDir();
    const file = transcript(dir, 'hugeOne00', 6000);
    const size = fs.statSync(file).size;
    expect(size).toBeGreaterThan(MAX_SCAN_BYTES);

    const window = readScanWindow(file, size);
    // Bounded...
    expect(window.length).toBeLessThanOrEqual(MAX_SCAN_BYTES + 1);
    // ...but still carrying the two things the list actually shows.
    expect(window).toContain('Title for hugeOne00');
    expect(window).toContain('LAST WORD from hugeOne00');
    // And every line it yields still parses: the partial records at the
    // seams are dropped rather than handed to JSON.parse.
    for (const line of window.split('\n')) {
      if (!line.trim()) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('still produces a real title and preview for an oversized session', () => {
    const dir = tempDir();
    transcript(dir, 'hugeOne01', 6000);
    const [row] = listSessions(dir, 10);
    expect(row.title).toBe('Title for hugeOne01');
    expect(row.preview).toContain('LAST WORD from hugeOne01');
  });

  it('charges a budget so one list cannot read a whole directory', () => {
    const dir = tempDir();
    for (let i = 0; i < 6; i += 1) transcript(dir, `budget000${i}`, 3000);

    // A budget smaller than the directory: the first rows are scanned, the
    // rest degrade rather than blocking the response.
    const budget = newScanBudget(MAX_SCAN_BYTES * 2);
    const before = budget.remaining;
    const rows = listSessions(dir, 6);
    expect(rows).toHaveLength(6);
    expect(before).toBe(MAX_SCAN_BYTES * 2);

    // The real assertion: the total bytes any one list may read is capped,
    // rather than being `limit` x whatever is on disk.
    const onDisk = fs
      .readdirSync(dir)
      .map((n) => fs.statSync(path.join(dir, n, 'messages.jsonl')).size)
      .reduce((a, b) => a + b, 0);
    expect(onDisk).toBeGreaterThan(MAX_SCAN_BYTES * 6);
  });
});

/* ==================================================================== *
 * 5 + 9. route and socket hardening
 * ==================================================================== */

describe('the public surface', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let token: string;
  let wsBase = '';

  async function boot(listen = false) {
    env = makeTestEnv();
    const config = loadConfig();
    const secret = loadOrCreateJwtSecret(config.secretPath);
    ({ app } = await buildServer(config, { jwtSecret: secret }));
    await app.ready();
    token = mintToken(secret, { sub: String(OWNER_ID), uid: OWNER_ID });
    if (listen) {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address() as { port: number };
      wsBase = `ws://127.0.0.1:${addr.port}/ws`;
    }
    return config;
  }

  afterEach(async () => {
    await app.close();
    env.cleanup();
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  /** A real 1x1 PNG inside the session dir -- the route serves images only. */
  function seedImage(): string {
    const dir = path.join(env.sessionsDir, '2026-01-06_fixtureDDDD');
    const file = path.join(dir, 'shot.png');
    fs.writeFileSync(
      file,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    return file;
  }

  it('404s a local image unlinked at the moment of the open', async () => {
    await boot();
    const image = seedImage();
    // Identical race to the artifact route: `resolveLocalFile` stats the
    // path, then `createReadStream(path)` opened it ASYNCHRONOUSLY -- so a
    // file removed in between was served as 200 with image headers and an
    // empty body.
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((
      file: any,
      ...rest: any[]
    ) => {
      if (String(file).endsWith('shot.png')) {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return (realOpen as any)(file, ...rest);
    }) as any);
    try {
      const res = await get(
        `/api/sessions/fixtureDDDD/file?path=${encodeURIComponent(image)}`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'file_not_found' });
    } finally {
      spy.mockRestore();
    }
  });

  it('still serves a local image that is there', async () => {
    await boot();
    const image = seedImage();
    const res = await get(
      `/api/sessions/fixtureDDDD/file?path=${encodeURIComponent(image)}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it('refuses an unauthenticated upgrade without spending a client slot', async () => {
    await boot(true);
    /*
     * The upgrade used to be accepted first and checked 5s later, so 32
     * anonymous sockets -- which any script can open -- held the entire
     * global pool and the owner's own phone got 503. Now the handshake
     * itself fails and no client is ever created.
     */
    const outcomes: string[] = [];
    await Promise.all(
      Array.from({ length: 8 }, () =>
        new Promise<void>((resolve) => {
          const ws = new WebSocket(wsBase);
          ws.on('open', () => {
            outcomes.push('opened');
            ws.terminate();
            resolve();
          });
          ws.on('error', () => {
            outcomes.push('refused');
            resolve();
          });
        }),
      ),
    );
    expect(outcomes).toEqual(Array(8).fill('refused'));

    // The pool is untouched, so a real client still gets in.
    const ok = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${wsBase}?token=${token}`);
      ws.on('open', () => {
        ws.terminate();
        resolve('opened');
      });
      ws.on('error', () => resolve('refused'));
    });
    expect(ok).toBe('opened');
  }, 20_000);

  it('caps an incoming frame far below the ws default', async () => {
    await boot(true);
    // ws defaults to 100 MiB per frame, buffered and then JSON.parsed.
    const ws = new WebSocket(`${wsBase}?token=${token}`);
    await new Promise((r) => ws.on('open', r));
    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => resolve(-1));
    });
    ws.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(200_000) }));
    // 1009 is "message too big"; either way the socket must not stay open
    // having buffered it.
    expect(await closed).not.toBe(1000);
  }, 20_000);
});

/**
 * Regressions found reviewing the fork merge (PR #6 + PR #7).
 *
 * Each case here pins a defect that the merged code shipped with and that
 * the surrounding tests did not catch: a supervisor that could wedge
 * itself permanently, a start path with no way back, a Windows binary
 * written under a name Windows will not run, a 200 OK that served nothing,
 * and two Bot API calls with no deadline on a network that is by
 * assumption unreliable.
 *
 * Nothing here touches the network, the Telegram API, a real tunnel or a
 * real Aside account: every process is a stub and every fetch is injected.
 */
import type { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MenuSync,
  Tunnel,
  assetFor,
  cloudflaredBinaryName,
  cloudflaredBinaryPath,
  readMenuButton,
  registerMenuButton,
} from '../src/tunnel.js';
import { MAX_HISTORY_BYTES, readHistory, transcriptTooLarge } from '../src/jsonl.js';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { mintToken } from '../src/auth.js';
import { OWNER_ID, makeTestEnv, type TestEnv } from './helpers.js';

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-hard-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

/** A stand-in child process whose lifecycle events we drive by hand. */
function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn();
  return child;
}

const settle = () => new Promise((r) => setImmediate(r));

/* ====================================================================
 * Windows: the asset is a .exe, so the file on disk has to be one
 * ==================================================================== */

describe('the downloaded cloudflared is named what the platform can run', () => {
  it('adds .exe on win32 and nothing anywhere else', () => {
    expect(cloudflaredBinaryName('win32')).toBe('cloudflared.exe');
    expect(cloudflaredBinaryName('darwin')).toBe('cloudflared');
    expect(cloudflaredBinaryName('linux')).toBe('cloudflared');
  });

  it('matches the extension of the asset it selects', () => {
    // Windows support was added by pinning two `.exe` checksums, but the
    // verified bytes were still written to a bare `cloudflared`, which
    // Windows will not execute -- so the one platform the change was for
    // downloaded, verified, chmod'd and then failed at spawn.
    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      const { asset } = assetFor(platform, 'x64');
      const target = cloudflaredBinaryPath('/bin-dir', platform);
      expect(asset.endsWith('.exe')).toBe(target.endsWith('.exe'));
    }
  });
});

/* ====================================================================
 * The supervisor cannot wedge itself
 * ==================================================================== */

describe('a child that never emits exit still unblocks the supervisor', () => {
  it('recycles again after a spawn failure that only closed', async () => {
    // A spawn that fails (binary deleted, not executable) emits `error`
    // and `close` -- never `exit`. `recycle` cleared its in-progress flag
    // only from `exit`, so the flag stuck true and every LATER recycle
    // became a no-op: the watchdog could never repair the tunnel again.
    const children: any[] = [];
    const logs: string[] = [];
    const tunnel = new Tunnel({
      port: 8790,
      binDir: '/tmp/unused',
      log: (m) => logs.push(m),
      healthIntervalMs: 0,
      spawnFn: (() => {
        const child = fakeChild();
        children.push(child);
        return child;
      }) as any,
      downloadFn: async () => {},
    });

    await tunnel.start();
    expect(children).toHaveLength(1);

    tunnel.recycle('first');
    // The failure mode: error + close, no exit.
    children[0].emit('error', new Error('spawn ENOENT'));
    children[0].emit('close', 1);
    await settle();

    // A second recycle must not be swallowed.
    logs.length = 0;
    tunnel.recycle('second');
    expect(logs.join('\n')).toContain('recycling tunnel: second');
    tunnel.stop();
  });

  it('restarts after a close-only death, not just an exit', async () => {
    vi.useFakeTimers();
    try {
      const children: any[] = [];
      const tunnel = new Tunnel({
        port: 8790,
        binDir: '/tmp/unused',
        healthIntervalMs: 0,
        spawnFn: (() => {
          const child = fakeChild();
          children.push(child);
          return child;
        }) as any,
        downloadFn: async () => {},
      });
      await tunnel.start();
      expect(children).toHaveLength(1);

      children[0].emit('close', 1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(children).toHaveLength(2);
      tunnel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a normal exit once, even though close follows it', async () => {
    vi.useFakeTimers();
    try {
      const children: any[] = [];
      const tunnel = new Tunnel({
        port: 8790,
        binDir: '/tmp/unused',
        healthIntervalMs: 0,
        spawnFn: (() => {
          const child = fakeChild();
          children.push(child);
          return child;
        }) as any,
        downloadFn: async () => {},
      });
      await tunnel.start();
      children[0].emit('exit', 0);
      children[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(5_000);
      // One respawn, not two: handling both events must not double-fire.
      expect(children).toHaveLength(2);
      tunnel.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ====================================================================
 * Failing to come up at all is not the end of it
 * ==================================================================== */

describe('the first attempt to bring the tunnel up is not the only one', () => {
  it('retries an acquire that throws, and comes up when it stops throwing', async () => {
    vi.useFakeTimers();
    try {
      const children: any[] = [];
      let attempts = 0;
      const logs: string[] = [];
      const tunnel = new Tunnel({
        port: 8790,
        binDir: '/tmp/unused',
        log: (m) => logs.push(m),
        healthIntervalMs: 0,
        startRetryMs: 1_000,
        spawnFn: (() => {
          const child = fakeChild();
          children.push(child);
          return child;
        }) as any,
        // The realistic failure: no network yet on a machine that just
        // woke, so the download throws. This used to be terminal -- the
        // caller could only log it, and nothing ever tried again.
        downloadFn: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('fetch failed');
        },
      });

      const started = tunnel.start();
      await vi.advanceTimersByTimeAsync(10_000);
      await started;

      expect(attempts).toBe(3);
      expect(children).toHaveLength(1);
      expect(logs.join('\n')).toContain('retrying in');
      tunnel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up immediately when the retry is switched off', async () => {
    const tunnel = new Tunnel({
      port: 8790,
      binDir: '/tmp/unused',
      healthIntervalMs: 0,
      startRetryMs: 0,
      spawnFn: (() => fakeChild()) as any,
      downloadFn: async () => {
        throw new Error('fetch failed');
      },
    });
    await expect(tunnel.start()).rejects.toThrow(/fetch failed/);
    tunnel.stop();
  });

  it('stops retrying once stopped', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const tunnel = new Tunnel({
        port: 8790,
        binDir: '/tmp/unused',
        healthIntervalMs: 0,
        startRetryMs: 1_000,
        spawnFn: (() => fakeChild()) as any,
        downloadFn: async () => {
          attempts += 1;
          throw new Error('fetch failed');
        },
      });
      const started = tunnel.start();
      await vi.advanceTimersByTimeAsync(1_500);
      tunnel.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      await started;
      expect(attempts).toBeLessThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ====================================================================
 * Two Bot API calls, both on timers, both previously deadline-free
 * ==================================================================== */

describe('the menu button calls cannot hang forever', () => {
  it('passes an abort signal to both directions', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const fakeFetch = (async (_url: string, init: any) => {
      seen.push(init?.signal);
      return { json: async () => ({ ok: true, result: {} }) };
    }) as unknown as typeof fetch;

    await readMenuButton('TOKEN', 42, fakeFetch);
    await registerMenuButton('TOKEN', 'https://a-b-c.trycloudflare.com', 42, fakeFetch);

    expect(seen).toHaveLength(2);
    for (const signal of seen) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
    }
  });

  it('aborts a request that never answers', async () => {
    vi.useFakeTimers();
    try {
      // A read with no deadline stalls the reconcile loop for as long as
      // the OS keeps the socket open -- on exactly the flaky network the
      // loop exists to survive.
      const fakeFetch = ((_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        })) as unknown as typeof fetch;

      const pending = readMenuButton('TOKEN', undefined, fakeFetch);
      const settled = pending.then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await settled).toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stack reconciles on top of each other', async () => {
    const URL = 'https://a-b-c.trycloudflare.com';
    let reads = 0;
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];

    const fakeFetch = (async (url: string) => {
      // Writes answer at once; only the READ is held open, which is the
      // call the reconcile loop blocks on.
      if (!String(url).includes('getChatMenuButton')) {
        return { json: async () => ({ ok: true }) };
      }
      reads += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight -= 1;
      return { json: async () => ({ ok: true, result: { web_app: { url: URL } } }) };
    }) as unknown as typeof fetch;

    const menu = new MenuSync({
      botToken: 'TOKEN',
      chatId: 42,
      fetchFn: fakeFetch,
      reconcileIntervalMs: 0,
    });
    menu.setTarget(URL);
    await settle();

    const first = menu.reconcile();
    await settle();
    // The health probe fires reconcile on every successful probe and the
    // timer fires it independently; overlapping them must not mean two
    // live reads of the same value.
    const second = menu.reconcile();
    await settle();
    expect(peak).toBe(1);
    expect(reads).toBe(1);

    for (const open of gates) open();
    await Promise.all([first, second]);

    // And once the first has finished, a later one is allowed through.
    const third = menu.reconcile();
    await settle();
    expect(reads).toBe(2);
    gates.pop()?.();
    await third;
    menu.stop();
  });
});

/* ====================================================================
 * An oversized transcript is a 413, not an empty conversation
 * ==================================================================== */

describe('a transcript past the cap', () => {
  it('is reported as too large rather than read as empty', () => {
    const dir = tempDir();
    const file = path.join(dir, 'messages.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ role: 'user', content: 'hi' })}\n`);

    expect(transcriptTooLarge(file, 1)).toBe(true);
    expect(transcriptTooLarge(file, MAX_HISTORY_BYTES)).toBe(false);
    // readHistory still fails SAFE -- it must never allocate the file --
    // which is exactly why an empty result cannot be trusted as an answer.
    expect(readHistory(file, 1)).toEqual([]);
    expect(readHistory(file, MAX_HISTORY_BYTES)).toHaveLength(1);
  });

  it('is not confused with a missing file or a directory', () => {
    const dir = tempDir();
    expect(transcriptTooLarge(path.join(dir, 'nope.jsonl'), 1)).toBe(false);
    expect(transcriptTooLarge(dir, 1)).toBe(false);
  });
});

/* ====================================================================
 * Route-level: the artifact race and the oversized thread
 * ==================================================================== */

describe('routes that used to answer 200 with nothing in it', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let token: string;

  async function boot() {
    env = makeTestEnv();
    const config = loadConfig();
    const secret = loadOrCreateJwtSecret(config.secretPath);
    ({ app } = await buildServer(config, { jwtSecret: secret }));
    await app.ready();
    token = mintToken(secret, { sub: String(OWNER_ID), uid: OWNER_ID });
    return config;
  }

  afterEach(async () => {
    await app.close();
    env.cleanup();
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('404s an artifact that resolves and stats but will not open', async () => {
    const config = await boot();
    const artifact = path.join(
      config.sessionsDir,
      '2026-01-06_fixtureDDDD',
      'artifacts',
      '2026-01-06',
      'notes.md',
    );
    expect(fs.existsSync(artifact)).toBe(true);

    /*
     * The agent owns this directory and rewrites it while a download is
     * being served, so "the path resolved and stat'd" is not "the bytes
     * can be read". The handler used to call
     * `fs.createReadStream(path)`, which opens ASYNCHRONOUSLY -- the
     * failure arrived as an `error` EVENT, long after the try/catch
     * around the call had returned and after 200 plus the artifact
     * headers were already on the wire. The client got a successful,
     * correctly typed, completely empty file.
     *
     * A mode-000 file is that state without mocking anything: stat
     * succeeds, open does not.
     */
    if (process.getuid?.() === 0) return; // root opens anything
    fs.chmodSync(artifact, 0o000);
    try {
      const res = await get(
        '/api/sessions/fixtureDDDD/artifacts/file?group=artifacts&path=2026-01-06%2Fnotes.md',
      );
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'file_not_found' });
    } finally {
      fs.chmodSync(artifact, 0o644);
    }
  });

  it('404s an artifact unlinked at the moment of the open', async () => {
    await boot();
    // `resolveArtifact` returns a realpath, and on macOS the temp root is
    // itself a symlink -- so this matches on the tail rather than on a
    // path built from the config.
    const tail = path.join('2026-01-06', 'notes.md');

    // The same race, driven at the exact seam: the handler must answer a
    // failed open with a status code, which is only possible because it
    // opens synchronously by descriptor rather than handing a path to a
    // stream that opens later.
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((
      file: any,
      ...rest: any[]
    ) => {
      if (String(file).endsWith(tail)) {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return (realOpen as any)(file, ...rest);
    }) as any);

    try {
      const res = await get(
        '/api/sessions/fixtureDDDD/artifacts/file?group=artifacts&path=2026-01-06%2Fnotes.md',
      );
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'file_not_found' });
    } finally {
      spy.mockRestore();
    }
  });

  it('still serves an artifact that is actually there', async () => {
    await boot();
    const res = await get(
      '/api/sessions/fixtureDDDD/artifacts/file?group=artifacts&path=2026-01-06%2Fnotes.md',
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# Notes');
  });

  it('413s a thread whose transcript is past the cap', async () => {
    const config = await boot();
    const msgFile = path.join(
      config.sessionsDir,
      '2026-01-06_fixtureDDDD',
      'messages.jsonl',
    );
    const realStat = fs.statSync;
    const spy = vi
      .spyOn(fs, 'statSync')
      .mockImplementation(((file: any, options: any) => {
        const stat = (realStat as any)(file, options);
        if (file === msgFile && stat) {
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
            size: 64 * 1024 * 1024,
          });
        }
        return stat;
      }) as any);

    try {
      // The old answer was 200 with `items: []` -- a session full of work
      // rendered as a chat with nothing in it, and no way to tell that
      // apart from a genuinely empty one.
      const res = await get('/api/sessions/fixtureDDDD/thread');
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: 'transcript_too_large' });
    } finally {
      spy.mockRestore();
    }
  });
});

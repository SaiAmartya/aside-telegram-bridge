/**
 * The last review round: three majors and a minor, all reproduced first.
 *
 * Nothing here touches the network, the Telegram API, a real tunnel or a
 * real Aside account.
 */
import type { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Tunnel,
  assetFor,
  cloudflaredBinaryPath,
  ensureCloudflared,
  isExecutableFile,
  managedBinaryFault,
  pinnedRelease,
} from '../src/tunnel.js';
import {
  MAX_LOCAL_IMAGE_BYTES,
  localFileRoots,
  openLocalFile,
} from '../src/localfiles.js';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { mintToken } from '../src/auth.js';
import { OWNER_ID, makeTestEnv, type TestEnv } from './helpers.js';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-final-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

/** Open descriptors for this process -- used to prove nothing leaks. */
function openFdCount(): number {
  try {
    return fs.readdirSync('/dev/fd').length;
  } catch {
    return -1; // not available on this platform; the assertion is skipped
  }
}

/* ==================================================================== *
 * 1. re-acquisition actually revalidates the managed binary
 * ==================================================================== */

describe('a managed cloudflared is revalidated, not just found', () => {
  /** A bin dir holding a "verified" binary plus its marker. */
  function managed(body = 'pretend-cloudflared-binary', mode = 0o755) {
    const dir = tempDir();
    const target = cloudflaredBinaryPath(dir);
    fs.writeFileSync(target, body);
    fs.chmodSync(target, mode);
    fs.writeFileSync(
      path.join(dir, 'cloudflared.verified.json'),
      JSON.stringify({
        tag: pinnedRelease().tag,
        asset: assetFor().asset,
        sha256: crypto.createHash('sha256').update('pretend-cloudflared-binary').digest('hex'),
      }),
    );
    return { dir, target };
  }

  it('reports no fault for a good binary', () => {
    const { dir, target } = managed();
    expect(managedBinaryFault(target, dir)).toBeNull();
  });

  it('reports a lost executable bit', () => {
    // The reported failure: a managed binary at 0644. It hashes correctly
    // and cannot be spawned, so a digest-only check would miss it.
    const { dir, target } = managed('pretend-cloudflared-binary', 0o644);
    expect(isExecutableFile(target)).toBe(false);
    expect(managedBinaryFault(target, dir)).toBe('not executable');
  });

  it('reports a digest mismatch', () => {
    const { dir, target } = managed();
    fs.writeFileSync(target, 'truncated');
    fs.chmodSync(target, 0o755);
    expect(managedBinaryFault(target, dir)).toMatch(/checksum .* does not match/);
  });

  it('boot does NOT revalidate, so an ordinary start pays nothing', async () => {
    const { dir, target } = managed('pretend-cloudflared-binary', 0o644);
    globalThis.fetch = (async () => {
      throw new Error('must not download at boot');
    }) as unknown as typeof fetch;
    expect(await ensureCloudflared(dir)).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('re-acquisition restores a lost executable bit in place', async () => {
    const { dir, target } = managed('pretend-cloudflared-binary', 0o644);
    const logs: string[] = [];
    globalThis.fetch = (async () => {
      throw new Error('must not download for a mode-only fault');
    }) as unknown as typeof fetch;

    const got = await ensureCloudflared(dir, (m) => logs.push(m), {
      revalidate: true,
    });
    expect(got).toBe(target);
    expect(isExecutableFile(target)).toBe(true);
    expect(logs.join('\n')).toContain('not executable');
  });

  it('re-acquisition quarantines a corrupt binary and re-downloads', async () => {
    const { dir, target } = managed();
    fs.writeFileSync(target, 'this is not cloudflared at all');
    fs.chmodSync(target, 0o755);

    // The download is stubbed to fail, which is enough: what matters is
    // that the bad file was moved aside instead of being handed back.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      body: null,
    })) as unknown as typeof fetch;

    const logs: string[] = [];
    await expect(
      ensureCloudflared(dir, (m) => logs.push(m), { revalidate: true }),
    ).rejects.toThrow();

    expect(logs.join('\n')).toContain('is unusable');
    // Quarantined, not silently deleted, and the marker went with it.
    expect(fs.existsSync(`${target}.corrupt`)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'cloudflared.verified.json'))).toBe(false);
  });

  it('never touches a binary the user supplied themselves', async () => {
    // A user-supplied path returns from `acquire` before `ensureCloudflared`
    // is reached, so nothing in the quarantine path can ever see it.
    const dir = tempDir();
    const mine = path.join(dir, 'my-cloudflared');
    fs.writeFileSync(mine, 'mine');
    fs.chmodSync(mine, 0o644); // deliberately not executable

    const child = new EventEmitter() as any;
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.kill = vi.fn();

    const spawned: string[] = [];
    const tunnel = new Tunnel({
      port: 8790,
      binDir: path.join(dir, 'bin'),
      cloudflaredPath: mine,
      healthIntervalMs: 0,
      spawnFn: ((cmd: string) => {
        spawned.push(cmd);
        return child;
      }) as any,
    });
    await tunnel.start();
    // Two url-less deaths would trigger re-acquisition for a MANAGED
    // binary; for a supplied one it must simply re-spawn the same path.
    expect(spawned).toEqual([mine]);
    expect(fs.readFileSync(mine, 'utf8')).toBe('mine');
    expect(fs.existsSync(`${mine}.corrupt`)).toBe(false);
    tunnel.stop();
  });
});

/* ==================================================================== *
 * 2. the failure throttle cannot lock out the owner
 * ==================================================================== */

describe('the websocket upgrade throttle', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let token: string;
  let wsBase = '';

  afterEach(async () => {
    await app.close();
    env.cleanup();
  });

  async function boot() {
    env = makeTestEnv();
    const config = loadConfig();
    const secret = loadOrCreateJwtSecret(config.secretPath);
    ({ app } = await buildServer(config, { jwtSecret: secret }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    wsBase = `ws://127.0.0.1:${addr.port}/ws`;
    token = mintToken(secret, { sub: String(OWNER_ID), uid: OWNER_ID });
  }

  const probe = (url: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(url);
      ws.on('open', () => {
        ws.terminate();
        resolve('opened');
      });
      ws.on('error', () => resolve('refused'));
      setTimeout(() => resolve('timeout'), 5_000);
    });

  it('lets the valid owner in after a flood of bad attempts', async () => {
    await boot();
    /*
     * The throttle used to be consulted BEFORE the signature check, and
     * every request arrives from cloudflared on one loopback address --
     * so 20 bad tokens from anywhere filled the single shared bucket and
     * the owner's own phone got 429 for the rest of the window. The limit
     * caused the outage it was added to prevent.
     */
    for (let i = 0; i < 25; i += 1) {
      expect(await probe(`${wsBase}?token=bad-${i}`)).toBe('refused');
    }
    // The owner, with a genuinely valid JWT, immediately after.
    expect(await probe(`${wsBase}?token=${token}`)).toBe('opened');
    // And again, to show the bypass is not a one-off.
    expect(await probe(`${wsBase}?token=${token}`)).toBe('opened');
  }, 40_000);

  it('still refuses anonymous and bad-token upgrades', async () => {
    await boot();
    expect(await probe(wsBase)).toBe('refused');
    expect(await probe(`${wsBase}?token=garbage`)).toBe('refused');
    // ...and a valid token still works, so nothing was loosened.
    expect(await probe(`${wsBase}?token=${token}`)).toBe('opened');
  }, 20_000);
});

/* ==================================================================== *
 * 4. local-image checks bind to the descriptor
 * ==================================================================== */

describe('openLocalFile checks the descriptor, not the name', () => {
  function seed(): { roots: string[]; dir: string; image: string } {
    const dir = tempDir();
    const sessionDir = path.join(dir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const image = path.join(sessionDir, 'shot.png');
    fs.writeFileSync(
      image,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const roots = localFileRoots({
      sessionDir,
      uploadsDir: path.join(dir, 'uploads'),
      mediaDir: path.join(dir, 'media'),
    });
    return { roots, dir, image };
  }

  it('opens a real image and reports its size from the descriptor', () => {
    const { roots, image } = seed();
    const opened = openLocalFile(roots, image);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.contentType).toBe('image/png');
    expect(opened.size).toBe(fs.statSync(image).size);
    fs.closeSync(opened.fd);
  });

  it('refuses a final component that is a symlink', () => {
    const { roots, dir, image } = seed();
    // The containment decision used to be made on the path and then a
    // separate open followed whatever the name meant by then. O_NOFOLLOW
    // refuses the open outright.
    const outside = path.join(dir, 'outside.png');
    fs.writeFileSync(outside, 'not in a root');
    const link = path.join(path.dirname(image), 'link.png');
    fs.symlinkSync(outside, link);

    const opened = openLocalFile(roots, link);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    // `realpath` already resolves it outside the roots; either refusal is
    // correct, and neither may be a successful open.
    expect(['forbidden_path', 'file_not_found']).toContain(opened.reason);
  });

  it('serves an alias that legitimately resolves inside a root', () => {
    const { roots, image } = seed();
    // `resolveLocalFile` realpaths before deciding containment and
    // `openLocalFile` opens THAT resolved path, so an alias to a contained
    // file is a contained file. This is the behaviour O_NOFOLLOW must not
    // break.
    const link = path.join(path.dirname(image), 'alias.png');
    fs.symlinkSync(image, link);
    const opened = openLocalFile(roots, link);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.file).toBe(fs.realpathSync(image));
      fs.closeSync(opened.fd);
    }
  });

  it('refuses a path that became a symlink after it was resolved', () => {
    const { roots, dir, image } = seed();
    /*
     * The actual race: containment, type and size were all decided from
     * the resolved path, and the open happened afterwards. Here realpath
     * is made to return a name that IS a symlink at open time -- inside a
     * root, so path-side containment is satisfied -- pointing at a file
     * outside every root. That is precisely the swap an agent rewriting
     * its own directory can produce. Without O_NOFOLLOW the open follows
     * it and streams bytes no check ever saw.
     */
    const outside = path.join(dir, 'elsewhere.png');
    fs.writeFileSync(outside, 'bytes from outside every root');
    // Built under the REALPATH of the root, so `startsWith(root)` holds.
    const link = path.join(roots[0], 'swapped.png');
    fs.symlinkSync(outside, link);

    const realReal = fs.realpathSync;
    const spy = vi.spyOn(fs, 'realpathSync').mockImplementation(((
      target: any,
      ...rest: any[]
    ) => {
      if (String(target) === image) return link; // resolved -> a symlink
      return (realReal as any)(target, ...rest);
    }) as any);
    try {
      const opened = openLocalFile(roots, image);
      if ((fs.constants.O_NOFOLLOW ?? 0) === 0) {
        if (opened.ok) fs.closeSync(opened.fd);
        return; // no such flag on this platform
      }
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.reason).toBe('forbidden_path');
    } finally {
      spy.mockRestore();
    }
  });

  it('enforces the size cap on the DESCRIPTOR, not the earlier stat', () => {
    const { roots, image } = seed();
    // `resolveLocalFile` measured the path; this makes that measurement a
    // lie by the time the bytes are opened, which is what the fd-side
    // check exists to catch.
    const realStat = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((
      target: any,
      ...rest: any[]
    ) => {
      const st = (realStat as any)(target, ...rest);
      if (st && String(target) === fs.realpathSync(image)) {
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          size: 1,
          isFile: () => true,
        });
      }
      return st;
    }) as any);
    try {
      const opened = openLocalFile(roots, image, 4);
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.reason).toBe('file_too_large');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a directory rather than streaming it', () => {
    const { roots, image } = seed();
    const asDir = path.join(path.dirname(image), 'dir.png');
    fs.mkdirSync(asDir);
    const opened = openLocalFile(roots, asDir);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toBe('file_not_found');
  });

  it('enforces the cap on the opened bytes', () => {
    const { roots, image } = seed();
    const opened = openLocalFile(roots, image, 4);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toBe('file_too_large');
  });

  it('leaks no descriptor on any rejecting path', () => {
    const { roots, dir, image } = seed();
    const before = openFdCount();
    if (before < 0) return; // /dev/fd unavailable
    for (let i = 0; i < 40; i += 1) {
      openLocalFile(roots, image, 4); // too large
      openLocalFile(roots, path.join(dir, 'nope.png')); // missing
      openLocalFile(roots, '/etc/hosts'); // wrong type + outside
    }
    expect(openFdCount()).toBeLessThanOrEqual(before + 2);
  });

  it('keeps the path-side rules it already had', () => {
    const { roots, image } = seed();
    expect(openLocalFile(roots, 'relative.png')).toEqual({
      ok: false,
      reason: 'bad_path',
    });
    expect(openLocalFile(roots, `${image}\0.png`)).toEqual({
      ok: false,
      reason: 'bad_path',
    });
    expect(openLocalFile(roots, '/etc/hosts')).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
    expect(MAX_LOCAL_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});

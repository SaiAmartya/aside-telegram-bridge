/**
 * Tunnel supervision and menu registration.
 *
 * Nothing here touches the network or spawns a process: the cloudflared
 * output below is a captured sample, and `registerMenuButton` is driven
 * through an injected fetch. The real Bot API is never called from tests.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Tunnel,
  assetFor,
  ensureCloudflared,
  menuButtonPayload,
  parseTunnelUrl,
  pinnedRelease,
  registerMenuButton,
  rotateLog,
  sha256File,
  userSuppliedCloudflared,
} from '../src/tunnel.js';

/** Real `cloudflared tunnel --url` banner output. */
const BANNER = `
2026-07-25T12:00:00Z INF Thank you for trying Cloudflare Tunnel.
2026-07-25T12:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):   |
|  https://shiny-otter-pool-vast.trycloudflare.com                                            |
+--------------------------------------------------------------------------------------------+
2026-07-25T12:00:01Z INF Connection registered connIndex=0
`;

describe('parseTunnelUrl', () => {
  it('finds the hostname inside the ASCII banner', () => {
    expect(parseTunnelUrl(BANNER)).toBe(
      'https://shiny-otter-pool-vast.trycloudflare.com',
    );
  });

  it('handles the URL arriving alone on a later chunk', () => {
    expect(parseTunnelUrl('|  https://abc-def-123.trycloudflare.com  |')).toBe(
      'https://abc-def-123.trycloudflare.com',
    );
  });

  it('returns null for output with no tunnel URL', () => {
    expect(parseTunnelUrl('INF Connection registered')).toBeNull();
    expect(parseTunnelUrl('')).toBeNull();
    // A different host must not be mistaken for a tunnel.
    expect(parseTunnelUrl('https://example.com')).toBeNull();
  });
});

describe('assetFor', () => {
  it('picks the right release asset per platform', () => {
    expect(assetFor('darwin', 'arm64')).toEqual({
      asset: 'cloudflared-darwin-arm64.tgz',
      archive: 'tgz',
    });
    expect(assetFor('darwin', 'x64')).toEqual({
      asset: 'cloudflared-darwin-amd64.tgz',
      archive: 'tgz',
    });
    expect(assetFor('linux', 'x64')).toEqual({
      asset: 'cloudflared-linux-amd64',
      archive: 'raw',
    });
    expect(assetFor('linux', 'arm64')).toEqual({
      asset: 'cloudflared-linux-arm64',
      archive: 'raw',
    });
  });

  it('serves Windows now that its checksums are pinned', () => {
    // win32 used to throw. It ships a bare .exe, not a tarball.
    expect(assetFor('win32', 'x64')).toEqual({
      asset: 'cloudflared-windows-amd64.exe',
      archive: 'raw',
    });
    expect(assetFor('win32', 'ia32')).toEqual({
      asset: 'cloudflared-windows-386.exe',
      archive: 'raw',
    });
  });

  it('refuses platforms cloudflared does not ship for, and says what to do', () => {
    const run = () => assetFor('aix', 'ppc64');
    expect(run).toThrow(/no build for aix\/ppc64/);
    // A refusal that names no way forward is just a dead end.
    expect(run).toThrow(/MINIAPP_TUNNEL=none/);
    expect(run).toThrow(/MINIAPP_CLOUDFLARED_PATH/);
  });

  it('has a pinned checksum for every asset it can select', () => {
    // A platform mapping with no vendored hash fails closed at download
    // time, which is a worse way to find out than a failing test.
    const { assets } = pinnedRelease();
    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      for (const arch of ['x64', 'arm64', 'arm', 'ia32']) {
        let picked;
        try {
          picked = assetFor(platform, arch);
        } catch {
          continue;
        }
        expect(assets[picked.asset], `${platform}/${arch}`).toBeTruthy();
      }
    }
  });
});

/** A stand-in child process whose streams we drive by hand. */
function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn();
  return child;
}

describe('Tunnel', () => {
  it('reports the URL it parses out of cloudflared', async () => {
    const child = fakeChild();
    const urls: string[] = [];
    const tunnel = new Tunnel({
      port: 8790,
      binDir: '/tmp/unused',
      onUrl: (url) => urls.push(url),
      spawnFn: (() => child) as any,
      downloadFn: async () => {},
    });

    await tunnel.start();
    child.stderr.push(BANNER);
    await new Promise((r) => setImmediate(r));

    expect(urls).toEqual(['https://shiny-otter-pool-vast.trycloudflare.com']);
    expect(tunnel.url).toBe('https://shiny-otter-pool-vast.trycloudflare.com');
    tunnel.stop();
  });

  it('reports a rotated hostname exactly once per change', async () => {
    const child = fakeChild();
    const urls: string[] = [];
    const tunnel = new Tunnel({
      port: 8790,
      binDir: '/tmp/unused',
      onUrl: (url) => urls.push(url),
      spawnFn: (() => child) as any,
      downloadFn: async () => {},
    });

    await tunnel.start();
    child.stderr.push(BANNER);
    await new Promise((r) => setImmediate(r));
    // The same URL repeated in later output must not re-fire.
    child.stderr.push(BANNER);
    await new Promise((r) => setImmediate(r));
    child.stderr.push('https://second-name-here.trycloudflare.com');
    await new Promise((r) => setImmediate(r));

    expect(urls).toEqual([
      'https://shiny-otter-pool-vast.trycloudflare.com',
      'https://second-name-here.trycloudflare.com',
    ]);
    tunnel.stop();
  });

  it('stops supervising once stopped', async () => {
    const child = fakeChild();
    let spawns = 0;
    const tunnel = new Tunnel({
      port: 8790,
      binDir: '/tmp/unused',
      spawnFn: ((): any => {
        spawns += 1;
        return child;
      }) as any,
      downloadFn: async () => {},
    });

    await tunnel.start();
    expect(spawns).toBe(1);
    tunnel.stop();
    child.emit('exit', 0);
    await new Promise((r) => setImmediate(r));
    expect(spawns).toBe(1);
  });

  it('clears the URL when the process dies, so a stale host is not reported live', async () => {
    const child = fakeChild();
    const tunnel = new Tunnel({
      port: 8790,
      binDir: '/tmp/unused',
      spawnFn: (() => child) as any,
      downloadFn: async () => {},
    });
    await tunnel.start();
    child.stderr.push(BANNER);
    await new Promise((r) => setImmediate(r));
    expect(tunnel.url).not.toBeNull();

    child.emit('exit', 1);
    expect(tunnel.url).toBeNull();
    tunnel.stop();
  });
});

describe('menu button', () => {
  it('builds the Telegram web_app payload', () => {
    expect(
      menuButtonPayload('https://abc.trycloudflare.com'),
    ).toEqual({
      menu_button: {
        type: 'web_app',
        text: 'Aside',
        web_app: { url: 'https://abc.trycloudflare.com' },
      },
    });
  });

  it('posts setChatMenuButton through the injected fetch only', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;

    const res = await registerMenuButton(
      'TOKEN',
      'https://abc.trycloudflare.com',
      987654321,
      fakeFetch,
    );

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://api.telegram.org/botTOKEN/setChatMenuButton',
    );
    expect(calls[0].body).toEqual(
      menuButtonPayload('https://abc.trycloudflare.com', 'Aside', 987654321),
    );
  });

  it('reports a rejection instead of throwing', async () => {
    const fakeFetch = (async () => ({
      json: async () => ({ ok: false, description: 'Unauthorized' }),
    })) as unknown as typeof fetch;

    const res = await registerMenuButton('TOKEN', 'https://x.trycloudflare.com', undefined, fakeFetch);
    expect(res).toEqual({ ok: false, description: 'Unauthorized' });
  });
});

/**
 * Audit M-6: the binary that gets chmod 755'd and executed.
 *
 * `fetch` is stubbed, so nothing here reaches the network -- the point is
 * that a body which does not hash to the vendored digest must never end up
 * at the destination path, and that the failure names a way forward
 * instead of a way to skip the check.
 */
describe('cloudflared integrity (M-6)', () => {
  const temps: string[] = [];
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MINIAPP_CLOUDFLARED_PATH;
    while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
  });

  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-cf-'));
    temps.push(dir);
    return dir;
  };

  const serve = (body: string) => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: Readable.toWeb(Readable.from([Buffer.from(body)])),
    })) as unknown as typeof fetch;
  };

  it('pins a release tag rather than tracking latest', () => {
    const { tag, assets } = pinnedRelease();
    expect(tag).toMatch(/^\d{4}\.\d+\.\d+$/);
    // Every asset `assetFor` can name has to have a digest, or the fail-
    // closed path fires for a platform we claim to support.
    for (const [platform, arch] of [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['linux', 'arm'],
    ] as const) {
      const { asset } = assetFor(platform, arch);
      expect(assets[asset], asset).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses a download whose bytes do not match the vendored digest', async () => {
    const dir = tempDir();
    serve('this is not cloudflared');
    await expect(ensureCloudflared(dir)).rejects.toThrow(/checksum mismatch/);
    // Nothing was left behind that a later run could mistake for verified.
    expect(fs.existsSync(path.join(dir, 'cloudflared'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'cloudflared.part'))).toBe(false);
  });

  it('names the escape hatches when it fails, and no way to skip the check', async () => {
    const dir = tempDir();
    serve('nope');
    const err = await ensureCloudflared(dir).catch((e: Error) => e.message);
    expect(err).toContain('MINIAPP_CLOUDFLARED_PATH');
    expect(err).toContain('cloudflared_path');
    expect(err).not.toMatch(/skip|disable|insecure/i);
  });

  it('accepts bytes that do hash to the vendored digest', async () => {
    const dir = tempDir();
    // Drive the raw-asset path with a body whose digest we pin for this
    // one call, so the success branch is exercised without a 39 MB fetch.
    const body = 'pretend-cloudflared-binary';
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    const release = pinnedRelease();
    const { asset } = assetFor(process.platform, process.arch);
    const original = release.assets[asset];
    const archive = assetFor(process.platform, process.arch).archive;
    release.assets[asset] = digest;
    serve(body);
    try {
      if (archive === 'raw') {
        const bin = await ensureCloudflared(dir);
        expect(sha256File(bin)).toBe(digest);
        // The marker records what was verified, so a moved pin is visible.
        const marker = JSON.parse(
          fs.readFileSync(path.join(dir, 'cloudflared.verified.json'), 'utf8'),
        );
        expect(marker).toEqual({ tag: release.tag, asset, sha256: digest });
      } else {
        // darwin: the verified bytes are a tarball, so extraction fails on
        // a fake body -- which is still proof the digest check passed.
        await expect(ensureCloudflared(dir)).rejects.not.toThrow(
          /checksum mismatch/,
        );
      }
    } finally {
      release.assets[asset] = original;
    }
  });

  it('reuses a binary that is already there', async () => {
    const dir = tempDir();
    const bin = path.join(dir, 'cloudflared');
    fs.writeFileSync(bin, 'already here');
    globalThis.fetch = (async () => {
      throw new Error('must not download');
    }) as unknown as typeof fetch;
    expect(await ensureCloudflared(dir)).toBe(bin);
  });

  it('lets the owner supply their own binary instead', () => {
    const dir = tempDir();
    const bin = path.join(dir, 'my-cloudflared');
    fs.writeFileSync(bin, 'mine');

    expect(userSuppliedCloudflared()).toBeNull();
    expect(userSuppliedCloudflared(bin)).toBe(bin);
    process.env.MINIAPP_CLOUDFLARED_PATH = bin;
    // The env wins, so a one-off run overrides config without editing the
    // file that carries the bot token.
    expect(userSuppliedCloudflared('/somewhere/else')).toBe(bin);
    delete process.env.MINIAPP_CLOUDFLARED_PATH;

    expect(() => userSuppliedCloudflared('/no/such/cloudflared')).toThrow(
      /does not exist/,
    );
  });

  it('spawns a supplied binary without downloading anything', async () => {
    const dir = tempDir();
    const bin = path.join(dir, 'my-cloudflared');
    fs.writeFileSync(bin, 'mine');
    globalThis.fetch = (async () => {
      throw new Error('must not download');
    }) as unknown as typeof fetch;

    const child = fakeChild();
    const spawned: string[] = [];
    const tunnel = new Tunnel({
      port: 8790,
      binDir: path.join(dir, 'bin'),
      cloudflaredPath: bin,
      spawnFn: ((cmd: string) => {
        spawned.push(cmd);
        return child;
      }) as any,
    });
    await tunnel.start();
    expect(spawned).toEqual([bin]);
    tunnel.stop();
  });
});

describe('rotateLog', () => {
  const temps: string[] = [];
  afterEach(() => {
    while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
  });

  it('rotates a log past its cap and leaves a small one alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-log-'));
    temps.push(dir);
    const big = path.join(dir, 'big.log');
    const small = path.join(dir, 'small.log');
    fs.writeFileSync(big, 'x'.repeat(200));
    fs.writeFileSync(small, 'x');

    rotateLog(big, 100);
    expect(fs.existsSync(`${big}.1`)).toBe(true);
    expect(fs.existsSync(big)).toBe(false);

    rotateLog(small, 100);
    expect(fs.existsSync(small)).toBe(true);
    expect(fs.existsSync(`${small}.1`)).toBe(false);
  });

  it('is a no-op for a missing file', () => {
    expect(() => rotateLog('/nope/none.log', 10)).not.toThrow();
  });
});

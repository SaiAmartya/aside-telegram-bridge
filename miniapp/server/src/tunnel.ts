/**
 * Public HTTPS exposure, with no extra tooling for the end user.
 *
 * A Telegram Mini App must be served over HTTPS from a public URL, but the
 * server runs on someone's Mac. Rather than making people set up Tailscale
 * or a Cloudflare account, this downloads the static `cloudflared` binary
 * once and runs a quick tunnel, which needs no account at all.
 *
 * The tradeoff, deliberately taken: a quick tunnel's hostname is ephemeral
 * and changes on every restart. That is why `onUrl` exists and why menu
 * registration is wired to it -- when the hostname rotates, the menu
 * button is pointed at the new one.
 *
 * The binary lives under the bridge's state directory, never in the repo.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { defaultAsideRoot } from './config.js';

/**
 * The pinned release and its vendored digests -- audit finding M-6.
 *
 * Read from disk rather than `import`ed so the file stays plain JSON that
 * a human can diff when the pin moves, and so no import-attribute syntax
 * is needed on the Node versions this supports. The build copies it next
 * to the emitted JS; under vitest `import.meta.url` is the source file, so
 * both resolve to a real path.
 */
export interface PinnedRelease {
  tag: string;
  assets: Record<string, string>;
}

const RELEASE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'cloudflared-release.json',
);

let pinnedCache: PinnedRelease | null = null;

export function pinnedRelease(): PinnedRelease {
  if (!pinnedCache) {
    const raw = JSON.parse(fs.readFileSync(RELEASE_FILE, 'utf8')) as PinnedRelease;
    pinnedCache = { tag: String(raw.tag), assets: raw.assets || {} };
  }
  return pinnedCache;
}

function releaseBase(): string {
  return `https://github.com/cloudflare/cloudflared/releases/download/${
    pinnedRelease().tag
  }`;
}

/**
 * What to tell someone whose download did not verify.
 *
 * Failing closed is only defensible if there is a way forward that is not
 * "turn the check off", so both escape hatches are named every time.
 */
const BYO_BINARY_HINT =
  'Point the server at a cloudflared you installed yourself instead: set ' +
  'MINIAPP_CLOUDFLARED_PATH=/path/to/cloudflared, or "cloudflared_path" ' +
  'in the miniapp section of config.json (`brew install cloudflared`).';

/** Any trycloudflare hostname the CLI prints as it comes up or rotates. */
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

/**
 * Hostnames under trycloudflare.com that are NOT this machine's tunnel.
 *
 * cloudflared talks to `api.trycloudflare.com` to register a quick tunnel
 * and prints that hostname inside its own error text when registration
 * fails -- which is exactly what happens on a laptop that just woke up and
 * has no network yet. The old parser matched it, published it as the public
 * URL, and pushed it to Telegram's menu button. Observed in the wild on
 * 2026-08-02: `tunnel url https://api.trycloudflare.com` immediately
 * followed by `tunnel exited (1)`.
 *
 * A real quick-tunnel hostname is a multi-word hyphenated slug, so a bare
 * single-label host is rejected on both counts: the denylist and the
 * missing hyphen.
 */
const RESERVED_TUNNEL_HOSTS = new Set([
  'api',
  'www',
  'dash',
  'developers',
  'update',
  'protocol-v2',
  'region1',
  'region2',
]);

/** True when `host` looks like a real ephemeral quick-tunnel slug. */
export function isQuickTunnelHost(host: string): boolean {
  const label = String(host || '')
    .replace(/^https:\/\//i, '')
    .replace(/\.trycloudflare\.com\/?$/i, '')
    .toLowerCase();
  if (!label || RESERVED_TUNNEL_HOSTS.has(label)) return false;
  // Quick tunnels are always several words joined by hyphens. Anything
  // without one is infrastructure, not us.
  return label.includes('-');
}

export interface TunnelAsset {
  asset: string;
  /** darwin ships gzipped tarballs; linux ships a bare binary. */
  archive: 'tgz' | 'raw';
}

/**
 * What the downloaded binary is called on disk.
 *
 * Windows will not execute a file without an executable extension, and
 * `assetFor` already selects a `.exe` there -- so writing it out as a
 * bare `cloudflared` produced a file that verified, chmod'd and then
 * failed at spawn with ENOENT, on the one platform the Windows support
 * was added for.
 */
export function cloudflaredBinaryName(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

/** The verified binary's path inside `binDir`, for this platform. */
export function cloudflaredBinaryPath(
  binDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(binDir, cloudflaredBinaryName(platform));
}

/**
 * Which release asset this machine needs.
 *
 * Exported so the platform matrix is testable without downloading
 * anything.
 */
export function assetFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): TunnelAsset {
  const is64 = arch === 'x64' || arch === 'x86_64';
  if (platform === 'darwin') {
    return {
      asset: is64 ? 'cloudflared-darwin-amd64.tgz' : 'cloudflared-darwin-arm64.tgz',
      archive: 'tgz',
    };
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { asset: 'cloudflared-linux-arm64', archive: 'raw' };
    if (arch === 'arm') return { asset: 'cloudflared-linux-arm', archive: 'raw' };
    return { asset: 'cloudflared-linux-amd64', archive: 'raw' };
  }
  if (platform === 'win32') {
    return {
      asset: is64 ? 'cloudflared-windows-amd64.exe' : 'cloudflared-windows-386.exe',
      archive: 'raw',
    };
  }
  // Reached only on genuinely exotic platforms now. Name the two ways
  // forward rather than just refusing: an unsupported tunnel is not the
  // same as an unusable app, since the server still runs locally.
  throw new Error(
    `cloudflared has no build for ${platform}/${arch}. Run with ` +
      'MINIAPP_TUNNEL=none and expose the port yourself, or install ' +
      'cloudflared and set MINIAPP_CLOUDFLARED_PATH.',
  );
}

/**
 * First trycloudflare URL in a chunk of cloudflared output.
 *
 * cloudflared banners the URL inside an ASCII box across several lines, so
 * this scans rather than matching a fixed line shape.
 */
export function parseTunnelUrl(chunk: string): string | null {
  const matches = String(chunk || '').match(URL_RE);
  if (!matches) return null;
  for (const match of matches) {
    const url = match.toLowerCase();
    if (isQuickTunnelHost(url)) return url;
  }
  return null;
}

export interface TunnelOptions {
  port: number;
  /** Directory for the downloaded binary -- outside the repo. */
  binDir: string;
  /** A cloudflared the user installed themselves; skips the download. */
  cloudflaredPath?: string;
  onUrl?: (url: string) => void;
  log?: (message: string) => void;
  /** Injected in tests so no network or process is ever touched. */
  spawnFn?: typeof spawn;
  downloadFn?: (dest: string) => Promise<void>;
  /**
   * How often to probe the PUBLIC url and check for a sleep/wake gap.
   * Defaults to 45s; set to 0 to disable the watchdog entirely.
   */
  healthIntervalMs?: number;
  /** Consecutive probe failures before the tunnel is force-recycled. */
  healthFailureLimit?: number;
  /** Fired every time a probe confirms the public url is reachable. */
  onHealthy?: (url: string) => void;
  /** Injected in tests. */
  fetchFn?: typeof fetch;
  /**
   * Base backoff between attempts to ACQUIRE the binary at startup.
   *
   * Distinct from the restart backoff: acquiring can fail for minutes
   * (no network yet on a machine that just booted), and giving up on it
   * is what left the tunnel permanently down. Defaults to 5s, doubling to
   * a 60s ceiling. 0 disables the retry, which is only ever what a test
   * wants.
   */
  startRetryMs?: number;
}

/**
 * Extra timer lag that means "this machine was asleep", not "this machine
 * was busy".
 *
 * A setInterval does not fire while macOS is suspended, so the first tick
 * after the lid opens arrives late by roughly the sleep duration. 20s of
 * slack is far more than scheduler jitter and far less than any real nap.
 */
const WAKE_DRIFT_MS = 20_000;

export function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * Download to `dest`, but only publish it if the bytes hash to `expected`.
 *
 * The partial file is written under `.part` and hashed there, so a
 * mismatch never leaves anything at the destination path that a later
 * run would mistake for a verified binary.
 */
async function download(
  url: string,
  dest: string,
  expected: string,
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`download failed (${res.status}) for ${url}`);
  }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await pipeline(res.body as any, fs.createWriteStream(tmp));

  const actual = sha256File(tmp);
  if (actual !== expected) {
    await fs.promises.rm(tmp, { force: true });
    throw new Error(
      `cloudflared checksum mismatch for ${path.basename(url)}: expected ` +
        `${expected}, got ${actual}. Refusing to run it. ${BYO_BINARY_HINT}`,
    );
  }
  await fs.promises.rename(tmp, dest);
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/**
 * A cloudflared the user installed themselves, or null.
 *
 * The env var wins over config so a one-off run can override an install
 * without editing the file that carries the bot token. Both are checked
 * before anything is downloaded: someone who has already got the binary
 * should never be made to fetch a second copy.
 */
export function userSuppliedCloudflared(
  configured?: string,
): string | null {
  const raw = (process.env.MINIAPP_CLOUDFLARED_PATH || configured || '').trim();
  if (!raw) return null;
  const expanded = raw.startsWith('~/')
    ? path.join(os.homedir(), raw.slice(2))
    : raw;
  if (!fs.existsSync(expanded)) {
    throw new Error(
      `cloudflared_path points at ${expanded}, which does not exist`,
    );
  }
  return expanded;
}

/** Where the verified-download marker for `binDir` lives. */
function markerPath(binDir: string): string {
  return path.join(binDir, 'cloudflared.verified.json');
}

/** What the marker records about the file that was written next to it. */
interface VerifiedMarker {
  tag: string;
  asset: string;
  sha256: string;
}

function readMarker(binDir: string): VerifiedMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath(binDir), 'utf8'));
    return {
      tag: String(raw.tag || ''),
      asset: String(raw.asset || ''),
      sha256: String(raw.sha256 || ''),
    };
  } catch {
    // pre-M-6 install: no marker was ever written
    return null;
  }
}

/** True when this platform cares about the executable bit at all. */
function needsExecutableBit(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/** True when `file`'s mode lets somebody execute it. */
export function isExecutableFile(file: string): boolean {
  if (!needsExecutableBit()) return fs.existsSync(file);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  return Boolean(stat?.isFile() && (stat.mode & 0o111) !== 0);
}

/**
 * Move a managed binary out of the way so the next attempt re-downloads.
 *
 * Renamed rather than unlinked: whatever was there was executed (or was
 * meant to be), and if this ever fires on something that was actually
 * fine, the bytes are still on disk to look at. The marker goes with it,
 * because a marker describing a file that is no longer there is worse
 * than no marker.
 *
 * ONLY ever called for `binDir`, which is this app's own state directory.
 * A user-supplied `cloudflared_path` never reaches here: `Tunnel.acquire`
 * returns it before `ensureCloudflared` is called, precisely so that
 * nothing in this file can rename or delete a binary somebody else owns.
 */
function quarantine(target: string, binDir: string, log: (m: string) => void): void {
  const moved = `${target}.corrupt`;
  try {
    fs.rmSync(moved, { force: true });
    fs.renameSync(target, moved);
    log(`quarantined the unusable cloudflared at ${moved}`);
  } catch {
    // Rename failed (read-only dir, races). Removing it is still better
    // than looping on a binary that cannot run.
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // Nothing else to try; the download below will fail loudly.
    }
  }
  try {
    fs.rmSync(markerPath(binDir), { force: true });
  } catch {
    // best effort
  }
}

/**
 * Whether the managed binary already on disk is still usable.
 *
 * Returns a reason string when it is not, or null when it is fine. Both
 * halves matter and they fail differently: a truncated or swapped file
 * hashes wrong, and a file that lost its executable bit hashes RIGHT and
 * still cannot be spawned.
 */
export function managedBinaryFault(
  target: string,
  binDir: string,
): string | null {
  const marker = readMarker(binDir);
  const { assets } = pinnedRelease();
  // Prefer the digest the file was actually verified against; fall back
  // to the current pin's digest for this platform's asset.
  let expected = marker?.sha256 || '';
  if (!expected) {
    try {
      expected = assets[assetFor().asset] || '';
    } catch {
      expected = '';
    }
  }
  if (expected) {
    let actual = '';
    try {
      actual = sha256File(target);
    } catch (err) {
      return `unreadable (${(err as Error).message})`;
    }
    if (actual !== expected) {
      // With no marker this could equally be a legitimately older build,
      // so only a MARKED file is called corrupt on digest alone.
      if (marker?.sha256) return `checksum ${actual} does not match ${expected}`;
    }
  }
  if (needsExecutableBit() && !isExecutableFile(target)) {
    return 'not executable';
  }
  return null;
}

/**
 * Ensure a verified binary exists at `binDir/cloudflared`.
 *
 * Audit finding M-6 was that this downloaded from
 * `releases/latest/download`, chmod 755'd whatever arrived and executed
 * it, with HTTPS to github.com as the only control. Now the release tag
 * is pinned and every asset's SHA-256 is vendored in
 * `cloudflared-release.json`; a mismatch deletes the partial file and
 * throws, and there is no flag to skip the check -- the way past it is to
 * supply your own binary, which is an explicit choice rather than a
 * silent downgrade.
 *
 * An existing binary is reused. When it carries a marker from an older
 * pin the marker is honoured rather than forcing a re-download: the file
 * on disk was verified against the pin that was current when it landed,
 * and silently replacing a working tunnel binary on upgrade is a worse
 * failure mode than running a slightly older cloudflared.
 *
 * `revalidate` is what makes the supervisor's re-acquisition real. Without
 * it this function returned ANY existing file untouched -- so the
 * re-acquire path that exists to repair a broken binary handed the broken
 * binary straight back, and the tunnel cycled on it forever. The
 * supervisor sets it after a run that never produced a hostname, which is
 * the one moment "what is on disk does not work" is known to be true; at
 * that point the file is checked against its recorded digest and its
 * executable bit, and anything that fails is quarantined and re-fetched.
 * Boot stays lenient, so an ordinary start never pays for a 40MB download
 * it does not need.
 */
export async function ensureCloudflared(
  binDir: string,
  log: (m: string) => void = () => {},
  opts: { revalidate?: boolean } = {},
): Promise<string> {
  const target = cloudflaredBinaryPath(binDir);
  const { tag, assets } = pinnedRelease();

  if (fs.existsSync(target)) {
    const marker = readMarker(binDir);
    const verifiedTag = marker?.tag || '';

    if (opts.revalidate) {
      const fault = managedBinaryFault(target, binDir);
      if (fault) {
        log(`cloudflared at ${target} is unusable: ${fault}`);
        // A lost executable bit is ours to put back -- this is our own
        // file in our own state directory, and a 40MB download to fix a
        // mode is the wrong trade.
        if (fault === 'not executable') {
          try {
            fs.chmodSync(target, 0o755);
          } catch {
            // fall through to quarantine
          }
        }
        if (managedBinaryFault(target, binDir)) {
          quarantine(target, binDir, log);
          // Fall through to the download path below.
        } else {
          log('restored the executable bit on cloudflared');
          return target;
        }
      } else {
        return target;
      }
    } else {
      if (verifiedTag && verifiedTag !== tag) {
        log(
          `cloudflared on disk was verified against ${verifiedTag}; pin is now ` +
            `${tag}. Delete ${target} to fetch and verify the pinned build.`,
        );
      } else if (!verifiedTag) {
        log(
          `cloudflared on disk predates checksum verification. Delete ${target} ` +
            'to re-fetch it against the pinned release.',
        );
      }
      return target;
    }
  }

  const { asset, archive } = assetFor();
  const expected = assets[asset];
  if (!expected) {
    throw new Error(
      `no vendored SHA-256 for ${asset} at cloudflared ${tag}, so it cannot ` +
        `be verified and will not be run. ${BYO_BINARY_HINT}`,
    );
  }

  const url = `${releaseBase()}/${asset}`;
  log(`downloading cloudflared ${tag} (${asset})`);
  await fs.promises.mkdir(binDir, { recursive: true });

  if (archive === 'raw') {
    await download(url, target, expected);
  } else {
    const tgz = path.join(binDir, asset);
    await download(url, tgz, expected);
    await run('tar', ['-xzf', tgz, '-C', binDir]);
    await fs.promises.rm(tgz, { force: true });
    // The darwin tarball unpacks to `cloudflared` already; if a release
    // ever nests it, surface that clearly rather than failing at spawn.
    if (!fs.existsSync(target)) {
      throw new Error(`cloudflared not found in ${asset} after extraction`);
    }
  }

  // No-op on Windows (NTFS has no mode bits), and it throws on some
  // filesystems there rather than being ignored.
  if (process.platform !== 'win32') await fs.promises.chmod(target, 0o755);
  fs.writeFileSync(
    markerPath(binDir),
    JSON.stringify({ tag, asset, sha256: expected }, null, 2),
  );
  log(`cloudflared ${tag} verified and ready`);
  return target;
}

/**
 * A supervised quick tunnel.
 *
 * Restarts with backoff if cloudflared exits -- which it does on network
 * loss and on sleep/wake -- and reports every hostname change through
 * `onUrl`.
 */
export class Tunnel {
  private child: ChildProcess | null = null;
  private stopped = false;
  private restarts = 0;
  private timer: NodeJS.Timeout | null = null;
  private monitor: NodeJS.Timeout | null = null;
  private lastTick = Date.now();
  private failures = 0;
  private recycling = false;
  /** Consecutive child deaths that never produced a url. */
  private spawnFailures = 0;
  /** True while an acquire+spawn cycle is in flight, so two cannot race. */
  private acquiring = false;
  url: string | null = null;

  constructor(private readonly opts: TunnelOptions) {}

  private log(message: string): void {
    this.opts.log?.(message);
  }

  private handleChunk(chunk: string): void {
    const found = parseTunnelUrl(chunk);
    if (!found || found === this.url) return;
    this.url = found;
    this.log(`tunnel url ${found}`);
    this.opts.onUrl?.(found);
  }

  /**
   * Probe the tunnel from the OUTSIDE.
   *
   * Checking that the child process is alive is not the same as checking
   * that the tunnel works, and after a sleep/wake cycle those two answers
   * routinely disagree: cloudflared keeps running while its edge
   * connections are dead, so `exit` never fires, nothing restarts, and the
   * hostname Telegram is pointed at serves Cloudflare's own 5xx error page
   * forever. Only a request that travels out to Cloudflare and back to this
   * process can tell the difference.
   */
  private async probe(url: string): Promise<boolean> {
    const fetchFn = this.opts.fetchFn || fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetchFn(`${url}/api/health`, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'cache-control': 'no-cache' },
      });
      // Cloudflare's tunnel-down pages are 502/503/530. Anything this
      // origin generated itself (including a 401) proves the path is up.
      return res.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Tear the child down so the exit handler brings up a fresh hostname. */
  recycle(reason: string): void {
    if (this.stopped || this.recycling) return;
    this.recycling = true;
    this.failures = 0;
    this.url = null;
    this.log(`recycling tunnel: ${reason}`);
    const child = this.child;
    if (!child) {
      // Nothing running and no pending restart means the backoff timer was
      // the only thing holding it; let it proceed.
      this.recycling = false;
      return;
    }
    child.kill('SIGTERM');
    // A cloudflared wedged on a dead socket can ignore SIGTERM. Do not let
    // a hung child block the restart path indefinitely.
    const hard = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 5_000);
    hard.unref?.();

    /*
     * `recycling` MUST come back down, on every path.
     *
     * It was cleared only from `exit`, and `exit` is precisely the event a
     * child that never started does not emit: a spawn failure (a deleted
     * or non-executable binary) emits `error` then `close` and nothing
     * else. That left the flag stuck true, and a stuck flag makes every
     * later `recycle` a no-op -- so the one fault the watchdog exists to
     * repair became the one fault it could never repair. `close` is
     * emitted for both outcomes, and the timer is the backstop for an
     * emitter that somehow emits neither.
     */
    let settled = false;
    let giveUp: NodeJS.Timeout | null = null;
    const release = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      if (giveUp) clearTimeout(giveUp);
      this.recycling = false;
    };
    giveUp = setTimeout(release, 15_000);
    giveUp.unref?.();
    child.once('exit', release);
    child.once('close', release);
  }

  private async tick(period: number): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const drift = now - this.lastTick;
    this.lastTick = now;

    if (drift > period + WAKE_DRIFT_MS) {
      // The lid was shut. Do not trust the old hostname, and do not wait
      // for a probe to time out first: recycle straight away so the menu
      // button is repointed while the user is still walking back to it.
      this.log(`wake detected after ~${Math.round(drift / 1000)}s asleep`);
      this.recycle('machine woke from sleep');
      return;
    }

    const url = this.url;
    if (!url) return;

    if (await this.probe(url)) {
      this.failures = 0;
      // A tunnel that has proven itself should not inherit the long backoff
      // earned by an earlier bad patch of network.
      this.restarts = 0;
      this.opts.onHealthy?.(url);
      return;
    }

    this.failures += 1;
    const limit = this.opts.healthFailureLimit ?? 2;
    this.log(`tunnel probe failed (${this.failures}/${limit})`);
    if (this.failures >= limit) this.recycle('public url stopped responding');
  }

  private startMonitor(): void {
    const period = this.opts.healthIntervalMs ?? 45_000;
    if (this.monitor || period <= 0) return;
    this.lastTick = Date.now();
    this.monitor = setInterval(() => {
      void this.tick(period).catch(() => {});
    }, period);
    this.monitor.unref?.();
  }

  /** Resolve the binary to spawn, downloading and verifying if needed. */
  private async acquire(revalidate = false): Promise<string> {
    const supplied = userSuppliedCloudflared(this.opts.cloudflaredPath);
    if (supplied) {
      // Their binary, their call: nothing to verify and nothing to fetch.
      this.log(`using cloudflared at ${supplied}`);
      return supplied;
    }
    if (this.opts.downloadFn) {
      const bin = cloudflaredBinaryPath(this.opts.binDir);
      await this.opts.downloadFn(bin);
      return bin;
    }
    return ensureCloudflared(this.opts.binDir, (m) => this.log(m), {
      revalidate,
    });
  }

  /**
   * Bring the tunnel up, and keep trying until it does.
   *
   * This used to be a single attempt whose rejection the caller could only
   * log. The realistic way it fails is the download: a machine that just
   * booted or just woke runs this before the network is up, `fetch`
   * throws, and the tunnel was then down permanently -- the watchdog spins
   * without a url to probe and nothing ever retries. That is the exact
   * failure class the rest of this file exists to survive, so it is
   * retried here too, with the same capped backoff shape.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.startMonitor();
    return this.acquireAndSpawn(true);
  }

  /**
   * Get a binary and spawn it, retrying the ACQUIRE with backoff.
   *
   * `first` distinguishes the initial call, which still rejects when the
   * retry is switched off so a caller can see the failure, from the
   * re-acquisitions driven by `spawnOnce` -- those have nobody to reject
   * to and must never throw into a timer callback.
   */
  private async acquireAndSpawn(
    first = false,
    revalidate = false,
  ): Promise<void> {
    if (this.acquiring) return;
    this.acquiring = true;
    const base = this.opts.startRetryMs ?? 5_000;
    let attempt = 0;
    try {
      for (;;) {
        if (this.stopped) return;
        try {
          const bin = await this.acquire(revalidate);
          if (this.stopped) return;
          this.spawnFailures = 0;
          this.spawnOnce(bin);
          return;
        } catch (err) {
          if (this.stopped) return;
          if (base <= 0) {
            if (first) throw err;
            this.log(`tunnel could not be acquired: ${(err as Error).message}`);
            return;
          }
          attempt += 1;
          const delay = Math.min(60_000, base * 2 ** Math.min(attempt - 1, 4));
          this.log(
            `tunnel could not start (attempt ${attempt}): ` +
              `${(err as Error).message}; retrying in ${delay}ms`,
          );
          // Deliberately NOT `this.timer`: `stop()` clears that one, and a
          // cleared timer here would suspend this loop forever instead of
          // letting it wake up and see `stopped`.
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delay).unref?.();
          });
        }
      }
    } finally {
      this.acquiring = false;
    }
  }

  /**
   * Consecutive deaths that produced no url before one is treated as
   * "this binary is not usable" rather than "the network is having a
   * moment". Two is enough to rule out a one-off while still repairing
   * quickly; a tunnel that comes up and prints a hostname resets it.
   */
  private static readonly REACQUIRE_AFTER = 2;

  private spawnOnce(bin: string): void {
    if (this.stopped) return;
    const spawnFn = this.opts.spawnFn || spawn;
    this.log(`starting tunnel -> http://127.0.0.1:${this.opts.port}`);

    const child = spawnFn(
      bin,
      [
        'tunnel',
        '--no-autoupdate',
        // QUIC (UDP 7844) is blocked on some networks (e.g. VPNs), which
        // leaves the quick tunnel stuck serving Cloudflare 530 while the
        // process stays alive. HTTP/2 over TCP is the precheck-recommended
        // fallback and works through those same networks.
        '--protocol',
        'http2',
        '--url',
        `http://127.0.0.1:${this.opts.port}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;

    // cloudflared banners the URL on stderr, but read both: which stream
    // carries it has moved between releases.
    const onData = (buf: Buffer) => this.handleChunk(buf.toString('utf8'));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    /*
     * `exit` is not emitted when the spawn itself fails -- a binary that
     * was deleted or is not executable gives `error` then `close`, so a
     * restart hung off `exit` alone never fired and the tunnel stayed
     * down with one line in the log. Both are handled, once.
     */
    let ended = false;
    const onEnd = (code: number | null) => {
      if (ended) return;
      ended = true;
      this.child = null;
      if (this.stopped) return;
      // A run that never printed a hostname did not work. Counting those
      // separately from ordinary exits is what tells "the binary is gone"
      // apart from "the network dropped".
      const producedUrl = this.url !== null;
      // A rotated hostname must not be reported as still live.
      this.url = null;
      this.restarts += 1;
      this.spawnFailures = producedUrl ? 0 : this.spawnFailures + 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.restarts, 5));

      /*
       * Re-acquire rather than re-spawn a path that does not work.
       *
       * `bin` is captured once, at start, and every restart used to reuse
       * it. If the binary is deleted, truncated by a failed upgrade, or
       * loses its executable bit while we run, the spawn fails with
       * ENOENT/EACCES -- which is `error` + `close`, so the restart fires,
       * spawns the same dead path, fails identically, and does that
       * forever at a 30s cap with the tunnel permanently down. Going back
       * through `acquire()` re-downloads and re-verifies against the
       * pinned checksum, which is the only thing that can actually repair
       * it. The same backoff timer gates it, so this is not a tight loop.
       */
      if (this.spawnFailures >= Tunnel.REACQUIRE_AFTER) {
        this.spawnFailures = 0;
        this.log(
          `tunnel exited (${code}) without a url twice; re-acquiring ` +
            `cloudflared in ${delay}ms`,
        );
        this.timer = setTimeout(() => {
          // `revalidate`: the binary just failed to produce a hostname
          // twice, so "there is a file there" is not good enough any more.
          void this.acquireAndSpawn(false, true).catch((err) =>
            this.log(`tunnel re-acquire failed: ${(err as Error).message}`),
          );
        }, delay);
        this.timer.unref?.();
        return;
      }

      this.log(`tunnel exited (${code}); restarting in ${delay}ms`);
      this.timer = setTimeout(() => this.spawnOnce(bin), delay);
      this.timer.unref?.();
    };

    child.on('exit', onEnd);
    child.on('close', onEnd);
    child.on('error', (err) => this.log(`tunnel error: ${err.message}`));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
    this.recycling = false;
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}

/**
 * How long a single Bot API call may take before it is abandoned.
 *
 * Both calls here run on timers whose whole purpose is to repair drift. A
 * request with no deadline, made over the flaky network these timers exist
 * to survive, can hang for as long as the OS keeps the socket open -- and
 * while it hangs the reconcile loop is not reconciling. A short cap turns
 * that into a retried failure instead of a stall.
 */
const BOT_API_TIMEOUT_MS = 15_000;

/** Run `fetchFn` with an abort deadline, whatever it is. */
async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOT_API_TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read back what Telegram currently believes the menu button is.
 *
 * The write side already existed; without this read side there was no way
 * to notice that a write had been lost, and a lost write is precisely the
 * failure this file now exists to survive.
 */
export async function readMenuButton(
  botToken: string,
  chatId: number | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const query =
    chatId === undefined ? '' : `?chat_id=${encodeURIComponent(String(chatId))}`;
  const res = await fetchWithTimeout(
    fetchFn,
    `https://api.telegram.org/bot${botToken}/getChatMenuButton${query}`,
  );
  const body = (await res.json()) as {
    ok?: boolean;
    result?: { web_app?: { url?: string } };
  };
  if (!body?.ok) return null;
  return body.result?.web_app?.url || null;
}

/** Compare two menu-button urls ignoring a trailing slash. */
export function sameMenuUrl(a: string | null, b: string | null): boolean {
  const norm = (v: string | null) => (v || '').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b) && norm(a) !== '';
}

export interface MenuSyncOptions {
  botToken: string;
  chatId: number | undefined;
  log?: (message: string) => void;
  fetchFn?: typeof fetch;
  /** How often to re-read Telegram and repair drift. 0 disables. */
  reconcileIntervalMs?: number;
  /** Attempts per target before giving up until the next reconcile. */
  maxAttempts?: number;
}

/**
 * Keeps Telegram's menu button pointed at the live tunnel.
 *
 * The original code called `setChatMenuButton` once per hostname rotation
 * and dropped the result on the floor. That is fine on a desktop with a
 * permanent link and fatal on a laptop: the rotation that matters most
 * happens the instant the machine wakes, which is the one moment the
 * network is least likely to be ready. When that single call failed --
 * logged verbatim as `menu button failed: fetch failed` on 2026-08-02 --
 * Telegram kept serving the previous, already-dead hostname with nothing
 * scheduled to ever correct it. The mini app was then broken until the
 * next unrelated restart.
 *
 * So: retry with backoff, and independently re-read the live value on a
 * timer so a silently lost write repairs itself rather than persisting.
 */
export class MenuSync {
  private target: string | null = null;
  private confirmed: string | null = null;
  private attempt = 0;
  private retry: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private reconciling = false;
  /**
   * Bumped on every change of target.
   *
   * A quick tunnel rotates its hostname, so two writes for two different
   * urls can be in flight at once -- and the Bot API does not promise they
   * are served in the order they were sent. Without this, a slow write for
   * the OLD url could land AFTER the fast write for the new one, leaving
   * Telegram pointed at a dead hostname and `confirmed` recording a url
   * that is no longer the target. The reconcile loop would eventually
   * repair it, but "eventually" there is up to two minutes, which is well
   * past the point the owner has tapped the menu button and got nothing.
   */
  private generation = 0;
  /** Serialises pushes, so only one write is ever outstanding. */
  private pushing: Promise<void> = Promise.resolve();

  constructor(private readonly opts: MenuSyncOptions) {}

  private log(message: string): void {
    this.opts.log?.(message);
  }

  /** Point the button at `url`, retrying until Telegram confirms it. */
  setTarget(url: string): void {
    if (this.stopped) return;
    if (this.target === url) {
      // Already landed. Re-writing on every health probe would mean a
      // Bot API write every 45s for the life of the process, to say
      // something Telegram already knows.
      if (this.confirmed === url) return;
      void this.enqueuePush();
      return;
    }
    this.target = url;
    this.attempt = 0;
    this.confirmed = null;
    this.generation += 1;
    // A retry armed for the previous url is now meaningless.
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    void this.enqueuePush();
  }

  /**
   * Run pushes one at a time, newest target wins.
   *
   * Chaining rather than firing in parallel is what makes the generation
   * check sufficient: a superseded write is either still queued (and is
   * then dropped without ever reaching Telegram) or is the one in flight
   * (and is then not allowed to record its result).
   */
  private enqueuePush(): Promise<void> {
    const mine = this.generation;
    this.pushing = this.pushing.then(
      () => this.push(mine),
      () => this.push(mine),
    );
    return this.pushing;
  }

  private schedule(): void {
    if (this.stopped || this.retry) return;
    const max = this.opts.maxAttempts ?? 8;
    if (this.attempt >= max) {
      this.log(
        `menu button still unset after ${max} attempts; leaving it to the ` +
          'reconcile loop',
      );
      return;
    }
    // 2s, 4s, 8s ... capped. A laptop's network is usually back well
    // inside the first few of these, so the first retry is deliberately
    // the short one: `attempt` has already been incremented by the call
    // that just failed, so it is stepped back to keep 2s first.
    const step = Math.max(0, Math.min(this.attempt - 1, 5));
    const delay = Math.min(60_000, 2000 * 2 ** step);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.enqueuePush();
    }, delay);
    this.retry.unref?.();
  }

  private async push(generation = this.generation): Promise<void> {
    const url = this.target;
    if (this.stopped || !url) return;
    // Superseded before this write even started: sending it would point
    // Telegram back at the previous hostname.
    if (generation !== this.generation) return;
    this.attempt += 1;
    try {
      const res = await registerMenuButton(
        this.opts.botToken,
        url,
        this.opts.chatId,
        this.opts.fetchFn || fetch,
      );
      // Superseded WHILE in flight. Telegram may have taken this write,
      // but the newer one is the truth -- so do not record it as confirmed
      // (that would make `setTarget` think there is nothing to do) and let
      // the newer target's own push stand.
      if (generation !== this.generation) {
        this.log('menu button write superseded by a newer url; discarding');
        return;
      }
      if (!res.ok) {
        this.log(`menu button rejected: ${res.description || 'unknown'}`);
        this.schedule();
        return;
      }
      this.confirmed = url;
      this.attempt = 0;
      this.log('menu button registered');
    } catch (err) {
      if (generation !== this.generation) return;
      this.log(
        `menu button attempt ${this.attempt} failed: ${(err as Error).message}`,
      );
      this.schedule();
    }
  }

  /**
   * Re-read Telegram and repair any drift.
   *
   * This is the backstop that makes the whole thing self-healing: even if
   * every retry above was exhausted while the network was down, the next
   * successful read notices the mismatch and writes again.
   */
  async reconcile(): Promise<void> {
    const url = this.target;
    const generation = this.generation;
    if (this.stopped || !url) return;
    // The reconcile timer and every health probe both call this. Without a
    // guard a slow Bot API round-trip stacks calls on top of each other,
    // each one able to re-push the button.
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const live = await readMenuButton(
        this.opts.botToken,
        this.opts.chatId,
        this.opts.fetchFn || fetch,
      );
      // The target may have rotated while this read was in flight; what
      // Telegram said about the OLD url tells us nothing about the new one.
      if (generation !== this.generation) return;
      if (sameMenuUrl(live, url)) {
        this.confirmed = url;
        return;
      }
      this.log(`menu button drifted (telegram has ${live || 'none'}); repairing`);
      this.attempt = 0;
      await this.enqueuePush();
    } catch {
      // Offline. The next tick tries again; nothing to do here.
    } finally {
      this.reconciling = false;
    }
  }

  start(): void {
    const period = this.opts.reconcileIntervalMs ?? 120_000;
    if (this.timer || period <= 0) return;
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => {});
    }, period);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = null;
    this.retry = null;
  }

  /** The url Telegram has confirmed, or null if the write never landed. */
  get liveUrl(): string | null {
    return this.confirmed;
  }
}

/**
 * The Telegram menu button payload.
 *
 * Built as a pure function so it can be asserted in tests without any
 * chance of a request going out.
 */
export function menuButtonPayload(
  url: string,
  text = 'Aside',
  chatId?: number,
) {
  // chat_id is set explicitly because per-chat menu buttons override the
  // bot default. A prior chat-level override (from manual setup or an older
  // build) silently overrides later chat-less setChatMenuButton calls: the
  // API returns ok:true while the owner's chat keeps serving the stale URL.
  // Targeting the owner chat directly updates both the per-chat button and,
  // when none is set, falls through to the default.
  const payload: Record<string, unknown> = {
    menu_button: {
      type: 'web_app',
      text,
      web_app: { url },
    },
  };
  if (chatId !== undefined) payload.chat_id = chatId;
  return payload;
}

/**
 * Point the bot's menu button at `url`.
 *
 * This is the ONLY Bot API call in this codebase. It is gated on
 * `miniapp.auto_register_menu`, which is off by default: the bot is live
 * in production and re-registering its menu is the owner's decision, not
 * something an install should do on its own.
 */
export async function registerMenuButton(
  botToken: string,
  url: string,
  chatId: number | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; description?: string }> {
  const res = await fetchWithTimeout(
    fetchFn,
    `https://api.telegram.org/bot${botToken}/setChatMenuButton`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(menuButtonPayload(url, 'Aside', chatId)),
    },
  );
  const body = (await res.json()) as { ok?: boolean; description?: string };
  return { ok: Boolean(body?.ok), description: body?.description };
}

/** Trim a log file that has grown past `maxBytes`, keeping the tail. */
export function rotateLog(logPath: string, maxBytes: number): void {
  try {
    const stat = fs.statSync(logPath, { throwIfNoEntry: false });
    if (!stat || stat.size <= maxBytes) return;
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // Logging must never take the server down.
  }
}

export function defaultBinDir(stateDir: string): string {
  return path.join(
    stateDir || path.join(defaultAsideRoot(), 'telegram-bridge'),
    'bin',
  );
}

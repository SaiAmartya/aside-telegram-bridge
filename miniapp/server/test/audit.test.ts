/**
 * Regression tests from the independent audit.
 *
 * Every case here failed (or, for the coverage gaps, passed against
 * deliberately broken code) before the fix it guards. They are grouped by
 * the finding id in docs/AUDIT.md so a future reader can trace one to the
 * other.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
// @ts-expect-error -- plain ESM helper shared with the dev harness
import { buildInitDataFields, signInitData } from '../../scripts/sign-initdata.mjs';
import { buildServer, redactedRequest } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { verifyToken } from '../src/auth.js';
import { STATE_DB_OPEN_OPTIONS, StateDb } from '../src/statedb.js';
import {
  FALLBACK_EXEC_TIMEOUT_MS,
  TurnRunner,
  grantFullAccessExpression,
} from '../src/exec.js';
import {
  MAX_IMAGE_BYTES,
  MAX_STEP_IMAGES,
  MAX_THREAD_IMAGE_BYTES,
  buildThread,
  workSteps,
} from '../src/thread.js';
import { ThreadStore, firstDivergence } from '../src/threadstore.js';
import { listArtifacts } from '../src/artifacts.js';
import { FAKE_BOT_TOKEN, OWNER_ID, makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: FastifyInstance;
let secret: string;

beforeEach(async () => {
  env = makeTestEnv();
  const config = loadConfig();
  secret = loadOrCreateJwtSecret(config.secretPath);
  ({ app } = await buildServer(config, { jwtSecret: secret }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  env.cleanup();
});

const initData = () =>
  signInitData(buildInitDataFields({ userId: OWNER_ID }), FAKE_BOT_TOKEN);

async function authToken(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth',
    payload: { initDataRaw: initData() },
  });
  return res.json().token as string;
}

// --- A-1: rate limiting must not be steerable from a header ---------------

describe('A-1 rate limiting cannot be bypassed with X-Forwarded-For', () => {
  /**
   * `trustProxy: true` made `request.ip` the leftmost X-Forwarded-For entry,
   * which any client past the tunnel writes for itself -- so every bucket in
   * app.ts had a key the attacker chose. 30 attempts, 0 rejections.
   */
  it('still throttles /api/auth when every request claims a new client IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth',
        payload: { initDataRaw: 'garbage' },
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
      });
      codes.push(res.statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes.at(-1)).toBe(429);
  });

  it('does not let a header decide the reported client address', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(res.statusCode).toBe(200);
    // The redacting serializer reports request.ip; with trustProxy off it can
    // never be the spoofed value.
    expect(redactedRequest({ url: '/x', ip: '127.0.0.1' }).remoteAddress).toBe(
      '127.0.0.1',
    );
  });
});

// --- A-2: no bearer token in the logs -------------------------------------

describe('A-2 the log serializer drops the query string', () => {
  /**
   * The artifact route takes `?token=<jwt>` because a download cannot carry
   * a header, and Fastify's default req serializer logged `req.url` whole --
   * writing a live 24h bearer into miniapp.log on every download.
   */
  it('redacts a token out of a logged url', () => {
    const token = jwt.sign({ uid: OWNER_ID }, secret, { algorithm: 'HS256' });
    const logged = redactedRequest({
      method: 'GET',
      url: `/api/sessions/abc/artifacts/file?group=artifacts&path=a.png&token=${token}`,
      ip: '127.0.0.1',
    });
    expect(String(logged.url)).not.toContain(token);
    expect(String(logged.url)).not.toContain('token=');
    expect(logged.url).toBe('/api/sessions/abc/artifacts/file?<redacted>');
  });

  it('leaves a url with no query string alone', () => {
    expect(redactedRequest({ url: '/api/status' }).url).toBe('/api/status');
  });
});

// --- A-5: the JWT algorithm is pinned -------------------------------------

describe('A-5 JWT verification pins HS256', () => {
  /**
   * The pin was entirely unasserted: widening the accepted list passed all
   * 286 tests. Note what is and is not testable here. Adding `'none'` to the
   * list changes nothing observable -- jsonwebtoken rejects an unsigned
   * token on its own whenever a secret is supplied -- so `none` is an
   * equivalent mutation and a test that "proves" it would be pinning the
   * library, not this module. Widening to another HMAC family IS observable,
   * and that is what these assert.
   */
  it('rejects an HS512 token signed with the very same secret', () => {
    const forged = jwt.sign({ uid: OWNER_ID }, secret, {
      algorithm: 'HS512',
      subject: String(OWNER_ID),
    });
    // Same key, same claims, different algorithm: only the pin rejects this.
    expect(jwt.decode(forged, { complete: true })?.header.alg).toBe('HS512');
    expect(() => verifyToken(forged, secret, OWNER_ID)).toThrow(/invalid/);
  });

  it('rejects an HS384 token signed with the very same secret', () => {
    const forged = jwt.sign({ uid: OWNER_ID }, secret, {
      algorithm: 'HS384',
      subject: String(OWNER_ID),
    });
    expect(() => verifyToken(forged, secret, OWNER_ID)).toThrow(/invalid/);
  });

  it('rejects an unsigned alg:none token', () => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        uid: OWNER_ID,
        sub: String(OWNER_ID),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    expect(() => verifyToken(`${header}.${body}.`, secret, OWNER_ID)).toThrow();
  });

  it('accepts the token this server actually mints', async () => {
    expect(verifyToken(await authToken(), secret, OWNER_ID).uid).toBe(OWNER_ID);
  });
});

// --- A-6: StateDb opens the database read-only ----------------------------

describe('A-6 StateDb opens the daemon database read-only', () => {
  /**
   * statedb.ts documents `readOnly` (capital O) as load-bearing and says
   * "there is a test pinning this". The test that existed constructed its own
   * `DatabaseSync` and asserted node:sqlite's behaviour -- it never touched
   * StateDb, so changing the production call to the footgun spelling
   * (`readonly`) passed every test. This asserts the production path.
   */
  it('opens with the exact options object production uses, and it forbids writes', async () => {
    // The production value, not a literal retyped in the test -- that is the
    // difference between pinning this module and pinning node:sqlite. Change
    // the spelling in statedb.ts and this fails.
    const { DatabaseSync } = await import('node:sqlite');
    const handle = new DatabaseSync(env.stateDbPath, STATE_DB_OPEN_OPTIONS as never);
    expect(() =>
      handle.exec("UPDATE sessions SET title = 'pwned' WHERE id = 'fixtureAAAA'"),
    ).toThrow(/readonly/i);
    handle.close();

    // And the reads this module needs still work through that same object.
    const db = new StateDb(env.stateDbPath);
    expect((await db.read('fixtureAAAA')).permissionMode).toBe('full-access');
  });

  it('leaves the table untouched after a full read cycle', async () => {
    const db = new StateDb(env.stateDbPath);
    await db.read('fixtureAAAA');
    await db.list(10);
    await db.children('fixtureBBBB');
    const { DatabaseSync } = await import('node:sqlite');
    const check = new DatabaseSync(env.stateDbPath, { readOnly: true });
    const row = check
      .prepare('SELECT title FROM sessions WHERE id = ?')
      .get('fixtureAAAA') as { title: string };
    check.close();
    expect(row.title).toBe('Fixture plan summary');
  });
});

// --- B-1 / B-2: createSession discovery races -----------------------------

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function rig(sessionsDir: string, execTimeoutMs = 60_000) {
  const children: FakeChild[] = [];
  const argvs: string[][] = [];
  const runner = new TurnRunner({
    asideCli: '/bin/echo',
    sessionsDir,
    execTimeoutMs,
    defaultModel: 'm',
    defaultEffort: 'high',
    modelAliases: {},
    spawnFn: ((_bin: string, args: string[]) => {
      argvs.push(args);
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as never,
  });
  return { runner, children, argvs };
}

function tempSessions(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sessions-'));
  temps.push(dir);
  return dir;
}
const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('B-1 a session whose CLI dies during discovery is not left wedged', () => {
  /**
   * The CLI creates its directory and then exits before the 300ms poll wakes
   * up. `trackChild`'s cleanup ran with no id in hand, and the code then
   * marked the queue running anyway -- so the session reported busy forever,
   * every later send queued behind a turn that had already finished, and
   * /api/status showed a phantom in flight.
   */
  it('reports the session idle and runs the next send', async () => {
    const dir = tempSessions();
    const { runner, children } = rig(dir);

    const created = runner.createSession(
      { text: 'hi', model: 'm', effort: 'high' },
      { timeoutMs: 4000, pollMs: 50 },
    );
    await tick(10);
    fs.mkdirSync(path.join(dir, '2026-01-01_newSessionX'));
    children[0].exitCode = 1;
    children[0].emit('close', 1);
    await tick(10);

    const { sessionId } = await created;
    expect(sessionId).toBe('newSessionX');
    expect(runner.isBusy(sessionId)).toBe(false);
    expect(runner.status().inFlight).toEqual([]);

    runner.send(sessionId, { text: 'follow up', model: 'm', effort: 'high' });
    // A second child means the follow-up actually ran rather than piling up.
    expect(children.length).toBe(2);
    expect(runner.queuedCount(sessionId)).toBe(0);
  });
});

describe('B-2 concurrent creates cannot claim the same session', () => {
  /**
   * Both calls sorted the new directories and took the last one, so two
   * turns landed on one id: one session's replies were attributed to the
   * other, and both queues collided on it.
   */
  it('hands two overlapping creates two distinct ids', async () => {
    const dir = tempSessions();
    const { runner } = rig(dir);
    const a = runner.createSession(
      { text: 'A', model: 'm', effort: 'high' },
      { timeoutMs: 4000, pollMs: 40 },
    );
    const b = runner.createSession(
      { text: 'B', model: 'm', effort: 'high' },
      { timeoutMs: 4000, pollMs: 40 },
    );
    await tick(20);
    // One CLI wins the race to create its directory. Before the fix BOTH
    // discoveries were watching, both saw this directory, and both returned
    // its id -- two turns on one session.
    fs.mkdirSync(path.join(dir, '2026-01-01_aaaaaaaa'));
    const ra = await a;
    expect(ra.sessionId).toBe('aaaaaaaa');
    // The second create is only now looking, and its own CLI answers it.
    fs.mkdirSync(path.join(dir, '2026-01-01_zzzzzzzz'));
    const rb = await b;
    expect(rb.sessionId).toBe('zzzzzzzz');
    expect(ra.sessionId).not.toBe(rb.sessionId);
  });

  it('will not hand back an id another discovery already claimed', async () => {
    const dir = tempSessions();
    const { runner } = rig(dir);
    // Simulate a discovery that is mid-flight and has taken this id.
    (runner as any).claimedIds.add('takenOne');
    const created = runner.createSession(
      { text: 'B', model: 'm', effort: 'high' },
      { timeoutMs: 600, pollMs: 40 },
    );
    await tick(20);
    fs.mkdirSync(path.join(dir, '2026-01-01_takenOne'));
    await expect(created).rejects.toThrow(/could not detect/);
  });

  it('never claims a session it is already running a turn against', async () => {
    const dir = tempSessions();
    const { runner } = rig(dir);
    // A turn is already in flight on `existing`.
    fs.mkdirSync(path.join(dir, '2026-01-01_existing'), { recursive: true });
    runner.send('existing', { text: 'x', model: 'm', effort: 'high' });
    expect(runner.isBusy('existing')).toBe(true);

    const created = runner.createSession(
      { text: 'new one', model: 'm', effort: 'high' },
      { timeoutMs: 1500, pollMs: 40 },
    );
    await tick(20);
    // Only the busy directory is "new" relative to the snapshot? No: it was
    // there first. Add one that genuinely is ours.
    fs.mkdirSync(path.join(dir, '2026-01-02_freshOne'));
    expect((await created).sessionId).toBe('freshOne');
  });
});

describe('B-3 shutdown reaps a create-session child that has no queue yet', () => {
  it('kills the pending child', async () => {
    const dir = tempSessions();
    const { runner, children } = rig(dir);
    void runner
      .createSession({ text: 'A', model: 'm', effort: 'high' }, { timeoutMs: 400, pollMs: 50 })
      .catch(() => undefined);
    await tick(30);
    runner.shutdown();
    expect(children[0].killed).toBe(true);
    await tick(450);
  });
});

describe('B-4 an unusable exec timeout does not kill every turn instantly', () => {
  /**
   * config.ts computes `Number(raw.exec_timeout_seconds || 1200) * 1000`,
   * which is NaN for any non-numeric config value -- and setTimeout(fn, NaN)
   * fires on the next tick, SIGTERMing every turn the moment it starts.
   */
  it('falls back to a real timeout when the configured one is NaN', async () => {
    const dir = tempSessions();
    const { runner, children } = rig(dir, Number('not-a-number') * 1000);
    runner.send('s1', { text: 'x', model: 'm', effort: 'high' });
    await tick(40);
    expect(children[0].killed).toBe(false);
    expect(FALLBACK_EXEC_TIMEOUT_MS).toBeGreaterThan(60_000);
    runner.shutdown();
  });
});

describe('B-5 the repl expression for full access is a JSON literal', () => {
  it('escapes an id that would otherwise close the quote', () => {
    const expr = grantFullAccessExpression("x'); process.exit(1); //");
    expect(expr).toContain(JSON.stringify("x'); process.exit(1); //"));
    // The payload cannot terminate the argument and start a new statement.
    expect(expr).not.toMatch(/\('x'\)/);
    expect(expr.endsWith("{ permissionMode: 'full-access' })")).toBe(true);
  });

  it('is unchanged for an ordinary id', () => {
    expect(grantFullAccessExpression('abc123')).toBe(
      `aside.sessions.update("abc123", { permissionMode: 'full-access' })`,
    );
  });
});

// --- B-6: inline image payloads -------------------------------------------

describe('B-6 inline images are capped', () => {
  /**
   * Measured on the owner's own 57MB transcript: 58.1MB of base64 data URIs
   * across 91 images in 35 thread items. That was the whole /thread
   * response, it was re-sent on every socket resync, and it made
   * `firstDivergence` cost 176ms per 150ms push tick.
   */
  const imageResult = (count: number, bytesEach: number) => [
    {
      role: 'assistant',
      timestamp: 1,
      content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }],
    },
    {
      role: 'toolResult',
      timestamp: 2,
      toolCallId: 'c1',
      toolName: 'bash',
      content: Array.from({ length: count }, () => ({
        type: 'image',
        mimeType: 'image/png',
        data: 'A'.repeat(bytesEach),
      })),
    },
  ];

  it('keeps at most MAX_STEP_IMAGES and reports the rest', () => {
    const items = buildThread(imageResult(9, 100) as never, false);
    const work = items.find((i) => i.kind === 'work') as any;
    const step = work.items.find((i: any) => i.kind === 'step');
    expect(step.images.length).toBe(MAX_STEP_IMAGES);
    expect(step.imagesDropped).toBe(9 - MAX_STEP_IMAGES);
  });

  it('drops a single oversized image rather than inlining it', () => {
    const items = buildThread(imageResult(1, MAX_IMAGE_BYTES + 1) as never, false);
    const work = items.find((i) => i.kind === 'work') as any;
    const step = work.items.find((i: any) => i.kind === 'step');
    expect(step.images).toEqual([]);
    expect(step.imagesDropped).toBe(1);
  });

  it('bounds the serialised size of a step no matter what the tool returned', () => {
    const items = buildThread(imageResult(40, MAX_IMAGE_BYTES * 2) as never, false);
    const bytes = JSON.stringify(items).length;
    expect(bytes).toBeLessThan(MAX_STEP_IMAGES * MAX_IMAGE_BYTES + 8_000);
  });

  /**
   * Per-step caps alone are not enough: a long session simply has many
   * steps. The owner's own 57MB transcript still produced a 20MB thread
   * with only the per-step limits in place.
   */
  it('bounds the whole thread, not just one step', () => {
    const many: unknown[] = [];
    for (let i = 0; i < 200; i += 1) {
      many.push(
        {
          role: 'assistant',
          timestamp: i * 2,
          content: [{ type: 'toolCall', id: `c${i}`, name: 'bash', arguments: {} }],
        },
        {
          role: 'toolResult',
          timestamp: i * 2 + 1,
          toolCallId: `c${i}`,
          toolName: 'bash',
          content: [
            { type: 'image', mimeType: 'image/png', data: 'A'.repeat(200_000) },
          ],
        },
      );
    }
    const items = buildThread(many as never, false);
    const total = JSON.stringify(items).length;
    expect(total).toBeLessThan(MAX_THREAD_IMAGE_BYTES + 1_000_000);

    // The newest steps are the ones that kept their screenshots.
    const steps = workSteps(items);
    const withImages = steps.filter((s) => s.images.length);
    expect(withImages.length).toBeGreaterThan(0);
    expect(steps.at(-1)!.images.length).toBe(1);
    expect(steps[0].images.length).toBe(0);
    expect(steps[0].imagesDropped).toBe(1);
  });

  it('leaves an ordinary screenshot alone', () => {
    const items = buildThread(imageResult(1, 1_000) as never, false);
    const work = items.find((i) => i.kind === 'work') as any;
    const step = work.items.find((i: any) => i.kind === 'step');
    expect(step.images.length).toBe(1);
    expect(step.images[0].startsWith('data:image/png;base64,')).toBe(true);
    expect(step.imagesDropped).toBeUndefined();
  });
});

describe('B-7 the thread diff short-circuits on identical items', () => {
  it('does not serialise items the builder handed back unchanged', () => {
    const shared: any[] = Array.from({ length: 50 }, (_, i) => ({
      kind: 'answer',
      id: `a${i}`,
      text: 'x'.repeat(2000),
      ts: null,
    }));
    let serialised = 0;
    const spy = { toJSON: () => (serialised += 1) };
    const tagged = shared.map((item) => Object.assign(item, { probe: spy }));
    expect(firstDivergence(tagged, tagged)).toBe(tagged.length);
    expect(serialised).toBe(0);
  });

  it('still finds a real divergence', () => {
    const a: any[] = [
      { kind: 'answer', id: 'a', text: 'one', ts: null },
      { kind: 'answer', id: 'b', text: 'two', ts: null },
    ];
    const b: any[] = [
      { kind: 'answer', id: 'a', text: 'one', ts: null },
      { kind: 'answer', id: 'b', text: 'CHANGED', ts: null },
    ];
    expect(firstDivergence(a, b)).toBe(1);
  });
});

describe('B-8 caches are bounded', () => {
  it('ThreadStore keeps a fixed number of sessions', () => {
    const dir = tempSessions();
    const store = new ThreadStore(() => 'stamp');
    for (let i = 0; i < 60; i += 1) {
      const file = path.join(dir, `s${i}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ role: 'user', content: 'hi' }) + '\n');
      store.build(`session-${i}`, file, false);
    }
    expect(store.size).toBeLessThanOrEqual(16);
  });

  it('the runner prunes idle session queues but never a busy one', async () => {
    const dir = tempSessions();
    const { runner, children } = rig(dir);
    runner.send('keep-me', { text: 'x', model: 'm', effort: 'high' });
    for (let i = 0; i < 400; i += 1) {
      runner.send(`s${i}`, { text: 'x', model: 'm', effort: 'high' });
    }
    // Settle every child except the first.
    for (const child of children.slice(1)) child.emit('close', 0);
    await tick(20);
    expect(runner.isBusy('keep-me')).toBe(true);
    expect((runner as any).queues.size).toBeLessThanOrEqual(300);
    runner.shutdown();
  });
});

// --- B-9: upload receipts age out -----------------------------------------

describe('B-9 upload receipts and their bytes are reclaimed', () => {
  it('still accepts a path it just issued, and rejects an arbitrary one', async () => {
    const auth = { authorization: `Bearer ${await authToken()}` };
    const boundary = '----auditboundary';
    const body =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="files"; filename="probe.txt"\r\n' +
      'Content-Type: text/plain\r\n\r\nhello\r\n' +
      `--${boundary}--\r\n`;
    const up = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(up.statusCode).toBe(200);
    const issued = up.json().files[0].path as string;
    expect(fs.existsSync(issued)).toBe(true);

    // A path the server never issued is not accepted as an attachment.
    const forged = await app.inject({
      method: 'POST',
      url: '/api/sessions/fixtureAAAA/send',
      headers: auth,
      payload: { text: '', attachments: ['/etc/passwd'] },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error).toBe('empty_text');
  });
});

// --- Coverage gaps found by mutation --------------------------------------

describe('C-1 gaps surfaced by mutating the code under test', () => {
  /** listArtifacts must not name a symlink the read side will refuse. */
  it('never lists a symlink, even one pointing inside the group', () => {
    const dir = path.join(env.sessionsDir, '2026-01-06_fixtureDDDD');
    const target = path.join(env.root, 'outside.txt');
    fs.writeFileSync(target, 'outside');
    fs.symlinkSync(target, path.join(dir, 'artifacts', 'escape.txt'));
    fs.symlinkSync(env.root, path.join(dir, 'artifacts', 'rootlink'));

    const files = listArtifacts(dir, 'artifacts').map((f) => f.path);
    expect(files).not.toContain('escape.txt');
    expect(files.some((f) => f.startsWith('rootlink'))).toBe(false);
    // The real file is still there.
    expect(files).toContain('2026-01-06/notes.md');
  });

  /** The route-level upload cap, which exists because multipart truncates. */
  it('413s an upload past the per-file cap', async () => {
    const auth = { authorization: `Bearer ${await authToken()}` };
    const boundary = '----auditbig';
    const big = 'x'.repeat(21 * 1024 * 1024);
    const body =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="files"; filename="big.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n' +
      `${big}\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('file_too_large');
  });

  /** Only trailing assistant text is the answer; commentary stays folded. */
  it('does not promote mid-turn commentary to the answer', () => {
    const items = buildThread(
      [
        { role: 'user', timestamp: 1, content: 'go' },
        {
          role: 'assistant',
          timestamp: 2,
          content: [
            { type: 'text', text: 'let me look' },
            { type: 'toolCall', id: 'c1', name: 'bash', arguments: { title: 'ls' } },
          ],
        },
      ] as never,
      false,
    );
    const answers = items.filter((i) => i.kind === 'answer');
    expect(answers).toHaveLength(0);
    const work = items.find((i) => i.kind === 'work') as any;
    expect(work.items.some((i: any) => i.kind === 'text' && i.text === 'let me look')).toBe(true);
  });

  it('promotes trailing assistant text to the answer', () => {
    const items = buildThread(
      [
        { role: 'user', timestamp: 1, content: 'go' },
        {
          role: 'assistant',
          timestamp: 2,
          content: [
            { type: 'toolCall', id: 'c1', name: 'bash', arguments: { title: 'ls' } },
            { type: 'text', text: 'done' },
          ],
        },
      ] as never,
      false,
    );
    const answer = items.find((i) => i.kind === 'answer') as any;
    expect(answer?.text).toBe('done');
  });

  /**
   * Queued turns only batch when model AND effort match. Asserted on the
   * argv the runner actually spawns, because that is the only place the
   * mistake shows: batching across models runs someone's message at a model
   * they did not pick, and the queue counters look identical either way.
   */
  it('never batches queued turns across different models', async () => {
    const dir = tempSessions();
    const { runner, children, argvs } = rig(dir);
    // The first send starts a turn immediately, so batching is only ever
    // decided among the messages that pile up BEHIND it -- which is where
    // these three have to sit for the guard to be exercised at all.
    runner.send('s1', { text: 'running', model: 'alpha', effort: 'high' });
    runner.send('s1', { text: 'first', model: 'alpha', effort: 'high' });
    runner.send('s1', { text: 'second', model: 'beta', effort: 'high' });
    runner.send('s1', { text: 'third', model: 'beta', effort: 'high' });
    expect(argvs[0].at(-1)).toBe('running');

    children[0].emit('close', 0);
    await tick(10);
    // Turn 2 is alpha's alone; the two beta messages must not ride with it.
    expect(argvs).toHaveLength(2);
    expect(argvs[1].at(-1)).toBe('first');
    expect(argvs[1][argvs[1].indexOf('-m') + 1]).toBe('alpha');

    children[1].emit('close', 0);
    await tick(10);
    // Turn 3 batches the two that DO agree, at their own model.
    expect(argvs[2].at(-1)).toBe('second\n\nthird');
    expect(argvs[2][argvs[2].indexOf('-m') + 1]).toBe('beta');
    runner.shutdown();
  });

  it('never batches queued turns across different efforts', async () => {
    const dir = tempSessions();
    const { runner, children, argvs } = rig(dir);
    runner.send('s1', { text: 'running', model: 'alpha', effort: 'high' });
    runner.send('s1', { text: 'first', model: 'alpha', effort: 'high' });
    runner.send('s1', { text: 'second', model: 'alpha', effort: 'low' });
    children[0].emit('close', 0);
    await tick(10);
    expect(argvs[1].at(-1)).toBe('first');
    expect(argvs[1][argvs[1].indexOf('--effort') + 1]).toBe('high');
    children[1].emit('close', 0);
    await tick(10);
    expect(argvs[2].at(-1)).toBe('second');
    expect(argvs[2][argvs[2].indexOf('--effort') + 1]).toBe('low');
    runner.shutdown();
  });
});

// --- A-3: the WebSocket is not an unauthenticated open door ---------------

describe('A-3 the WebSocket upgrade is gated', () => {
  let live: FastifyInstance;
  let wsUrl = '';

  beforeEach(async () => {
    const config = loadConfig();
    ({ app: live } = await buildServer(config, {
      jwtSecret: loadOrCreateJwtSecret(config.secretPath),
    }));
    await live.listen({ port: 0, host: '127.0.0.1' });
    const addr = live.server.address() as { port: number };
    wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
  });
  afterEach(async () => {
    await live.close();
  });

  /**
   * The upgrade handler is a raw server listener, outside Fastify's routing
   * and outside the rate limiter. A tokenless socket that simply said
   * nothing used to be held open forever; 200 of them were accepted in a
   * second, each adding four listeners to the runner's emitters.
   *
   * It is now refused at the handshake instead of accepted-then-dropped,
   * so it never becomes a client at all -- see the upgrade handler. The
   * socket therefore errors rather than opening.
   */
  it('refuses a tokenless socket at the handshake', async () => {
    const ws = new WebSocket(wsUrl);
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('opened'));
      ws.on('error', () => resolve('refused'));
      setTimeout(() => resolve('timeout'), 9_000);
    });
    expect(outcome).toBe('refused');
    ws.terminate();
  }, 15_000);

  it('refuses new upgrades past the connection ceiling', async () => {
    const token = await new Promise<string>((resolve) => {
      live
        .inject({ method: 'POST', url: '/api/auth', payload: { initDataRaw: initData() } })
        .then((res) => resolve(res.json().token));
    });
    const socks: WebSocket[] = [];
    let refused = 0;
    await Promise.all(
      Array.from({ length: 48 }, () =>
        new Promise<void>((resolve) => {
          const ws = new WebSocket(`${wsUrl}?token=${token}`);
          socks.push(ws);
          ws.on('open', () => resolve());
          ws.on('error', () => {
            refused += 1;
            resolve();
          });
        }),
      ),
    );
    expect(refused).toBeGreaterThan(0);
    for (const ws of socks) ws.terminate();
  }, 15_000);

  it('still lets the real client in', async () => {
    const res = await live.inject({
      method: 'POST',
      url: '/api/auth',
      payload: { initDataRaw: initData() },
    });
    const ws = new WebSocket(`${wsUrl}?token=${res.json().token}`);
    const first = await new Promise<any>((resolve) => {
      ws.on('message', (raw) => resolve(JSON.parse(String(raw))));
    });
    expect(first.type).toBe('ready');
    ws.terminate();
  }, 15_000);
});

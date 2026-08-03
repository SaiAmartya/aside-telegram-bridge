/**
 * End-to-end smoke test over a real socket: sign initData -> POST /api/auth
 * -> list sessions -> fetch a transcript -> open the WebSocket -> append
 * lines to the fixture jsonl -> assert the parsed entries arrive live.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM helper shared with the dev harness
import { buildInitDataFields, signInitData } from '../../scripts/sign-initdata.mjs';
import { buildServer } from '../src/app.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { FAKE_BOT_TOKEN, OWNER_ID, makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: FastifyInstance;
let base: string;
let token: string;

const TRANSCRIPT = () =>
  path.join(env.sessionsDir, '2026-01-02_fixtureAAAA', 'messages.jsonl');

function appendLine(obj: unknown): void {
  fs.appendFileSync(TRANSCRIPT(), `${JSON.stringify(obj)}\n`);
}

/** Collect socket frames so assertions can wait for a specific one. */
function collector(ws: WebSocket) {
  const frames: any[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  return {
    frames,
    async waitFor(predicate: (f: any) => boolean, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = frames.find(predicate);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(
        `timed out waiting for frame; saw: ${frames.map((f) => f.type).join(', ')}`,
      );
    },
  };
}

beforeAll(async () => {
  env = makeTestEnv();
  const config = loadConfig();
  const secret = loadOrCreateJwtSecret(config.secretPath);
  ({ app } = await buildServer(config, { jwtSecret: secret }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  env.cleanup();
});

describe('integration smoke', () => {
  it('authenticates with a freshly signed initData', async () => {
    const initDataRaw = signInitData(
      buildInitDataFields({ userId: OWNER_ID, platform: 'ios' }),
      FAKE_BOT_TOKEN,
    );
    const res = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initDataRaw }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.user.id).toBe(OWNER_ID);
    token = body.token;
  });

  it('lists sessions and fetches a transcript over HTTP', async () => {
    const auth = { authorization: `Bearer ${token}` };

    const list = (await (
      await fetch(`${base}/api/sessions`, { headers: auth })
    ).json()) as any;
    expect(list.sessions.length).toBe(3);

    const messages = (await (
      await fetch(`${base}/api/sessions/fixtureAAAA/messages`, { headers: auth })
    ).json()) as any;
    expect(messages.entries.at(-1).kind).toBe('assistant_text');
    expect(messages.lastLine).toBe(6);
  });

  it('rejects an unauthenticated WebSocket', async () => {
    // Refused at the handshake now, rather than upgraded and then closed
    // with 4401: a bad token must not cost a slot in the client pool. The
    // client sees the failed upgrade as an `error`, not an `open`.
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=garbage`);
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('opened'));
      ws.on('close', () => resolve('closed'));
      ws.on('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
    ws.terminate();
  });

  /**
   * The round-3 protocol: the server builds the thread and pushes the tail
   * that changed. This is the fix for "the message is received all at
   * once" -- each completed transcript part lands on its own, rather than
   * the client refetching the whole turn once it is over.
   */
  it('pushes each new transcript part as a thread delta', async () => {
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`,
    );
    const feed = collector(ws);
    await new Promise((resolve) => ws.on('open', resolve));
    await feed.waitFor((f) => f.type === 'ready');

    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'fixtureAAAA' }));
    const subscribed = await feed.waitFor((f) => f.type === 'subscribed');
    expect(subscribed.busy).toBe(false);
    // The baseline is what is already on disk, so opening a thread does not
    // re-send a history the client just fetched over REST.
    expect(subscribed.length).toBeGreaterThan(0);
    const baseLength = subscribed.length;

    // A user message arrives on its own...
    const askedAt = Date.now();
    appendLine({
      role: 'user',
      content: 'a live follow-up question',
      timestamp: 1767312100,
    });

    const userDelta = await feed.waitFor(
      (f) =>
        f.type === 'thread_delta' &&
        f.items.some((i: any) => i.kind === 'user' && i.text.includes('follow-up')),
    );
    // Latency from the write to the push, which is the whole point of this
    // change. The watcher's poll floor is 800ms and fs.watch usually beats
    // it; 1.5s is the ceiling the owner would notice.
    expect(Date.now() - askedAt).toBeLessThan(1_500);
    expect(userDelta.fromIndex).toBe(baseLength);
    expect(userDelta.length).toBe(baseLength + 1);

    // ...and the tool call that follows arrives as its own delta, appended
    // after it rather than bundled at the end of the turn.
    appendLine({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'toolu_live',
          name: 'websearch',
          arguments: { title: 'Search the web' },
        },
      ],
      model: 'claude-sonnet-5',
      timestamp: 1767312101,
    });

    const workDelta = await feed.waitFor(
      (f) =>
        f.type === 'thread_delta' &&
        f.items.some((i: any) => i.kind === 'work'),
    );
    const work = workDelta.items.find((i: any) => i.kind === 'work');
    expect(work.items[0].label).toBe('Search the web');
    // The user bubble is untouched, so only the tail was sent.
    expect(workDelta.fromIndex).toBe(baseLength + 1);

    // A half-written line must not produce a delta until it is terminated.
    const before = feed.frames.filter((f) => f.type === 'thread_delta').length;
    fs.appendFileSync(TRANSCRIPT(), '{"role":"assistant","content":[{"type":"te');
    await new Promise((r) => setTimeout(r, 1_500));
    expect(feed.frames.filter((f) => f.type === 'thread_delta').length).toBe(
      before,
    );

    fs.appendFileSync(
      TRANSCRIPT(),
      'xt","text":"finished writing"}],"timestamp":1767312102}\n',
    );
    const answered = await feed.waitFor(
      (f) =>
        f.type === 'thread_delta' &&
        f.items.some(
          (i: any) => i.kind === 'answer' && i.text === 'finished writing',
        ),
    );
    expect(answered.length).toBe(baseLength + 3);

    ws.close();
  });

  /**
   * A client that has fallen behind -- a webview restored from the
   * background, typically -- asks for the whole thread back.
   */
  it('re-sends the whole thread on resync', async () => {
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`,
    );
    const feed = collector(ws);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'fixtureAAAA' }));
    const subscribed = await feed.waitFor((f) => f.type === 'subscribed');

    ws.send(JSON.stringify({ type: 'resync' }));
    const full = await feed.waitFor((f) => f.type === 'thread_delta');
    expect(full.fromIndex).toBe(0);
    expect(full.items).toHaveLength(subscribed.length);
    // Lines 7-9, appended by the previous test, are in it.
    expect(
      full.items.some(
        (i: any) => i.kind === 'answer' && i.text === 'finished writing',
      ),
    ).toBe(true);
    ws.close();
  });

  /**
   * A session created from the home composer has an id before it has a
   * transcript: `aside exec` hands the id back as soon as its directory
   * appears, and messages.jsonl lands a moment later. Caught on a live run,
   * where the socket answered `session_not_found` 900ms after the id was
   * issued and the new chat then showed nothing until it was reopened.
   *
   * The wait is granted only while the server is mid-turn on that id, so
   * this runs against its own instance with a CLI that stays alive.
   */
  it('waits for a brand new session’s transcript instead of failing', async () => {
    const slowEnv = makeTestEnv();
    const slowCli = path.join(slowEnv.root, 'slow-cli.sh');
    fs.writeFileSync(slowCli, '#!/bin/sh\nsleep 20\n', { mode: 0o755 });
    fs.writeFileSync(
      slowEnv.configPath,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(slowEnv.configPath, 'utf8')),
        aside_cli: slowCli,
      }),
    );

    const slowConfig = loadConfig();
    const slowSecret = loadOrCreateJwtSecret(slowConfig.secretPath);
    const built = await buildServer(slowConfig, { jwtSecret: slowSecret });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (built.app.server.address() as { port: number }).port;
    const slowBase = `http://127.0.0.1:${port}`;

    const authRes = await fetch(`${slowBase}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        initDataRaw: signInitData(
          buildInitDataFields({ userId: OWNER_ID, platform: 'ios' }),
          FAKE_BOT_TOKEN,
        ),
      }),
    });
    const slowToken = ((await authRes.json()) as any).token as string;

    try {
      const id = 'freshSession01';
      const dir = path.join(slowEnv.sessionsDir, `2026-01-05_${id}`);
      // Marks the queue running, which is what earns the wait.
      built.runner.send(id, {
        text: 'kick off',
        model: 'claude-sonnet-5',
        effort: 'low',
      });

      const ws = new WebSocket(
        `${slowBase.replace('http', 'ws')}/ws?token=${encodeURIComponent(slowToken)}`,
      );
      const feed = collector(ws);
      await new Promise((resolve) => ws.on('open', resolve));
      await feed.waitFor((f) => f.type === 'ready');

      // Subscribe BEFORE anything exists on disk.
      ws.send(JSON.stringify({ type: 'subscribe', sessionId: id }));
      await new Promise((r) => setTimeout(r, 700));
      expect(feed.frames.some((f) => f.type === 'error')).toBe(false);
      expect(feed.frames.some((f) => f.type === 'subscribed')).toBe(false);

      // The CLI catches up.
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'messages.jsonl'),
        `${JSON.stringify({ role: 'user', content: 'first message', timestamp: 1767570000 })}\n`,
      );

      const subscribed = await feed.waitFor((f) => f.type === 'subscribed');
      expect(subscribed.sessionId).toBe(id);

      // And it is live from there.
      fs.appendFileSync(
        path.join(dir, 'messages.jsonl'),
        `${JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: 'the reply' }],
          timestamp: 1767570001,
        })}\n`,
      );
      const delta = await feed.waitFor(
        (f) =>
          f.type === 'thread_delta' &&
          f.items.some((i: any) => i.kind === 'answer' && i.text === 'the reply'),
      );
      expect(delta.sessionId).toBe(id);
      ws.close();
    } finally {
      await built.app.close();
      slowEnv.cleanup();
      // Put the shared rig's env vars back for the remaining tests.
      process.env.MINIAPP_CONFIG = env.configPath;
      process.env.MINIAPP_SESSIONS_DIR = env.sessionsDir;
      process.env.MINIAPP_SECRET_PATH = env.secretPath;
      process.env.MINIAPP_STATE_DB = env.stateDbPath;
    }
  });

  it('refuses to subscribe to an unknown or malformed session', async () => {
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`,
    );
    const feed = collector(ws);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: '../../etc' }));
    expect((await feed.waitFor((f) => f.type === 'error')).reason).toBe(
      'bad_session_id',
    );
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'nosuchsession' }));
    expect(
      (await feed.waitFor((f) => f.reason === 'session_not_found')).type,
    ).toBe('error');
    ws.close();
  });
});

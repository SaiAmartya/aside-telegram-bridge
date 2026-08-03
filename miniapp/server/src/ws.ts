/**
 * WebSocket transport for a live thread.
 *
 * Client -> server
 *   {type:"auth", token}                  (only if ?token= was not used)
 *   {type:"subscribe", sessionId}
 *   {type:"ping"}
 *
 * Server -> client
 *   {type:"ready"}
 *   {type:"subscribed", sessionId, busy, queued}
 *   {type:"thread_delta", sessionId, fromIndex, items, length}
 *   {type:"thread_meta", sessionId, stats, sources, todos}
 *   {type:"subagent_delta", sessionId, childId, steps, total}
 *   {type:"stream_delta", sessionId, text}
 *   {type:"turn_started", ...} / {type:"turn_finished", ...}
 *   {type:"permission_changed", sessionId, permission, ...}
 *   {type:"error", reason}
 *
 * What changed in round 3, and why:
 *
 * Round 2 pushed raw transcript entries and the client answered each one by
 * refetching the whole structured thread through the CLI facade, throttled
 * to 1.2s. That is what made a reply appear in one lump -- nothing could be
 * drawn until a ~139MB binary had been spawned and had returned the entire
 * turn. Here the server builds the thread itself (a file read, no spawn)
 * and sends only the tail that changed, so a tool call shows up as it
 * happens rather than when the turn ends.
 *
 * Two levels of liveness ride on this socket:
 *
 *  - `thread_delta` is authoritative and comes from the transcript. Every
 *    completed part -- a text block, a tool call, a tool result -- lands
 *    within one watcher tick of being written.
 *  - `stream_delta` is provisional and comes from the running child's
 *    stdout, which mirrors the answer token by token well before the
 *    transcript line for that message is written. It is always superseded
 *    by the `thread_delta` that carries the real text.
 *
 * The per-connection baseline is reset on `turn_finished`, which forces one
 * full resync per turn. That closes the only gap in the diff scheme: a line
 * written between the client's REST load and this socket's first build
 * would otherwise never produce a delta, because the server's baseline
 * already contained it.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import type { MiniappConfig } from './config.js';
import { verifyToken } from './auth.js';
import { isValidSessionId, sessionMsgFile } from './sessions.js';
import type {
  TurnRunner,
  InFlightTurn,
  TurnFinished,
  StreamDelta,
} from './exec.js';
import type { WatcherRegistry } from './watcher.js';
import {
  buildParentView,
  diffThread,
  type ParentView,
  type ThreadStore,
} from './threadstore.js';
import type { ChildSession, ThreadItem } from './thread.js';
import type { SubagentIndex } from './subagents.js';

const HEARTBEAT_MS = 30_000;

/**
 * Floor on how often one connection is handed a rebuilt thread.
 *
 * Low enough that a step appears as it happens, high enough that a burst of
 * transcript writes does not turn into a burst of frames over a phone
 * connection.
 */
const PUSH_THROTTLE_MS = 150;

/**
 * How long a subscribe will wait for a brand new session's transcript.
 *
 * `TurnRunner.createSession` allows 60s to spot the new directory, so the
 * file follows well inside this window; past it, the session genuinely is
 * not there.
 */
const NEW_SESSION_WAIT_MS = 30_000;
const NEW_SESSION_POLL_MS = 250;

/**
 * How long a socket may stay connected without proving who it is.
 *
 * Now a backstop rather than the gate: the upgrade handler below verifies
 * the token BEFORE the handshake, so a connection that reaches this point
 * is already authenticated. It is kept because it costs nothing and it
 * keeps the in-band `{type:"auth"}` branch of the documented protocol
 * honest -- if the upgrade gate is ever relaxed, an anonymous socket is
 * still dropped rather than held open forever.
 */
const AUTH_DEADLINE_MS = 5_000;

/**
 * Ceiling on concurrent sockets.
 *
 * The real client holds exactly one. This is a backstop against a flood
 * from the public tunnel, not a limit anyone should ever meet.
 */
const MAX_CLIENTS = 32;

/**
 * Ceiling on a single incoming frame.
 *
 * Every client->server message in the protocol at the top of this file is
 * a handful of fields: a type, a token, a session id. `ws` defaults to
 * 100 MiB, so before this a public tunnel would happily buffer a 100 MB
 * frame into memory and then hand it to `JSON.parse` -- which is a second
 * copy and a full parse of attacker-chosen bytes, from one socket, with no
 * further authentication needed beyond a token. 64 KiB is ~300x the
 * largest legitimate frame and still small enough to be uninteresting.
 */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Failed-upgrade budget, per remote address.
 *
 * Counts only FAILURES, and -- since everything arrives from cloudflared
 * on one loopback address -- is consulted only AFTER a token has failed to
 * verify. Both halves are load-bearing: counting failures alone still let
 * an attacker's twenty bad tokens fill the single shared bucket and lock
 * the owner out, because the check ran before the signature did. A proven
 * owner now bypasses the budget and empties it.
 *
 * The window is short because the only legitimate source of a failure is
 * an expired token, which the client replaces by re-authenticating over
 * HTTP.
 */
const UPGRADE_FAIL_LIMIT = 20;
const UPGRADE_FAIL_WINDOW_MS = 60_000;

interface Deps {
  app: FastifyInstance;
  config: MiniappConfig;
  runner: TurnRunner;
  watchers: WatcherRegistry;
  threads: ThreadStore;
  subagents: SubagentIndex;
  jwtSecret: string;
}

export function attachWebSocket(deps: Deps): WebSocketServer {
  const { app, config, runner, watchers, threads, subagents, jwtSecret } = deps;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  /** Recent failed upgrades, per remote address. See UPGRADE_FAIL_LIMIT. */
  const upgradeFailures = new Map<string, number[]>();

  function noteUpgradeFailure(key: string): void {
    const now = Date.now();
    const recent = (upgradeFailures.get(key) || []).filter(
      (at) => now - at < UPGRADE_FAIL_WINDOW_MS,
    );
    recent.push(now);
    upgradeFailures.set(key, recent);
    // The map is keyed by peer and everything arrives from cloudflared on
    // loopback, so it stays tiny -- but a direct-LAN deployment must not
    // let it grow without bound either.
    if (upgradeFailures.size > 64) {
      for (const [peer, times] of upgradeFailures) {
        if (!times.some((at) => now - at < UPGRADE_FAIL_WINDOW_MS)) {
          upgradeFailures.delete(peer);
        }
      }
    }
  }

  /** A proven owner clears the bucket: it was never describing them. */
  function clearUpgradeFailures(key: string): void {
    upgradeFailures.delete(key);
  }

  function upgradeThrottled(key: string): boolean {
    const now = Date.now();
    const recent = (upgradeFailures.get(key) || []).filter(
      (at) => now - at < UPGRADE_FAIL_WINDOW_MS,
    );
    if (recent.length) upgradeFailures.set(key, recent);
    return recent.length >= UPGRADE_FAIL_LIMIT;
  }

  // Each connection registers four listeners across these two emitters, so
  // the default ceiling of 10 trips a spurious "possible memory leak"
  // warning well before MAX_CLIENTS. The real bound is MAX_CLIENTS itself.
  runner.setMaxListeners(MAX_CLIENTS + 10);
  subagents.setMaxListeners(MAX_CLIENTS + 10);

  /*
   * Authenticate BEFORE the handshake, not after it.
   *
   * This endpoint is the one thing the public tunnel exposes that is not
   * behind Fastify's routing or its rate limiter. Accepting first and
   * checking later meant an anonymous request took a slot out of the
   * global pool of MAX_CLIENTS and held it for AUTH_DEADLINE_MS -- so 32
   * tokenless connections every five seconds, which any script can manage,
   * kept the owner's own phone getting 503 indefinitely. Verifying the
   * token here means an unauthenticated peer never becomes a client at
   * all: no slot, no listeners, no timer, no frames read.
   *
   * The token stays out of every log line: only `url.pathname` is ever
   * logged, never `request.url`, which carries `?token=`.
   */
  app.server.on('upgrade', (request, socket, head) => {
    const peer = request.socket.remoteAddress || 'unknown';
    const refuse = (status: string, countsAsFailure = true) => {
      if (countsAsFailure) noteUpgradeFailure(peer);
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    let url: URL;
    try {
      url = new URL(request.url || '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    /*
     * Verify FIRST, throttle second.
     *
     * The throttle used to run ahead of `verifyToken`, and every request
     * arrives from cloudflared on loopback -- so there is exactly one
     * bucket, shared by the attacker and the owner. Twenty bad tokens from
     * anywhere on the internet therefore locked the owner's own phone out
     * of its own Mini App for the rest of the window: the thing the limit
     * was added to prevent, caused by the limit.
     *
     * A valid signature is proof of ownership, so it is checked first and
     * bypasses the budget entirely. The budget still exists and still
     * counts, but it now only ever gates requests that FAILED -- which is
     * the only traffic it was ever meant to describe.
     *
     * This does not reopen the slot or payload attacks: an unauthenticated
     * peer is still refused before `handleUpgrade`, so it never becomes a
     * client, and the frame cap below is unchanged. The cost a throttled
     * flood can still buy is one HS256 verification per attempt, which is
     * microseconds against a bounded-length token.
     */
    const token = url.searchParams.get('token');
    let authed = false;
    try {
      verifyToken(token || undefined, jwtSecret, config.allowedUserId);
      authed = true;
      clearUpgradeFailures(peer);
    } catch {
      authed = false;
    }

    if (!authed) {
      if (upgradeThrottled(peer)) {
        // Past the failure budget: refuse without counting it again, so a
        // sustained flood cannot extend its own window indefinitely.
        refuse('429 Too Many Requests', false);
        return;
      }
      app.log.warn(
        { path: url.pathname },
        'websocket upgrade refused: bad or missing token',
      );
      refuse('401 Unauthorized');
      return;
    }

    // Refuse rather than accept-then-drop: a socket that never completes
    // the handshake costs nothing, and this is the only gate in front of an
    // endpoint the tunnel exposes publicly. Checked AFTER auth so a flood
    // of anonymous sockets can no longer deny the pool to the real client.
    if (wss.clients.size >= MAX_CLIENTS) {
      refuse('503 Service Unavailable', false);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, token);
    });
  });

  wss.on('connection', (ws: WebSocket, _req, queryToken?: string | null) => {
    let authed = false;
    let sessionId: string | null = null;
    let msgFile: string | null = null;
    /** What this client is believed to have. The diff is against this. */
    let baseline: ThreadItem[] = [];
    /** Last `thread_meta` sent, so unchanged token counts stay off the wire. */
    let metaSent = '';
    let detach: (() => void) | null = null;
    let pushTimer: NodeJS.Timeout | null = null;
    let awaitTimer: NodeJS.Timeout | null = null;
    let lastPush = 0;
    /** Subagents whose timeline needs re-sending on the next push. */
    const dirtyChildren = new Set<string>();
    /** Live watchers on running subagents, keyed by child session id. */
    const childDetach = new Map<string, () => void>();

    const send = (payload: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    /** Dropped the moment the socket authenticates -- see AUTH_DEADLINE_MS. */
    let authTimer: NodeJS.Timeout | null = setTimeout(() => {
      authTimer = null;
      if (authed) return;
      send({ type: 'error', reason: 'unauthorized' });
      ws.close(4401, 'unauthorized');
      // close() waits for the peer; a silent client must not get to wait.
      setTimeout(() => ws.terminate(), 250).unref?.();
    }, AUTH_DEADLINE_MS);
    authTimer.unref?.();

    const clearAuthTimer = () => {
      if (authTimer) clearTimeout(authTimer);
      authTimer = null;
    };

    const authenticate = (token: string | null | undefined): boolean => {
      try {
        verifyToken(token || undefined, jwtSecret, config.allowedUserId);
        authed = true;
        clearAuthTimer();
        send({ type: 'ready' });
        return true;
      } catch {
        clearAuthTimer();
        send({ type: 'error', reason: 'unauthorized' });
        ws.close(4401, 'unauthorized');
        return false;
      }
    };

    if (queryToken && !authenticate(queryToken)) return;

    /**
     * Follow the subagents that are still running.
     *
     * A child writes its own messages.jsonl, so its live tool rows come from
     * tailing that file exactly as the parent's do. Watchers are held only
     * while a child runs; a child that has just finished is marked dirty one
     * last time so its card settles on its final state before we let go.
     */
    const followChildren = (children: ChildSession[]) => {
      const running = new Set(children.filter((c) => c.running).map((c) => c.id));
      for (const [childId, release] of childDetach) {
        if (running.has(childId)) continue;
        release();
        childDetach.delete(childId);
        dirtyChildren.add(childId);
      }
      for (const child of children) {
        if (!child.running || childDetach.has(child.id)) continue;
        const file = sessionMsgFile(config.sessionsDir, child.id);
        if (!file || !fs.existsSync(file)) continue;
        const watcher = watchers.acquire(child.id, file);
        const onEntries = () => {
          dirtyChildren.add(child.id);
          schedulePush();
        };
        watcher.on('entries', onEntries);
        childDetach.set(child.id, () => {
          watcher.off('entries', onEntries);
          watchers.release(child.id);
        });
        dirtyChildren.add(child.id);
      }
    };

    /** Rebuild from the transcript and push whatever moved. */
    const pushNow = () => {
      if (!sessionId || !msgFile) return;
      lastPush = Date.now();
      const busy = runner.isBusy(sessionId);
      const children = subagents.snapshot(sessionId, busy);
      let next: ParentView;
      try {
        next = buildParentView(
          threads,
          config.sessionsDir,
          sessionId,
          msgFile,
          busy,
          children,
        );
      } catch {
        return; // transcript vanished mid-read; the next tick recovers
      }

      followChildren(children.children);
      for (const steps of next.children) {
        if (!dirtyChildren.has(steps.childId)) continue;
        send({ type: 'subagent_delta', sessionId, ...steps });
      }
      dirtyChildren.clear();

      // Token counters, the citation catalog and the task list ride their
      // own event: they move independently of the item list, and a fold
      // gaining a step must not force all of that back over the wire.
      const meta = JSON.stringify({
        stats: next.stats,
        sources: next.sources,
        todos: next.todos,
      });
      if (meta !== metaSent) {
        metaSent = meta;
        send({
          type: 'thread_meta',
          sessionId,
          stats: next.stats,
          sources: next.sources,
          todos: next.todos,
        });
      }

      const delta = diffThread(baseline, next.items);
      if (!delta) return;
      baseline = next.items;
      send({ type: 'thread_delta', sessionId, ...delta });
    };

    const schedulePush = () => {
      if (pushTimer) return;
      const wait = Math.max(0, PUSH_THROTTLE_MS - (Date.now() - lastPush));
      pushTimer = setTimeout(() => {
        pushTimer = null;
        pushNow();
      }, wait);
      pushTimer.unref?.();
    };

    const onTurnStarted = (turn: InFlightTurn) => {
      if (turn.sessionId && turn.sessionId === sessionId) {
        send({ type: 'turn_started', ...turn });
        schedulePush();
      }
    };
    const onTurnFinished = (turn: TurnFinished) => {
      if (turn.sessionId !== sessionId) return;
      send({ type: 'turn_finished', ...turn });
      // One guaranteed full resync per turn -- see the header note. The
      // child list is re-read rather than waited out, so a subagent that
      // finished with the turn settles immediately.
      baseline = [];
      metaSent = '';
      void subagents.refresh(turn.sessionId).then(schedulePush, () => {});
      schedulePush();
    };
    /** A spawn or a status change is a thread change, with no file write. */
    const onSubagents = (parentId: string) => {
      if (parentId === sessionId) schedulePush();
    };
    const onStreamDelta = (delta: StreamDelta) => {
      if (delta.sessionId !== sessionId) return;
      send({ type: 'stream_delta', sessionId, text: delta.text });
    };

    runner.on('turn_started', onTurnStarted);
    runner.on('turn_finished', onTurnFinished);
    runner.on('stream_delta', onStreamDelta);
    subagents.on('updated', onSubagents);

    const unsubscribe = () => {
      detach?.();
      detach = null;
      for (const release of childDetach.values()) release();
      childDetach.clear();
      dirtyChildren.clear();
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = null;
      if (awaitTimer) clearTimeout(awaitTimer);
      awaitTimer = null;
      if (sessionId && msgFile) watchers.release(sessionId);
      sessionId = null;
      msgFile = null;
      baseline = [];
      metaSent = '';
    };

    /**
     * Attach the watcher once the transcript exists.
     *
     * A session created from the home composer has an id before it has a
     * file: `aside exec` is handed back as soon as its directory appears,
     * and messages.jsonl lands a moment later. Failing the subscribe
     * outright (which is what the first cut did) left a brand new chat with
     * no live updates at all until the user backed out and reopened it --
     * caught on a live run, where the socket answered `session_not_found`
     * 900ms after the session id was issued.
     *
     * So a missing file is a WAIT, not an error, for as long as the CLI
     * could plausibly still be creating it.
     */
    const attach = (id: string, file: string) => {
      msgFile = file;
      try {
        // The client has just loaded the thread over REST, so the baseline
        // starts at what is on disk now rather than empty -- otherwise
        // every thread open would re-send the history it already has.
        baseline = threads.build(
          id,
          file,
          runner.isBusy(id),
          subagents.snapshot(id),
        ).items;
      } catch {
        baseline = [];
      }

      const watcher = watchers.acquire(id, file);
      const onEntries = () => schedulePush();
      watcher.on('entries', onEntries);
      detach = () => watcher.off('entries', onEntries);

      send({
        type: 'subscribed',
        sessionId: id,
        busy: runner.isBusy(id),
        queued: runner.queuedCount(id),
        length: baseline.length,
      });
    };

    const subscribe = (nextId: string) => {
      if (!isValidSessionId(nextId)) {
        send({ type: 'error', reason: 'bad_session_id' });
        return;
      }
      unsubscribe();
      sessionId = nextId;

      const file = sessionMsgFile(config.sessionsDir, nextId);
      if (file && fs.existsSync(file)) {
        attach(nextId, file);
        return;
      }

      // Nothing on disk. Waiting is only justified when this server is
      // itself mid-turn on that id -- which is exactly the just-created
      // case, since `createSession` marks the queue running before it hands
      // the id back. For any other unknown id the answer is immediate, so a
      // typo or a stale link does not hang the client for half a minute.
      if (!runner.isBusy(nextId)) {
        send({ type: 'error', reason: 'session_not_found' });
        sessionId = null;
        return;
      }

      const deadline = Date.now() + NEW_SESSION_WAIT_MS;
      const poll = () => {
        if (sessionId !== nextId || ws.readyState !== ws.OPEN) return;
        const found = sessionMsgFile(config.sessionsDir, nextId);
        if (found && fs.existsSync(found)) {
          attach(nextId, found);
          return;
        }
        // The turn ending without a transcript means it failed outright.
        if (Date.now() > deadline || !runner.isBusy(nextId)) {
          send({ type: 'error', reason: 'session_not_found' });
          sessionId = null;
          return;
        }
        awaitTimer = setTimeout(poll, NEW_SESSION_POLL_MS);
        awaitTimer.unref?.();
      };
      poll();
    };

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        send({ type: 'error', reason: 'bad_json' });
        return;
      }
      if (msg?.type === 'auth') {
        if (!authed) authenticate(msg.token);
        return;
      }
      if (!authed) {
        send({ type: 'error', reason: 'unauthorized' });
        ws.close(4401, 'unauthorized');
        return;
      }
      if (msg?.type === 'ping') {
        send({ type: 'pong' });
        return;
      }
      if (msg?.type === 'subscribe') {
        subscribe(String(msg.sessionId || ''));
        return;
      }
      if (msg?.type === 'unsubscribe') {
        unsubscribe();
        return;
      }
      // A client that has fallen behind (a tab restored from the
      // background, typically) can ask for the whole thread again.
      if (msg?.type === 'resync') {
        baseline = [];
        schedulePush();
        return;
      }
      send({ type: 'error', reason: 'unknown_message' });
    });

    ws.on('close', () => {
      clearAuthTimer();
      unsubscribe();
      runner.off('turn_started', onTurnStarted);
      runner.off('turn_finished', onTurnFinished);
      runner.off('stream_delta', onStreamDelta);
      subagents.off('updated', onSubagents);
    });

    ws.on('error', () => ws.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if ((client as any).__alive === false) {
        client.terminate();
        continue;
      }
      (client as any).__alive = false;
      client.ping();
      client.once('pong', () => {
        (client as any).__alive = true;
      });
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    for (const client of wss.clients) client.terminate();
    wss.close();
  });

  return wss;
}

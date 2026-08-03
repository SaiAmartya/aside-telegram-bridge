/**
 * Turn execution: `aside exec` as a child process, one in-flight turn per
 * session, everything else queued.
 *
 * Ported from bridge.py's worker loop. Two behaviours from there matter:
 *  - Serial per session. The CLI silently drops prompts sent to a busy
 *    session, so a second concurrent turn is not "parallel", it is lost.
 *  - Adjacent queued messages batch into one turn (joined by a blank line)
 *    when they share model and effort, which is what makes rapid-fire
 *    typing behave sanely.
 *
 * Args are passed as an argv array (never a shell string), so prompt text
 * needs no quoting and cannot inject.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { EFFORT_LEVELS, type EffortLevel } from './config.js';
import { ProseFilter, stripAnsi } from './prose.js';
import { classifyError, execFailureAlert, type ErrorAlert } from './errors.js';

export interface TurnRequest {
  text: string;
  model: string;
  effort: EffortLevel;
}

/**
 * A slice of the assistant's answer, straight off the child's stdout.
 *
 * Provisional by construction: the transcript is still the source of truth
 * and replaces this the moment the message's jsonl line is written.
 */
export interface StreamDelta {
  sessionId: string;
  text: string;
}

export interface InFlightTurn {
  sessionId: string;
  model: string;
  effort: EffortLevel;
  startedAt: number;
  /** True until the CLI has created the session directory. */
  pending?: boolean;
}

export interface TurnFinished {
  sessionId: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
  /** The failure as a card, when there is one. See `errors.ts`. */
  alert?: ErrorAlert;
  /** Set when the user tapped Stop rather than the turn ending on its own. */
  stopped?: boolean;
  /**
   * Set when the driver was reaped because the session suspended on a
   * native question. The turn did not fail and was not stopped -- it is
   * parked, and the thread shows the question card.
   */
  suspended?: boolean;
}

export interface RunnerOptions {
  asideCli: string;
  sessionsDir: string;
  execTimeoutMs: number;
  defaultModel: string;
  defaultEffort: EffortLevel;
  modelAliases: Record<string, string>;
  /** Run `aside repl` to grant full-access on freshly created sessions. */
  grantFullAccess?: boolean;
  /**
   * Read a session's daemon status, for the suspend watchdog.
   *
   * Optional so the runner stays constructible without a database; without
   * it there is simply no watchdog and the old behaviour stands.
   */
  readStatus?: (sessionId: string) => Promise<string | null>;
  /** How often the watchdog checks a running turn's session status. */
  watchdogMs?: number;
  /** Injection seam for tests. */
  spawnFn?: typeof spawn;
}

interface SessionQueue {
  running: InFlightTurn | null;
  child: ChildProcess | null;
  queued: TurnRequest[];
  /** Cleared when the turn settles; see `armWatchdog`. */
  watchdog: NodeJS.Timeout | null;
  /** Set by `stop()` so the finish handler can report it honestly. */
  stopped?: boolean;
  /** Set by the watchdog when it reaps a suspended driver. */
  suspended?: boolean;
}

export function isEffort(value: unknown): value is EffortLevel {
  return EFFORT_LEVELS.includes(value as EffortLevel);
}

/**
 * Pull the daemon's model-unavailable notice out of a captured stream.
 *
 * This is the one failure a user can actually fix from the phone (pick
 * another model), so it is surfaced verbatim in the thread instead of
 * being reported as a generic turn failure.
 */
export function modelUnavailableIn(output: string): string | null {
  const match = String(output || '').match(
    /Requested model \S+ is not available for this account\.[^\n]*/,
  );
  return match ? match[0].trim() : null;
}

/**
 * Ceiling on retained per-session queue entries.
 *
 * A queue is created on first contact with a session id and, before this,
 * was never removed -- so a process meant to run for weeks accumulated one
 * entry per session it ever saw. Idle entries are pruned; a running or
 * queued one is never touched.
 */
const MAX_IDLE_QUEUES = 256;

/** Fallback when `execTimeoutMs` arrives unusable. See `armTimeout`. */
export const FALLBACK_EXEC_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The end-of-options marker, sent immediately before the prompt.
 *
 * The prompt is a POSITIONAL argument, and the CLI's parser reads anything
 * dash-leading as a flag no matter where it appears. So a perfectly
 * ordinary message that happens to start with `-` never reaches the agent:
 *
 *   $ aside exec --session X "- Color test: Red"
 *   error: unknown option '- Color test: Red'
 *
 * Caught in live E2E, where tapping an option on a question card sent
 * exactly that and the turn died with exit code 1. It is not specific to
 * question answers -- "-- actually, do X instead" typed by hand fails the
 * same way.
 *
 * `--` is the standard terminator and the CLI honours it: verified against
 * the real binary, where `aside exec --session X -- "-leading text"` gets
 * as far as "Session not found" rather than failing to parse. Passing it
 * unconditionally is correct: everything after `--` is positional, which
 * is what the prompt always was.
 *
 * Note this is NOT a shell-injection guard -- args already go as an argv
 * array, never a shell string. It is purely about the CLI's own parser.
 */
export const PROMPT_TERMINATOR = '--';

/**
 * How often a running turn's session status is checked.
 *
 * The watchdog exists because a session that calls `ask_user_question` goes
 * to `status=suspended` and the `aside exec` process this server spawned
 * then waits forever for an answer that can only come from the desktop
 * sidepanel. Left alone that child never exits: the queue stays `running`,
 * every later message piles up behind a turn that will never finish, and
 * the UI spins indefinitely. Reaping it is what turns a permanent jam into
 * a question card the user can see.
 */
export const WATCHDOG_INTERVAL_MS = 2_000;

/**
 * Grace between SIGTERM and SIGKILL when stopping a turn.
 *
 * The CLI flushes its transcript on SIGTERM, so the partial answer survives
 * -- which is the difference between a stopped turn that shows what the
 * agent got through and one that shows nothing.
 */
export const STOP_GRACE_MS = 3_000;

/**
 * The `aside repl` expression that widens a fresh session's permissions.
 *
 * The id is embedded with `JSON.stringify`, not with quotes-and-concat.
 * This was the one place in the codebase building repl code by string
 * interpolation (`'${sessionId}'`), which is the shape that turns into
 * remote code execution against the daemon the day the id stops being a
 * `[A-Za-z0-9_-]` token from a directory name. Every other repl call site
 * already went through a JSON literal; this one now matches.
 *
 * Exported so the escaping is asserted directly.
 */
export function grantFullAccessExpression(sessionId: string): string {
  return `aside.sessions.update(${JSON.stringify(
    sessionId,
  )}, { permissionMode: 'full-access' })`;
}


/**
 * `['-m', model]`, or nothing at all.
 *
 * An empty model is not an error and must not become `-m ''`, which the
 * CLI rejects outright. It means "this install has no configured default",
 * and the right response is to leave the flag off entirely so the CLI
 * falls back to the account's own default model. That is what a fresh
 * install with no `default_model` in its config now does, instead of
 * guessing at a Claude model the user may not have.
 */
export function modelArgs(model: string | undefined): string[] {
  const id = String(model || '').trim();
  return id ? ['-m', id] : [];
}

export class TurnRunner extends EventEmitter {
  private queues = new Map<string, SessionQueue>();
  private pendingNew: InFlightTurn[] = [];
  private spawnFn: typeof spawn;
  /**
   * Session ids a `createSession` discovery has already taken.
   *
   * Two concurrent creates used to pick the same directory -- both took the
   * lexicographically last new name -- so two turns landed on one id and one
   * session's output was attributed to the other. Verified. A claimed id is
   * off the table for any other discovery.
   */
  private claimedIds = new Set<string>();
  /** Create-session children that have no queue entry yet -- see `shutdown`. */
  private pendingChildren = new Set<ChildProcess>();
  /** Serialises discovery, so two creates cannot race over the same window. */
  private createChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: RunnerOptions) {
    super();
    this.spawnFn = opts.spawnFn || spawn;
  }

  /** Map a short alias (`sonnet`) onto its full model id. */
  resolveModel(model?: unknown): string {
    const raw = typeof model === 'string' && model.trim() ? model.trim() : '';
    if (!raw) return this.opts.defaultModel;
    return this.opts.modelAliases[raw] || raw;
  }

  resolveEffort(effort?: unknown): EffortLevel {
    return isEffort(effort) ? effort : this.opts.defaultEffort;
  }

  private queueFor(sessionId: string): SessionQueue {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = { running: null, child: null, queued: [], watchdog: null };
      this.queues.set(sessionId, queue);
    }
    return queue;
  }

  isBusy(sessionId: string): boolean {
    return Boolean(this.queues.get(sessionId)?.running);
  }

  queuedCount(sessionId: string): number {
    return this.queues.get(sessionId)?.queued.length ?? 0;
  }

  /** Accept a turn. Runs now if the session is idle, otherwise queues. */
  send(sessionId: string, request: TurnRequest): { queued: number } {
    const queue = this.queueFor(sessionId);
    queue.queued.push(request);
    if (!queue.running) this.pump(sessionId);
    return { queued: queue.queued.length };
  }

  private pump(sessionId: string): void {
    const queue = this.queueFor(sessionId);
    if (queue.running || !queue.queued.length) return;

    // Batch adjacent messages that share model + effort, like the bridge's
    // worker does, so quick follow-ups become one turn instead of a stall.
    const head = queue.queued.shift()!;
    const texts = [head.text];
    while (
      queue.queued.length &&
      queue.queued[0].model === head.model &&
      queue.queued[0].effort === head.effort
    ) {
      texts.push(queue.queued.shift()!.text);
    }

    const turn: InFlightTurn = {
      sessionId,
      model: head.model,
      effort: head.effort,
      startedAt: Date.now(),
    };
    queue.running = turn;
    this.emit('turn_started', turn);

    const args = [
      'exec',
      '--session',
      sessionId,
      ...modelArgs(head.model),
      '--effort',
      head.effort,
      // See `PROMPT_TERMINATOR`. Without this a message beginning with a
      // dash is parsed as a flag and the turn dies with `unknown option`.
      PROMPT_TERMINATOR,
      texts.join('\n\n'),
    ];
    const child = this.spawnFn(this.opts.asideCli, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    queue.child = child;
    queue.stopped = false;
    queue.suspended = false;
    this.armWatchdog(sessionId, queue, child);
    this.trackChild(child, turn, () => {
      this.disarmWatchdog(queue);
      const how = { stopped: queue.stopped, suspended: queue.suspended };
      queue.running = null;
      queue.child = null;
      queue.stopped = false;
      queue.suspended = false;
      this.pump(sessionId);
      this.pruneQueues();
      return how;
    });
  }

  /**
   * Watch a running turn for the session going `suspended`.
   *
   * `suspended` means the agent called a native question tool and the
   * daemon is waiting on the desktop sidepanel. The driver we spawned will
   * never return, so it is reaped by PID and the turn is reported finished
   * with `suspended: true` -- which is what lets the client swap an
   * infinite spinner for the question card.
   *
   * No status reader configured means no watchdog, and the previous
   * behaviour is unchanged.
   */
  private armWatchdog(
    sessionId: string,
    queue: SessionQueue,
    child: ChildProcess,
  ): void {
    const readStatus = this.opts.readStatus;
    if (!readStatus) return;
    const every = Number(this.opts.watchdogMs) > 0
      ? Number(this.opts.watchdogMs)
      : WATCHDOG_INTERVAL_MS;

    const timer = setInterval(() => {
      // A child that has already gone is not this timer's problem.
      if (queue.child !== child || child.exitCode !== null || child.signalCode) {
        this.disarmWatchdog(queue);
        return;
      }
      void readStatus(sessionId).then(
        (status) => {
          if (String(status || '').toLowerCase() !== 'suspended') return;
          if (queue.child !== child) return;
          queue.suspended = true;
          this.killChild(child);
        },
        () => {
          // An unreadable status is not evidence of anything; the next
          // tick tries again and the exec timeout is still the backstop.
        },
      );
    }, every);
    timer.unref?.();
    queue.watchdog = timer;
  }

  private disarmWatchdog(queue: SessionQueue): void {
    if (queue.watchdog) clearInterval(queue.watchdog);
    queue.watchdog = null;
  }

  /**
   * SIGTERM, then SIGKILL if it is still there.
   *
   * Always by PID -- never by name or command line. The live production
   * mini app runs from the same binary with the same argv, so a
   * pattern-based kill would take down the owner's real service.
   */
  private killChild(child: ChildProcess): void {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    const hard = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, STOP_GRACE_MS);
    hard.unref?.();
  }

  /**
   * Stop the turn a session is running, and drop anything queued behind it.
   *
   * Queued messages go too, deliberately: someone who taps Stop wants the
   * agent to stop, and silently running the next queued prompt a moment
   * later is the opposite of that.
   *
   * Returns false when there was nothing to stop, so the route can answer
   * honestly rather than claiming it did something.
   */
  stop(sessionId: string): boolean {
    const queue = this.queues.get(sessionId);
    if (!queue?.running || !queue.child) return false;
    queue.stopped = true;
    queue.queued.length = 0;
    this.disarmWatchdog(queue);
    this.killChild(queue.child);
    return true;
  }

  /**
   * The turn timeout, guaranteed usable.
   *
   * `config.ts` computes this as `Number(raw.exec_timeout_seconds || 1200) *
   * 1000`, which is NaN for any non-numeric value in the bridge config --
   * and `setTimeout(fn, NaN)` fires on the next tick, so every turn was
   * SIGTERM'd the instant it started. Silent, total, and indistinguishable
   * from the CLI failing. Verified.
   */
  private execTimeoutMs(): number {
    const raw = this.opts.execTimeoutMs;
    return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_EXEC_TIMEOUT_MS;
  }

  /**
   * `onDone` releases the queue and may hand back how the turn ended, which
   * only it knows -- the queue entry carries the `stopped` / `suspended`
   * flags and it is the thing that clears them.
   */
  private trackChild(
    child: ChildProcess,
    turn: InFlightTurn,
    onDone: () => { stopped?: boolean; suspended?: boolean } | void,
  ): void {
    let stderr = '';
    child.stderr?.on('data', (buf: Buffer) => {
      stderr = (stderr + buf.toString('utf8')).slice(-2000);
    });

    // The daemon reports an unusable model on stdout, not stderr, and
    // often still exits 0. Draining stdout without reading it would
    // swallow the one message that explains why nothing happened.
    //
    // The same stream also carries the answer as it is generated, so it is
    // passed through the prose filter and pushed out as deltas. A turn
    // whose session id is not known yet (a brand new session, mid
    // discovery) simply has nowhere to send them, and they are dropped
    // rather than queued -- the transcript covers that window.
    let stdout = '';
    const prose = new ProseFilter();
    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8');
      stdout = (stdout + text).slice(-4000);
      const delta = prose.feed(text);
      if (delta && turn.sessionId) {
        this.emit('stream_delta', {
          sessionId: turn.sessionId,
          text: delta,
        } satisfies StreamDelta);
      }
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, this.execTimeoutMs());
    timeout.unref?.();

    let settled = false;
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const how = onDone() || {};
      const payload: TurnFinished = {
        sessionId: turn.sessionId,
        exitCode,
        durationMs: Date.now() - turn.startedAt,
      };
      // Both streams are terminal output; anything surfaced to the user
      // has its escape sequences removed first.
      const cleanOut = stripAnsi(stdout);
      const cleanErr = stripAnsi(stderr);
      const refusal =
        modelUnavailableIn(cleanOut) || modelUnavailableIn(cleanErr);

      if (how.suspended) {
        // Not a failure. The agent asked something the daemon is holding
        // the session open for; the thread shows the question.
        payload.suspended = true;
      } else if (how.stopped) {
        // Also not a failure -- the user asked for this. Reporting a
        // SIGTERM exit as an error would put a red card on a deliberate act.
        payload.stopped = true;
      } else if (refusal) {
        payload.error = refusal;
        payload.alert = classifyError(refusal, { provider: turn.model.split('/')[0] });
      } else if (error || (exitCode !== 0 && cleanErr.trim())) {
        payload.error = (error || cleanErr.trim()).slice(0, 500);
        payload.alert = execFailureAlert(exitCode, payload.error);
      }
      this.emit('turn_finished', payload);
    };

    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  }

  /**
   * Start a brand new session. The CLI creates the session directory
   * within a second or two of launch, so we watch for a directory that was
   * not there before and hand the id back while the turn keeps running --
   * the client can then subscribe and watch the first reply stream in.
   */
  async createSession(
    request: TurnRequest,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ sessionId: string }> {
    // Discovery is a race against the filesystem, so only one may run at a
    // time. Two overlapping creates otherwise saw the same "new" directory
    // and both claimed it.
    const run = this.createChain.then(
      () => this.createSessionLocked(request, opts),
      () => this.createSessionLocked(request, opts),
    );
    this.createChain = run.catch(() => undefined);
    return run;
  }

  private async createSessionLocked(
    request: TurnRequest,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ sessionId: string }> {
    const before = new Set(this.listSessionDirs());
    const turn: InFlightTurn = {
      sessionId: '',
      model: request.model,
      effort: request.effort,
      startedAt: Date.now(),
      pending: true,
    };
    this.pendingNew.push(turn);

    const child = this.spawnFn(
      this.opts.asideCli,
      [
        'exec',
        ...modelArgs(request.model),
        '--effort',
        request.effort,
        // Same reason as the continuation path -- see `PROMPT_TERMINATOR`.
        PROMPT_TERMINATOR,
        request.text,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.pendingChildren.add(child);

    let discovered: string | null = null;
    /**
     * Set the moment the child settles.
     *
     * This is the whole fix for a session that came back wedged. The old
     * shape marked the queue `running` AFTER the poll loop, unconditionally
     * -- so a CLI that created its directory and then died before the next
     * 300ms tick had already run its cleanup (with `discovered` still null)
     * by the time we set `running`. Nothing ever cleared it: the session
     * reported busy forever, every later send queued behind a turn that had
     * finished minutes ago, and `/api/status` showed a phantom in flight.
     * Reproduced against this runner.
     */
    let settled = false;
    const dropPending = () => {
      const index = this.pendingNew.indexOf(turn);
      if (index >= 0) this.pendingNew.splice(index, 1);
    };
    const releaseQueue = (sessionId: string) => {
      const queue = this.queueFor(sessionId);
      this.disarmWatchdog(queue);
      const how = { stopped: queue.stopped, suspended: queue.suspended };
      queue.running = null;
      queue.child = null;
      queue.stopped = false;
      queue.suspended = false;
      this.pump(sessionId);
      return how;
    };

    this.trackChild(child, turn, () => {
      settled = true;
      this.pendingChildren.delete(child);
      dropPending();
      return discovered ? releaseQueue(discovered) : undefined;
    });

    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    const pollMs = opts.pollMs ?? 300;
    while (Date.now() < deadline) {
      const fresh = this.listSessionDirs()
        .filter((name) => !before.has(name))
        .map((name) => ({ name, id: name.slice(name.lastIndexOf('_') + 1) }))
        // A directory another discovery already took is not ours, and
        // neither is one we are already running a turn against.
        .filter(({ id }) => id && !this.claimedIds.has(id) && !this.isBusy(id));
      if (fresh.length) {
        // Newest wins when several appeared at once; the name carries the
        // date, so a plain sort orders them.
        fresh.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        discovered = fresh[fresh.length - 1].id;
        this.claimedIds.add(discovered);
        break;
      }
      if (child.exitCode !== null || child.signalCode) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (!discovered) {
      dropPending();
      child.kill('SIGTERM');
      throw new Error('could not detect a new session id from the CLI');
    }

    turn.sessionId = discovered;
    turn.pending = false;
    dropPending();

    if (settled) {
      // The child finished while we were still looking for its directory.
      // Its cleanup ran with no id to release, so do that work here rather
      // than marking a finished turn as running.
      this.claimedIds.delete(discovered);
      this.pump(discovered);
      return { sessionId: discovered };
    }

    const queue = this.queueFor(discovered);
    queue.running = turn;
    queue.child = child;
    queue.stopped = false;
    queue.suspended = false;
    // Only now is there an id to watch. A brand new session can suspend on
    // its very first turn, so it needs the watchdog as much as any other.
    this.armWatchdog(discovered, queue, child);
    // Bound: the directory now exists, so the next discovery's "before"
    // snapshot already excludes it and the claim has done its job. The
    // queue now owns the child, so shutdown reaches it that way.
    this.claimedIds.delete(discovered);
    this.pendingChildren.delete(child);
    this.emit('turn_started', turn);

    if (this.opts.grantFullAccess) this.grantFullAccess(discovered);
    return { sessionId: discovered };
  }

  /**
   * New CLI sessions default to guard mode. Off by default here -- the
   * mini app does not silently widen permissions; flip
   * `miniapp_grant_full_access` in the bridge config to opt in.
   */
  private grantFullAccess(sessionId: string): void {
    try {
      const child = this.spawnFn(
        this.opts.asideCli,
        ['repl', grantFullAccessExpression(sessionId)],
        { stdio: 'ignore' },
      );
      /*
       * Tracked, bounded and reaped.
       *
       * This was fire-and-forget: not in `pendingChildren`, so `shutdown`
       * never killed it, with no timeout and no close handler. An `aside
       * repl` that hung against an unresponsive daemon therefore lived
       * forever, one per session created, holding its pipes open. Being
       * best-effort is not a reason to leave a process untracked.
       */
      this.pendingChildren.add(child);
      const hard = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 10_000);
      hard.unref?.();
      const done = () => {
        clearTimeout(hard);
        this.pendingChildren.delete(child);
      };
      child.on('error', done);
      child.on('close', done);
    } catch {
      // best effort only
    }
  }

  private listSessionDirs(): string[] {
    try {
      return fs
        .readdirSync(this.opts.sessionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.includes('_'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  status(): { inFlight: InFlightTurn[]; queued: Record<string, number> } {
    const inFlight: InFlightTurn[] = [...this.pendingNew];
    const queued: Record<string, number> = {};
    for (const [sessionId, queue] of this.queues) {
      if (queue.running) inFlight.push(queue.running);
      if (queue.queued.length) queued[sessionId] = queue.queued.length;
    }
    return { inFlight, queued };
  }

  /**
   * Drop idle queue entries once there are more than we want to retain.
   *
   * Called after a turn settles. A queue with work in it is never pruned,
   * so this cannot lose a pending message.
   */
  private pruneQueues(): void {
    if (this.queues.size <= MAX_IDLE_QUEUES) return;
    for (const [sessionId, queue] of this.queues) {
      if (this.queues.size <= MAX_IDLE_QUEUES) return;
      if (queue.running || queue.queued.length) continue;
      this.queues.delete(sessionId);
    }
  }

  /**
   * Stop tracking and kill anything still running (server shutdown).
   *
   * `pendingChildren` matters: a `createSession` whose directory has not
   * appeared yet has no queue entry, so the old loop over `queues` walked
   * straight past it and left an `aside exec` running after the server had
   * gone. Verified.
   */
  shutdown(): void {
    for (const queue of this.queues.values()) {
      queue.queued.length = 0;
      this.disarmWatchdog(queue);
      queue.child?.kill('SIGTERM');
    }
    for (const child of this.pendingChildren) child.kill('SIGTERM');
    this.pendingChildren.clear();
  }
}

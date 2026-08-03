/**
 * Read-only peek at the daemon's own session state.
 *
 * The facade exposes titles and status but not a session's permission mode
 * or the model it is actually pinned to. Those live in the daemon's SQLite
 * database. This module reads them and nothing else.
 *
 * Safety rules, all deliberate:
 *
 *  - The database is opened with `readOnly: true`. Note the capital "O":
 *    `readonly` (lowercase) is silently ignored by node:sqlite and yields a
 *    WRITABLE handle. Verified against Node 23 -- lowercase let an INSERT
 *    through, capital-O rejected it with "attempt to write a readonly
 *    database". There is a test pinning this.
 *  - One short query per call, then the handle is closed. No transactions
 *    are held, so the daemon is never blocked behind us.
 *  - Every failure path returns "unknown" rather than a guess. A wrong
 *    permission label is worse than no permission label.
 */
import os from 'node:os';
import path from 'node:path';
import { defaultAsideRoot } from './config.js';

/** Shape of the `model` column, which stores JSON rather than a bare id. */
export interface SessionModel {
  provider: string;
  modelId: string;
  thinkingLevel?: string;
}

export interface SessionState {
  /** Display label, or null when it could not be read. */
  permission: string | null;
  /** The raw enum value the daemon stores -- what the picker checkmarks. */
  permissionMode: string | null;
  /** `runtime_config.finalConfirm`, or null when unreadable. */
  finalConfirm: boolean | null;
  /** The whole runtime_config, needed to write one key without losing the rest. */
  runtimeConfig: Record<string, unknown> | null;
  /** Per-session model, or null when unset/unreadable. */
  model: SessionModel | null;
  /** Set when this session is a subagent of another one. */
  parentId: string | null;
  /**
   * The daemon's own status for this session, or null when unreadable.
   *
   * `suspended` is the one value with teeth: it is what a session goes to
   * when it is blocked on a native `ask_user_question` or
   * `request_action_confirmation`, waiting for an answer the desktop
   * sidepanel is the only thing that can give. Verified today. Both the
   * driver watchdog and the composer's disabled state key off it.
   */
  status: string | null;
}

/** True when the session is blocked on a tool only the desktop can answer. */
export function isSuspended(status: string | null | undefined): boolean {
  return String(status || '').toLowerCase() === 'suspended';
}

export const UNKNOWN_STATE: SessionState = {
  permission: null,
  permissionMode: null,
  finalConfirm: null,
  runtimeConfig: null,
  model: null,
  parentId: null,
  status: null,
};

/**
 * A session row as the daemon's own table has it.
 *
 * This is the list source now. `aside.sessions.list()` returns only what
 * the browser sidepanel shows -- verified: 93 rows against 179 in the
 * table -- and drops every CLI-created session, which is where the Telegram
 * bridge's and this app's own sessions live.
 */
export interface StateSessionRow {
  id: string;
  /** May be the daemon's placeholder ("Aside CLI", "New Session") or empty. */
  title: string;
  trigger: string | null;
  status: string;
  readAt: number;
  updatedAt: number;
  createdAt: number;
  ephemeral: boolean;
}

/**
 * A subagent session, as the parent's thread needs it.
 *
 * `toolCallId` comes out of the `trigger` JSON and is the spawn call that
 * created this child -- the exact join key back into the parent transcript.
 */
export interface StateChildRow {
  id: string;
  title: string;
  status: string;
  toolCallId: string;
  model: SessionModel | null;
  createdAt: number;
  updatedAt: number;
}

export function defaultStateDbPath(): string {
  return (
    process.env.MINIAPP_STATE_DB ||
    path.join(defaultAsideRoot(), 'state.db')
  );
}

/**
 * Turn a stored `permission_mode` into the label Aside shows.
 *
 * The real column carries at least `full-access`, `guard` and `read-only`
 * (all three are present in live data), so this humanises the value
 * generically instead of switching on two known strings -- a new mode
 * should render as itself, not vanish or be mislabelled.
 */
export function permissionLabel(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const words = value.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return null;
  return words
    .map((word, index) =>
      index === 0 ? word[0].toUpperCase() + word.slice(1) : word,
    )
    .join(' ');
}

/** True when a label means "the agent can do anything" -- shown in orange. */
export function isFullAccess(label: string | null): boolean {
  return (label || '').toLowerCase().startsWith('full');
}

/**
 * Parse the `model` column.
 *
 * It holds a JSON object (`{"provider":…,"modelId":…,"thinkingLevel":…}`),
 * not the bare model id, so a raw read would put a JSON blob on the pill.
 */
export function parseSessionModel(raw: unknown): SessionModel | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const modelId = String(parsed.modelId || '').trim();
    if (!modelId) return null;
    return {
      provider: String(parsed.provider || '').trim(),
      modelId,
      thinkingLevel: parsed.thinkingLevel
        ? String(parsed.thinkingLevel)
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * node:sqlite is loaded lazily.
 *
 * It is still flagged experimental and absent before Node 22.5, so a
 * static import would take the whole server down on an older runtime for
 * a feature that is only ever a nice-to-have.
 */
type DatabaseCtor = new (
  filename: string,
  options?: Record<string, unknown>,
) => {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
};

type DbHandle = InstanceType<DatabaseCtor>;

/**
 * The options every handle in this module is opened with.
 *
 * A named constant rather than an inline literal, so the one property that
 * matters can be asserted directly. Note the capital "O": node:sqlite
 * silently ignores a lowercase `readonly` and hands back a WRITABLE handle,
 * and nothing about the reads here would look any different if it did --
 * which is exactly why the spelling needs a test that fails when it changes,
 * not a test that re-asserts what node:sqlite does with a literal of its own.
 */
export const STATE_DB_OPEN_OPTIONS: Readonly<Record<string, unknown>> =
  Object.freeze({ readOnly: true });

let ctor: DatabaseCtor | null | undefined;

async function loadDatabase(): Promise<DatabaseCtor | null> {
  if (ctor !== undefined) return ctor;
  try {
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync: DatabaseCtor;
    };
    ctor = mod.DatabaseSync ?? null;
  } catch {
    ctor = null;
  }
  return ctor;
}

interface CacheEntry {
  at: number;
  value: SessionState;
}

/**
 * Reads the permission mode and pinned model for one session.
 *
 * Results are cached briefly: a thread open triggers one read, and the
 * client re-polls the thread while a turn streams.
 */
/** Bounded, for the same reason every other cache here is. */
const MAX_STATE_CACHE = 256;

export class StateDb {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly dbPath: string = defaultStateDbPath(),
    private readonly ttlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async read(sessionId: string): Promise<SessionState> {
    const hit = this.cache.get(sessionId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;

    const value = await this.query(sessionId);
    this.cache.delete(sessionId);
    this.cache.set(sessionId, { at: this.now(), value });
    while (this.cache.size > MAX_STATE_CACHE) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return value;
  }

  /** Drop a cached row after a write, so the next read reflects it. */
  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /** This session's subagents, or null when the database is unreadable. */
  async children(parentId: string): Promise<StateChildRow[] | null> {
    const db = await this.open();
    if (!db) return null;
    try {
      return await readChildren(db, parentId);
    } catch {
      return null;
    } finally {
      try {
        db.close();
      } catch {
        // as elsewhere: closing a handle that never opened is not interesting
      }
    }
  }

  private async open(): Promise<DbHandle | null> {
    const Database = await loadDatabase();
    if (!Database) return null;
    try {
      return new Database(this.dbPath, STATE_DB_OPEN_OPTIONS);
    } catch {
      return null;
    }
  }

  private async query(sessionId: string): Promise<SessionState> {
    const db = await this.open();
    if (!db) return UNKNOWN_STATE;

    try {
      // `SELECT *` rather than a column list: the columns this reads have
      // been added to the table over time (`runtime_config` is newer than
      // `permission_mode`), and naming one the local database does not have
      // fails the whole read for the ones it does. One row by id is cheap
      // enough that the extra columns cost nothing.
      const row = db
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(sessionId) as
        | {
            permission_mode?: unknown;
            model?: unknown;
            runtime_config?: unknown;
            parent_id?: unknown;
            status?: unknown;
          }
        | undefined;

      // No row is not an error -- the session may predate the column or
      // live only on disk -- but it is still "unknown", so we say nothing.
      if (!row) return UNKNOWN_STATE;

      const runtimeConfig = parseRuntimeConfig(row.runtime_config);
      const mode = String(row.permission_mode ?? '').trim();

      return {
        permission: permissionLabel(row.permission_mode),
        permissionMode: mode || null,
        finalConfirm:
          runtimeConfig && typeof runtimeConfig.finalConfirm === 'boolean'
            ? runtimeConfig.finalConfirm
            : null,
        runtimeConfig,
        model: parseSessionModel(row.model),
        parentId: row.parent_id ? String(row.parent_id) : null,
        status: row.status ? String(row.status) : null,
      };
    } catch {
      // Missing file, locked db, absent table or column: all mean we do
      // not know, and the label is hidden rather than guessed.
      return UNKNOWN_STATE;
    } finally {
      try {
        db.close();
      } catch {
        // closing a handle that never opened is not interesting
      }
    }
  }

  /**
   * Every session the app should list.
   *
   * The filters, and why each one is there:
   *
   *  - `archived_at IS NULL` / `incognito = 0`: the browser hides both.
   *  - `parent_id IS NULL` plus `trigger.type != 'subagent'`: a subagent's
   *    own session is an implementation detail of its parent's turn. The
   *    sidepanel does not list them and 49 of them would otherwise bury the
   *    real conversations.
   *  - `ephemeral` is deliberately NOT filtered. That is the correction to
   *    the original diagnosis: CLI-created sessions -- the Telegram
   *    bridge's, and every session this app itself starts through `aside
   *    exec` -- are stored with `ephemeral = 1` and the placeholder title
   *    "Aside CLI". Excluding them is exactly what made them invisible, so
   *    the app would not even list a session the owner had just started
   *    from their phone.
   *
   * Returns null (not an empty list) when the database cannot be read, so
   * the caller can tell "no sessions" from "no database" and fall back.
   */
  async list(limit = 200): Promise<StateSessionRow[] | null> {
    const db = await this.open();
    if (!db) return null;

    try {
      const rows = db
        .prepare(
          `SELECT id, title, trigger, status, read_at, updated_at, created_at, ephemeral
             FROM sessions
            WHERE archived_at IS NULL
              AND incognito = 0
              AND parent_id IS NULL
              AND (trigger IS NULL OR json_extract(trigger, '$.type') != 'subagent')
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .all(Math.max(1, Math.min(Number(limit) | 0 || 200, 1000))) as Array<
        Record<string, unknown>
      >;

      return rows
        .filter((row) => typeof row.id === 'string' && row.id)
        .map((row) => ({
          id: String(row.id),
          title: String(row.title ?? '').trim(),
          trigger: row.trigger ? String(row.trigger) : null,
          status: String(row.status ?? 'idle'),
          readAt: epochMs(row.read_at),
          updatedAt: epochMs(row.updated_at),
          createdAt: epochMs(row.created_at),
          ephemeral: Number(row.ephemeral) === 1,
        }));
    } catch {
      return null;
    } finally {
      try {
        db.close();
      } catch {
        // as above
      }
    }
  }
}

/**
 * A session's subagents, oldest spawn first.
 *
 * Read here rather than through `aside.sessions.childSessions()`, which
 * returns the same rows: the facade costs a ~139MB process spawn per call
 * and this runs on every thread rebuild, and only the table carries the
 * child's pinned model. Returns null when the database cannot be read, so
 * the caller can fall back to bare spawn rows instead of claiming a session
 * has no subagents.
 */
export async function readChildren(
  db: { prepare: DbHandle['prepare'] },
  parentId: string,
): Promise<StateChildRow[]> {
  const rows = db
    .prepare(
      `SELECT id, title, status, trigger, model, created_at, updated_at
         FROM sessions
        WHERE parent_id = ?
        ORDER BY created_at ASC`,
    )
    .all(parentId) as Array<Record<string, unknown>>;

  return rows
    .filter((row) => typeof row.id === 'string' && row.id)
    .map((row) => ({
      id: String(row.id),
      title: String(row.title ?? '').trim(),
      status: String(row.status ?? 'idle'),
      toolCallId: triggerToolCallId(row.trigger),
      model: parseSessionModel(row.model),
      createdAt: epochMs(row.created_at),
      updatedAt: epochMs(row.updated_at),
    }));
}

/** `trigger` is JSON; a subagent's carries the spawn call that made it. */
export function triggerToolCallId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const parsed = JSON.parse(raw) as { toolCallId?: unknown };
    return typeof parsed.toolCallId === 'string' ? parsed.toolCallId : '';
  } catch {
    return '';
  }
}

/** The table stores unix SECONDS; the wire and the UI speak milliseconds. */
export function epochMs(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : Math.round(n * 1000);
}

/** Parse the `runtime_config` column, which holds a JSON object. */
export function parseRuntimeConfig(
  raw: unknown,
): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

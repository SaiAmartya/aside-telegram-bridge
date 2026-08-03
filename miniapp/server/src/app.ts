/**
 * Fastify app: auth spine, read API, write API, and the SPA host.
 *
 * Everything under /api except /api/auth and /api/health requires a bearer
 * JWT; the WebSocket requires the same token via ?token= or a first
 * `{type:"auth"}` frame.
 */
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import {
  EFFORT_LABELS,
  EFFORT_LEVELS,
  EFFORT_MENU,
  type MiniappConfig,
} from './config.js';
import {
  FacadeCache,
  fetchDefaultModel,
  fetchSession,
  markSessionRead,
} from './facade.js';
import {
  buildCatalog,
  contextWindowFor,
  modelLabel,
  readProviderIds,
} from './catalog.js';
import { readDesktopState } from './desktop.js';
import { StateDb, isFullAccess, isSuspended } from './statedb.js';
import { SettingsStore, defaultSettingsPath, resolveNewSessionModel } from './settings.js';
import { stripAgentDirectives, withPreamble, withReminder } from './preamble.js';
import {
  answerMessage,
  pendingNativeQuestion,
  recoveryPrompt,
} from './questions.js';
import { ThreadStore, buildParentView, fileStamp } from './threadstore.js';
import { SubagentIndex, toChildSession } from './subagents.js';
import {
  MAX_ARTIFACT_BYTES,
  isArtifactGroup,
  artifactContentType,
  listArtifacts,
  resolveArtifact,
  type ArtifactGroup,
} from './artifacts.js';
import {
  MAX_LOCAL_IMAGE_BYTES,
  localFileRoots,
  localFileStatus,
  openLocalFile,
} from './localfiles.js';
import {
  PERMISSION_MENU,
  applyPermission,
  isPermissionMode,
} from './permission.js';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  UploadError,
  defaultUploadsDir,
  promptWithAttachments,
  saveUpload,
  type SavedUpload,
} from './uploads.js';
import {
  InitDataError,
  MAX_AUTH_AGE_SECONDS,
  validateInitData,
} from './initdata.js';
import { TokenError, bearerFrom, mintToken, verifyToken } from './auth.js';
import { parseTranscript } from './transcript.js';
import { buildThread } from './thread.js';
import { readHistory, transcriptTooLarge } from './jsonl.js';
import {
  firstUserText,
  isMobileSession,
  isPlaceholderTitle,
  isValidSessionId,
  listSessionRows,
  resolveSessionDir,
  sessionMsgFile,
  titleFromTranscript,
  waitForTranscript,
} from './sessions.js';
import { SoftConfirmStore, defaultSoftConfirmPath } from './softconfirm.js';
import { TurnRunner } from './exec.js';
import { WatcherRegistry } from './watcher.js';
import { attachWebSocket } from './ws.js';

const MAX_MESSAGE_CHARS = 32_000;
const DEFAULT_ENTRY_LIMIT = 800;

/** Ceiling on a transcript read whole into memory. See the /messages route. */
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/** Upload receipts older than this are dropped, with their bytes. */
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
const UPLOAD_SWEEP_MS = 30 * 60 * 1000;
/** Hard ceiling on live receipts, so a flood cannot grow the map forever. */
const MAX_UPLOAD_RECEIPTS = 200;

/**
 * Strip the query string out of a logged URL.
 *
 * The artifact download route accepts `?token=<jwt>` because a download is
 * handed to the OS and cannot carry a header -- and Fastify's default `req`
 * serializer logs `req.url` verbatim, which wrote a live 24h bearer token
 * into miniapp.log in cleartext on every download. Observed directly; the
 * path is all the log needs.
 */
export function redactedRequest(request: {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  ip?: string;
  socket?: { remotePort?: number };
}): Record<string, unknown> {
  const raw = String(request.url ?? '');
  const cut = raw.indexOf('?');
  return {
    method: request.method,
    url: cut === -1 ? raw : `${raw.slice(0, cut)}?<redacted>`,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

export interface BuiltServer {
  app: FastifyInstance;
  runner: TurnRunner;
  watchers: WatcherRegistry;
  subagents: SubagentIndex;
}

export interface BuildOptions {
  /** Absolute path to the built SPA; static hosting is skipped if absent. */
  webDist?: string;
  jwtSecret: string;
  logger?: boolean;
  /**
   * The current public tunnel URL, read lazily.
   *
   * A function rather than a value because a quick tunnel rotates its
   * hostname while the server runs, so a snapshot taken at boot would be
   * wrong within the hour. The settings screen shows it; nothing depends
   * on it.
   */
  publicUrl?: () => string | null;
  /** Shown on the settings screen, so the owner can tell builds apart. */
  version?: string;
}

export async function buildServer(
  config: MiniappConfig,
  opts: BuildOptions,
): Promise<BuiltServer> {
  const app = Fastify({
    logger: opts.logger
      ? { serializers: { req: redactedRequest } }
      : (opts.logger ?? false),
    /**
     * `trustProxy` is deliberately OFF.
     *
     * It used to be `true`, which made `request.ip` the leftmost
     * `X-Forwarded-For` entry -- a header any client past the tunnel can
     * write. Since @fastify/rate-limit keys its buckets on `request.ip`,
     * that turned every limit in this file into a no-op: 30 `/api/auth`
     * attempts with a rotating `X-Forwarded-For` drew zero 429s. Verified
     * against this server, and pinned by a test.
     *
     * With it off, `request.ip` is the real socket peer -- the cloudflared
     * process on loopback -- so every request shares one bucket. For a
     * single-owner app that is the correct granularity anyway, and it is
     * the only one an attacker cannot choose for themselves.
     */
    trustProxy: false,
  });
  const startedAt = Date.now();

  // Read-only reader for the daemon's session table: the list, and each
  // session's permission mode, final-confirm flag, pinned model and status.
  // Declared before the runner because the runner's suspend watchdog reads
  // status through it.
  const stateDb = new StateDb(config.stateDbPath);

  const runner = new TurnRunner({
    asideCli: config.asideCli,
    sessionsDir: config.sessionsDir,
    execTimeoutMs: config.execTimeoutMs,
    defaultModel: config.defaultModel,
    defaultEffort: config.defaultEffort,
    modelAliases: config.modelAliases,
    grantFullAccess: process.env.MINIAPP_GRANT_FULL_ACCESS === '1',
    /**
     * The suspend watchdog's eyes. A session blocked on a native question
     * tool goes to `status=suspended` and the driver we spawned would
     * otherwise hang forever waiting for a desktop-only answer.
     *
     * The cache is invalidated first because `StateDb.read` holds a row for
     * 5s and the watchdog's entire job is to notice a transition promptly.
     */
    readStatus: async (sessionId) => {
      stateDb.invalidate(sessionId);
      return (await stateDb.read(sessionId)).status;
    },
  });
  const watchers = new WatcherRegistry();
  // Defaults for sessions this app creates, in this app's own store. See
  // settings.ts for why nothing here writes Aside's global settings.
  const settings = new SettingsStore(
    defaultSettingsPath(config.miniapp.stateDir),
  );
  // "Confirm before acting" for sessions driven from a phone. It is NOT
  // the daemon's `finalConfirm`: that one mandates the native confirmation
  // tool, which is the thing that bricks a mobile session. See
  // softconfirm.ts.
  const softConfirm = new SoftConfirmStore(
    defaultSoftConfirmPath(config.miniapp.stateDir),
  );
  // Every facade call spawns the CLI binary, so reads go through a
  // short-TTL, in-flight-coalescing cache rather than straight to it.
  const facade = new FacadeCache({ asideCli: config.asideCli });
  // Threads are built from the transcript on disk, so a rebuild is a file
  // read rather than a process spawn -- cheap enough to redo per write.
  const threads = new ThreadStore((file) =>
    fileStamp(file, (p) => fs.statSync(p, { throwIfNoEntry: false }) || undefined),
  );
  const uploadsDir = defaultUploadsDir();

  // The catalog USED to be built once, on the assumption that its inputs
  // could not change while we run. That assumption was wrong: the desktop
  // app rewrites ~/.aside/u/0/models.json whenever a provider or model is
  // edited, so a catalog frozen at boot goes stale the moment the owner
  // touches their model list -- which is exactly how the phone ended up
  // offering models that no longer existed and hiding ones that did.
  //
  // Rebuilding is two small cached-by-the-OS file reads, but it is on the
  // thread-render path, so it is memoised for a few seconds. Short enough
  // that a change in the desktop shows up on the phone almost at once, long
  // enough that a burst of requests does not re-read per item.
  const CATALOG_TTL_MS = 5_000;
  let catalogCache: ReturnType<typeof buildCatalog> = [];
  let catalogAt = 0;

  function currentCatalog(): ReturnType<typeof buildCatalog> {
    const now = Date.now();
    if (now - catalogAt < CATALOG_TTL_MS && catalogCache.length) {
      return catalogCache;
    }
    const desktop = readDesktopState(config.sessionsDir);
    catalogCache = buildCatalog(
      readProviderIds(config.credentialsPath),
      config.modelCatalogOverrides as any,
      desktop.providers,
      [desktop.defaultModel, ...Object.values(desktop.categories)],
    );
    catalogAt = now;
    return catalogCache;
  }

  /**
   * Kept as a getter-backed alias so the many existing `catalog` readers
   * below pick up refreshes without each one having to remember to call
   * `currentCatalog()`.
   */
  const catalog = new Proxy([] as ReturnType<typeof buildCatalog>, {
    get(_target, prop, receiver) {
      return Reflect.get(currentCatalog(), prop, receiver);
    },
    has(_target, prop) {
      return Reflect.has(currentCatalog(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(currentCatalog());
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(currentCatalog(), prop);
    },
  }) as ReturnType<typeof buildCatalog>;

  /**
   * Subagents of a session, read from the daemon's table and kept warm so
   * the synchronous thread build can see them. See `SubagentIndex`.
   */
  const subagents = new SubagentIndex(async (parentId) => {
    const rows = await stateDb.children(parentId);
    if (!rows) return null;
    return rows.map((row) =>
      toChildSession(row, (provider, modelId) =>
        modelLabel(catalog, provider, modelId),
      ),
    );
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    // Belt and braces alongside `trustProxy: false`: the bucket key is read
    // off the socket, never off a header, so no request can choose it.
    keyGenerator: (request) =>
      (request.raw.socket?.remoteAddress as string | undefined) || 'unknown',
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: MAX_UPLOAD_FILES,
      // Only files are expected; a stray text field is not a reason to 500.
      fields: 4,
    },
  });

  /** Bearer-token gate for every /api route except auth and health. */
  const requireAuth = async (request: FastifyRequest, reply: any) => {
    try {
      const claims = verifyToken(
        bearerFrom(request.headers.authorization),
        opts.jwtSecret,
        config.allowedUserId,
      );
      (request as any).user = claims;
    } catch (err) {
      const code = err instanceof TokenError ? err.code : 'invalid';
      return reply.code(401).send({ error: 'unauthorized', reason: code });
    }
  };

  /**
   * Same gate, but also accepting `?token=`.
   *
   * Used only by the artifact download route: a download is handed to the
   * OS (or to Telegram's own downloader), which issues a plain GET and
   * cannot carry an Authorization header. The WebSocket upgrade already
   * accepts the token this way for the same reason.
   */
  const requireAuthOrQueryToken = async (request: FastifyRequest, reply: any) => {
    const fromQuery = (request.query as { token?: unknown }).token;
    if (typeof fromQuery === 'string' && fromQuery) {
      try {
        (request as any).user = verifyToken(
          fromQuery,
          opts.jwtSecret,
          config.allowedUserId,
        );
        return;
      } catch {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    }
    return requireAuth(request, reply);
  };

  app.get('/api/health', async () => ({ ok: true }));

  // --- Phase 0: the auth spine ------------------------------------------
  app.post(
    '/api/auth',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = (request.body || {}) as { initDataRaw?: unknown };
      try {
        const validated = validateInitData(
          String(body.initDataRaw ?? ''),
          config.botToken,
          config.allowedUserId,
          { maxAgeSeconds: MAX_AUTH_AGE_SECONDS },
        );
        const token = mintToken(opts.jwtSecret, {
          sub: String(validated.user.id),
          uid: validated.user.id,
          name: validated.user.first_name,
        });
        return {
          token,
          user: {
            id: validated.user.id,
            firstName: validated.user.first_name,
            username: validated.user.username,
          },
          expiresIn: 24 * 60 * 60,
        };
      } catch (err) {
        if (err instanceof InitDataError) {
          const status = err.code === 'forbidden_user' ? 403 : 401;
          return reply.code(status).send({ error: 'auth_failed', reason: err.code });
        }
        request.log.error({ err }, 'auth failure');
        return reply.code(500).send({ error: 'internal' });
      }
    },
  );

  // --- Phase 1: read API -------------------------------------------------
  app.get(
    '/api/sessions',
    { preHandler: requireAuth },
    async (request) => {
      const query = request.query as { limit?: string };
      const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 200);
      const { rows, source } = await listSessionRows(
        facade,
        config.sessionsDir,
        limit,
        stateDb,
      );
      return { sessions: rows, source };
    },
  );

  /**
   * The thread as the sidepanel draws it: user bubbles, work folds, and
   * final answers. Opening a thread also clears its unread state, so the
   * dot disappears here and in the browser together.
   *
   * The transcript on disk is the source, NOT `aside.sessions.messages()`.
   * The facade returns the agent's current CONTEXT rather than the
   * conversation: on a long session it begins mid-turn, after compaction,
   * with a `system-message` and a wall of tool activity and no user message
   * in front of it. Built from that, a real session renders as one bare
   * work fold with no bubbles and no answers -- which is exactly what the
   * owner saw. messages.jsonl holds the whole history and the same record
   * shape, so it is what gets parsed here.
   */
  app.get(
    '/api/sessions/:id/thread',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }

      /*
       * Wait for a transcript that is still being written rather than
       * 404ing on it. See `waitForTranscript`: this is the same rule the
       * WebSocket already used, and its absence here is what made a brand
       * new chat flash "404: session_not_found" before it settled.
       */
      const msgFile = await waitForTranscript(config.sessionsDir, id, (sid) =>
        runner.isBusy(sid),
      );
      if (!msgFile) {
        return reply.code(404).send({ error: 'session_not_found' });
      }

      /*
       * Say so, rather than serving an empty conversation.
       *
       * `readHistory` refuses a transcript past the cap and returns an
       * empty list -- which is correct as a memory guard and a lie as an
       * answer: the thread rendered as a chat with nothing in it, 200 OK,
       * with no way to tell that from a genuinely empty session. This is
       * the same 413 `/messages` already gives, and the client already
       * turns it into "This chat is too long to open on your phone."
       */
      if (transcriptTooLarge(msgFile, MAX_TRANSCRIPT_BYTES)) {
        return reply.code(413).send({ error: 'transcript_too_large' });
      }

      const session = await fetchSession(facade, id).catch(() => null);
      const running = runner.isBusy(id) || session?.status === 'running';
      // A thread open is the one place worth paying for a fresh child read
      // rather than whatever the index happens to hold.
      const children = await subagents.refresh(id);
      const snapshot = buildParentView(
        threads,
        config.sessionsDir,
        id,
        msgFile,
        running,
        children,
      );

      // Best-effort; a failure here must not block the read.
      void markSessionRead(facade, id);

      // The session's real permission mode and pinned model. Both are null
      // when unreadable, and the client hides rather than guesses.
      const state = await stateDb.read(id);

      /**
       * The daemon's own status wins over the facade's.
       *
       * `suspended` -- blocked on a native question tool -- is the state
       * the composer has to know about, and it is in the table. Sending a
       * message to a suspended session queues an `aside exec` that hangs
       * forever, so the client disables the composer on it and says why.
       */
      const status = state.status || session?.status || 'idle';

      /**
       * A session started from a phone: this app's own, or bridge.py's.
       *
       * The switch in the permission popover means the SOFT protocol on
       * one of these, so what it shows has to come from the soft store --
       * the daemon's own flag is held at false there on purpose. See the
       * permission route.
       */
      const mobile = isMobileSession(config.sessionsDir, id);

      /**
       * The daemon titles every CLI-created session "Aside CLI", and every
       * session this app starts is CLI-created -- so the header on a
       * brand-new thread read "Aside CLI" rather than what the
       * conversation was about. The session LIST already worked around
       * this (see `isPlaceholderTitle` + `localScan`); the thread route
       * did not, so the same session showed a real title in the list and a
       * placeholder once opened. Same rule, applied in both places now.
       */
      const rawTitle = session?.title || '';
      const title = isPlaceholderTitle(rawTitle)
        ? titleFromTranscript(config.sessionsDir, id) || rawTitle
        : rawTitle;

      return {
        sessionId: id,
        title,
        status,
        /** Blocked on a desktop-only question; see `isSuspended`. */
        suspended: isSuspended(status),
        items: snapshot.items,
        stats: snapshot.stats,
        sources: snapshot.sources,
        /** Replayed `write_todos` state, for the task-list section. */
        todos: snapshot.todos,
        // From the snapshot, not from `children`: these carry the palette
        // slot of the spawn row each child came from, so the panel and the
        // thread draw the same creature colour.
        subagents: snapshot.subagents,
        /** Each subagent's timeline tail, so its card renders on first paint. */
        subagentSteps: snapshot.children,
        /** Set when this session is itself a subagent of another. */
        parentId: state.parentId,
        contextWindow: state.model
          ? contextWindowFor(catalog, state.model.provider, state.model.modelId)
          : contextWindowFor(catalog, 'claude-code', config.defaultModel),
        busy: runner.isBusy(id),
        queued: runner.queuedCount(id),
        permission: state.permission,
        permissionMode: state.permissionMode,
        finalConfirm: mobile ? softConfirm.has(id) : state.finalConfirm,
        /** True when the confirm toggle means the soft protocol. */
        softConfirm: mobile,
        model: state.model
          ? {
              provider: state.model.provider,
              modelId: state.model.modelId,
              label: modelLabel(
                catalog,
                state.model.provider,
                state.model.modelId,
              ),
              effort: state.model.thinkingLevel || null,
              effortLabel: state.model.thinkingLevel
                ? EFFORT_LABELS[state.model.thinkingLevel] ||
                  state.model.thinkingLevel
                : null,
            }
          : null,
      };
    },
  );

  /**
   * Raw transcript entries. The thread endpoint above is the primary read;
   * this stays as the live-streaming delta source during a running turn,
   * where tailing the jsonl beats re-spawning the CLI per token.
   */
  app.get(
    '/api/sessions/:id/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { afterLine?: string; limit?: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const msgFile = sessionMsgFile(config.sessionsDir, id);
      if (!msgFile || !fs.existsSync(msgFile)) {
        return reply.code(404).send({ error: 'session_not_found' });
      }
      const afterLine = Number.isFinite(Number(query.afterLine))
        ? Number(query.afterLine)
        : -1;
      const limit = Math.min(
        Math.max(Number(query.limit) || DEFAULT_ENTRY_LIMIT, 1),
        5000,
      );

      // This reads the whole transcript into memory before it can honour
      // `afterLine`, because line offsets are the cursor. A real session
      // reaches 57MB on the owner's machine, so the read is capped rather
      // than left to allocate whatever is on disk -- an oversized transcript
      // is reported as truncated instead of being turned into a 180MB
      // allocation per request.
      const size = fs.statSync(msgFile, { throwIfNoEntry: false })?.size ?? 0;
      if (size > MAX_TRANSCRIPT_BYTES) {
        return reply.code(413).send({ error: 'transcript_too_large' });
      }
      const buffer = fs.readFileSync(msgFile, 'utf8');
      const { entries, lastLine } = parseTranscript(buffer, { afterLine });
      const truncated = entries.length > limit;
      return {
        sessionId: id,
        entries: truncated ? entries.slice(-limit) : entries,
        truncated,
        lastLine,
        busy: runner.isBusy(id),
        queued: runner.queuedCount(id),
      };
    },
  );

  /**
   * The session's own files: what the agent wrote, and what came in with a
   * message. Both groups are always reported so the panel can say "no
   * files yet" rather than omitting a section that exists but is empty.
   */
  app.get(
    '/api/sessions/:id/artifacts',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const dir = isValidSessionId(id)
        ? resolveSessionDir(config.sessionsDir, id)
        : null;
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      if (!dir) return reply.code(404).send({ error: 'session_not_found' });

      return {
        sessionId: id,
        groups: [
          { id: 'artifacts', files: listArtifacts(dir, 'artifacts') },
          { id: 'attachments', files: listArtifacts(dir, 'attachments') },
        ],
      };
    },
  );

  /**
   * One file's bytes.
   *
   * The path is resolved and realpath-checked against the group directory
   * before anything is read, so neither `../` nor a symlink can name a file
   * elsewhere on the machine -- see `resolveArtifact`.
   */
  app.get(
    '/api/sessions/:id/artifacts/file',
    { preHandler: requireAuthOrQueryToken },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { path?: string; group?: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const group: ArtifactGroup = isArtifactGroup(query.group)
        ? query.group
        : 'artifacts';
      const dir = resolveSessionDir(config.sessionsDir, id);
      if (!dir) return reply.code(404).send({ error: 'session_not_found' });

      const file = resolveArtifact(dir, group, String(query.path ?? ''));
      if (!file) return reply.code(403).send({ error: 'forbidden_path' });

      // The agent owns this directory and may be rewriting it right now, so
      // the file can disappear between the resolve above and this stat. That
      // is a 404, not an unhandled throw turning into a 500. The isFile
      // check also has to come BEFORE any open: opening a fifo blocks.
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) {
        return reply.code(404).send({ error: 'file_not_found' });
      }

      /*
       * Open by descriptor, and answer off the descriptor.
       *
       * The window this closes is the one between the stat above and the
       * first byte read: the agent can unlink or truncate the file in it.
       * `fs.createReadStream(path)` cannot report that -- it opens
       * asynchronously and reports ENOENT as an `error` EVENT, so a
       * try/catch around it never fires and the handler had already sent
       * 200 plus artifact headers by the time the failure arrived. The
       * client got a successful, empty, correctly-typed response for a
       * file that was not there.
       *
       * `openSync` throws where it can be turned into a 404, and once the
       * descriptor is held the bytes behind it are stable no matter what
       * happens to the path -- so the size check below is also being
       * applied to the same file that is about to be sent, rather than to
       * whatever the name pointed at a moment ago.
       */
      let fd: number;
      try {
        fd = fs.openSync(file, 'r');
      } catch {
        return reply.code(404).send({ error: 'file_not_found' });
      }

      let opened: fs.Stats;
      try {
        opened = fs.fstatSync(fd);
      } catch {
        fs.closeSync(fd);
        return reply.code(404).send({ error: 'file_not_found' });
      }
      if (!opened.isFile()) {
        fs.closeSync(fd);
        return reply.code(404).send({ error: 'file_not_found' });
      }
      if (opened.size > MAX_ARTIFACT_BYTES) {
        fs.closeSync(fd);
        return reply.code(413).send({ error: 'file_too_large' });
      }

      const stream = fs.createReadStream(file, { fd, autoClose: true });
      // A read error after the headers are out cannot become a status
      // code, but it must not become an unhandled 'error' event either.
      stream.on('error', () => stream.destroy());

      return reply
        .header('content-type', artifactContentType(file))
        .header('cache-control', 'private, no-store')
        // These bytes are agent output; nothing here should ever be treated
        // as markup for our own origin.
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('x-content-type-options', 'nosniff')
        .send(stream);
    },
  );

  /**
   * A local image an answer points at, by absolute path.
   *
   * Answers routinely contain `![shot](/Users/…/shot.png)`, because the
   * agent writes markdown for a reader who is on the same machine it is.
   * The webview is not, so without this the bubble renders a broken-image
   * icon -- reported from a live run, where the same screenshot displayed
   * fine in the work timeline (transcript data URIs) and not in the answer
   * above it.
   *
   * Deliberately NOT a general file route: `resolveLocalFile` accepts
   * three roots, images only, 10 MB, realpath-contained. See
   * `localfiles.ts` for why each of those is there. `?token=` is accepted
   * for the same reason the artifact route accepts it -- an `<img>` tag
   * cannot carry an Authorization header -- and the logger's query
   * redaction (see `redactedRequest`) covers this path too.
   */
  app.get(
    '/api/sessions/:id/file',
    { preHandler: requireAuthOrQueryToken },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { path?: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const dir = resolveSessionDir(config.sessionsDir, id);
      if (!dir) return reply.code(404).send({ error: 'session_not_found' });

      const roots = localFileRoots({
        sessionDir: dir,
        uploadsDir,
        mediaDir: config.mediaDir,
      });
      /*
       * Resolve AND open together -- see `openLocalFile`.
       *
       * Containment, content type and the 10 MiB cap used to be decided
       * from the PATH and then a separate open streamed whatever the name
       * meant by that point. `openLocalFile` opens with `O_NOFOLLOW` and
       * re-checks "regular file" and the size cap on the DESCRIPTOR, so
       * the bytes that were measured are the bytes that go out.
       */
      const found = openLocalFile(roots, query.path, MAX_LOCAL_IMAGE_BYTES);
      if (!found.ok) {
        return reply
          .code(localFileStatus(found.reason))
          .send({ error: found.reason });
      }

      const stream = fs.createReadStream(found.file, {
        fd: found.fd,
        autoClose: true,
      });
      // A read error past the headers cannot become a status code, but it
      // must not become an unhandled 'error' event either.
      stream.on('error', () => stream.destroy());

      return reply
        .header('content-type', found.contentType)
        .header('cache-control', 'private, no-store')
        // Same posture as the artifact route: these bytes are agent output
        // and must never be treated as markup for our own origin.
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('x-content-type-options', 'nosniff')
        .send(stream);
    },
  );

  // --- Phase 2: write API ------------------------------------------------

  /**
   * Accept files from the phone and hand back the paths they landed on.
   *
   * Upload is a separate step from send, deliberately: the composer shows
   * chips the moment the OS picker returns, so the bytes are on their way
   * while the user is still typing, and a send with attachments is a plain
   * JSON call carrying paths.
   *
   * The paths returned here are the ONLY ones a later send will accept --
   * see `resolveAttachments`. A client cannot name an arbitrary file on the
   * machine and have it read out to the agent.
   */
  /**
   * Receipts for files this server stored, keyed by the path it handed out.
   *
   * Bounded in both directions. Left unbounded (which is how this started)
   * it is a map that only ever grows in a process meant to run for weeks,
   * and the bytes behind it accumulate under the uploads root with nothing
   * ever removing them. Entries age out after UPLOAD_TTL_MS -- comfortably
   * longer than the pick-then-send window the composer needs -- and the
   * oldest are evicted past MAX_UPLOAD_RECEIPTS regardless.
   */
  const uploadTokens = new Map<string, { saved: SavedUpload; at: number }>();

  const sweepUploads = (now = Date.now()): number => {
    let dropped = 0;
    for (const [key, entry] of uploadTokens) {
      if (now - entry.at < UPLOAD_TTL_MS) continue;
      uploadTokens.delete(key);
      dropped += 1;
      // The agent has long since read (or not read) these; the bytes are
      // the owner's private files and there is no reason to keep them.
      try {
        fs.rmSync(entry.saved.path, { force: true });
      } catch {
        // a file already gone is exactly the state we wanted
      }
    }
    // Map iteration is insertion-ordered, so the head is the oldest.
    while (uploadTokens.size > MAX_UPLOAD_RECEIPTS) {
      const oldest = uploadTokens.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      uploadTokens.delete(oldest);
      dropped += 1;
    }
    return dropped;
  };

  const uploadSweeper = setInterval(() => sweepUploads(), UPLOAD_SWEEP_MS);
  uploadSweeper.unref?.();

  const takeUploads = async (
    request: FastifyRequest,
  ): Promise<{ files: SavedUpload[]; error?: string; status?: number }> => {
    const files: SavedUpload[] = [];
    try {
      for await (const part of (request as any).files()) {
        if (files.length >= MAX_UPLOAD_FILES) {
          return { files, error: 'too_many_files', status: 413 };
        }
        const data: Buffer = await part.toBuffer();
        // @fastify/multipart flags a stream it had to truncate rather than
        // throwing, so the cap is checked explicitly too.
        if (part.file?.truncated || data.length > MAX_UPLOAD_BYTES) {
          return { files, error: 'file_too_large', status: 413 };
        }
        const saved = saveUpload(
          uploadsDir,
          part.filename,
          data,
          part.mimetype,
        );
        uploadTokens.set(saved.path, { saved, at: Date.now() });
        sweepUploads();
        files.push(saved);
      }
    } catch (err) {
      if (err instanceof UploadError) {
        return {
          files,
          error: err.code === 'too_large' ? 'file_too_large' : err.code,
          status: 413,
        };
      }
      // @fastify/multipart enforces its own limits by throwing a coded
      // error rather than returning, and those are the same two conditions
      // as above -- so they get the same 413 rather than a generic 400.
      const code = (err as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        return { files, error: 'file_too_large', status: 413 };
      }
      if (code === 'FST_FILES_LIMIT') {
        return { files, error: 'too_many_files', status: 413 };
      }
      request.log.error({ err }, 'upload failed');
      return { files, error: 'upload_failed', status: 400 };
    }
    if (!files.length) return { files, error: 'no_files', status: 400 };
    return { files };
  };

  /** Only paths this server itself handed out are ever passed to the agent. */
  const resolveAttachments = (raw: unknown): SavedUpload[] => {
    if (!Array.isArray(raw)) return [];
    const out: SavedUpload[] = [];
    for (const value of raw.slice(0, MAX_UPLOAD_FILES)) {
      const hit = typeof value === 'string' ? uploadTokens.get(value) : undefined;
      if (hit) out.push(hit.saved);
    }
    return out;
  };

  const uploadReply = async (request: FastifyRequest, reply: any) => {
    const { files, error, status } = await takeUploads(request);
    if (error) return reply.code(status || 400).send({ error });
    return {
      files: files.map((f) => ({
        path: f.path,
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
      })),
    };
  };

  app.post(
    '/api/sessions/:id/attachments',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      return uploadReply(request, reply);
    },
  );

  /** The home composer has no session yet, so uploads are not scoped to one. */
  app.post(
    '/api/attachments',
    { preHandler: requireAuth },
    async (request, reply) => uploadReply(request, reply),
  );

  app.post(
    '/api/sessions/new',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = (request.body || {}) as Record<string, unknown>;
      const text = String(body.text ?? '').trim();
      const attachments = resolveAttachments(body.attachments);
      if (!text && !attachments.length) {
        return reply.code(400).send({ error: 'empty_text' });
      }
      if (text.length > MAX_MESSAGE_CHARS) {
        return reply.code(413).send({ error: 'text_too_long' });
      }
      const stored = settings.read();
      /**
       * "Confirm before acting", as the composer's switch now means it.
       *
       * It used to become `runtimeConfig.finalConfirm = true`, i.e. the
       * daemon-level mandate to call `request_action_confirmation` -- the
       * one tool that suspends a session on a prompt no phone can answer.
       * A switch whose ON position guarantees a dead session is not a
       * safety feature. It is a stronger line in the preamble instead.
       */
      const strictConfirm =
        typeof body.finalConfirm === 'boolean'
          ? body.finalConfirm
          : Boolean(stored.defaultFinalConfirm);
      try {
        const { sessionId } = await runner.createSession({
          // The mobile-session preamble rides on the first prompt only.
          // It is what stops the agent calling `ask_user_question`, which
          // suspends the session on a question no phone can answer -- see
          // preamble.ts. It is stripped back out for display.
          text: withPreamble(
            promptWithAttachments(text, attachments.map((f) => f.path)),
            { strictConfirm },
          ),
          // An explicit pick from the composer wins; the stored default is
          // only consulted when the client sent nothing.
          model: runner.resolveModel(
            resolveNewSessionModel(stored, body.model),
          ),
          effort: runner.resolveEffort(body.effort ?? stored.defaultEffort),
        });

        softConfirm.set(sessionId, strictConfirm);

        // A permission choice made on the home composer applies to the
        // session the send just created. The create-then-update shape is
        // the same one the Python bridge uses; it binds from the NEXT turn.
        //
        // The stored default backs the composer's choice rather than
        // overriding it, and stays null unless the owner set one -- this
        // app does not widen permissions on its own. See settings.ts.
        const mode = isPermissionMode(body.permissionMode)
          ? body.permissionMode
          : (stored.defaultPermissionMode ?? undefined);
        /**
         * Always OFF, on every session this app creates.
         *
         * Not "leave it alone": the account-level default is inherited by
         * a new session, so an owner who has `finalConfirm` on for their
         * desktop work gets it on a session started from their phone too
         * -- and that is a SYSTEM instruction requiring the native
         * confirmation tool, which outranks the preamble above and bricks
         * the session the first time the agent touches anything external.
         * Writing false explicitly is the only way to be sure.
         *
         * Residual risk, stated honestly: like every other runtimeConfig
         * write, this binds on the NEXT `aside exec` spawn. The CLI offers
         * no flag or environment variable to bind it at create time
         * (checked against `aside exec --help`), so the very first turn of
         * a new session still runs under the inherited value. The preamble
         * is the only cover for that turn -- which is why it names the
         * tools explicitly rather than just describing the protocol.
         */
        void applyPermission(
          {
            facade,
            readRuntimeConfig: async (sid) =>
              (await stateDb.read(sid)).runtimeConfig,
          },
          sessionId,
          { mode, finalConfirm: false },
        )
          .then(() => stateDb.invalidate(sessionId))
          .catch((err) =>
            request.log.error({ err }, 'new-session permission apply failed'),
          );

        return { sessionId, accepted: true, softConfirm: strictConfirm };
      } catch (err) {
        request.log.error({ err }, 'new session failed');
        return reply
          .code(502)
          .send({ error: 'session_create_failed', reason: (err as Error).message });
      }
    },
  );

  app.post(
    '/api/sessions/:id/send',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as Record<string, unknown>;
      const text = String(body.text ?? '').trim();
      const attachments = resolveAttachments(body.attachments);
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      if (!text && !attachments.length) {
        return reply.code(400).send({ error: 'empty_text' });
      }
      if (text.length > MAX_MESSAGE_CHARS) {
        return reply.code(413).send({ error: 'text_too_long' });
      }
      if (!sessionMsgFile(config.sessionsDir, id)) {
        return reply.code(404).send({ error: 'session_not_found' });
      }

      /**
       * Refuse rather than jam.
       *
       * A session suspended on a native `ask_user_question` accepts an
       * `aside exec` and then never returns from it -- verified today
       * against the live CLI. Queuing one turns a recoverable state into a
       * permanently wedged session, so it is a 409 with a reason the client
       * can put on screen instead.
       */
      stateDb.invalidate(id);
      const live = await stateDb.read(id);
      if (isSuspended(live.status)) {
        return reply.code(409).send({
          error: 'session_suspended',
          reason:
            'This session is waiting on a question that can only be answered from Aside on your computer.',
        });
      }

      const { queued } = runner.send(id, {
        /**
         * The one-line reminder rides on every follow-up.
         *
         * The preamble is on the first message only, and a long session
         * gets compacted -- the instruction is exactly the kind of
         * housekeeping a summariser drops, after which the next question
         * is a native tool call and the session is unrecoverable. See
         * `MOBILE_FOLLOWUP_REMINDER`. It is appended, so it composes with
         * the attachment header (which is prepended) and cannot make the
         * prompt dash-leading.
         */
        text: withReminder(
          promptWithAttachments(text, attachments.map((f) => f.path)),
          { strictConfirm: softConfirm.has(id) },
        ),
        model: runner.resolveModel(body.model),
        effort: runner.resolveEffort(body.effort),
      });
      return { accepted: true, queued, busy: runner.isBusy(id) };
    },
  );

  /**
   * Stop the turn a session is running.
   *
   * The server owns the driver child, so this is a kill by PID -- SIGTERM,
   * then SIGKILL after a grace period (see `STOP_GRACE_MS`). Never a
   * pattern kill: the owner's live mini app service runs the same binary
   * with the same argv, and matching on that would take it down.
   *
   * Answering 409 when there is nothing running is the honest reply; the
   * composer re-enables either way.
   */
  app.post(
    '/api/sessions/:id/stop',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      if (!runner.stop(id)) {
        return reply.code(409).send({ error: 'not_running' });
      }
      return { ok: true, stopping: true };
    },
  );

  /**
   * Answer a soft-protocol question by sending the choice as a message.
   *
   * Deliberately its own route rather than a plain send: it is the one
   * place that must never be pointed at a suspended session (a native
   * pending tool cannot be answered this way, and trying is what hangs a
   * driver), and having a named endpoint keeps that check in one place.
   */
  app.post(
    '/api/sessions/:id/answer',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as Record<string, unknown>;
      const label = String(body.label ?? '').trim();
      const header = String(body.header ?? '').trim();
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      if (!label) return reply.code(400).send({ error: 'empty_answer' });
      if (!sessionMsgFile(config.sessionsDir, id)) {
        return reply.code(404).send({ error: 'session_not_found' });
      }

      stateDb.invalidate(id);
      const live = await stateDb.read(id);
      if (isSuspended(live.status)) {
        return reply.code(409).send({
          error: 'session_suspended',
          reason:
            'This question is waiting on Aside on your computer and cannot be answered from here.',
        });
      }

      const { queued } = runner.send(id, {
        // Same reminder as an ordinary send. Appended, so the answer text
        // still leads the prompt and the `--` terminator still covers a
        // label that begins with a dash.
        text: withReminder(answerMessage(header, label), {
          strictConfirm: softConfirm.has(id),
        }),
        model: runner.resolveModel(body.model),
        effort: runner.resolveEffort(body.effort),
      });
      return { accepted: true, queued, busy: runner.isBusy(id) };
    },
  );

  /**
   * Carry on from a session that is stuck on a desktop-only question.
   *
   * There is no unsticking one. The daemon holds it suspended waiting for
   * an answer over the sidepanel's authenticated channel, and nothing this
   * server can send reaches that channel -- verified against the live CLI
   * in every form. So the way forward is sideways: a NEW session, carrying
   * the full mobile preamble, seeded with what was asked and what the user
   * just tapped. See `recoveryPrompt`.
   *
   * The stuck session is left exactly as it is. It is still readable, and
   * pretending otherwise would be the same dishonesty the read-only banner
   * exists to avoid.
   */
  app.post(
    '/api/sessions/:id/recover',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as Record<string, unknown>;
      const answer = String(body.answer ?? '').trim();
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const msgFile = sessionMsgFile(config.sessionsDir, id);
      if (!msgFile) {
        return reply.code(404).send({ error: 'session_not_found' });
      }

      // The question comes from the server's own thread build rather than
      // from the request body: the client could send anything, and what
      // the new session is told the old one asked has to be true.
      const question = pendingNativeQuestion(
        buildThread(readHistory(msgFile), false) as any,
      );
      if (!question) {
        return reply.code(409).send({ error: 'no_pending_question' });
      }

      const stored = settings.read();
      const strictConfirm = softConfirm.has(id);
      const seed = recoveryPrompt({
        question,
        answer,
        firstMessage: stripAgentDirectives(firstUserText(msgFile)),
      });

      try {
        const { sessionId } = await runner.createSession({
          text: withPreamble(seed, { strictConfirm }),
          model: runner.resolveModel(
            resolveNewSessionModel(stored, body.model),
          ),
          effort: runner.resolveEffort(body.effort ?? stored.defaultEffort),
        });
        softConfirm.set(sessionId, strictConfirm);
        // Same reasoning as the create route: never inherit the account's
        // native final-confirm onto a session driven from a phone.
        void applyPermission(
          {
            facade,
            readRuntimeConfig: async (sid) =>
              (await stateDb.read(sid)).runtimeConfig,
          },
          sessionId,
          {
            mode: stored.defaultPermissionMode ?? undefined,
            finalConfirm: false,
          },
        )
          .then(() => stateDb.invalidate(sessionId))
          .catch((err) =>
            request.log.error({ err }, 'recovery permission apply failed'),
          );
        return { sessionId, accepted: true, from: id };
      } catch (err) {
        request.log.error({ err }, 'recovery session failed');
        return reply
          .code(502)
          .send({ error: 'session_create_failed', reason: (err as Error).message });
      }
    },
  );

  // --- settings ----------------------------------------------------------

  app.get('/api/settings', { preHandler: requireAuth }, async () => ({
    settings: settings.read(),
  }));

  /**
   * Partial update. Only the keys the body carries are touched, so a client
   * that knows about one field cannot blank the others.
   */
  app.post(
    '/api/settings',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return reply.code(400).send({ error: 'bad_body' });
      }
      return { settings: settings.write(body) };
    },
  );

  /**
   * Change a session's permission mode and/or its confirm-before-acting
   * toggle.
   *
   * Honest about scope: the daemon reads both when it spawns the next
   * `aside exec`, so a change takes effect from the next message rather
   * than reaching into a turn already running. The UI says the same.
   *
   * The confirm toggle forks on where the session came from. On one this
   * app or bridge.py started -- a session being DRIVEN FROM A PHONE -- the
   * native `finalConfirm` flag is never set true, because it is the
   * daemon-level mandate to call `request_action_confirmation` and that
   * tool can only be answered from the desktop sidepanel. Turning a safety
   * switch on must not be the thing that kills the session. It writes the
   * soft flag instead (see softconfirm.ts), which becomes a stronger line
   * in the preamble and in every follow-up reminder.
   *
   * On a session started at the owner's desk the sidepanel IS there, so
   * the switch keeps its original meaning and writes the daemon's flag.
   */
  app.post(
    '/api/sessions/:id/permission',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as Record<string, unknown>;
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      if (!sessionMsgFile(config.sessionsDir, id)) {
        return reply.code(404).send({ error: 'session_not_found' });
      }

      const hasMode = body.mode !== undefined;
      const hasConfirm = body.finalConfirm !== undefined;
      if (!hasMode && !hasConfirm) {
        return reply.code(400).send({ error: 'nothing_to_change' });
      }
      if (hasMode && !isPermissionMode(body.mode)) {
        return reply.code(400).send({ error: 'bad_mode' });
      }
      if (hasConfirm && typeof body.finalConfirm !== 'boolean') {
        return reply.code(400).send({ error: 'bad_final_confirm' });
      }

      const mobile = isMobileSession(config.sessionsDir, id);
      const wanted = hasConfirm ? (body.finalConfirm as boolean) : undefined;
      if (hasConfirm && mobile) softConfirm.set(id, Boolean(wanted));

      try {
        await applyPermission(
          {
            facade,
            readRuntimeConfig: async (sid) =>
              (await stateDb.read(sid)).runtimeConfig,
          },
          id,
          {
            mode: hasMode ? (body.mode as any) : undefined,
            // On a mobile session the native flag is forced OFF rather
            // than left alone: it may already be true, inherited from the
            // account default, and this is the moment to clear it.
            finalConfirm: hasConfirm ? (mobile ? false : wanted) : undefined,
          },
        );
      } catch (err) {
        request.log.error({ err }, 'permission update failed');
        return reply.code(502).send({ error: 'permission_update_failed' });
      }

      // The write went through the daemon, so every cached read of this
      // session is now stale.
      stateDb.invalidate(id);
      facade.invalidate(`session:${id}`);

      const state = await stateDb.read(id);
      return {
        ok: true,
        permission: state.permission,
        permissionMode: state.permissionMode,
        /**
         * What the switch shows. On a mobile session that is the soft flag
         * -- reporting the daemon's (always false) value would flick the
         * switch back off under the owner's thumb.
         */
        finalConfirm: mobile ? softConfirm.has(id) : state.finalConfirm,
        /** True when the toggle means the soft protocol, not the daemon's. */
        softConfirm: mobile,
        fullAccess: isFullAccess(state.permission),
        /** The change binds on the next spawn, not on the running turn. */
        appliesFrom: 'next-message',
      };
    },
  );

  app.get('/api/status', { preHandler: requireAuth }, async () => {
    const status = runner.status();

    // Aside's own current default, so the pills open showing what the
    // browser shows rather than a config guess.
    //
    // Three sources, most authoritative first. The daemon is asked first
    // because it is the live answer, but it needs a ~139MB process spawn
    // and fails whenever the desktop app is not running -- and it was
    // failing to `claude-code` + whatever stale string the bridge config
    // carried, which is how the phone came to show a model the desktop had
    // not used in days. settings.json is the same value the daemon would
    // have reported, read straight off disk, so it is a far better second
    // than the hand-maintained config.
    const daemonDefault = await fetchDefaultModel(facade).catch(() => null);
    const desktop = readDesktopState(config.sessionsDir);
    const fallback = desktop.defaultModel;
    const provider =
      daemonDefault?.provider || fallback?.provider || 'claude-code';
    const modelId =
      daemonDefault?.modelId || fallback?.modelId || config.defaultModel;
    const effort =
      daemonDefault?.thinkingLevel ||
      fallback?.thinkingLevel ||
      config.defaultEffort;

    return {
      uptimeMs: Date.now() - startedAt,
      inFlight: status.inFlight,
      queued: status.queued,
      catalog,
      efforts: EFFORT_LEVELS,
      /** What the Reasoning popover offers, in Aside's order. */
      effortMenu: EFFORT_MENU.map((id) => ({ id, label: EFFORT_LABELS[id] })),
      /** What the Permission popover offers, in Aside's order. */
      permissionMenu: PERMISSION_MENU,
      uploads: { maxFiles: MAX_UPLOAD_FILES, maxBytes: MAX_UPLOAD_BYTES },
      defaults: {
        provider,
        modelId,
        modelLabel: modelLabel(catalog, provider, modelId),
        effort,
        effortLabel: EFFORT_LABELS[effort] || effort,
      },
      permission: process.env.MINIAPP_GRANT_FULL_ACCESS === '1'
        ? 'Full access'
        : 'Guard',
      /**
       * What the settings screen's Connection section reports.
       *
       * Deliberately free of anything sensitive: no token, no user id, no
       * absolute paths. `bridgeRunning` is inferred from whether the Python
       * bridge's config directory is on disk, which is all this process can
       * honestly say about a service it does not own.
       */
      service: {
        version: opts.version || '',
        /** `cloudflared` or `none`, straight from the config. */
        tunnel: config.miniapp.tunnel,
        tunnelUrl: opts.publicUrl?.() || null,
        port: config.port,
        // The daemon answering the facade at all is the useful signal.
        asideReachable: daemonDefault !== null,
        bridgeConfigured: fs.existsSync(
          path.join(config.miniapp.stateDir, 'config.json'),
        ),
      },
    };
  });

  // --- SPA hosting -------------------------------------------------------
  if (opts.webDist && fs.existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  attachWebSocket({
    app,
    config,
    runner,
    watchers,
    threads,
    subagents,
    jwtSecret: opts.jwtSecret,
  });

  app.addHook('onClose', async () => {
    clearInterval(uploadSweeper);
    watchers.closeAll();
    runner.shutdown();
  });

  return { app, runner, watchers, subagents };
}

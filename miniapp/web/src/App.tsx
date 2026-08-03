/**
 * The app shell: a sidepanel home screen and a thread screen.
 *
 * Home is the composer card over the session list -- sending from it
 * starts a new session, which is why there is no separate new-chat
 * control. The thread screen carries the reply composer and the bottom
 * bar. Model, effort and permission controls appear on both and drive the
 * same state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SessionList } from './components/SessionList';
import { Thread } from './components/Thread';
import { Composer } from './components/Composer';
import { PermissionPicker } from './components/Pickers';
import { ModelSheet } from './components/ModelSheet';
import { CitationSheet } from './components/Citations';
import { SessionPanel } from './components/SessionPanel';
import { SettingsScreen } from './components/SettingsScreen';
import { RestCue, RestHero } from './components/Rest';
import { StreamFooter, estimateTokens } from './components/StreamFooter';
import { TodoSection } from './components/TodoSection';
import { ErrorCard } from './components/ErrorCard';
import { ChevronLeft, PanelRight, Settings, Spinner } from './components/Icons';
import type { CitationMark } from './utils/citations';
import { api, setAuthToken } from './api';
import { useThread } from './hooks/useThread';
import { useAttachments } from './hooks/useAttachments';
import { reconcilePick, resolvePills, resolveThreadModel } from './utils/pills';
import {
  applyTheme,
  backButton,
  haptic,
  initTelegram,
  onThemeChanged,
  readInitData,
  stashDevInitData,
} from './telegram';
import type { CatalogProvider, SessionRow, StatusResponse } from './types';

/**
 * A thread on the navigation stack.
 *
 * `parentTitle` is set when this thread was opened from a subagent card, so
 * the header can say whose subagent it is. It comes from the caller rather
 * than from another lookup: whoever navigated here already had the title on
 * screen.
 */
interface ThreadScreenState {
  id: string;
  parentTitle?: string;
}
type AuthState =
  | { phase: 'pending' }
  | { phase: 'ready'; name?: string }
  | { phase: 'failed'; reason: string };

type PickerState =
  | { kind: 'none' }
  | { kind: 'model'; anchor: HTMLElement }
  | { kind: 'permission'; anchor: HTMLElement };

const PROVIDER_KEY = 'miniapp.provider';
const MODEL_KEY = 'miniapp.model';
const EFFORT_KEY = 'miniapp.effort';

/**
 * The permission menu, if /status has not answered yet.
 *
 * Hard-coded rather than left empty because these three are the daemon's
 * whole enum -- it validates against exactly this list -- so there is
 * nothing to discover and no risk of showing a mode that does not exist.
 */
const FALLBACK_PERMISSION_MENU = [
  { id: 'read-only', label: 'Read only' },
  { id: 'guard', label: 'Guard' },
  { id: 'full-access', label: 'Full access' },
];

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ phase: 'pending' });
  /**
   * The open threads, innermost last. Home is the empty stack.
   *
   * A stack rather than a single screen because a subagent card opens the
   * child's own thread, and backing out of it has to land on the parent
   * rather than on the session list.
   */
  const [stack, setStack] = useState<ThreadScreenState[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [picker, setPicker] = useState<PickerState>({ kind: 'none' });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** The Settings screen, opened from the model picker's Settings row. */
  const [settingsOpen, setSettingsOpen] = useState(false);

  const attachments = useAttachments();

  /**
   * The home scroller and the history block inside it.
   *
   * Home is one tall scroll: a full-viewport resting panel, then the
   * session list below it. Both refs exist so the Recents cue can drive
   * the same movement the swipe does, and so backing out of a thread
   * returns to the resting panel rather than wherever the list was left.
   */
  const homeScroll = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const scrollToHistory = useCallback(() => {
    haptic('light');
    historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // A chosen model/effort sticks across launches; until one is chosen the
  // pills mirror whatever the daemon's own default is.
  const [provider, setProvider] = useState(
    () => localStorage.getItem(PROVIDER_KEY) || '',
  );
  const [modelId, setModelId] = useState(
    () => localStorage.getItem(MODEL_KEY) || '',
  );
  const [effort, setEffort] = useState(
    () => localStorage.getItem(EFFORT_KEY) || '',
  );

  /**
   * The permission a NEW session should get.
   *
   * There is no session to write to on the home screen, so the choice is
   * held here and applied right after the CLI hands back an id -- the same
   * create-then-update shape the Python bridge uses. `null` means "leave
   * the daemon's default alone", which is the honest default.
   */
  const [newMode, setNewMode] = useState<string | null>(null);
  const [newFinalConfirm, setNewFinalConfirm] = useState<boolean | null>(null);

  // --- auth ---------------------------------------------------------------
  useEffect(() => {
    initTelegram();
    applyTheme();
    const off = onThemeChanged(applyTheme);
    stashDevInitData(location.hash);

    const raw = readInitData();
    if (!raw) {
      setAuth({ phase: 'failed', reason: 'Open this from Telegram.' });
      return off;
    }
    api.auth(raw).then(
      (res) => {
        setAuthToken(res.token);
        setAuth({ phase: 'ready', name: res.user.firstName });
      },
      (err) => setAuth({ phase: 'failed', reason: (err as Error).message }),
    );
    return off;
  }, []);

  // --- data ---------------------------------------------------------------
  const loadSessions = useCallback(async () => {
    try {
      const res = await api.sessions();
      setSessions(res.sessions);
    } catch {
      // The list keeps its previous contents rather than blanking out.
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  /**
   * Re-read the catalog and the daemon's default.
   *
   * The server rebuilds its catalog from the desktop app's own
   * models.json/settings.json on a 5s TTL, but the client used to fetch
   * `/status` exactly once at launch -- so every one of those refreshes
   * was invisible to the phone, which kept offering models the desktop had
   * deleted and kept showing a default the desktop had changed. A Mini App
   * webview is routinely left open for days.
   */
  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch {
      // Keep whatever we last knew rather than blanking the pickers.
    }
  }, []);

  useEffect(() => {
    if (auth.phase !== 'ready') return;
    void loadSessions();
    void refreshStatus();
  }, [auth.phase, loadSessions, refreshStatus]);

  // A bounded refresh, so a long-lived webview converges on the desktop's
  // current model list without anyone reopening the app.
  useEffect(() => {
    if (auth.phase !== 'ready') return undefined;
    const timer = window.setInterval(refreshStatus, 60_000);
    return () => window.clearInterval(timer);
  }, [auth.phase, refreshStatus]);

  // --- navigation ---------------------------------------------------------
  const screen = stack[stack.length - 1] as ThreadScreenState | undefined;

  // Keep the home list fresh so unread dots and running spinners track the
  // browser without a manual pull.
  useEffect(() => {
    if (auth.phase !== 'ready' || screen) return;
    const timer = window.setInterval(loadSessions, 8000);
    return () => window.clearInterval(timer);
  }, [auth.phase, screen, loadSessions]);

  const openThread = useCallback(
    (next: ThreadScreenState, replace = true) => {
      setStack((prev) => (replace ? [next] : [...prev, next]));
      setDraft('');
      attachments.clear();
    },
    [attachments],
  );

  /** Back: out of a subagent to its parent, or out of the last thread home. */
  const goBack = useCallback(() => {
    setStack((prev) => prev.slice(0, -1));
    setDraft('');
    attachments.clear();
    if (stack.length <= 1) void loadSessions();
  }, [loadSessions, attachments, stack.length]);

  useEffect(() => {
    if (!screen) return undefined;
    // show() hands back its own teardown, which both unbinds and hides.
    return backButton.show(goBack);
  }, [screen, goBack]);

  // --- pills --------------------------------------------------------------
  /**
   * An explicit local pick wins; otherwise the pills mirror the daemon's
   * own account default, so someone who has never chosen sees what the
   * browser would use. The precedence lives in `resolvePills`, which is
   * tested directly.
   */
  /**
   * Drop a stored pick the desktop no longer offers.
   *
   * Runs on every status refresh, so a model deleted in the desktop app
   * stops being selected — and stops being SENT — within one refresh
   * rather than never. A pick the catalog still lists is left exactly
   * alone: pinning a model on purpose has to survive this.
   */
  useEffect(() => {
    const next = reconcilePick(status?.catalog, { provider, modelId });
    if (!next) return;
    setProvider(next.provider);
    setModelId(next.modelId);
    localStorage.removeItem(PROVIDER_KEY);
    localStorage.removeItem(MODEL_KEY);
  }, [status, provider, modelId]);

  const pills = useMemo(
    () => resolvePills(status, { provider, modelId, effort }),
    [status, provider, modelId, effort],
  );

  const permissionMenu = status?.permissionMenu?.length
    ? status.permissionMenu
    : FALLBACK_PERMISSION_MENU;

  const pickModel = (nextProvider: string, nextModel: string) => {
    setProvider(nextProvider);
    setModelId(nextModel);
    localStorage.setItem(PROVIDER_KEY, nextProvider);
    localStorage.setItem(MODEL_KEY, nextModel);
    haptic('light');
  };

  const pickEffort = (next: string) => {
    setEffort(next);
    localStorage.setItem(EFFORT_KEY, next);
    haptic('light');
  };

  /** The CLI takes `provider/modelId`; a bare id means "daemon default". */
  const wireModel = () =>
    pills.provider && pills.modelId
      ? `${pills.provider}/${pills.modelId}`
      : undefined;

  // --- sending ------------------------------------------------------------
  const startSession = async () => {
    const text = draft.trim();
    const files = attachments.readyPaths();
    if ((!text && !files.length) || sending) return;
    setSending(true);
    try {
      const res = await api.newSession({
        text,
        model: wireModel(),
        effort: pills.effortId,
        attachments: files,
        permissionMode: newMode ?? undefined,
        finalConfirm: newFinalConfirm ?? undefined,
      });
      setDraft('');
      attachments.clear();
      await loadSessions();
      openThread({ id: res.sessionId });
    } catch {
      // Surfaced as an error card once the turn reports back.
    } finally {
      setSending(false);
    }
  };

  if (auth.phase === 'pending') {
    return (
      <div className="boot">
        <Spinner size={18} />
      </div>
    );
  }
  if (auth.phase === 'failed') {
    return (
      <div className="boot">
        <p className="boot-title">Can’t sign in</p>
        <p className="boot-reason">{auth.reason}</p>
      </div>
    );
  }

  const openModel = (anchor: HTMLElement) => {
    // Opening the picker is the moment the list on screen has to be the
    // list the desktop actually has. The sheet renders from whatever
    // `status` holds now and re-renders when this lands, so there is no
    // spinner and no wait.
    void refreshStatus();
    setPicker({ kind: 'model', anchor });
  };
  const openPermission = (anchor: HTMLElement) =>
    setPicker({ kind: 'permission', anchor });
  const closePicker = () => setPicker({ kind: 'none' });

  /**
   * The open picker, with its checkmark on whatever the *caller* is
   * currently running -- the account default on home, the session's own
   * settings inside a thread.
   */
  const renderPicker = (current: {
    provider: string;
    modelId: string;
    effortId: string;
    permissionMode: string | null;
    finalConfirm: boolean | null;
    softConfirm?: boolean;
    onPickMode: (id: string) => void;
    onToggleConfirm: (next: boolean) => void;
  }) =>
    picker.kind === 'model' && status ? (
      <ModelSheet
        catalog={status.catalog}
        currentProvider={current.provider}
        currentModel={current.modelId}
        effortOptions={status.effortMenu}
        currentEffort={current.effortId}
        onPickModel={pickModel}
        onPickEffort={pickEffort}
        onClose={closePicker}
        onOpenSettings={() => {
          closePicker();
          setSettingsOpen(true);
        }}
      />
    ) : picker.kind === 'permission' ? (
      <PermissionPicker
        anchor={picker.anchor}
        options={permissionMenu}
        current={current.permissionMode}
        finalConfirm={current.finalConfirm}
        softConfirm={current.softConfirm}
        onPickMode={current.onPickMode}
        onToggleConfirm={current.onToggleConfirm}
        onClose={closePicker}
      />
    ) : null;

  // Settings is a full screen rather than a sheet: it is a destination with
  // its own back affordance, which is how Aside treats it too.
  if (settingsOpen) {
    return (
      <SettingsScreen status={status} onClose={() => setSettingsOpen(false)} />
    );
  }

  if (!screen) {
    return (
      <div className="app app-home">
        {/*
          One scroller holding two full panels. The composer is NOT in it:
          it is docked below, so the software keyboard cannot push it out
          of reach and the history genuinely scrolls up from underneath it,
          which is the whole point of the layout.
        */}
        <main className="home-scroll" ref={homeScroll}>
          <section className="home-rest">
            {/*
              Settings had no route in from this screen at all -- it lived
              behind a row inside the model picker, which is not somewhere
              anyone looks for it. One icon, and the otherwise empty top of
              the resting panel now has a reason to exist.
            */}
            <div className="home-topbar">
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  haptic('light');
                  setSettingsOpen(true);
                }}
                aria-label="Settings"
              >
                <Settings size={19} strokeWidth={1.75} />
              </button>
            </div>
            <RestHero name={auth.phase === 'ready' ? auth.name : undefined} />
            <RestCue count={sessions.length} onOpen={scrollToHistory} />
          </section>
          <section className="home-history" ref={historyRef}>
            <h2 className="home-history-head">Recents</h2>
            <SessionList
              sessions={sessions}
              onOpen={(id) => openThread({ id })}
              loading={loadingSessions}
            />
          </section>
        </main>

        <footer className="home-dock">
          <Composer
            variant="home"
            value={draft}
            onChange={setDraft}
            onSubmit={startSession}
            pills={pills}
            onOpenModel={openModel}
            onOpenPermission={openPermission}
            permissionMode={newMode}
            attachments={attachments.items}
            onAddFiles={(files) => attachments.add(files)}
            onRemoveAttachment={attachments.remove}
            busy={sending}
            disabled={sending}
          />
        </footer>
        {renderPicker({
          ...pills,
          permissionMode: newMode,
          finalConfirm: newFinalConfirm,
          // A session started here is a mobile session by definition.
          softConfirm: true,
          onPickMode: (id) => {
            setNewMode(id);
            haptic('light');
          },
          onToggleConfirm: (next) => {
            setNewFinalConfirm(next);
            haptic('light');
          },
        })}
      </div>
    );
  }

  return (
    <ThreadScreen
      key={screen.id}
      sessionId={screen.id}
      parentTitle={screen.parentTitle}
      onBack={goBack}
      onInspectSubagent={(id, parentTitle) =>
        openThread({ id, parentTitle }, false)
      }
      onOpenRecovered={(id) => {
        void loadSessions();
        openThread({ id });
      }}
      pills={pills}
      // Whether the user has actively chosen; when they have not, the
      // thread shows the session's own model rather than the account
      // default, which is a different thing.
      catalog={status?.catalog}
      hasModelOverride={Boolean(modelId)}
      hasEffortOverride={Boolean(effort)}
      draft={draft}
      setDraft={setDraft}
      attachments={attachments}
      openModel={openModel}
      openPermission={openPermission}
      renderPicker={renderPicker}
    />
  );
}

function ThreadScreen({
  sessionId,
  parentTitle,
  onBack,
  onInspectSubagent,
  onOpenRecovered,
  pills,
  catalog,
  hasModelOverride,
  hasEffortOverride,
  draft,
  setDraft,
  attachments,
  openModel,
  openPermission,
  renderPicker,
}: {
  sessionId: string;
  /** Set when this thread was opened from a subagent card. */
  parentTitle?: string;
  onBack: () => void;
  /** Push a child thread; the second argument is THIS thread's title. */
  onInspectSubagent: (childId: string, parentTitle: string) => void;
  /** Replace this thread with the session that continues from it. */
  onOpenRecovered: (sessionId: string) => void;
  pills: {
    provider: string;
    modelId: string;
    modelLabel: string;
    effortLabel: string;
    effortId: string;
  };
  catalog?: CatalogProvider[];
  hasModelOverride: boolean;
  hasEffortOverride: boolean;
  draft: string;
  setDraft: (value: string) => void;
  attachments: ReturnType<typeof useAttachments>;
  openModel: (anchor: HTMLElement) => void;
  openPermission: (anchor: HTMLElement) => void;
  renderPicker: (current: {
    provider: string;
    modelId: string;
    effortId: string;
    permissionMode: string | null;
    finalConfirm: boolean | null;
    softConfirm?: boolean;
    onPickMode: (id: string) => void;
    onToggleConfirm: (next: boolean) => void;
  }) => React.ReactNode;
}) {
  const thread = useThread(sessionId);
  const scroller = useRef<HTMLDivElement>(null);
  const [sending, setSending] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [citation, setCitation] = useState<CitationMark | null>(null);

  /**
   * What this thread is actually running.
   *
   * Precedence: an explicit choice by the user, else the model the daemon
   * has pinned to this session, else the account default. The middle case
   * is the one that was missing -- the bar used to show the account
   * default on every session regardless of what it was really using.
   */
  const chosen = resolveThreadModel({
    catalog,
    pills,
    threadModel: thread.model,
    hasModelOverride,
  });
  const effective = {
    ...chosen,
    effortId: hasEffortOverride
      ? pills.effortId
      : thread.model?.effort || pills.effortId,
    effortLabel: hasEffortOverride
      ? pills.effortLabel
      : thread.model?.effortLabel || pills.effortLabel,
  };

  // Stay pinned to the newest content while a turn streams, but never yank
  // the view away from someone who has scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [thread.items]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const send = async () => {
    const text = draft.trim();
    const files = attachments.ready();
    if ((!text && !files.length) || sending) return;
    setSending(true);

    // The bubble goes up before the request does. This is the fix for
    // "the message I send isn't viewable right away": nothing about the
    // send needs to have succeeded for the user to see what they typed.
    thread.addPending({
      text,
      attachments: files.map((f) => ({ name: f.name, mimeType: f.mimeType })),
      at: Date.now(),
    });
    setDraft('');
    attachments.clear();
    pinned.current = true;

    try {
      // Send what the bar says. Passing the session's own model explicitly
      // keeps a continuation on the model it was already using instead of
      // silently switching it to the account default.
      await api.send(sessionId, {
        text,
        model:
          effective.provider && effective.modelId
            ? `${effective.provider}/${effective.modelId}`
            : undefined,
        effort: effective.effortId,
        attachments: files.map((f) => f.path!).filter(Boolean),
      });
    } finally {
      setSending(false);
    }
  };

  /**
   * Answer a question card by sending the chosen option as a message.
   *
   * Only soft-marker questions ever reach this: a native pending tool is
   * rendered read-only, because there is no request that can answer one.
   * The echo goes up first for the same reason `send` does it -- the tap
   * should be visible immediately.
   *
   * The echo text must match `answerMessage` in server/src/questions.ts
   * exactly: `pendingIsEchoed` retires the optimistic bubble by comparing
   * it against what the transcript ends up holding, so a format that
   * drifts from the server's leaves a ghost bubble on screen for the full
   * two-minute TTL. No leading dash -- see that function for why.
   */
  const answer = async (header: string, label: string) => {
    const text = header ? `${header}: ${label}` : label;
    thread.addPending({ text, attachments: [], at: Date.now() });
    pinned.current = true;
    await api.answer(sessionId, {
      header,
      label,
      model:
        effective.provider && effective.modelId
          ? `${effective.provider}/${effective.modelId}`
          : undefined,
      effort: effective.effortId,
    });
  };

  /**
   * Carry on from a question only the desktop could answer.
   *
   * The stuck session stays stuck -- nothing can change that -- so this
   * starts a NEW one, seeded by the server from the pending question, the
   * option just tapped, and the stuck session's own opening message. The
   * new thread replaces this one on screen, because it is where the
   * conversation actually continues.
   */
  const recover = async (label: string) => {
    const res = await api.recover(sessionId, {
      answer: label,
      model:
        effective.provider && effective.modelId
          ? `${effective.provider}/${effective.modelId}`
          : undefined,
      effort: effective.effortId,
    });
    onOpenRecovered(res.sessionId);
  };

  const setPermission = async (patch: {
    mode?: string;
    finalConfirm?: boolean;
  }) => {
    haptic('light');
    // Optimistic, then corrected by what the daemon reports back.
    thread.applyPermission({
      permission: thread.permission,
      permissionMode: patch.mode ?? thread.permissionMode,
      finalConfirm: patch.finalConfirm ?? thread.finalConfirm,
    });
    try {
      const res = await api.permission(sessionId, patch);
      thread.applyPermission({
        permission: res.permission,
        permissionMode: res.permissionMode,
        finalConfirm: res.finalConfirm,
      });
    } catch {
      // Put the truth back: re-read rather than leaving a claim we cannot
      // stand behind on screen.
      thread.refresh();
    }
  };

  return (
    <div className="app">
      <header className="thread-header">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} strokeWidth={1.75} />
        </button>
        <span className="thread-titles">
          <span className="thread-title">{thread.title}</span>
          {thread.parentId ? (
            <span className="thread-subtitle">
              {parentTitle ? `Subagent of ${parentTitle}` : 'Subagent'}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            haptic('light');
            setPanelOpen(true);
          }}
          aria-label="Session panel"
        >
          <PanelRight size={19} strokeWidth={1.75} />
        </button>
      </header>

      <div className="thread-scroll" ref={scroller} onScroll={onScroll}>
        {thread.loading && thread.items.length === 0 ? (
          <p className="list-empty">Loading…</p>
        ) : null}
        {thread.error && thread.items.length === 0 ? (
          <p className="list-empty">{thread.error}</p>
        ) : null}

        <Thread
          items={thread.items}
          sessionId={sessionId}
          sources={thread.sources}
          subagentSteps={thread.subagentSteps}
          onInspectSubagent={(childId) =>
            onInspectSubagent(childId, thread.title)
          }
          onOpenCitation={setCitation}
          onAnswer={answer}
          onRecover={recover}
          busy={sending || thread.busy}
        />

        {/*
          The footer rides on `busy` alone now. It used to also require a
          turn start time, which the server only had once the first
          assistant record landed -- so on a slow first token it appeared
          late, and on a turn that produced none it never appeared at all.
        */}
        {thread.busy ? (
          <StreamFooter
            startedAt={thread.stats.turnStartedAt}
            tokens={
              thread.stats.turnTokens + estimateTokens(thread.streamingChars)
            }
          />
        ) : null}

        {thread.alerts.map((alert, index) => (
          <ErrorCard key={index} alert={alert} />
        ))}
      </div>

      <footer className="thread-footer">
        <Composer
          variant="reply"
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          pills={effective}
          onOpenModel={openModel}
          onOpenPermission={openPermission}
          permissionMode={thread.permissionMode}
          attachments={attachments.items}
          onAddFiles={(files) => attachments.add(files, sessionId)}
          onRemoveAttachment={attachments.remove}
          busy={sending}
          disabled={sending}
          streaming={thread.busy}
          onStop={() => void thread.stop()}
          stopping={thread.stopping}
          context={{
            used: thread.stats.totalTokens,
            window: thread.contextWindow,
          }}
          // A suspended session accepts a send and then hangs on it
          // forever, so the composer refuses rather than jamming.
          blockedReason={
            thread.suspended
              ? 'Waiting on a question that can only be answered from Aside on your computer. Use “Continue in a new session” on the question above to carry on from here.'
              : null
          }
          above={<TodoSection todos={thread.todos} />}
        />
      </footer>

      {panelOpen ? (
        <SessionPanel
          sessionId={sessionId}
          subagents={thread.subagents}
          todos={thread.todos}
          onInspectSubagent={(childId) => {
            setPanelOpen(false);
            onInspectSubagent(childId, thread.title);
          }}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}

      {citation ? (
        <CitationSheet
          mark={citation}
          sources={thread.sources}
          onClose={() => setCitation(null)}
        />
      ) : null}

      {renderPicker({
        ...effective,
        permissionMode: thread.permissionMode,
        finalConfirm: thread.finalConfirm,
        softConfirm: thread.softConfirm,
        onPickMode: (id) => void setPermission({ mode: id }),
        onToggleConfirm: (next) => void setPermission({ finalConfirm: next }),
      })}
    </div>
  );
}

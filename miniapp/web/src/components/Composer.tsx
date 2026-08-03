/**
 * The composer, in Aside's two forms.
 *
 * `home` is the card at the top of the sidepanel home screen -- sending
 * from it starts a NEW session, which is why there is no separate
 * new-chat button anywhere. `reply` is the slimmer pill above a thread's
 * bottom bar.
 *
 * Both carry the same model and effort pills, so the setting you can see
 * is always the setting the next turn will use, plus the `+` attach button
 * and the permission badge.
 *
 * The placeholder no longer mentions "@ for context". The browser's
 * @-popover lists the user's live open tabs, and that inventory lives in
 * the extension rather than in the daemon -- the database only records the
 * tabs a session has already borrowed. There is no way to populate it
 * faithfully from a phone, and offering a control that cannot work is
 * worse than not offering it.
 */
import { useEffect, useRef } from 'react';
import {
  ArrowUp,
  ChevronDown,
  FileIcon,
  PermissionGlyph,
  Plus,
  ProviderMark,
  Spinner,
  StopSquare,
  X,
} from './Icons';
import { ContextRing } from './ContextRing';
import { haptic } from '../telegram';
import type { ComposerAttachment } from '../types';
import { pillModelLabel } from '../utils/pills';

export interface PillState {
  modelLabel: string;
  effortLabel: string;
  effortId: string;
  /**
   * Provider id behind the model pill, so the pill can carry that
   * provider's REAL brand mark -- the Claude starburst, the OpenAI knot --
   * exactly as the desktop composer does. It used to be a hand-drawn
   * asterisk regardless of which model was running.
   */
  provider?: string;
}

export interface ComposerProps {
  variant: 'home' | 'reply';
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pills: PillState;
  onOpenModel: (anchor: HTMLElement) => void;
  onOpenPermission: (anchor: HTMLElement) => void;
  /** Chosen mode, for the badge's tint. Null when unknown. */
  permissionMode: string | null;
  attachments: ComposerAttachment[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (key: string) => void;
  busy?: boolean;
  disabled?: boolean;
  /**
   * A turn is streaming. Shows the stop control to the LEFT of send, as the
   * desktop composer does.
   */
  streaming?: boolean;
  /** Kill the running turn. Absent on the home composer, which has none. */
  onStop?: () => void;
  /** Between tapping Stop and the turn actually ending. */
  stopping?: boolean;
  /**
   * The session is blocked on a question only the desktop app can answer.
   * The input is disabled and this is the reason shown in its place --
   * sending would queue a turn that hangs forever.
   */
  blockedReason?: string | null;
  /**
   * Context-window occupancy, drawn as a ring beside the model pill.
   * Absent on home, where there is no session to measure.
   */
  context?: { used: number; window: number };
  /** Rendered directly above the composer: the task list. */
  above?: React.ReactNode;
}

/** The `✳ Fable 5 ∨` / `High ∨` triggers from the bottom bar. */
export function Pill({
  label,
  onOpen,
  mark,
  className = '',
}: {
  label: string;
  onOpen: (anchor: HTMLElement) => void;
  /** Provider id to draw a brand mark for, or absent for a bare pill. */
  mark?: string;
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      className={`pill ${className}`}
      onClick={() => ref.current && onOpen(ref.current)}
    >
      {mark ? <ProviderMark id={mark} size={13} /> : null}
      <span className="pill-label">{pillModelLabel(label)}</span>
      <ChevronDown size={13} strokeWidth={1.75} />
    </button>
  );
}

/**
 * What the OS picker is allowed to offer.
 *
 * Kept to what the agent can actually do something useful with locally.
 * `image/*` first so the phone's gallery is the obvious choice, which is
 * what the owner reaches for.
 */
const ACCEPT = 'image/*,application/pdf,.txt,.md,.csv,.json';

/** One attachment chip: an image thumbnail, or a doc icon and its name. */
function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
}) {
  const isImage =
    attachment.mimeType.startsWith('image/') && Boolean(attachment.previewUrl);

  return (
    <span
      className={`chip ${attachment.status === 'failed' ? 'is-failed' : ''} ${
        attachment.status === 'uploading' ? 'is-uploading' : ''
      }`}
      title={attachment.error || attachment.name}
    >
      {isImage ? (
        <img className="chip-thumb" src={attachment.previewUrl} alt="" />
      ) : (
        <span className="chip-glyph">
          <FileIcon size={13} strokeWidth={1.75} />
        </span>
      )}
      <span className="chip-name">{attachment.name}</span>
      {attachment.status === 'uploading' ? <Spinner size={12} /> : null}
      <button
        type="button"
        className="chip-remove"
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
      >
        <X size={12} strokeWidth={2} />
      </button>
    </span>
  );
}

/**
 * The permission badge next to `+`.
 *
 * Orange when the session is on full access, matching Aside -- that is the
 * one state worth catching out of the corner of your eye.
 */
export function PermissionButton({
  mode,
  onOpen,
}: {
  mode: string | null;
  onOpen: (anchor: HTMLElement) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const full = mode === 'full-access';
  return (
    <button
      ref={ref}
      type="button"
      className={`round-button ghost permission-button ${full ? 'is-full' : ''}`}
      aria-label="Permission"
      onClick={() => ref.current && onOpen(ref.current)}
    >
      <PermissionGlyph mode={mode || 'guard'} size={16} />
    </button>
  );
}

export function Composer({
  variant,
  value,
  onChange,
  onSubmit,
  pills,
  onOpenModel,
  onOpenPermission,
  permissionMode,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  busy,
  disabled,
  streaming,
  onStop,
  stopping,
  blockedReason,
  context,
  above,
}: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Grow with the content instead of scrolling inside a fixed box, which
  // is what the sidepanel composer does.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  const ready = attachments.filter((a) => a.status === 'ready');
  const uploading = attachments.some((a) => a.status === 'uploading');
  const blocked = Boolean(blockedReason);
  const canSend =
    (Boolean(value.trim()) || ready.length > 0) &&
    !disabled &&
    !uploading &&
    !blocked;

  const submit = () => {
    if (!canSend) return;
    haptic('light');
    onSubmit();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a newline. On phones the virtual
    // keyboard's return key inserts a newline, so the button is the
    // primary path there.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={`composer composer-${variant}`}>
      {/* The task list sits ON TOP of the composer, as in the desktop app. */}
      {above}

      {blockedReason ? (
        <p className="composer-blocked">{blockedReason}</p>
      ) : null}

      {attachments.length ? (
        <div className="chip-row">
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.key}
              attachment={attachment}
              onRemove={() => onRemoveAttachment(attachment.key)}
            />
          ))}
        </div>
      ) : null}

      <textarea
        ref={textarea}
        className="composer-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          variant === 'home' ? 'Chat with Aside…' : 'Reply to Aside…'
        }
        rows={1}
        disabled={blocked}
      />

      <div className="composer-actions">
        {/*
          A real file input, hidden behind the button. Telegram's webview is
          a normal WebView, so the OS picker (and the phone's gallery and
          camera) works exactly as it does in a browser -- no Telegram API
          involved.
        */}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          className="visually-hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            if (files.length) onAddFiles(files);
            // Reset so re-picking the same file fires change again.
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="round-button ghost"
          aria-label="Attach files"
          onClick={() => {
            haptic('light');
            fileInput.current?.click();
          }}
        >
          <Plus size={17} strokeWidth={1.75} />
        </button>

        <PermissionButton mode={permissionMode} onOpen={onOpenPermission} />

        {/*
          Pills sit immediately after the round buttons, with the slack
          pushed to the right of them -- the arrangement Claude's own
          composer uses. Right-aligning them (the old order) put the free
          space between the buttons and the pills, which read as two
          disconnected clusters rather than one row of controls.
        */}
        {/*
          Both screens carry the same control row. The reply composer used
          to drop the model pill and push it into a separate bottom bar,
          so sending a message visibly changed the furniture -- a different
          card, a different row, the model somewhere else. Claude's own app
          keeps one composer and only swaps the placeholder, which is why
          its thread does not feel like a second app.
        */}
        {context ? (
          <ContextRing used={context.used} window={context.window} />
        ) : null}
        <Pill
          label={pills.modelLabel}
          onOpen={onOpenModel}
          mark={pills.provider}
        />
        <span className="composer-spacer" />

        {/*
          Stop sits to the LEFT of send while a turn runs, matching the
          desktop composer's small black rounded square. It is a real kill:
          the server SIGTERMs the `aside exec` child it owns, by PID.
        */}
        {streaming && onStop ? (
          <button
            type="button"
            className="round-button stop"
            onClick={() => {
              haptic('medium');
              onStop();
            }}
            disabled={stopping}
            aria-label="Stop"
          >
            {stopping ? <Spinner size={14} /> : <StopSquare size={14} />}
          </button>
        ) : null}

        <button
          type="button"
          className="round-button send"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send"
        >
          {busy ? <Spinner size={16} /> : <ArrowUp size={17} strokeWidth={2} />}
        </button>
      </div>
    </div>
  );
}

/**
 * The thread's bottom bar: permission on the left, model and effort on the
 * right, with the context-window ring between them.
 *
 * `permission` is the session's real mode, read from the daemon. A null
 * means we could not read it, and the label is omitted entirely -- showing
 * a plausible-looking default here would claim the agent is sandboxed when
 * it may not be, which is the one failure mode worth designing against.
 *
 * The label is now a control as well as a readout: tapping it opens the
 * same Permission popover the composer's badge does.
 *
 * The ring is NOT a spinner. Aside draws context-window occupancy here and
 * says so in its own tooltip; "the agent is working" lives in the streaming
 * footer above the composer instead.
 */
export function BottomBar({
  permission,
  pills,
  onOpenModel,
  onOpenPermission,
  context,
  showContext = true,
}: {
  permission: string | null;
  pills: PillState;
  onOpenModel: (anchor: HTMLElement) => void;
  onOpenPermission: (anchor: HTMLElement) => void;
  /** Context-window occupancy for the ring. */
  context: { used: number; window: number };
  /**
   * Home has no session yet, so a ring there could only ever report an
   * empty window -- a control that cannot mean anything is just noise.
   */
  showContext?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const full = Boolean(permission?.toLowerCase().startsWith('full'));
  return (
    <div className="bottom-bar">
      {permission ? (
        <button
          ref={ref}
          type="button"
          className={`permission ${full ? 'is-full' : ''}`}
          onClick={() => ref.current && onOpenPermission(ref.current)}
        >
          <span className="permission-dot" />
          {permission}
        </button>
      ) : null}
      <span className="composer-spacer" />
      {showContext ? (
        <ContextRing used={context.used} window={context.window} />
      ) : null}
      {/*
        No effort pill. Reasoning is a row inside the model sheet on every
        screen, so there is one place to change it and one pill to read.
      */}
      <Pill
        label={pills.modelLabel}
        onOpen={onOpenModel}
        mark={pills.provider}
      />
    </div>
  );
}

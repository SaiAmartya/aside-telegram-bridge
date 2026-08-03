/** Compact number formatting for the streaming footer and the file panel. */

/**
 * Token counts, as Aside prints them: `506`, `1.4k`, `12k`, `285k`.
 *
 * Exact under a thousand, one decimal up to ten thousand, whole thousands
 * above that -- so the footer's last digit never twitches while a long
 * answer streams.
 */
export function formatTokens(n: number): string {
  const value = Math.max(0, Math.round(n));
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(value / 1000)}k`;
}

/** `12 KB`, `1.4 MB` -- file sizes in the session panel. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What to put on screen when a thread will not load.
 *
 * `ApiError.message` is `"<status>: <reason>"` -- fine in a log, wrong on a
 * phone. "404: session_not_found" was showing to users verbatim; it names
 * the transport, not the problem, and gives no idea what to do.
 */
export function threadErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const reason = raw.replace(/^\d{3}:\s*/, '').trim();

  switch (reason) {
    case 'session_not_found':
      return 'This chat is no longer on your Mac.';
    case 'bad_session_id':
      return 'That link points at a chat that does not exist.';
    case 'transcript_too_large':
      return 'This chat is too long to open on your phone.';
    case 'token_expired':
    case 'expired':
      return 'Your session expired. Reopen the app from the bot menu.';
    default:
      break;
  }
  // A network failure surfaces as a bare TypeError from fetch.
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return 'Cannot reach your Mac. Check that it is awake and online.';
  }
  return reason || 'Something went wrong loading this chat.';
}

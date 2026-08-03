/**
 * Serving the local image files an answer points at.
 *
 * The agent runs on this machine, so when it writes
 * `![screenshot](/Users/…/artifacts/2026-07-26/shot.png)` into an answer,
 * that path is real -- for the agent. The webview on the phone has no
 * filesystem, so the markdown renders a broken-image icon. (Images inside
 * the work timeline never had this problem: those arrive as data URIs in
 * the transcript itself.)
 *
 * This is the route that closes that gap: an absolute path in, the bytes
 * out, behind the same auth as everything else.
 *
 * The containment rules are the important part, and they are deliberately
 * the artifact route's rules rather than a second, looser set:
 *
 *  - Both the roots and the target are `realpath`'d before comparing, so
 *    neither `../` nor a symlink planted inside a root can name a file
 *    elsewhere on the machine.
 *  - Only three roots are allowed, and they are the only three places an
 *    image an answer can legitimately reference actually lives: that
 *    session's own directory, this app's uploads directory, and the
 *    bridge's Telegram media directory.
 *  - The content-type table is images only. The artifact route serves
 *    markdown and code too; this one is reached from an `<img>` tag, so
 *    anything that is not an image is a refusal rather than a download.
 *  - 10 MB cap. Nothing the agent screenshots comes close, and the cap is
 *    what stops a stray `.png` symlink to a disk image from being streamed
 *    down a phone connection.
 *
 * Everything else about the request -- bearer token or `?token=`, redacted
 * query logging -- is shared with the artifact route in `app.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Hard ceiling on one served image. */
export const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Extensions this route will serve, and what it calls them.
 *
 * Images only. SVG is included because the artifact route already serves
 * it and it is reached the same way -- through an `<img>` tag, which does
 * not run script -- and it goes out under the same sandbox CSP and
 * `nosniff` headers as everything else here.
 */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
};

/** Content type for a servable image, or null if this is not one. */
export function localImageContentType(name: string): string | null {
  return IMAGE_CONTENT_TYPES[path.extname(name).toLowerCase()] ?? null;
}

export interface LocalFileRootsOptions {
  /** The session's own directory -- `~/.aside/u/0/sessions/<date>_<id>`. */
  sessionDir: string;
  /** Where this app stores what the phone uploaded. */
  uploadsDir: string;
  /** Where bridge.py stores what arrived over Telegram. */
  mediaDir: string;
}

/**
 * The directories a path may resolve into, realpath'd.
 *
 * A root that does not exist (no uploads yet, no media yet) is dropped
 * rather than kept as a literal string: an unresolvable root can never
 * contain anything, and keeping it would mean comparing a real path
 * against a symlinked one and wrongly refusing.
 */
export function localFileRoots(opts: LocalFileRootsOptions): string[] {
  const roots: string[] = [];
  for (const dir of [opts.sessionDir, opts.uploadsDir, opts.mediaDir]) {
    if (!dir) continue;
    try {
      const real = fs.realpathSync(dir);
      if (!roots.includes(real)) roots.push(real);
    } catch {
      // not there yet; nothing can be inside it either
    }
  }
  return roots;
}

export type LocalFileRefusal =
  | 'bad_path'
  | 'forbidden_path'
  | 'unsupported_type'
  | 'file_not_found'
  | 'file_too_large';

export type LocalFileResult =
  | { ok: true; file: string; contentType: string; size: number }
  | { ok: false; reason: LocalFileRefusal };

/**
 * Resolve a client-supplied absolute path against the allowed roots.
 *
 * Relative paths are refused outright: this route exists for the absolute
 * paths an agent writes into an answer, and accepting a relative one would
 * mean picking a base directory on the caller's behalf.
 */
export function resolveLocalFile(
  roots: string[],
  raw: unknown,
  maxBytes = MAX_LOCAL_IMAGE_BYTES,
): LocalFileResult {
  const requested = String(raw ?? '');
  if (!requested || requested.includes('\0')) {
    return { ok: false, reason: 'bad_path' };
  }
  if (!path.isAbsolute(requested)) return { ok: false, reason: 'bad_path' };

  // The extension is checked on the requested name AND, below, on what it
  // resolved to -- a symlink `shot.png -> secrets.env` must not be served
  // just because the name the caller used looked like an image.
  if (!localImageContentType(requested)) {
    return { ok: false, reason: 'unsupported_type' };
  }

  let real: string;
  try {
    real = fs.realpathSync(requested);
  } catch {
    return { ok: false, reason: 'file_not_found' };
  }

  const inside = roots.some(
    (root) => real === root || real.startsWith(root + path.sep),
  );
  if (!inside) return { ok: false, reason: 'forbidden_path' };

  const contentType = localImageContentType(real);
  if (!contentType) return { ok: false, reason: 'unsupported_type' };

  const stat = fs.statSync(real, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { ok: false, reason: 'file_not_found' };
  if (stat.size > maxBytes) return { ok: false, reason: 'file_too_large' };

  return { ok: true, file: real, contentType, size: stat.size };
}

export type OpenedLocalFile =
  | { ok: true; fd: number; file: string; contentType: string; size: number }
  | { ok: false; reason: LocalFileRefusal };

/**
 * `O_NOFOLLOW` where the platform has it, 0 where it does not.
 *
 * Windows has no such flag, and `fs.constants.O_NOFOLLOW` is undefined
 * there -- passing `undefined` into the flags bitmask would produce NaN
 * and fail every open. Falling back to 0 keeps the descriptor-side checks
 * below, which are the substantive ones; only the "final component is a
 * symlink" refusal is unavailable, and Windows is not a supported target
 * for this server anyway.
 */
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Resolve AND open, so the file that is checked is the file that is sent.
 *
 * `resolveLocalFile` decides containment, type and size from the PATH. All
 * three answers stop being true the moment it returns: the agent owns
 * these directories and rewrites them constantly, so between the
 * `realpath`/`stat` and the open the name can come to mean a different
 * file -- a symlink out of the roots, a fifo, or something far larger than
 * the cap. The route then streamed whatever the name pointed at by then,
 * with a 200 and an image content-type already committed.
 *
 * So the checks move onto the descriptor: `O_NOFOLLOW` refuses to open a
 * final component that has become a symlink, and `fstat` on the open fd
 * describes the exact bytes about to be written to the socket, whatever
 * happened to the path afterwards. The path-side checks are kept because
 * they are what decides containment and content type in the first place.
 *
 * The descriptor is closed on every rejecting path. A leaked fd here is a
 * slow resource leak on a server meant to run for weeks.
 */
export function openLocalFile(
  roots: string[],
  raw: unknown,
  maxBytes = MAX_LOCAL_IMAGE_BYTES,
): OpenedLocalFile {
  const resolved = resolveLocalFile(roots, raw, maxBytes);
  if (!resolved.ok) return resolved;

  let fd: number;
  try {
    fd = fs.openSync(resolved.file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    // ELOOP is the O_NOFOLLOW refusal: the name became a symlink between
    // the realpath above and this open. Everything else is a vanished or
    // unreadable file.
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === 'ELOOP' ? 'forbidden_path' : 'file_not_found',
    };
  }

  const reject = (reason: LocalFileRefusal): OpenedLocalFile => {
    try {
      fs.closeSync(fd);
    } catch {
      // already gone
    }
    return { ok: false, reason };
  };

  let stat: fs.Stats;
  try {
    stat = fs.fstatSync(fd);
  } catch {
    return reject('file_not_found');
  }
  // A directory, a fifo, a device or a socket is not an image, and a fifo
  // in particular would block the stream forever.
  if (!stat.isFile()) return reject('file_not_found');
  if (stat.size > maxBytes) return reject('file_too_large');

  return {
    ok: true,
    fd,
    file: resolved.file,
    contentType: resolved.contentType,
    size: stat.size,
  };
}

/** HTTP status for a refusal. */
export function localFileStatus(reason: LocalFileRefusal): number {
  switch (reason) {
    case 'bad_path':
      return 400;
    case 'file_not_found':
      return 404;
    case 'file_too_large':
      return 413;
    default:
      return 403;
  }
}

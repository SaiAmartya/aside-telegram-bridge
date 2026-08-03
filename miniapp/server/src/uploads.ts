/**
 * Files sent from the phone.
 *
 * The agent runs locally with real filesystem access, so an attachment does
 * not need to be embedded in the prompt -- it needs to be *on disk* with a
 * path the agent can open. That is the pattern bridge.py already uses for
 * Telegram photos and documents, and it is what this reproduces.
 *
 * Everything here is written defensively because the filename is
 * attacker-controlled in the general case (a Telegram webview can upload
 * whatever the OS picker returns, and the picker takes the name from the
 * file itself):
 *
 *  - The name is reduced to its basename, then to a conservative
 *    `[A-Za-z0-9._-]` alphabet. `../`, absolute paths, NUL bytes, newlines
 *    and shell metacharacters cannot survive that.
 *  - A leading dot is stripped, so nothing lands as a dotfile and `..`
 *    cannot survive as a name in its own right.
 *  - Every stored file is prefixed with fresh randomness, so two uploads of
 *    `photo.jpg` never collide and a chosen name can never overwrite an
 *    existing file.
 *  - The day directory is created 0700. The uploads root is too.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultAsideRoot } from './config.js';

/** Per-file cap. Telegram's own webview upload limit is well under this. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Per-message cap, matching the composer's chip row. */
export const MAX_UPLOAD_FILES = 5;

const SAFE_CHARS = /[^A-Za-z0-9._-]+/g;
const MAX_NAME_LENGTH = 96;

/**
 * Reduce a client-supplied filename to something safe to join onto a path.
 *
 * Returns `file` when nothing usable survives, rather than an empty string:
 * a name is only cosmetic here (the random prefix provides uniqueness), and
 * an empty basename would produce a path ending in the separator.
 */
export function sanitizeFilename(raw: unknown): string {
  let name = String(raw ?? '');
  // Windows-style separators too -- a name is not necessarily POSIX.
  name = name.replace(/\\/g, '/');
  name = name.slice(name.lastIndexOf('/') + 1);
  // NUL and the other C0 controls, stripped before the alphabet filter.
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.replace(SAFE_CHARS, '_');
  name = name.replace(/^[._]+/, '');
  name = name.replace(/_{2,}/g, '_');
  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot, dot + 12) : '';
    name = name.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return name || 'file';
}

export function defaultUploadsDir(): string {
  return (
    process.env.MINIAPP_UPLOADS_DIR ||
    path.join(defaultAsideRoot(), 'telegram-bridge/miniapp-uploads')
  );
}

/** `yyyymmdd` for the local day, which is how the owner will look for these. */
export function dayStamp(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export interface SavedUpload {
  /** Absolute path the agent will be told to open. */
  path: string;
  /** The name as the user sees it in the chip -- sanitized, not the raw one. */
  name: string;
  size: number;
  mimeType: string;
}

export class UploadError extends Error {
  constructor(
    readonly code: 'too_large' | 'too_many' | 'empty',
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * Write one upload into `<root>/<yyyymmdd>/<random>-<safe name>`.
 *
 * Both directories are created 0700 -- uploads are the owner's private
 * files and there is no reason for anything else on the machine to read
 * them.
 */
export function saveUpload(
  root: string,
  filename: unknown,
  data: Buffer,
  mimeType = 'application/octet-stream',
  at: Date = new Date(),
): SavedUpload {
  if (!data.length) throw new UploadError('empty', 'file was empty');
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new UploadError('too_large', 'file exceeds the 20 MB limit');
  }

  const dir = path.join(root, dayStamp(at));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by the process umask, so it is set again
  // explicitly -- a 022 umask would otherwise leave these 0755.
  try {
    fs.chmodSync(root, 0o700);
    fs.chmodSync(dir, 0o700);
  } catch {
    // a pre-existing directory we do not own is not worth failing over
  }

  const name = sanitizeFilename(filename);
  const full = path.join(dir, `${crypto.randomBytes(6).toString('hex')}-${name}`);
  fs.writeFileSync(full, data, { mode: 0o600 });

  return { path: full, name, size: data.length, mimeType: String(mimeType) };
}

/**
 * Prefix the prompt with where the files landed.
 *
 * This exact shape is what the Python bridge already sends for Telegram
 * photos, and it is proven to make the agent open the files rather than ask
 * for them. The paths go *before* the user's text so the agent reads them
 * as context for what follows.
 */
export function promptWithAttachments(
  text: string,
  paths: string[],
): string {
  const body = String(text ?? '').trim();
  const files = paths.filter((p) => typeof p === 'string' && p);
  if (!files.length) return body;
  const noun = files.length === 1 ? 'file' : 'files';
  const header =
    `[user sent ${files.length} ${noun} from their phone, ` +
    `saved to: ${files.join(', ')}]`;
  return body ? `${header} ${body}` : header;
}

const HEADER_RE =
  /^\[user sent \d+ files? from their phone, saved to:\s*([^\]]*)\]\s*/;

/**
 * Undo `promptWithAttachments` for display.
 *
 * The header has to be in the prompt -- it is how the agent learns where
 * the files are -- but it must not be in the UI. Left alone, the user's own
 * bubble reads `[user sent 2 files from their phone, saved to:
 * /Users/…/a1b2c3-photo.png, …]` and the session list titles itself the
 * same way. Seen on a live run; both looked broken.
 *
 * The stored name carries the collision-avoiding random prefix, which is
 * stripped too so the chip shows the file the user actually picked.
 */
export function splitAttachmentHeader(text: string): {
  text: string;
  files: Array<{ name: string }>;
} {
  const raw = String(text ?? '');
  const match = HEADER_RE.exec(raw);
  if (!match) return { text: raw, files: [] };

  const files = match[1]
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const base = p.slice(p.lastIndexOf('/') + 1);
      return { name: base.replace(/^[0-9a-f]{12}-/, '') };
    });

  return { text: raw.slice(match[0].length), files };
}

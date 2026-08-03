/**
 * Live mirror of the desktop app's own provider catalog.
 *
 * The mini app used to carry a hand-written copy of the model list inside
 * the bridge config, and that copy drifted badly: by 2026-08-02 it listed
 * six 9router models that no longer existed (`claude-fable-5`,
 * `oc/deepseek-v4-flash-free(max)`, `cf/@cf/moonshotai/kimi-k2.6`,
 * `nvidia/deepseek-ai/deepseek-v4-pro`, `nvidia/z-ai/glm-5.2`,
 * `oc/nemotron-3-ultra-free`), was missing four that did (`glm5.2`,
 * `nemo`, `gc/gemini-2.5-pro`, `ocx/google-antigravity/claude-sonnet-4-6`),
 * showed one of OCX's seven, and pinned `claude-code` to
 * `connected: false, models: []` while the desktop's own default model was
 * `claude-code/claude-opus-5`. The phone could not select the model the
 * computer was actually running.
 *
 * Copying the list again would only reset that clock. Instead this reads
 * the files the desktop app itself writes:
 *
 *   <account>/models.json    custom providers and their models
 *   <account>/settings.json  defaultModel and the category bindings
 *
 * where <account> is whichever account the desktop is signed in to, not
 * a hardcoded u/0 -- see `defaultAsideRoot`.
 *
 * Both are read-only here. The desktop owns them; drift is impossible by
 * construction because there is no second copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultAsideRoot } from './config.js';

/** A model as the desktop app defines it. */
export interface DesktopModel {
  id: string;
  label: string;
  contextWindow: number;
  /** True when the model accepts images as well as text. */
  vision: boolean;
}

/** A provider as the desktop app defines it. */
export interface DesktopProvider {
  id: string;
  label: string;
  models: DesktopModel[];
}

/** A `provider/modelId` binding, as `defaultModel` and the categories use. */
export interface DesktopModelRef {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface DesktopState {
  providers: DesktopProvider[];
  defaultModel: DesktopModelRef | null;
  /** fast / standard / deep / visual, as bound in the desktop settings. */
  categories: Record<string, DesktopModelRef>;
}

export const EMPTY_DESKTOP: DesktopState = {
  providers: [],
  defaultModel: null,
  categories: {},
};

/**
 * The account root the desktop app keeps its state under.
 *
 * Derived from `sessionsDir` (which the bridge config already carries and
 * which is always `<root>/sessions`) so there is nothing new to configure,
 * with the conventional path as a fallback and an env override for tests.
 */
export function desktopRoot(sessionsDir: string): string {
  const explicit = process.env.MINIAPP_ASIDE_ROOT;
  if (explicit) return explicit;
  if (sessionsDir && path.basename(sessionsDir) === 'sessions') {
    return path.dirname(sessionsDir);
  }
  // Not a hardcoded u/0 any more: resolve whichever account is current.
  return defaultAsideRoot();
}

export function modelsPath(root: string): string {
  return path.join(root, 'models.json');
}

export function desktopSettingsPath(root: string): string {
  return path.join(root, 'settings.json');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing or half-written file: the caller falls back to built-ins
    // rather than showing an empty picker.
    return null;
  }
}

/** What `models.json` records for one model, coerced and defaulted. */
function toModel(raw: unknown): DesktopModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = String(record.id ?? '').trim();
  if (!id) return null;
  const input = Array.isArray(record.input) ? record.input.map(String) : [];
  const contextWindow = Number(record.contextWindow);
  return {
    id,
    label: String(record.name || record.label || id).trim() || id,
    contextWindow: contextWindow > 0 ? contextWindow : 200_000,
    vision: input.includes('image'),
  };
}

/**
 * Custom providers from `models.json`.
 *
 * Anything present here is configured and working in the desktop app, so
 * it is reported as connected. These providers are local gateways keyed by
 * a baseUrl rather than by an entry in credentials.json, which is why the
 * old credentials-only seeding never saw them.
 *
 * `apiKey` and `baseUrl` are deliberately not returned: nothing downstream
 * needs them and they must not reach the phone.
 */
export function readDesktopProviders(file: string): DesktopProvider[] {
  const parsed = readJson(file) as { providers?: Record<string, unknown> } | null;
  const providers = parsed?.providers;
  if (!providers || typeof providers !== 'object') return [];

  const out: DesktopProvider[] = [];
  for (const [id, value] of Object.entries(providers)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const models = Array.isArray(record.models)
      ? record.models.map(toModel).filter((m): m is DesktopModel => m !== null)
      : [];
    if (!models.length) continue;
    out.push({
      id,
      label: String(record.name || id).trim() || id,
      models,
    });
  }
  return out;
}

function toRef(raw: unknown): DesktopModelRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const provider = String(record.provider ?? '').trim();
  const modelId = String(record.modelId ?? '').trim();
  if (!provider || !modelId) return null;
  return {
    provider,
    modelId,
    thinkingLevel: String(record.thinkingLevel ?? '').trim(),
  };
}

/** `defaultModel` and `modelCategories` out of the desktop settings file. */
export function readDesktopSettings(file: string): {
  defaultModel: DesktopModelRef | null;
  categories: Record<string, DesktopModelRef>;
} {
  const parsed = readJson(file) as Record<string, unknown> | null;
  if (!parsed) return { defaultModel: null, categories: {} };

  const categories: Record<string, DesktopModelRef> = {};
  const rawCategories = parsed.modelCategories;
  if (rawCategories && typeof rawCategories === 'object') {
    for (const [name, value] of Object.entries(
      rawCategories as Record<string, unknown>,
    )) {
      const ref = toRef(value);
      if (ref) categories[name] = ref;
    }
  }

  return { defaultModel: toRef(parsed.defaultModel), categories };
}

/**
 * Read everything the catalog needs from the desktop, in one shot.
 *
 * Cheap enough to call per request (two small JSON files, page-cached by
 * the OS) and doing so is the point: editing a model in the desktop app
 * must show up on the phone without restarting anything.
 */
export function readDesktopState(sessionsDir: string): DesktopState {
  const root = desktopRoot(sessionsDir);
  const { defaultModel, categories } = readDesktopSettings(
    desktopSettingsPath(root),
  );
  return {
    providers: readDesktopProviders(modelsPath(root)),
    defaultModel,
    categories,
  };
}

/**
 * Provider / model catalog.
 *
 * The CLI takes `-m <provider>/<modelId>` but offers no way to enumerate
 * what a given account can actually use -- there is no catalog command.
 * So the catalog is curated here and *seeded* by which providers appear in
 * the user's credentials file.
 *
 * Credentials handling: we read the top-level KEYS of credentials.json and
 * nothing else. The values are OAuth tokens and API keys; they are never
 * read, never held in memory, never logged.
 *
 * Model ids drift as providers ship new versions, so the built-in table is
 * a default, not a fixed list: a `models` section in the bridge config is
 * merged over it and can add providers, add models, or replace a
 * provider's list outright.
 */
import fs from 'node:fs';
import type { DesktopModelRef, DesktopProvider } from './desktop.js';

export interface CatalogModel {
  /** The id the CLI expects after the slash, e.g. `gpt-5.5`. */
  id: string;
  /** What Aside's own picker shows, e.g. "GPT-5.5". */
  label: string;
  /**
   * Context window in tokens -- the denominator of the ring next to the
   * model pill. Aside's own tooltip reports 1000k for Fable 5 and the rest
   * of the line at 200k, which is what the defaults below encode.
   */
  contextWindow: number;
}

/** What a model gets when neither the table nor config names a window. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface CatalogProvider {
  /** Credential provider id, e.g. `openai-codex`. */
  id: string;
  /** Display name in Aside's picker, e.g. "ChatGPT". */
  label: string;
  models: CatalogModel[];
  /** True when this provider has credentials on this machine. */
  connected: boolean;
}

/**
 * Display names and model lists mirror Aside's own model picker. Keyed by
 * the credential provider id, which is also the `-m <provider>/...` prefix.
 */
interface ProviderSeed {
  id: string;
  label: string;
  /** `contextWindow` is omitted wherever the 200k default is right. */
  models: Array<{ id: string; label: string; contextWindow?: number }>;
}

const BUILTIN: ProviderSeed[] = [
  {
    id: 'claude-code',
    label: 'Claude',
    models: [
      { id: 'claude-fable-5', label: 'Fable 5', contextWindow: 1_000_000 },
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    ],
  },
  {
    id: 'openai-codex',
    label: 'ChatGPT',
    models: [
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
      { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
    ],
  },
  {
    id: 'xai-grok-oauth',
    label: 'Grok',
    models: [
      { id: 'grok-4.5', label: 'Grok 4.5' },
      { id: 'grok-4-fast', label: 'Grok 4 Fast' },
    ],
  },
];

/** Shape of the optional `models` section in the bridge config. */
export interface CatalogOverride {
  label?: string;
  models?: Array<{ id: string; label?: string; contextWindow?: number }>;
  /** Replace the built-in model list instead of merging into it. */
  replace?: boolean;
  /** Force the provider to show even without local credentials. */
  connected?: boolean;
}

/**
 * Top-level keys of credentials.json. Values are never touched.
 *
 * A missing or malformed file is not an error: it just means we cannot
 * seed from credentials and fall back to showing the built-in providers.
 */
export function readProviderIds(credentialsPath: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * Build the catalog: built-in table, seeded by `providerIds`, then
 * overlaid with user config.
 *
 * When credentials cannot be read at all we show every built-in provider
 * rather than an empty picker -- a picker that silently hides the user's
 * working model is worse than one that offers a model they must connect.
 */
export function buildCatalog(
  providerIds: string[],
  overrides: Record<string, CatalogOverride> = {},
  desktop: DesktopProvider[] = [],
  ensure: Array<DesktopModelRef | null | undefined> = [],
): CatalogProvider[] {
  const connectedSet = new Set(providerIds);
  const seedUnknown = providerIds.length === 0;

  const byId = new Map<string, CatalogProvider>();
  for (const base of BUILTIN) {
    byId.set(base.id, {
      ...base,
      models: base.models.map((m) => ({
        ...m,
        contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      })),
      connected: seedUnknown || connectedSet.has(base.id),
    });
  }

  // A credentialed provider we have no table for still deserves a row; the
  // user can name its models through config.
  for (const id of providerIds) {
    if (!byId.has(id)) {
      byId.set(id, { id, label: id, models: [], connected: true });
    }
  }

  // Providers the desktop app has configured in models.json. These are
  // local gateways addressed by baseUrl rather than by a credentials.json
  // entry, which is why credential seeding alone never surfaced them and
  // why they had to be transcribed by hand before. models.json is
  // authoritative for these, so it REPLACES rather than merges: a model the
  // desktop has dropped must disappear from the phone too, otherwise the
  // picker keeps offering ids the gateway will reject.
  for (const provider of desktop) {
    byId.set(provider.id, {
      id: provider.id,
      label: provider.label || provider.id,
      models: provider.models.map((m) => ({
        id: m.id,
        label: m.label,
        contextWindow: m.contextWindow || DEFAULT_CONTEXT_WINDOW,
      })),
      connected: true,
    });
  }

  for (const [id, override] of Object.entries(overrides || {})) {
    const existing = byId.get(id);
    const target: CatalogProvider = existing ?? {
      id,
      label: id,
      models: [],
      connected: seedUnknown || connectedSet.has(id),
    };

    if (override.label) target.label = override.label;
    if (typeof override.connected === 'boolean') {
      target.connected = override.connected;
    }
    if (override.models) {
      const existingModels = new Map(target.models.map((m) => [m.id, m]));
      const added = override.models
        .filter((m) => m && typeof m.id === 'string' && m.id)
        .map((m) => ({
          id: m.id,
          label: m.label || existingModels.get(m.id)?.label || m.id,
          // A merge that only renames a model must not silently reset its
          // context window to the generic default.
          contextWindow:
            Number(m.contextWindow) > 0
              ? Number(m.contextWindow)
              : (existingModels.get(m.id)?.contextWindow ??
                DEFAULT_CONTEXT_WINDOW),
        }));
      if (override.replace) {
        target.models = added;
      } else {
        const merged = new Map(existingModels);
        for (const m of added) merged.set(m.id, m);
        target.models = [...merged.values()];
      }
    }
    byId.set(id, target);
  }

  // Whatever the desktop is actually bound to must be selectable, even if
  // no other source named it. Without this a fresh model set in the desktop
  // app renders on the phone as a raw id in a picker that cannot select it.
  for (const ref of ensure) {
    if (!ref || !ref.provider || !ref.modelId) continue;
    const target = byId.get(ref.provider) ?? {
      id: ref.provider,
      label: ref.provider,
      models: [],
      connected: true,
    };
    if (!target.models.some((m) => m.id === ref.modelId)) {
      target.models = [
        ...target.models,
        {
          id: ref.modelId,
          label: ref.modelId,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
        },
      ];
    }
    // A provider the desktop is actively running is connected by
    // definition, whatever credentials.json happens to show.
    target.connected = true;
    byId.set(ref.provider, target);
  }

  // Connected providers first, then built-in order, so the picker opens on
  // something the account can actually run.
  const order = new Map(BUILTIN.map((b, i) => [b.id, i]));
  return [...byId.values()]
    .filter((p) => p.models.length > 0 || p.connected)
    .sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99);
    });
}

/** Human label for a `provider/modelId` pair, for the bottom-bar pill. */
export function modelLabel(
  catalog: CatalogProvider[],
  provider: string,
  modelId: string,
): string {
  for (const p of catalog) {
    if (p.id !== provider) continue;
    for (const m of p.models) if (m.id === modelId) return m.label;
  }
  // Unknown ids still need to render as something -- show the raw id
  // rather than a placeholder that hides which model is actually running.
  return modelId;
}

/**
 * Context window for a `provider/modelId` pair.
 *
 * An unknown model falls back to the default rather than to zero: a ring
 * with no denominator would read as "0% full", which is a stronger claim
 * than "we do not have this model in the table".
 */
export function contextWindowFor(
  catalog: CatalogProvider[],
  provider: string,
  modelId: string,
): number {
  for (const p of catalog) {
    if (p.id !== provider) continue;
    for (const m of p.models) if (m.id === modelId) return m.contextWindow;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

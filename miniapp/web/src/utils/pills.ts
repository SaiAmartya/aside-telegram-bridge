/**
 * What the model and effort pills should read.
 *
 * The precedence is the whole of it: an explicit local pick wins, and
 * otherwise the pills mirror the DAEMON's own account default (from
 * `/api/status`, which reads `aside.settings.getAll().defaultModel`) rather
 * than anything from the bridge config. A user who has never chosen should
 * see what the browser would use.
 *
 * Extracted from App so it can be tested directly. It also had a real bug
 * that only a direct test would have caught: the label started at the
 * daemon default's label and was only overwritten when the picked model was
 * found in the catalog -- so an explicit pick of a model the catalog does
 * not list displayed the DAEMON's model name while actually running the
 * picked one. The pill has to name the model that will run, or it is worse
 * than no pill.
 */
import type { CatalogProvider, StatusResponse } from '../types';

export interface PillState {
  provider: string;
  modelId: string;
  modelLabel: string;
  effortId: string;
  effortLabel: string;
}

export interface LocalPick {
  provider: string;
  modelId: string;
  effort: string;
}

/** The catalog's display name for a model, or '' when it lists no such one. */
export function catalogLabel(
  catalog: CatalogProvider[] | undefined,
  provider: string,
  modelId: string,
): string {
  if (!catalog || !provider || !modelId) return '';
  for (const entry of catalog) {
    if (entry.id !== provider) continue;
    const found = entry.models.find((m) => m.id === modelId);
    if (found) return found.label;
  }
  return '';
}

/**
 * Whether the catalog still offers `provider/modelId`.
 *
 * Only ever consulted against a NON-EMPTY catalog: an empty one means the
 * status call has not landed (or failed), and treating "I do not know yet"
 * as "that model is gone" would throw away a deliberate pin on every
 * cold start.
 */
export function catalogHasModel(
  catalog: CatalogProvider[] | undefined,
  provider: string,
  modelId: string,
): boolean {
  if (!catalog || !catalog.length || !provider || !modelId) return false;
  const entry = catalog.find((p) => p.id === provider);
  return Boolean(entry?.models.some((m) => m.id === modelId));
}

/**
 * A stored pick, checked against the catalog the server just returned.
 *
 * The desktop app owns the model list and the Mini App now mirrors it
 * live -- but the PICK lives in localStorage and used to be trusted
 * forever. Delete a provider in the desktop app and the phone would keep
 * showing the old model, keep it selected, and keep sending
 * `provider/modelId` on every turn, which the CLI then refuses. Anything
 * the catalog no longer lists is dropped so the pills fall back to the
 * daemon's own current default.
 *
 * Returns `null` when there is nothing to change, so a caller can avoid a
 * pointless state update on every poll.
 */
export function reconcilePick(
  catalog: CatalogProvider[] | undefined,
  pick: { provider: string; modelId: string },
): { provider: string; modelId: string } | null {
  // No pick, or nothing authoritative to check it against: leave it be.
  if (!pick.provider && !pick.modelId) return null;
  if (!catalog || !catalog.length) return null;
  if (catalogHasModel(catalog, pick.provider, pick.modelId)) return null;
  return { provider: '', modelId: '' };
}

/** What `/thread` reports the daemon has pinned to this session. */
export interface ThreadModel {
  provider: string;
  modelId: string;
  label?: string | null;
}

/**
 * The model a THREAD should show and send, reconciled against the catalog.
 *
 * `reconcilePick` above covers the choice the user made on the home
 * screen. This covers the other source, which was left unchecked: the
 * model the daemon has pinned to this particular session, read straight
 * out of `state.db`. A session pinned to a model the desktop app has since
 * deleted kept that model in `effective`, and `effective` is what send,
 * answer and recover all wire as `provider/modelId` -- so a removed model
 * went back out on every one of them, and `recover` in particular uses it
 * to create a BRAND NEW session, where the CLI has no pinned model to fall
 * back on and simply refuses the turn.
 *
 * Same rule as the global pick, for the same reason: a model still in the
 * catalog is preserved exactly (pinning is deliberate), and an absent or
 * empty catalog means "not known yet", never "deleted".
 */
export function resolveThreadModel(options: {
  catalog: CatalogProvider[] | undefined;
  pills: Pick<PillState, 'provider' | 'modelId' | 'modelLabel'>;
  threadModel?: ThreadModel | null;
  /** True when the user has explicitly picked a model on this device. */
  hasModelOverride: boolean;
}): { provider: string; modelId: string; modelLabel: string } {
  const { catalog, pills, threadModel, hasModelOverride } = options;

  // An explicit pick wins, and App has already reconciled that one.
  if (hasModelOverride) {
    return {
      provider: pills.provider,
      modelId: pills.modelId,
      modelLabel: pills.modelLabel,
    };
  }

  const pinned =
    threadModel && threadModel.provider && threadModel.modelId
      ? threadModel
      : null;

  if (pinned) {
    const known = Boolean(catalog && catalog.length);
    // Keep it when the catalog still lists it, and also when there is no
    // catalog to judge by -- dropping a session's own model because the
    // status call has not landed would be worse than keeping it.
    if (!known || catalogHasModel(catalog, pinned.provider, pinned.modelId)) {
      return {
        provider: pinned.provider,
        modelId: pinned.modelId,
        modelLabel: pinned.label || pinned.modelId,
      };
    }
  }

  // Either nothing was pinned, or what was pinned is gone. Fall back to
  // whatever the pills resolve to now -- the current pick or the daemon's
  // own default -- which is by construction something the account can run.
  return {
    provider: pills.provider,
    modelId: pills.modelId,
    modelLabel: pills.modelLabel,
  };
}

export function resolvePills(
  status: StatusResponse | null,
  pick: LocalPick,
): PillState {
  const defaults = status?.defaults;

  const hasModelPick = Boolean(pick.modelId);
  const provider = pick.provider || defaults?.provider || '';
  const modelId = pick.modelId || defaults?.modelId || '';

  // With a pick, the label must describe the PICKED model: the catalog's
  // name for it, else its bare id. Falling back to the daemon's label here
  // is what made the pill lie.
  const modelLabel = hasModelPick
    ? catalogLabel(status?.catalog, provider, modelId) || modelId || 'Model'
    : catalogLabel(status?.catalog, provider, modelId) ||
      defaults?.modelLabel ||
      modelId ||
      'Model';

  const effortId = pick.effort || defaults?.effort || 'high';
  const effortLabel =
    status?.effortMenu?.find((e) => e.id === effortId)?.label ||
    (pick.effort ? '' : defaults?.effortLabel) ||
    effortId;

  return { provider, modelId, modelLabel, effortId, effortLabel };
}

/**
 * The model name as the composer pill should show it.
 *
 * The pill lives in the tightest row in the app -- three round buttons and
 * two pills inside a 336px card -- and a catalog label like
 * "DeepSeek V4 Flash (Free)" needs about 165px of the ~200px the two pills
 * share. The result was a pill reading "DeepSee…", which names nothing.
 *
 * A trailing parenthetical is the part worth losing: "(Free)", "(Max)",
 * "(Nvidia)" qualify a model, they do not identify it, and the full label
 * is still shown in the picker one tap away. Everything else is left
 * alone, and CSS ellipsis remains the backstop for genuinely long ids.
 */
export function pillModelLabel(label: string): string {
  const trimmed = String(label || '').trim();
  const withoutSuffix = trimmed.replace(/\s*\([^()]*\)\s*$/, '').trim();
  // Never return an empty pill: a label that is ONLY a parenthetical keeps
  // whatever it had.
  return withoutSuffix || trimmed;
}

/**
 * The reasoning level as the composer pill should show it.
 *
 * The pill shares one 336px row with the attach button, the permission
 * badge, the model pill and send. Aside's own effort names run to
 * "Extra High" and "Ultrabrowse", and at full length either one pushes the
 * model pill down to an ellipsis that names nothing.
 *
 * These abbreviations are short enough to fit and long enough to stay
 * unambiguous -- no two levels share a prefix here -- and the full name is
 * still what the picker shows.
 */
const EFFORT_SHORT: Record<string, string> = {
  off: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  'extra high': 'XHigh',
  xhigh: 'XHigh',
  max: 'Max',
  ultrabrowse: 'Ultra',
};

export function pillEffortLabel(label: string): string {
  const trimmed = String(label || '').trim();
  return EFFORT_SHORT[trimmed.toLowerCase()] ?? trimmed;
}

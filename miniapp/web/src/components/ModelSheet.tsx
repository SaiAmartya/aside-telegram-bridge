/**
 * Model and reasoning, in one sheet.
 *
 * This replaces the anchored popover, and it takes reasoning with it. The
 * old arrangement put a model pill AND an effort pill in the composer's
 * action row, which on a 390px phone left the model about 85px -- enough
 * for "DeepSee…", which names nothing. Claude's own app solves it by
 * nesting Effort inside the model sheet as a row, so the composer carries
 * a single pill. That is the shape here: one pill, one sheet, reasoning a
 * tap deeper.
 *
 * Four views, one component, because they are one decision. `back` is
 * always to the model list rather than a history stack: there is nowhere
 * else to come from.
 */
import { useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ProviderMark,
  Search,
  Settings,
} from './Icons';
import type { CatalogProvider } from '../types';

/** `220000` -> `220k`, `1000000` -> `1M`. */
export function formatContext(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M context`;
  }
  return `${Math.round(tokens / 1000)}k context`;
}

export interface ModelSheetProps {
  catalog: CatalogProvider[];
  currentProvider: string;
  currentModel: string;
  effortOptions: Array<{ id: string; label: string }>;
  currentEffort: string;
  onPickModel: (provider: string, modelId: string) => void;
  onPickEffort: (id: string) => void;
  onOpenSettings?: () => void;
  onClose: () => void;
}

type View = 'models' | 'effort' | 'providers';

/** One tappable row in a grouped card. */
function Row({
  title,
  subtitle,
  leading,
  trailing,
  selected,
  onClick,
}: {
  title: string;
  subtitle?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sheet-row ${selected ? 'is-selected' : ''}`}
      onClick={onClick}
    >
      {leading ? <span className="sheet-row-glyph">{leading}</span> : null}
      <span className="sheet-row-text">
        <span className="sheet-row-title">{title}</span>
        {subtitle ? (
          <span className="sheet-row-subtitle">{subtitle}</span>
        ) : null}
      </span>
      {trailing ? <span className="sheet-row-trailing">{trailing}</span> : null}
    </button>
  );
}

export function ModelSheet({
  catalog,
  currentProvider,
  currentModel,
  effortOptions,
  currentEffort,
  onPickModel,
  onPickEffort,
  onOpenSettings,
  onClose,
}: ModelSheetProps) {
  const [view, setView] = useState<View>('models');
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const active =
    catalog.find((p) => p.id === currentProvider) || catalog[0] || null;

  /**
   * Search flattens every provider into one list.
   *
   * Without it you would have to already know which provider owns a model
   * to find it, which is the thing a search is for.
   */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const out: Array<{ provider: CatalogProvider; id: string; label: string; ctx: number }> = [];
    for (const provider of catalog) {
      for (const model of provider.models) {
        const hay = `${provider.label} ${model.label} ${model.id}`.toLowerCase();
        if (hay.includes(q)) {
          out.push({
            provider,
            id: model.id,
            label: model.label,
            ctx: model.contextWindow,
          });
        }
      }
    }
    return out;
  }, [catalog, query]);

  const choose = (provider: string, modelId: string) => {
    onPickModel(provider, modelId);
    onClose();
  };

  const effortLabel =
    effortOptions.find((o) => o.id === currentEffort)?.label || currentEffort;

  // --- reasoning -----------------------------------------------------
  if (view === 'effort') {
    return (
      <Sheet side="bottom" title="Reasoning" onClose={onClose}>
        <button
          type="button"
          className="sheet-back"
          onClick={() => setView('models')}
        >
          <ChevronLeft size={15} strokeWidth={2} /> Model
        </button>
        <div className="sheet-group">
          {effortOptions.map((option) => (
            <Row
              key={option.id}
              title={option.label}
              selected={option.id === currentEffort}
              trailing={
                option.id === currentEffort ? <Check size={17} /> : null
              }
              onClick={() => {
                onPickEffort(option.id);
                setView('models');
              }}
            />
          ))}
        </div>
      </Sheet>
    );
  }

  // --- every provider ------------------------------------------------
  if (view === 'providers') {
    const drilled = browsing
      ? catalog.find((p) => p.id === browsing) || null
      : null;

    return (
      <Sheet
        side="bottom"
        title={drilled ? drilled.label : 'More models'}
        onClose={onClose}
      >
        <button
          type="button"
          className="sheet-back"
          onClick={() => (drilled ? setBrowsing(null) : setView('models'))}
        >
          <ChevronLeft size={15} strokeWidth={2} />
          {drilled ? 'All providers' : 'Model'}
        </button>

        {drilled ? (
          <div className="sheet-group">
            {drilled.models.map((model) => (
              <Row
                key={model.id}
                title={model.label}
                subtitle={formatContext(model.contextWindow)}
                selected={
                  drilled.id === currentProvider && model.id === currentModel
                }
                trailing={
                  drilled.id === currentProvider && model.id === currentModel ? (
                    <Check size={17} />
                  ) : null
                }
                onClick={() => choose(drilled.id, model.id)}
              />
            ))}
            {drilled.models.length === 0 ? (
              <p className="sheet-empty">No models configured</p>
            ) : null}
          </div>
        ) : (
          <>
            <label className="sheet-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models"
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            {matches ? (
              <div className="sheet-group">
                {matches.map((match) => (
                  <Row
                    key={`${match.provider.id}/${match.id}`}
                    title={match.label}
                    subtitle={`${match.provider.label} · ${formatContext(match.ctx)}`}
                    leading={<ProviderMark id={match.provider.id} size={17} />}
                    selected={
                      match.provider.id === currentProvider &&
                      match.id === currentModel
                    }
                    trailing={
                      match.provider.id === currentProvider &&
                      match.id === currentModel ? (
                        <Check size={17} />
                      ) : null
                    }
                    onClick={() => choose(match.provider.id, match.id)}
                  />
                ))}
                {matches.length === 0 ? (
                  <p className="sheet-empty">No matches</p>
                ) : null}
              </div>
            ) : (
              <div className="sheet-group">
                {catalog.map((provider) => (
                  <Row
                    key={provider.id}
                    title={provider.label}
                    subtitle={`${provider.models.length} model${
                      provider.models.length === 1 ? '' : 's'
                    }`}
                    leading={<ProviderMark id={provider.id} size={17} />}
                    selected={provider.id === currentProvider}
                    trailing={<ChevronRight size={16} />}
                    onClick={() => setBrowsing(provider.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </Sheet>
    );
  }

  // --- the default view: this provider's models, then reasoning ------
  return (
    <Sheet side="bottom" title="Select model" onClose={onClose}>
      <div className="sheet-group">
        {(active?.models ?? []).map((model) => (
          <Row
            key={model.id}
            title={model.label}
            subtitle={formatContext(model.contextWindow)}
            selected={
              active?.id === currentProvider && model.id === currentModel
            }
            trailing={
              active?.id === currentProvider && model.id === currentModel ? (
                <Check size={17} />
              ) : null
            }
            onClick={() => choose(active!.id, model.id)}
          />
        ))}
        {!active || active.models.length === 0 ? (
          <p className="sheet-empty">No models configured</p>
        ) : null}
      </div>

      <div className="sheet-group">
        <Row
          title="Reasoning"
          subtitle={effortLabel}
          leading={<span className="sheet-dot-glyph" aria-hidden />}
          trailing={<ChevronRight size={16} />}
          onClick={() => setView('effort')}
        />
        <Row
          title="More models"
          subtitle={`${catalog.length} provider${catalog.length === 1 ? '' : 's'}`}
          leading={<span className="sheet-dots-glyph" aria-hidden />}
          trailing={<ChevronRight size={16} />}
          onClick={() => {
            setBrowsing(null);
            setQuery('');
            setView('providers');
          }}
        />
        {onOpenSettings ? (
          <Row
            title="Settings"
            leading={<Settings size={16} />}
            trailing={<ChevronRight size={16} />}
            onClick={onOpenSettings}
          />
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * Regression tests for the horizontal-overflow bug a user hit in the
 * field: a model id like `oc/deepseek-v4-flash-free(max)` made the
 * composer's model pill wider than the phone, which panned the ENTIRE app
 * sideways in Telegram's webview -- every screen was cut off at the left
 * edge.
 *
 * jsdom does no layout, so the width math itself cannot be asserted here.
 * What can be pinned is the contract that makes the layout safe:
 *
 * 1. The stylesheet rules that let a pill shrink and ellipsize, clamp the
 *    root against horizontal panning, and truncate the subagent model
 *    badge. These are load-bearing lines of CSS; losing any one of them
 *    in a refactor re-opens the bug silently.
 * 2. The DOM shape those rules select on: the label lives in
 *    `.pill-label`, the effort pill opts out of shrinking via
 *    `.pill-effort`, and the subagent badge wraps its text in
 *    `.subagent-model-label`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BottomBar, Composer } from '../src/components/Composer';
import type { PillState } from '../src/components/Composer';

afterEach(cleanup);

const here = path.dirname(fileURLToPath(import.meta.url));
const componentsCss = readFileSync(
  path.join(here, '../src/theme/components.css'),
  'utf8',
);
const baseCss = readFileSync(
  path.join(here, '../src/theme/base.css'),
  'utf8',
);

/**
 * Every declaration applied to a selector, across all of its rules, with
 * comments stripped -- a comment MENTIONING `flex: none` must not read as
 * the declaration itself.
 */
function ruleBody(css: string, selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(
    `(?:^|\\n)(?:[^{}\\n]*,\\s*\\n)*${escaped}(?:\\s*,[^{]*)?\\s*\\{([^}]*)\\}`,
    'g',
  );
  let body = '';
  for (const match of bare.matchAll(rule)) body += match[1];
  return body;
}

const LONG_MODEL = 'oc/deepseek-v4-flash-free(max)';

const pills: PillState = {
  modelLabel: LONG_MODEL,
  effortLabel: 'High',
  effortId: 'high',
  provider: 'openrouter',
};

function renderBar() {
  return render(
    <BottomBar
      permission="Guard"
      pills={pills}
      onOpenModel={vi.fn()}
      onOpenPermission={vi.fn()}
      context={{ used: 0, window: 0 }}
    />,
  );
}

function renderComposer() {
  return render(
    <Composer
      variant="home"
      value=""
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      pills={pills}
      onOpenModel={vi.fn()}
      onOpenPermission={vi.fn()}
      permissionMode="guard"
      attachments={[]}
      onAddFiles={vi.fn()}
      onRemoveAttachment={vi.fn()}
    />,
  );
}

describe('the pill cannot widen the app', () => {
  it('.pill shrinks instead of overflowing', () => {
    const body = ruleBody(componentsCss, '.pill');
    expect(body).toContain('min-width: 0');
    expect(body).toContain('flex: 0 1 auto');
    expect(body).toContain('max-width: 100%');
    expect(body).not.toContain('flex: none');
  });

  it('.pill-label ellipsizes', () => {
    const body = ruleBody(componentsCss, '.pill-label');
    expect(body).toContain('overflow: hidden');
    expect(body).toContain('text-overflow: ellipsis');
  });

  it('the effort pill opts back out of shrinking', () => {
    expect(ruleBody(componentsCss, '.pill-effort')).toContain('flex: none');
  });

  it('the composer carries exactly one pill: the model', () => {
    // Reasoning moved into the model sheet, so the action row has a single
    // pill to fit. That is what stopped the label ellipsising to
    // "DeepSee…" inside a 336px card.
    const { container } = renderComposer();
    const found = Array.from(container.querySelectorAll('.pill'));
    expect(found.length).toBe(1);
    expect(found[0].classList.contains('pill-effort')).toBe(false);
  });

  it('neither surface still renders an effort pill', () => {
    for (const { container } of [renderComposer(), renderBar()]) {
      expect(container.querySelector('.pill-effort')).toBeNull();
    }
  });

  it('the long model id renders inside .pill-label', () => {
    const { container } = renderBar();
    const labels = Array.from(container.querySelectorAll('.pill-label'));
    // The pill drops a trailing parenthetical qualifier -- see
    // `pillModelLabel` -- so the id renders without its "(max)" suffix.
    // What matters here is that it is inside .pill-label, which is the
    // element carrying the ellipsis.
    expect(labels.map((el) => el.textContent)).toContain(
      'oc/deepseek-v4-flash-free',
    );
  });

  it('the composer -- the surface that actually ships -- ellipsizes too', () => {
    /*
     * The assertion above was the original regression test, and it now
     * covers `BottomBar`, which nothing renders any more: the model pill
     * moved into the composer when the bottom bar was folded away. A
     * regression test pointed only at a component the app no longer
     * mounts cannot catch the bug coming back, so the same contract is
     * pinned on the surface a user sees.
     */
    const { container } = renderComposer();
    const labels = Array.from(container.querySelectorAll('.pill-label'));
    expect(labels.map((el) => el.textContent)).toContain(
      'oc/deepseek-v4-flash-free',
    );
    // And the label sits inside a pill that is allowed to shrink.
    const pill = container.querySelector('.pill');
    expect(pill?.querySelector('.pill-label')).not.toBeNull();
    expect(pill?.classList.contains('pill-effort')).toBe(false);
  });
});

describe('the thread footer keeps the gradient it was given', () => {
  it('has no leftover @supports rule repainting it flat', () => {
    /*
     * `.thread-footer` used to be a blurred bar, with an
     * `@supports not (backdrop-filter: blur(1px))` fallback painting it
     * opaque. The footer became a color-mix gradient -- with a solid
     * `var(--page)` first declaration as its own fallback -- but the
     * @supports rule stayed, so on the webviews it claimed to help
     * (older WebKit, which needs `-webkit-backdrop-filter` and therefore
     * fails the query) it overwrote the gradient with a flat, differently
     * coloured block.
     */
    const bare = componentsCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const supports = bare.match(
      /@supports[^{]*backdrop-filter[^{]*\{[\s\S]*?\}\s*\}/g,
    );
    for (const rule of supports || []) {
      expect(rule).not.toContain('.thread-footer');
    }
    // The footer still carries a solid fallback ahead of the gradient, so
    // a webview without color-mix gets a page-coloured bar, not nothing.
    const footer = ruleBody(componentsCss, '.thread-footer');
    expect(footer).toContain('background: var(--page)');
    expect(footer).toContain('linear-gradient');
  });
});

describe('the root clamps horizontal panning', () => {
  it('html/body carry overflow-x: hidden', () => {
    // The guard is one rule on `html, body`; match it wherever it lives.
    expect(baseCss).toMatch(
      /html,\s*\nbody\s*\{[^}]*overflow-x:\s*hidden/,
    );
  });
});

describe('the subagent model badge truncates', () => {
  it('.subagent-model shrinks and its label ellipsizes', () => {
    const badge = ruleBody(componentsCss, '.subagent-model');
    expect(badge).toContain('flex: 0 1 auto');
    expect(badge).toContain('min-width: 0');

    const label = ruleBody(componentsCss, '.subagent-model-label');
    expect(label).toContain('overflow: hidden');
    expect(label).toContain('text-overflow: ellipsis');
    expect(label).toContain('white-space: nowrap');
  });
});

/**
 * The home screen's resting state.
 *
 * The greeting is the only text on an otherwise empty screen, so a band
 * that lands wrong is very visible. It is a pure function of the hour for
 * exactly this reason: the boundaries are asserted rather than eyeballed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RestCue, RestHero, greetingFor } from '../src/components/Rest';
import { pillModelLabel } from '../src/utils/pills';
import { threadErrorText } from '../src/utils/format';

const here = path.dirname(fileURLToPath(import.meta.url));

function at(hour: number): Date {
  const d = new Date(2026, 7, 2, hour, 30, 0);
  return d;
}

describe('greetingFor', () => {
  it('covers every hour of the day without a gap', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      expect(greetingFor('Alex', at(hour))).toBeTruthy();
    }
  });

  it('uses the late-night band before 5am', () => {
    expect(greetingFor('Alex', at(1))).toBe('Up late, Alex?');
    expect(greetingFor('Alex', at(4))).toBe('Up late, Alex?');
  });

  it('switches at each boundary', () => {
    expect(greetingFor('Alex', at(5))).toBe('Early start, Alex');
    expect(greetingFor('Alex', at(9))).toBe('Morning, Alex');
    expect(greetingFor('Alex', at(12))).toBe('Afternoon, Alex');
    expect(greetingFor('Alex', at(17))).toBe('Evening, Alex');
    expect(greetingFor('Alex', at(21))).toBe('Still up, Alex?');
  });

  it('drops the name cleanly when there is not one', () => {
    // No dangling comma, and no "undefined" leaking onto the screen.
    for (const name of [undefined, '', '   ']) {
      const text = greetingFor(name, at(13));
      expect(text).toBe('Good afternoon');
      expect(text).not.toContain(',');
      expect(text).not.toContain('undefined');
    }
  });
});

describe('RestHero', () => {
  it('renders the greeting as the screen heading', () => {
    render(<RestHero name="Alex" />);
    expect(
      screen.getByRole('heading', { level: 1 }).textContent,
    ).toContain('Alex');
  });
});

describe('RestCue', () => {
  it('stays hidden when there is no history to reveal', () => {
    const { container } = render(<RestCue count={0} onOpen={() => {}} />);
    expect(container.querySelector('.rest-cue')).toBeNull();
  });

  it('appears once there is something below', () => {
    render(<RestCue count={3} onOpen={() => {}} />);
    expect(screen.getByText('Recents')).toBeTruthy();
  });
});

describe('pillModelLabel', () => {
  it('drops a trailing qualifier so the pill names the model', () => {
    // "DeepSee…" named nothing; the qualifier is the part worth losing.
    expect(pillModelLabel('DeepSeek V4 Flash (Free)')).toBe('DeepSeek V4 Flash');
    expect(pillModelLabel('Nemotron 3 Ultra (Nvidia)')).toBe('Nemotron 3 Ultra');
    expect(pillModelLabel('oc/deepseek-v4-flash-free(max)')).toBe(
      'oc/deepseek-v4-flash-free',
    );
  });

  it('leaves names without a qualifier untouched', () => {
    for (const name of ['Opus 5', 'GLM 5.2', 'Sonnet 4.6', 'gpt-5.5']) {
      expect(pillModelLabel(name)).toBe(name);
    }
  });

  it('never returns an empty pill', () => {
    // A label that is only a parenthetical would otherwise vanish.
    expect(pillModelLabel('(Free)')).toBe('(Free)');
    expect(pillModelLabel('')).toBe('');
  });

  it('only strips the LAST parenthetical', () => {
    expect(pillModelLabel('Foo (v2) Bar (Free)')).toBe('Foo (v2) Bar');
  });
});

describe('threadErrorText', () => {
  it('never shows a status code or a snake_case reason', () => {
    // "404: session_not_found" was reaching the screen verbatim.
    const out = threadErrorText(new Error('404: session_not_found'));
    expect(out).not.toMatch(/\d{3}:/);
    expect(out).not.toContain('_');
    expect(out).toBe('This chat is no longer on your Mac.');
  });

  it('explains the cases a user can act on', () => {
    expect(threadErrorText(new Error('413: transcript_too_large'))).toContain(
      'too long',
    );
    expect(threadErrorText(new Error('401: expired'))).toContain('bot menu');
    expect(threadErrorText(new TypeError('Failed to fetch'))).toContain(
      'awake and online',
    );
  });

  it('falls back to something readable for anything unknown', () => {
    expect(threadErrorText(new Error('500: kaboom'))).toBe('kaboom');
    expect(threadErrorText(null)).toBe('Something went wrong loading this chat.');
  });
});

/**
 * Finding 2, the wiring half.
 *
 * `reconcilePick` is unit-tested in pills.test.ts; what this pins is that
 * App actually CALLS it, and that the catalog is re-read rather than
 * fetched once at launch. Asserted against the source for the same reason
 * the overflow suite asserts against the stylesheet: rendering App needs
 * Telegram, auth and the whole api surface, and the contract that matters
 * here is three lines of wiring that a refactor can silently drop.
 */
describe('the app keeps its catalog and its pick honest', () => {
  const appSource = readFileSync(
    path.join(here, '../src/App.tsx'),
    'utf8',
  );

  it('re-reads /status rather than fetching it once', () => {
    expect(appSource).toMatch(/const refreshStatus = useCallback/);
    // A bounded interval, so a webview left open for days converges.
    expect(appSource).toMatch(/setInterval\(refreshStatus,\s*\d[\d_]*\)/);
  });

  it('re-reads the catalog when the model picker opens', () => {
    const openModel = appSource.slice(
      appSource.indexOf('const openModel'),
      appSource.indexOf('const openPermission'),
    );
    expect(openModel).toContain('refreshStatus()');
    expect(openModel).toContain("kind: 'model'");
  });

  it('reconciles the stored pick against the catalog it got back', () => {
    expect(appSource).toContain('reconcilePick(status?.catalog');
    // ...and clears the persisted copy too, or the next launch resurrects it.
    expect(appSource).toContain('localStorage.removeItem(PROVIDER_KEY)');
    expect(appSource).toContain('localStorage.removeItem(MODEL_KEY)');
  });
});

/**
 * Finding 3, the wiring half: all three outbound calls in ThreadScreen
 * read the reconciled `effective`, and `effective` is built by
 * `resolveThreadModel` from the catalog rather than from `thread.model`
 * directly.
 */
describe('the thread never wires a model the catalog dropped', () => {
  const appSource = readFileSync(path.join(here, '../src/App.tsx'), 'utf8');

  it('builds effective through resolveThreadModel with the catalog', () => {
    expect(appSource).toContain('resolveThreadModel({');
    expect(appSource).toMatch(/catalog,\s*\n\s*pills,\s*\n\s*threadModel: thread\.model,/);
    // ...and ThreadScreen is actually handed the catalog to judge with.
    expect(appSource).toContain('catalog={status?.catalog}');
  });

  it('no longer reads thread.model straight into the model fields', () => {
    const block = appSource.slice(
      appSource.indexOf('const effective = {'),
      appSource.indexOf('// Stay pinned to the newest content'),
    );
    expect(block).not.toContain('thread.model?.provider');
    expect(block).not.toContain('thread.model?.modelId');
  });

  it('send, answer and recover all wire the reconciled model', () => {
    const wired = appSource.match(/effective\.provider && effective\.modelId/g) || [];
    // send + answer + recover.
    expect(wired.length).toBe(3);
  });
});

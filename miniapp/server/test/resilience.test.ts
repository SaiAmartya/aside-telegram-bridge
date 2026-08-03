/**
 * Regression cover for the two failures that made the mini app unusable
 * after the laptop lid was closed, and for the catalog drift that let the
 * phone offer models the desktop no longer had.
 *
 * Every case here is drawn from something observed in the production log
 * on 2026-08-02, not from a hypothetical.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MenuSync,
  isQuickTunnelHost,
  parseTunnelUrl,
  readMenuButton,
  sameMenuUrl,
} from '../src/tunnel.js';
import {
  readDesktopProviders,
  readDesktopSettings,
  desktopRoot,
} from '../src/desktop.js';
import { buildCatalog } from '../src/catalog.js';
import { waitForTranscript } from '../src/sessions.js';

const temps: string[] = [];

function tempFile(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-res-'));
  temps.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('tunnel url parsing', () => {
  it('rejects cloudflared’s own api host', () => {
    // The exact line that broke production: with no network on wake,
    // cloudflared names api.trycloudflare.com in its failure output.
    expect(isQuickTunnelHost('https://api.trycloudflare.com')).toBe(false);
    expect(parseTunnelUrl('failed to request quick tunnel from https://api.trycloudflare.com')).toBeNull();
  });

  it('accepts a real quick-tunnel slug', () => {
    expect(
      parseTunnelUrl('|  https://magic-boundaries-them-pulse.trycloudflare.com  |'),
    ).toBe('https://magic-boundaries-them-pulse.trycloudflare.com');
  });

  it('picks the real host even when the api host appears first', () => {
    const chunk =
      'registering with https://api.trycloudflare.com ... ' +
      'https://federal-gmbh-wine-radiation.trycloudflare.com';
    expect(parseTunnelUrl(chunk)).toBe(
      'https://federal-gmbh-wine-radiation.trycloudflare.com',
    );
  });

  it('rejects other reserved infrastructure hosts', () => {
    for (const host of ['www', 'dash', 'update', 'region1']) {
      expect(isQuickTunnelHost(`https://${host}.trycloudflare.com`)).toBe(false);
    }
  });
});

describe('menu url comparison', () => {
  it('ignores a trailing slash', () => {
    // Telegram echoes the url back with a slash appended, so a naive
    // string compare would report permanent drift and rewrite forever.
    expect(
      sameMenuUrl('https://a-b-c.trycloudflare.com', 'https://a-b-c.trycloudflare.com/'),
    ).toBe(true);
  });

  it('treats empty as never matching', () => {
    expect(sameMenuUrl(null, null)).toBe(false);
    expect(sameMenuUrl('', '')).toBe(false);
  });
});

describe('MenuSync', () => {
  const URL_A = 'https://one-two-three-four.trycloudflare.com';

  it('retries after a failed registration instead of giving up', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      // First attempt fails the way the real one did: `fetch failed`.
      if (calls === 1) throw new Error('fetch failed');
      return { json: async () => ({ ok: true }) } as any;
    });

    const menu = new MenuSync({ botToken: 't', chatId: 1, fetchFn: fetchFn as any });
    menu.setTarget(URL_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(menu.liveUrl).toBeNull();

    // This is the whole point: an unattended retry lands it.
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toBe(2);
    expect(menu.liveUrl).toBe(URL_A);
    menu.stop();
  });

  it('repairs drift when Telegram reports a different url', async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn(async (url: any, init?: any) => {
      const href = String(url);
      if (href.includes('getChatMenuButton')) {
        return {
          json: async () => ({
            ok: true,
            // Telegram is still on the previous, dead hostname.
            result: { web_app: { url: 'https://stale-old-host-here.trycloudflare.com/' } },
          }),
        } as any;
      }
      seen.push(JSON.parse(init.body).menu_button.web_app.url);
      return { json: async () => ({ ok: true }) } as any;
    });

    const menu = new MenuSync({ botToken: 't', chatId: 1, fetchFn: fetchFn as any });
    menu.setTarget(URL_A);
    await Promise.resolve();
    seen.length = 0;

    await menu.reconcile();
    expect(seen).toContain(URL_A);
    menu.stop();
  });

  it('does not rewrite when Telegram already agrees', async () => {
    let writes = 0;
    const fetchFn = vi.fn(async (url: any) => {
      const href = String(url);
      if (href.includes('getChatMenuButton')) {
        return {
          json: async () => ({ ok: true, result: { web_app: { url: `${URL_A}/` } } }),
        } as any;
      }
      writes += 1;
      return { json: async () => ({ ok: true }) } as any;
    });

    const menu = new MenuSync({ botToken: 't', chatId: 1, fetchFn: fetchFn as any });
    menu.setTarget(URL_A);
    await Promise.resolve();
    const before = writes;
    await menu.reconcile();
    expect(writes).toBe(before);
    menu.stop();
  });
});

describe('readMenuButton', () => {
  it('pulls the web_app url out of the response', async () => {
    const fetchFn = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { web_app: { url: 'https://x-y-z.trycloudflare.com/' } } }),
    })) as any;
    expect(await readMenuButton('t', 1, fetchFn)).toBe('https://x-y-z.trycloudflare.com/');
  });

  it('returns null when the api says not ok', async () => {
    const fetchFn = vi.fn(async () => ({ json: async () => ({ ok: false }) })) as any;
    expect(await readMenuButton('t', 1, fetchFn)).toBeNull();
  });
});

describe('desktop catalog mirror', () => {
  const MODELS = JSON.stringify({
    providers: {
      '9router': {
        name: '9router',
        baseUrl: 'http://localhost:20128/v1',
        apiKey: 'sk-secret-value',
        models: [
          { id: 'glm5.2', name: 'GLM 5.2', contextWindow: 220000, input: ['text'] },
          { id: 'gemini/gemini-3.6-flash', name: 'Gemini 3.6', contextWindow: 1000000, input: ['text', 'image'] },
        ],
      },
      OCX: {
        name: 'OCX',
        models: [
          { id: 'opencode-free/ling-3.0-flash-free', name: 'Ling 3.0 Flash (Free)', contextWindow: 262144, input: ['text', 'image'] },
        ],
      },
      Empty: { name: 'Empty', models: [] },
    },
  });

  it('reads providers, labels and context windows', () => {
    const file = tempFile('models.json', MODELS);
    const providers = readDesktopProviders(file);
    expect(providers.map((p) => p.id).sort()).toEqual(['9router', 'OCX']);
    const nine = providers.find((p) => p.id === '9router')!;
    expect(nine.models[0]).toMatchObject({
      id: 'glm5.2',
      label: 'GLM 5.2',
      contextWindow: 220000,
      vision: false,
    });
    expect(nine.models[1].vision).toBe(true);
  });

  it('never surfaces the provider api key', () => {
    const file = tempFile('models.json', MODELS);
    expect(JSON.stringify(readDesktopProviders(file))).not.toContain('sk-secret-value');
  });

  it('drops a provider with no models rather than showing an empty row', () => {
    const file = tempFile('models.json', MODELS);
    expect(readDesktopProviders(file).some((p) => p.id === 'Empty')).toBe(false);
  });

  it('survives a missing or half-written file', () => {
    expect(readDesktopProviders('/nope/models.json')).toEqual([]);
    expect(readDesktopProviders(tempFile('models.json', '{"providers":'))).toEqual([]);
  });

  it('reads defaultModel and the category bindings', () => {
    const file = tempFile(
      'settings.json',
      JSON.stringify({
        defaultModel: { provider: 'claude-code', modelId: 'claude-opus-5', thinkingLevel: 'medium' },
        modelCategories: {
          fast: { provider: 'OCX', modelId: '9router/deepseek', thinkingLevel: 'max' },
          broken: { provider: '', modelId: '' },
        },
      }),
    );
    const { defaultModel, categories } = readDesktopSettings(file);
    expect(defaultModel).toEqual({
      provider: 'claude-code',
      modelId: 'claude-opus-5',
      thinkingLevel: 'medium',
    });
    expect(categories.fast.modelId).toBe('9router/deepseek');
    expect(categories.broken).toBeUndefined();
  });

  it('derives the account root from sessionsDir', () => {
    delete process.env.MINIAPP_ASIDE_ROOT;
    expect(desktopRoot('/Users/x/.aside/u/0/sessions')).toBe('/Users/x/.aside/u/0');
  });
});

describe('buildCatalog with desktop providers', () => {
  const desktop = [
    {
      id: '9router',
      label: '9router',
      models: [
        { id: 'glm5.2', label: 'GLM 5.2', contextWindow: 220000, vision: false },
      ],
    },
  ];

  it('keeps Claude available when it is credentialed', () => {
    // The regression: config had claude-code pinned to models:[] while the
    // desktop default model was claude-code/claude-opus-5.
    const catalog = buildCatalog(['claude-code'], {}, desktop, []);
    const claude = catalog.find((p) => p.id === 'claude-code');
    expect(claude?.connected).toBe(true);
    expect(claude?.models.map((m) => m.id)).toContain('claude-opus-5');
  });

  it('shows desktop providers as connected without a credentials entry', () => {
    const catalog = buildCatalog(['claude-code'], {}, desktop, []);
    const nine = catalog.find((p) => p.id === '9router');
    expect(nine?.connected).toBe(true);
    expect(nine?.models[0].contextWindow).toBe(220000);
  });

  it('replaces stale hand-written model lists rather than merging them', () => {
    const catalog = buildCatalog(
      ['claude-code'],
      {},
      desktop,
      [],
    );
    const nine = catalog.find((p) => p.id === '9router')!;
    expect(nine.models.map((m) => m.id)).toEqual(['glm5.2']);
  });

  it('guarantees the desktop’s bound model is selectable', () => {
    const catalog = buildCatalog(
      [],
      {},
      [],
      [{ provider: 'OCX', modelId: 'opencode-free/ling-3.0-flash-free', thinkingLevel: 'max' }],
    );
    const ocx = catalog.find((p) => p.id === 'OCX');
    expect(ocx?.connected).toBe(true);
    expect(ocx?.models.map((m) => m.id)).toContain('opencode-free/ling-3.0-flash-free');
  });

  it('ignores malformed ensure refs', () => {
    const catalog = buildCatalog(['claude-code'], {}, desktop, [null, undefined]);
    expect(catalog.length).toBeGreaterThan(0);
  });
});

describe('waitForTranscript', () => {
  function dir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-wait-'));
    temps.push(d);
    fs.mkdirSync(path.join(d, '2026-08-02_abcdefghijklmnop'), { recursive: true });
    return d;
  }
  const ID = 'abcdefghijklmnop';
  const msgPath = (d: string) =>
    path.join(d, '2026-08-02_abcdefghijklmnop', 'messages.jsonl');

  it('returns at once when the transcript already exists', async () => {
    const d = dir();
    fs.writeFileSync(msgPath(d), '');
    const found = await waitForTranscript(d, ID, () => false);
    expect(found).toBe(msgPath(d));
  });

  it('404s immediately for an unknown id nothing is running', async () => {
    // A typo or a stale link must not hang the client for 30 seconds.
    const d = dir();
    const started = Date.now();
    expect(await waitForTranscript(d, ID, () => false)).toBeNull();
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('waits for a transcript that is still being written', async () => {
    // The actual bug: the id exists, the turn is running, the file is a
    // few hundred ms behind. The old code answered 404 in that window.
    const d = dir();
    let ticks = 0;
    const found = await waitForTranscript(d, ID, () => true, {
      pollMs: 1,
      sleep: async () => {
        if (++ticks === 3) fs.writeFileSync(msgPath(d), '');
      },
    });
    expect(found).toBe(msgPath(d));
    expect(ticks).toBe(3);
  });

  it('gives up when the turn ends without ever writing one', async () => {
    const d = dir();
    let busy = true;
    let ticks = 0;
    const found = await waitForTranscript(d, ID, () => busy, {
      pollMs: 1,
      sleep: async () => {
        if (++ticks === 2) busy = false;
      },
    });
    expect(found).toBeNull();
  });

  it('gives up at the deadline', async () => {
    const d = dir();
    let clock = 0;
    const found = await waitForTranscript(d, ID, () => true, {
      pollMs: 1,
      waitMs: 10,
      now: () => clock,
      sleep: async () => {
        clock += 4;
      },
    });
    expect(found).toBeNull();
  });
});

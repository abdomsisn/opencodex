import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LanguageProvider } from '../src/i18n/provider';
import Tray from '../src/pages/Tray';

// #6920: mounted tray routing. The popup must not poll before its targets resolve, and then every
// read and the account switch go to the resolved shared-plane base (hub origin or local relay).
const globals = ['document', 'window', 'navigator', 'localStorage', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: Array<{ url: string; method: string }>;

const routes: Record<string, unknown> = {
  '/api/config': { providers: { openai: {}, oauthp: { authMode: 'oauth' }, keyp: { hasApiKey: true } } },
  '/api/codex-auth/accounts': { activeAccountId: 'a0', accounts: [{ id: 'a0', alias: 'Main', quota: { weeklyPercent: 10 } }, { id: 'a1', alias: 'Second', quota: { weeklyPercent: 20 } }] },
  '/api/codex-auth/active': { activeCodexAccountId: 'a0' },
  '/api/oauth/accounts?provider=oauthp&quota=1': { accounts: [] },
  '/api/providers/keys?name=keyp&quota=1': { keys: [] },
  '/api/companion/settings': { settings: { hiddenProviders: [], models: null, showChart: false, showToday: true, showAccounts: true, showModels: false, showCost: false } },
  '/api/usage?range=today': { summary: { requests: 1 }, models: [] },
  '/api/usage?range=30d': { summary: { requests: 2 }, models: [] },
};

function stubFetch(base: string) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({ url, method });
    if (!url.startsWith(base)) return new Response('not found', { status: 404 });
    const path = url.slice(base.length);
    if (method === 'PUT') return Response.json({ ok: true });
    return path in routes ? Response.json(routes[path]) : new Response('not found', { status: 404 });
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: 'http://127.0.0.1:10100/#/tray' });
  Object.defineProperty(testWindow.navigator, 'language', { configurable: true, value: 'en-US' });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    HTMLElement: { configurable: true, value: testWindow.HTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  container = testWindow.document.createElement('div') as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  requests = [];
  root = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function settle(turns = 30): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

function render(resolveApiBase: (signal: AbortSignal) => Promise<string>, base: string): void {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: stubFetch(base) });
  root = createRoot(container);
  act(() => root!.render(<LanguageProvider><Tray resolveApiBase={resolveApiBase} /></LanguageProvider>));
}

const expectedReads = [
  '/api/config', '/api/codex-auth/accounts', '/api/codex-auth/active',
  '/api/oauth/accounts?provider=oauthp&quota=1', '/api/providers/keys?name=keyp&quota=1',
  '/api/companion/settings', '/api/usage?range=today', '/api/usage?range=30d',
];

test('the cost chart drills from a month through weeks and days into the hourly curve', async () => {
  const base = '/api/machine/hub-relay';
  const read = stubFetch(base);
  render(async () => base, base);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (url.pathname.endsWith('/api/companion/settings')) {
      return Response.json({ settings: {
        hiddenProviders: [], models: null, showChart: true, showToday: true,
        showAccounts: false, showModels: false, chartHours: 24, bucketMinutes: 60, chartGrouping: 'model',
      } });
    }
    if (url.pathname.endsWith('/api/usage/timeline')) {
      expect(url.searchParams.get('metric')).toBe('cost');
      const edges = url.searchParams.get('boundaries')?.split(',').map(Number);
      const buckets = edges ? edges.length - 1 : 24;
      const start = (edges?.[0] ?? Date.now() - 86_400_000) / 1000;
      const end = (edges?.at(-1) ?? Date.now()) / 1000;
      return Response.json({
        metric: 'cost', buckets, start, end, bucketSeconds: 3600, availableModels: ['openai/gpt-5'],
        appliedFilters: { models: null, hiddenProviders: [] },
        series: [
          { id: 'openai/gpt-5', model: 'gpt-5', provider: 'openai', points: Array(buckets).fill(0.75), total: buckets * 0.75 },
          { id: 'openai/gpt-6', model: 'gpt-6', provider: 'openai', points: Array(buckets).fill(0.25), total: buckets * 0.25 },
        ],
        costCoverage: { priced: Array(buckets).fill(1), unpriced: Array(buckets).fill(0) },
        bucketUsage: { requests: Array(buckets).fill(5), tokens: Array(buckets).fill(1200) },
        missingMeasurements: 0, truncated: false,
      });
    }
    return read(input, init);
  };
  await settle();
  expect(container.querySelector('.tray-figure dd')?.textContent).toBe('$1.00');
  const click = async (selector: string, label?: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>(selector)).find(node => !label || node.textContent === label);
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
    await settle(5);
  };
  await click('.tray-chart-tags button', 'Bar chart');
  expect(container.querySelectorAll('.tray-cost-bars button')).toHaveLength(30);
  expect(container.querySelectorAll('.tray-cost-stack:first-child > span')).toHaveLength(60);
  expect(container.querySelector('.tray-bars-summary')?.textContent).toContain('5 requests');
  expect(container.querySelector('.tray-chart .usage-companion-legend')?.textContent).toContain('gpt-6');
  await click('.tray-chart-tags button', 'Month');
  expect(container.querySelectorAll('.tray-cost-bars button')).toHaveLength(6);
  await click('.tray-cost-bars button');
  expect(container.querySelectorAll('.tray-cost-bars button').length).toBeGreaterThanOrEqual(4);
  await click('.tray-cost-bars button');
  expect(container.querySelectorAll('.tray-cost-bars button').length).toBeGreaterThan(0);
  await click('.tray-cost-bars button');
  expect(container.querySelector('.tray-chart svg')?.getAttribute('aria-label')).toBe('Estimated API cost');
  await click('.tray-chart-detail button');
  expect(container.querySelector('.tray-cost-bars button')).not.toBeNull();
});

for (const base of ['https://hub.example.test', '/api/machine/hub-relay']) {
  test(`nothing is polled before resolution, then every read and the switch use ${base}`, async () => {
    const targets = deferred<string>();
    render(() => targets.promise, base);
    await settle(3);
    expect(requests).toEqual([]);

    targets.resolve(base);
    await settle();
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.url.startsWith(`${base}/api/`)).toBe(true);
    const paths = requests.map(request => request.url.slice(base.length));
    expect(paths.filter(path => path.startsWith('/api/usage/timeline?'))).toHaveLength(1);
    expect(paths.find(path => path.startsWith('/api/usage/timeline?'))).toContain('metric=cost');
    expect(new Set(paths.filter(path => !path.startsWith('/api/usage/timeline?')))).toEqual(new Set(expectedReads));
    // The header's connection state is read off those same reads; it adds no request of its own.
    expect(container.querySelector('.tray-status')?.getAttribute('data-state')).toBe('up');

    const use = container.querySelector('button.tray-use') as unknown as HTMLButtonElement | null;
    expect(use).not.toBeNull();
    await act(async () => { use!.click(); });
    await settle();
    expect(requests.filter(request => request.method === 'PUT').map(request => request.url)).toEqual([`${base}/api/codex-auth/active`]);
  });
}

test('a failed target discovery is reported, polls nothing, and Retry resolves again', async () => {
  let attempts = 0;
  render(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('local machine plane unavailable');
    return 'https://hub.example.test';
  }, 'https://hub.example.test');
  await settle(5);
  expect(requests).toEqual([]);
  expect(container.querySelector('.tray-status')?.getAttribute('data-state')).toBe('down');
  const alert = container.querySelector('[role="alert"] button') as unknown as HTMLButtonElement | null;
  expect(alert).not.toBeNull();
  await act(async () => { alert!.click(); });
  await settle();
  expect(attempts).toBe(2);
  expect(requests.map(request => request.url)).toContain('https://hub.example.test/api/config');
});

test('unmounting while targets resolve cancels resolution and polls nothing', async () => {
  const targets = deferred<string>();
  let signal: AbortSignal | undefined;
  render(next => { signal = next; return targets.promise; }, 'https://hub.example.test');
  await settle(2);
  act(() => root!.unmount());
  root = null;
  expect(signal?.aborted).toBe(true);
  targets.resolve('https://hub.example.test');
  await settle(5);
  expect(requests).toEqual([]);
});

test('unmounting during an account switch aborts the request and starts no refresh', async () => {
  const base = 'https://hub.example.test';
  render(async () => base, base);
  await settle();
  const reads = stubFetch(base);
  const put = deferred<Response>();
  let putSignal: AbortSignal | undefined;
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET').toUpperCase() !== 'PUT') return reads(input, init);
    requests.push({ url: String(input), method: 'PUT' });
    putSignal = init?.signal ?? undefined;
    return put.promise;
  } });
  const use = container.querySelector('button.tray-use') as unknown as HTMLButtonElement | null;
  expect(use).not.toBeNull();
  await act(async () => { use!.click(); });
  expect(putSignal?.aborted).toBe(false);
  act(() => root!.unmount());
  root = null;
  expect(putSignal?.aborted).toBe(true);
  const settled = requests.length;
  put.resolve(Response.json({ ok: true }));
  await settle(5);
  expect(requests.length).toBe(settled);
});

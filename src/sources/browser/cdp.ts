import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { Config } from '../../config';

// One CDP connection to the operator's Chrome, one reused tab, one page operation at a time.

let browser: Browser | undefined;
let connecting: Promise<Browser> | undefined;
let tab: Page | undefined;
let tabContext: BrowserContext | undefined;

async function connect(config: Config): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  connecting ??= chromium
    .connectOverCDP(config.CHROME_CDP_URL, { timeout: 10_000 })
    .then((b) => {
      browser = b;
      b.on('disconnected', () => {
        if (browser === b) {
          browser = undefined;
          tab = undefined;
          tabContext = undefined;
        }
      });
      return b;
    })
    .finally(() => {
      connecting = undefined;
    });
  return connecting;
}

/** Our single tab, in the browser's default context so the operator's logins apply. */
export async function getTab(config: Config): Promise<Page> {
  const b = await connect(config);
  if (tab && !tab.isClosed()) return tab;
  const context = b.contexts()[0];
  if (!context) throw new Error('chrome has no default browser context');
  tabContext = context;
  tab = await context.newPage();
  tab.on('close', () => {
    if (tab && tab.isClosed()) tab = undefined;
  });
  return tab;
}

// Serialises page operations across every browser source.
let tail: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}

/** Runs fn with our tab while holding the lock. */
export function withTab<T>(config: Config, fn: (page: Page) => Promise<T>): Promise<T> {
  return runExclusive(async () => fn(await getTab(config)));
}

// -------------------------------------------------------------- pacing

let lastNavigation = 0;

const abortable = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const sleep = abortable;

/** Waits until 2-4 seconds have passed since the previous navigation (any site). */
export async function paceNavigation(signal?: AbortSignal, rand: () => number = Math.random): Promise<void> {
  const gap = 2000 + rand() * 2000;
  const wait = lastNavigation + gap - Date.now();
  if (wait > 0) await abortable(wait, signal);
  lastNavigation = Date.now();
}

// -------------------------------------------------------------- reachability

const REACH_TTL_MS = 30_000;
let reach: { at: number; ok: boolean; pending?: Promise<boolean> } = { at: 0, ok: false };

/** Is a Chrome listening on CHROME_CDP_URL? Cached for 30 seconds. */
export async function isReachable(config: Config): Promise<boolean> {
  if (Date.now() - reach.at < REACH_TTL_MS) return reach.ok;
  if (reach.pending) return reach.pending;
  const pending = fetch(`${config.CHROME_CDP_URL.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false)
    .then((ok) => {
      reach = { at: Date.now(), ok };
      return ok;
    });
  reach = { ...reach, pending };
  return pending;
}

/** Last known reachability, without waiting. */
export const lastKnownReachable = (): boolean => reach.ok;

// -------------------------------------------------------------- shutdown

/** Closes our tab and drops the connection. Never closes the operator's browser. */
export async function disconnect(): Promise<void> {
  const t = tab;
  const b = browser;
  tab = undefined;
  tabContext = undefined;
  browser = undefined;
  if (t && !t.isClosed()) await t.close().catch(() => undefined);
  // For a CDP-attached browser, close() only detaches.
  if (b) await b.close().catch(() => undefined);
}

/** Test hook. */
export function resetForTests(): void {
  browser = tab = tabContext = undefined;
  tail = Promise.resolve();
  lastNavigation = 0;
  reach = { at: 0, ok: false };
}

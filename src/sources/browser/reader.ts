import type { Page } from 'playwright-core';
import type { EventBus } from '../../domain/ports';
import { detectChallenge, waitForOperator } from './challenge';
import { paceNavigation, sleep } from './cdp';

export const MAX_TEXT_CHARS = 40_000;

export interface ReadOptions {
  bus: EventBus;
  site: string;
  /** Anchors whose absolute href matches get the href inlined as `<url>`. */
  linkPattern?: RegExp;
  signal?: AbortSignal;
  settleMs?: number;
  maxChars?: number;
  /** Shows the hidden Chrome window during a human check (setChromeVisible). */
  reveal?: (visible: boolean) => Promise<void>;
}

export interface PageRead {
  url: string;
  title: string;
  text: string;
  /** 'none': no check seen; 'cleared': the person solved it; 'blocked': still there after the wait. */
  challenge: 'none' | 'cleared' | 'blocked';
  challengeReason?: string;
  status?: number;
}

// Runs inside the page, passed as a string. Args are spliced in as JSON.
const textScript = (pattern: string | null, flags: string, max: number): string => `(() => {
  const re = ${pattern === null ? 'null' : `new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)})`};
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','NAV','FOOTER','TEMPLATE','IFRAME','HEAD','CANVAS','VIDEO','AUDIO','SELECT','OPTION']);
  const BLOCK = new Set(['DIV','P','LI','UL','OL','SECTION','ARTICLE','H1','H2','H3','H4','H5','H6','TR','BR','HEADER','MAIN','ASIDE','FORM','TABLE','FIGURE']);
  const out = [];
  let lastHref = '';
  const visible = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  };
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP.has(el.tagName.toUpperCase()) || el.getAttribute('aria-hidden') === 'true' || !visible(el)) return;
    const block = BLOCK.has(el.tagName);
    if (block) out.push('\\n');
    for (const c of el.childNodes) walk(c);
    if (el.tagName === 'A' && re) {
      const href = el.href || '';
      if (href && re.test(href) && href !== lastHref) {
        out.push(' <' + href.split('#')[0] + '> ');
        lastHref = href;
      }
    }
    if (block) out.push('\\n');
  };
  if (document.body) walk(document.body);
  const text = out.join(' ').replace(/[ \\t\\u00a0]+/g, ' ').replace(/ ?\\n ?/g, '\\n').replace(/\\n{2,}/g, '\\n').trim();
  return text.slice(0, ${max});
})()`;

/**
 * Loads one page in our tab the way a person would and returns compact text.
 * Call inside withTab(). One navigation only; no pagination.
 */
export async function readPage(page: Page, url: string, opts: ReadOptions): Promise<PageRead> {
  const { signal, bus, site, settleMs = 1500, maxChars = MAX_TEXT_CHARS } = opts;
  await paceNavigation(signal, undefined, url);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const status = response?.status();
  await sleep(settleMs, signal);

  let challenge: PageRead['challenge'] = 'none';
  let reason = await detectChallenge(page, { status });
  if (reason) {
    const cleared = await waitForOperator(page, bus, site, { signal, reveal: opts.reveal });
    challenge = cleared ? 'cleared' : 'blocked';
    if (!cleared) return { url: page.url(), title: await page.title().catch(() => ''), text: '', challenge, challengeReason: reason, status };
    await sleep(settleMs, signal);
  }

  // Two gentle scrolls to trigger lazy loading.
  for (let i = 0; i < 2; i++) {
    await page.evaluate('window.scrollBy(0, Math.round(window.innerHeight * 0.8))').catch(() => undefined);
    await sleep(700, signal);
  }
  await page.evaluate('window.scrollTo(0, 0)').catch(() => undefined);

  const pattern = opts.linkPattern;
  const text = await page.evaluate<string>(textScript(pattern ? pattern.source : null, pattern ? pattern.flags.replace(/[gy]/g, '') : '', maxChars));
  return { url: page.url(), title: await page.title().catch(() => ''), text, challenge, challengeReason: reason ?? undefined, status };
}

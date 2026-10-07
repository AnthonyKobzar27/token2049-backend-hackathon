import type { EventBus } from '../../domain/ports';

// Detects bot challenges and waits for the person to clear them. Never touches the challenge.

export interface PageSignals {
  /** Known challenge container ids/classes present in the DOM. */
  markers: string[];
  /** src of every iframe. */
  frames: string[];
  /** Start of the visible body text. */
  text: string;
}

/** The slice of a Playwright Page that detection needs. */
export interface PageLike {
  url(): string;
  title(): Promise<string>;
  evaluate<R>(script: string): Promise<R>;
  bringToFront?(): Promise<void>;
}

// Runs inside the page. A string, so the loader's name helpers cannot leak into it.
export const SIGNALS_SCRIPT = `(() => {
  const ids = ['px-captcha', 'challenge-form', 'cf-challenge-running', 'cf-please-wait', 'datadome', 'sec-cpt-if'];
  const markers = ids.filter((i) => document.getElementById(i));
  if (document.querySelector('.cf-turnstile, [id^="px-captcha"], .g-recaptcha, .h-captcha')) markers.push('widget');
  const frames = Array.from(document.querySelectorAll('iframe')).map((f) => f.src || '');
  const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 1500);
  return { markers, frames, text };
})()`;

const TITLE_RE = /^(access denied|attention required|just a moment|are you (a )?human|human verification|verify you are (a )?human|robot or human|security check|please verify)/i;
const FRAME_RE = /challenges\.cloudflare\.com|captcha-delivery\.com|perimeterx|px-cdn|px-cloud|hcaptcha\.com\/captcha|google\.com\/recaptcha\/(api2|enterprise)\/bframe/i;
const TEXT_RE = /press\s*(&|and)\s*hold|verify you are (a )?human|checking (if the site connection is secure|your browser)|enable javascript and cookies to continue|confirm you are (a )?human/i;

export interface ChallengeInput {
  url: string;
  title: string;
  status?: number;
  signals: PageSignals;
}

/** Pure classification. Returns the reason, or null when the page looks normal. */
export function classify({ title, status, signals }: ChallengeInput): string | null {
  const shortBody = signals.text.length < 600;
  if (signals.markers.some((m) => m !== 'widget') && shortBody) return `challenge element (${signals.markers.join(',')})`;
  if (signals.markers.includes('px-captcha')) return 'PerimeterX "px-captcha"';
  if (TITLE_RE.test(title.trim())) return `title "${title.trim()}"`;
  if (signals.frames.some((f) => FRAME_RE.test(f)) && shortBody) return 'challenge iframe';
  if (TEXT_RE.test(signals.text.slice(0, 600)) && shortBody) return 'challenge text';
  if (status === 403 && shortBody) return 'HTTP 403';
  return null;
}

export async function detectChallenge(page: PageLike, opts: { status?: number } = {}): Promise<string | null> {
  let signals: PageSignals;
  let title = '';
  try {
    title = await page.title();
    signals = await page.evaluate<PageSignals>(SIGNALS_SCRIPT);
  } catch {
    // Mid-navigation: the context was destroyed. Not a challenge signal by itself.
    return null;
  }
  return classify({ url: page.url(), title, status: opts.status, signals });
}

export interface WaitOptions {
  /** Defaults to 3 minutes / 3 seconds. */
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** Shows the hidden Chrome window while the person solves the check, and hides it again after. */
  reveal?: (visible: boolean) => Promise<void>;
}

/** Tells the operator, brings the tab to front, and polls until the check is gone. True when cleared. */
export async function waitForOperator(page: PageLike, bus: EventBus, site: string, opts: WaitOptions = {}): Promise<boolean> {
  const { timeoutMs = 180_000, pollMs = 3000, signal } = opts;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  bus.emit({
    type: 'operator.attention',
    source: site,
    message: `${site} is asking for a human check. Please complete it in the Chrome window.`,
    url: page.url(),
  });
  await page.bringToFront?.().catch(() => undefined);
  await opts.reveal?.(true).catch(() => undefined);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      await sleep(pollMs);
      if (!(await detectChallenge(page))) return true;
    }
    return false;
  } finally {
    await opts.reveal?.(false).catch(() => undefined);
  }
}

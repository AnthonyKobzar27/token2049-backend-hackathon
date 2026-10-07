import type { Page } from 'playwright-core';
import type { Brief } from '../../domain/types';
import type { EventBus } from '../../domain/ports';
import { detectChallenge, waitForOperator } from './challenge';
import { paceNavigation, sleep } from './cdp';

// Books a freelancer on a site without a booking API the way a person starts one: open their page,
// press the site's contact button, write the brief, send. Never touches checkout or payment.

export interface ContactSpec {
  /** Accessible name of the button or link that opens the message box ("Contact me", "Get a Quote"). */
  button: RegExp;
  /** Accessible name of the send button inside the message box. */
  send: RegExp;
}

export type ContactOutcome =
  | { status: 'sent'; url: string }
  | { status: 'login_required'; url: string }
  | { status: 'challenge'; url: string; reason: string }
  | { status: 'not_found'; url: string; step: 'button' | 'message_box' | 'send' }
  | { status: 'error'; url: string; error: string };

/** The first message a freelancer receives: the brief, the budget, and a request for an offer. */
export function contactMessage(brief: Brief, priceUsd: number): string {
  const lines = [
    `Hi! I'd like to hire you for this: ${brief.task.trim()}`,
    brief.notes ? `Details: ${brief.notes.trim()}` : '',
    brief.when ? `When: ${whenText(brief)}` : '',
    brief.hoursNeeded ? `Estimated time: ${brief.hoursNeeded} hours` : '',
    brief.deadlineDays ? `Needed within ${brief.deadlineDays} days` : '',
    `Budget: about $${Math.round(priceUsd)} USD.`,
    'Could you send me a custom offer if you can take it on? Thanks!',
  ];
  return lines.filter(Boolean).join('\n');
}

function whenText(brief: Brief): string {
  const w = brief.when!;
  const parts = [w.date, w.window ? `${w.window.start}-${w.window.end}` : undefined, w.timezone ?? brief.timezone].filter(Boolean);
  return parts.join(' ');
}

const LOGIN_URL = /\/(login|log-in|signin|sign-in|sign_in|join|register|signup|sign-up)(\b|\/|\?)/i;

async function loginWall(page: Page): Promise<boolean> {
  if (LOGIN_URL.test(page.url())) return true;
  // Logged out: the header offers "Sign in" / "Join" (messaging needs an account on every site).
  const signIn = page.getByRole('link', { name: /^\s*(sign in|log in|login|join( fiverr| now| free)?|sign up)\s*$/i }).or(
    page.getByRole('button', { name: /^\s*(sign in|log in|login|join( fiverr| now| free)?|sign up)\s*$/i }),
  );
  if (await signIn.first().isVisible().catch(() => false)) return true;
  // A sign-in modal over the page: a visible password field.
  return page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
}

async function firstVisible(page: Page, candidates: ReturnType<Page['locator']>[]): Promise<ReturnType<Page['locator']> | undefined> {
  for (const c of candidates) {
    const el = c.first();
    if (await el.isVisible().catch(() => false)) return el;
  }
  return undefined;
}

export interface ContactOptions {
  signal?: AbortSignal;
  /** Milliseconds to wait for each element to appear. */
  waitMs?: number;
  /** Test hook: skip the human-pace delay. */
  pace?: boolean;
  /** With a bus, a human check is handed to the operator (texted, window shown) and the step continues once solved. */
  bus?: EventBus;
  site?: string;
  reveal?: (visible: boolean) => Promise<void>;
}

/**
 * Opens `url` in our tab and messages the freelancer. Call inside withTab().
 * Returns without sending when the site wants a login or a human check: the operator handles those.
 */
export async function contactOnPage(page: Page, url: string, spec: ContactSpec, message: string, opts: ContactOptions = {}): Promise<ContactOutcome> {
  const { signal, waitMs = 8_000, pace = true } = opts;
  try {
    if (pace) await paceNavigation(signal, undefined, url);
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(1_500, signal);
    const reason = await detectChallenge(page, { status: res?.status() });
    if (reason) {
      const cleared = opts.bus ? await waitForOperator(page, opts.bus, opts.site ?? new URL(url).hostname, { signal, reveal: opts.reveal }) : false;
      if (!cleared) return { status: 'challenge', url: page.url(), reason };
      await sleep(1_500, signal);
    }
    if (await loginWall(page)) return { status: 'login_required', url: page.url() };

    const button = await waitFor(page, () => firstVisible(page, [page.getByRole('button', { name: spec.button }), page.getByRole('link', { name: spec.button })]), waitMs, signal);
    if (!button) return { status: 'not_found', url: page.url(), step: 'button' };
    await button.click({ timeout: 10_000 });
    await sleep(1_500, signal);
    if (await loginWall(page)) return { status: 'login_required', url: page.url() };

    const box = await waitFor(
      page,
      () => firstVisible(page, [page.getByRole('textbox', { name: /message|describe|write|tell|request|details/i }), page.locator('textarea'), page.locator('[contenteditable="true"]')]),
      waitMs,
      signal,
    );
    if (!box) return { status: 'not_found', url: page.url(), step: 'message_box' };
    await box.click({ timeout: 5_000 });
    await box.fill(message, { timeout: 10_000 });
    await sleep(600, signal);

    const send = await waitFor(page, () => firstVisible(page, [page.getByRole('button', { name: spec.send })]), waitMs, signal);
    if (!send) return { status: 'not_found', url: page.url(), step: 'send' };
    await send.click({ timeout: 10_000 });
    await sleep(2_000, signal);
    if (await loginWall(page)) return { status: 'login_required', url: page.url() };
    return { status: 'sent', url: page.url() };
  } catch (err) {
    return { status: 'error', url: page.url(), error: err instanceof Error ? err.message : String(err) };
  }
}

async function waitFor<T>(page: Page, find: () => Promise<T | undefined>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await find();
    if (found) return found;
    if (Date.now() >= deadline || signal?.aborted || page.isClosed()) return undefined;
    await sleep(400, signal).catch(() => undefined);
  }
}

/** Plain-language next step for the operator, per outcome. */
export function contactInstructions(site: string, name: string, outcome: ContactOutcome, priceUsd: number): string {
  switch (outcome.status) {
    case 'sent':
      return `HAAS sent your brief to ${name} on ${site} and asked for a custom offer (about $${Math.round(priceUsd)}). When they reply, accept the offer and pay on ${site} in the HAAS Chrome window. HAAS never clicks order or pay.`;
    case 'login_required':
      return `${site} needs you to log in before HAAS can message ${name}. Log into ${site} in the HAAS Chrome window, then contact ${name} with the brief and order on ${site}.`;
    case 'challenge':
      return `${site} showed a human check (${outcome.reason}). Solve it in the HAAS Chrome window, then contact ${name} with the brief and order on ${site}.`;
    case 'not_found':
      return `HAAS could not find the ${outcome.step === 'button' ? 'contact button' : outcome.step === 'message_box' ? 'message box' : 'send button'} on ${name}'s ${site} page. Contact ${name} yourself with the brief and order on ${site}.`;
    case 'error':
      return `Messaging ${name} on ${site} failed (${outcome.error}). Contact ${name} yourself with the brief and order on ${site}.`;
  }
}

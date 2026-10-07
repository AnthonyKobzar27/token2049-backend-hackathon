// Only legitimate work goes on the board. HAAS never pays people to defeat a site's controls.

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

const RULES: { re: RegExp; reason: string }[] = [
  { re: /\b(re)?captchas?\b|\bh-?captcha\b|\bturnstile\b|\bfuncaptcha\b|\barkose\b/i, reason: 'solving CAPTCHAs or human checks' },
  {
    re: /\b(solve|solving|pass|passing|beat|beating)\b[^.]{0,40}\b(human (check|verification)|bot (check|challenge|detection)|anti-?bot|challenge page)/i,
    reason: 'passing human or bot checks for someone else',
  },
  {
    re: /\b(bypass|circumvent|evade|evading|defeat|get around|work around|disable)\b[^.]{0,50}\b(captcha|rate.?limit|paywall|ban|block|geo.?block|verification|2fa|two.factor|otp|anti-?bot|bot detection|detection|security|drm|kyc|login|queue limit|purchase limit)/i,
    reason: "getting around a site's controls",
  },
  { re: /\b(sms|phone|otp|verification) (code|number)s?\b[^.]{0,40}\b(for|to (create|open|verify))\b[^.]{0,30}\baccounts?\b/i, reason: "verifying accounts on someone else's behalf" },
  { re: /\b(bulk|mass|fake)\b[^.]{0,20}\b(accounts?|sign-?ups|registrations)\b/i, reason: 'creating accounts in bulk' },
  { re: /\b(fake|paid|incentivi[sz]ed)\b[^.]{0,15}\b(reviews?|ratings?|likes|followers)\b/i, reason: 'fake reviews or engagement' },
];

/** Rejects briefs that ask a worker to solve CAPTCHAs, defeat site controls, or fake engagement. */
export function checkTask(text: string): GuardVerdict {
  for (const r of RULES) if (r.re.test(text)) return { ok: false, reason: `HAAS does not post tasks that involve ${r.reason}.` };
  return { ok: true };
}

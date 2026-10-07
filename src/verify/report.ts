// Plain-text rendering of a QA report: approval details, revision requests, logs.
import { freelancerSafe } from '../agent/outreach';
import type { VerificationReport } from '../domain/types';

const VERDICT_TEXT: Record<VerificationReport['verdict'], string> = {
  pass: 'PASSED',
  fail: 'FAILED',
  needs_human: 'NEEDS A PERSON',
};

/** Multi-line plain text: verdict, score, summary, then one line per check. */
export function qaSummaryText(r: VerificationReport): string {
  const lines = [
    `QA ${VERDICT_TEXT[r.verdict]} (score ${Math.round(r.score * 100)}/100, attempt ${r.attempt}${r.model ? `, ${r.model}` : ''})`,
    r.summary,
    ...r.checks.map((c) => `${c.ok ? '[ok]' : '[x]'} ${c.name}: ${c.detail}`),
    `Result hash: ${r.resultHash}`,
  ];
  return lines.join('\n');
}

/** What the freelancer is asked to fix after a failed QA run. */
export function revisionRequestText(r: VerificationReport): string {
  const failed = r.checks.filter((c) => !c.ok);
  // Check details are written by our verifier: keep only what a person would say to a person.
  const items = (failed.length ? failed.map((c) => c.detail) : [r.summary]).map((d) => freelancerSafe(d)).filter(Boolean).map((d) => `- ${d}`);
  if (!items.length) items.push("- it doesn't quite match what I asked for yet");
  return ['Thanks for sending this over! Just a couple of fixes before I can sign off:', ...items, 'Send the updated version when you can. Thanks!'].join('\n');
}

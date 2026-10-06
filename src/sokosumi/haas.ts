// Runs HAAS for a Sokosumi Task: Task text -> brief -> routing -> ranked shortlist as the result.
// A Task has no awaiting_input round-trip, so the job stops at the shortlist; nothing is booked.
import type { Intake } from '../agent/intake';
import { fallbackBrief } from '../agent/intake';
import type { JobService } from '../domain/ports';
import type { Brief, Job, Shortlist } from '../domain/types';
import { parseBrief } from '../masumi/schema';
import type { SokosumiTask } from './core';
import type { HaasRun } from './worker';

/** A JSON brief in the description is used as is; otherwise the intake model (or the fallback) reads the text. */
export function createTaskBriefParser(intake?: Intake) {
  return async (task: Pick<SokosumiTask, 'name' | 'description'>): Promise<Brief> => {
    const desc = task.description?.trim() ?? '';
    if (desc.startsWith('{')) {
      try {
        const parsed = parseBrief(JSON.parse(desc));
        if (parsed.ok) return parsed.value;
      } catch {
        // not JSON after all; read it as text
      }
    }
    const text = [task.name, desc].filter(Boolean).join('\n');
    const history = [{ from: 'hirer' as const, text }];
    if (intake) {
      // Two rounds marked as already asked: the intake returns a brief instead of a question.
      const out = await intake
        .next([...history, { from: 'agent', text: '(no follow-up questions possible)' }, { from: 'hirer', text: 'Use what you have.' }, { from: 'agent', text: '(none)' }, { from: 'hirer', text: 'Go ahead.' }])
        .catch(() => null);
      if (out?.kind === 'brief') return out.brief;
    }
    return fallbackBrief(history).brief;
  };
}

const money = (n: number | null | undefined) => (n === undefined || n === null ? 'no quote' : `$${Math.round(n)}`);

/** Plain text a person reads in the Task, followed by the same shortlist as JSON for agents. */
export function formatShortlist(brief: Brief, shortlist: Shortlist | null): string {
  const lines = [`HAAS shortlist for: ${brief.task}`, ''];
  const cands = shortlist?.candidates ?? [];
  if (!cands.length) lines.push('No freelancer matched this brief on the enabled platforms.');
  cands.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.profile.name} (${c.profile.platform}), score ${Math.round(c.score)}, ${money(c.quoteUsd)}`);
    lines.push(`   ${c.reason}`);
    if (c.profile.url) lines.push(`   ${c.profile.url}`);
    if (c.unknowns.length) lines.push(`   Not published: ${c.unknowns.join(', ')}`);
  });
  lines.push('', 'Nothing was booked. Reply with the candidate you want and HAAS books them after your approval.');
  const json = {
    task: brief.task,
    candidates: cands.map((c) => ({
      id: c.profile.id,
      platform: c.profile.platform,
      name: c.profile.name,
      url: c.profile.url,
      score: c.score,
      reason: c.reason,
      quote_usd: c.quoteUsd ?? null,
      unknowns: c.unknowns,
    })),
  };
  lines.push('', '```json', JSON.stringify(json), '```');
  return lines.join('\n');
}

/** Starts a HAAS job for the Task and resolves with the shortlist once routing has finished. */
export function createHaasRunner(deps: { jobs: JobService; timeoutMs: number; pollMs?: number }) {
  const pollMs = deps.pollMs ?? 1000;
  return async (brief: Brief, taskId: string): Promise<HaasRun> => {
    // One engine job per Task, by id: after a worker restart the Task resumes its job instead of
    // starting (and routing, or paying an AI agent for) a second one.
    const id = `job_sk_${taskId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const job = deps.jobs.getJob(id) ?? deps.jobs.startJob({ id, brief, client: 'sokosumi', clientRef: taskId });
    const deadline = Date.now() + deps.timeoutMs;
    let cur: Job | null = job;
    while (cur && cur.status === 'running') {
      if (Date.now() > deadline) throw new Error('routing timed out');
      await new Promise((r) => setTimeout(r, pollMs));
      cur = deps.jobs.getJob(job.id);
    }
    if (!cur) throw new Error('job disappeared');
    if (cur.status === 'failed') throw new Error(cur.error ?? 'routing failed');
    // An AI agent did the work (AI-first delegation): its output is the Task's answer.
    if (cur.status === 'completed' && cur.result?.path === 'ai') return { result: cur.result.output || cur.result.summary, jobId: job.id };
    const result = formatShortlist(brief, deps.jobs.getShortlist(job.id));
    // Close the check-in: the Task's answer is the shortlist, not a booking.
    if (cur.status === 'awaiting_input') {
      try {
        deps.jobs.provideInput(job.id, { action: 'cancel' });
      } catch {
        // already closed
      }
    }
    return { result, jobId: job.id };
  };
}

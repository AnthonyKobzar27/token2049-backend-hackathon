// AI-first delegation: "Can an AI agent do it?" If so, hire a Masumi agent under a hard time budget;
// otherwise (or on any failure) hand back to the human router. Never throws, never exceeds the budget.
import type { Config } from '../config';
import type { EventBus } from '../domain/ports';
import type { Brief, Job, JobResult } from '../domain/types';
import type { Buyer } from '../masumi/buyer';
import type { Classification, Classifier } from './classify';

export type DelegationOutcome =
  | { result: JobResult; classification: Classification }
  | { result: null; reason: string; classification?: Classification };

export interface Delegator {
  tryAi(job: Job): Promise<DelegationOutcome>;
}

const SUMMARY_OUTPUT_CHARS = 3_000;
const MAX_AGENTS = 2;

/** The brief as one instruction for a text agent. */
export function taskText(brief: Brief): string {
  const parts = [brief.task.trim()];
  if (brief.notes) parts.push(`Notes: ${brief.notes}`);
  if (brief.language) parts.push(`Respond in language: ${brief.language}`);
  if (brief.skills.length) parts.push(`Relevant skills: ${brief.skills.join(', ')}`);
  return parts.join('\n');
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createDelegator(deps: { config: Config; bus: EventBus; classifier: Classifier; buyer: Buyer }): Delegator {
  const { config, bus, classifier, buyer } = deps;

  return {
    async tryAi(job) {
      if (config.AI_DELEGATION === 'off') return { result: null, reason: 'AI delegation is off' };
      const say = (message: string) => bus.emit({ type: 'job.progress', jobId: job.id, message });
      const ctrl = new AbortController();
      const budget = setTimeout(() => ctrl.abort(new Error(`AI time budget of ${config.AI_TIME_BUDGET_MS} ms used up`)), config.AI_TIME_BUDGET_MS);
      const timedOut = new Promise<never>((_, reject) => ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason), { once: true }));
      timedOut.catch(() => {});
      const within = <T>(p: Promise<T>) => Promise.race([p, timedOut]);

      // Registry lookup runs while we classify; it is dropped if the work needs a human.
      const agentsP = buyer.findAgents({ signal: ctrl.signal });
      agentsP.catch(() => {});
      let classification: Classification | undefined;
      try {
        say('Checking whether an AI agent can do this…');
        classification = await within(classifier.classify(job.brief));
        if (classification.kind === 'human') {
          say(`This needs a person (${classification.reason}). Searching freelancers…`);
          return { result: null, reason: `classified human: ${classification.reason}`, classification };
        }
        const agents = (await within(agentsP)).slice(0, MAX_AGENTS);
        if (!agents.length) {
          say('No AI agent is available for this; finding a human instead…');
          return { result: null, reason: 'no AI agent available', classification };
        }

        const errors: string[] = [];
        for (const agent of agents) {
          say(`Trying an AI agent: ${agent.name}…`);
          try {
            const { output, work } = await within(buyer.hire(agent, taskText(job.brief), { signal: ctrl.signal, onProgress: say }));
            const shown = output.length > SUMMARY_OUTPUT_CHARS ? `${output.slice(0, SUMMARY_OUTPUT_CHARS)}…` : output;
            const how = `${work.paid ? 'paid on Cardano' : 'free/demo mode'}${work.verified ? ', result hash verified' : ''}`;
            return {
              classification,
              result: {
                outcome: 'delivered',
                path: 'ai',
                summary: `Done by AI agent ${work.name} (Masumi job ${work.jobId}, ${how}).\n\n${shown}`,
                output,
                agent: work,
              },
            };
          } catch (err) {
            if (ctrl.signal.aborted) throw err;
            errors.push(`${agent.name}: ${errText(err)}`);
            console.error(`[delegate] ${job.id}: agent ${agent.name} failed:`, errText(err));
          }
        }
        say('The AI agent could not finish this; finding a human instead…');
        return { result: null, reason: errors.join('; '), classification };
      } catch (err) {
        const reason = errText(err);
        say(ctrl.signal.aborted ? 'The AI agent ran out of time; finding a human instead…' : 'The AI path failed; finding a human instead…');
        console.error(`[delegate] ${job.id}: ${reason}`);
        return { result: null, reason, classification };
      } finally {
        clearTimeout(budget);
        if (!ctrl.signal.aborted) ctrl.abort(new Error('done'));
      }
    },
  };
}

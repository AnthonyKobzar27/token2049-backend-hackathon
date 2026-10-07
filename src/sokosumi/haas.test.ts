import { describe, expect, it, vi } from 'vitest';
import type { JobService } from '../domain/ports';
import type { Job } from '../domain/types';
import { createHaasRunner } from './haas';

describe('Sokosumi HAAS runner', () => {
  it("answers the Task with the AI agent's output when the AI path did the work", async () => {
    const done: Job = { id: 'j1', status: 'completed', client: 'sokosumi', brief: { task: 't', skills: [], remoteOk: true }, round: 1, createdAt: 1, updatedAt: 1, path: 'ai', result: { outcome: 'delivered', path: 'ai', summary: 'Done by AI agent X', output: '- bullet one' } };
    const jobs = { startJob: () => ({ ...done, status: 'running' }), getJob: () => done, getShortlist: () => null } as unknown as JobService;
    const run = await createHaasRunner({ jobs, timeoutMs: 1000, pollMs: 1 })({ task: 't', skills: [], remoteOk: true }, 'task_1');
    expect(run).toEqual({ result: '- bullet one', jobId: 'j1' });
  });

  it('resumes the Task\'s own job after a restart instead of starting a second one', async () => {
    const done: Job = { id: 'job_sk_task_2', status: 'completed', client: 'sokosumi', brief: { task: 't', skills: [], remoteOk: true }, round: 1, createdAt: 1, updatedAt: 1, path: 'ai', result: { outcome: 'delivered', path: 'ai', summary: 's', output: 'out' } };
    const startJob = vi.fn();
    const jobs = { startJob, getJob: (id: string) => (id === done.id ? done : null), getShortlist: () => null } as unknown as JobService;
    const run = await createHaasRunner({ jobs, timeoutMs: 1000, pollMs: 1 })({ task: 't', skills: [], remoteOk: true }, 'task 2');
    expect(run.jobId).toBe('job_sk_task_2');
    expect(startJob).not.toHaveBeenCalled();
  });
});

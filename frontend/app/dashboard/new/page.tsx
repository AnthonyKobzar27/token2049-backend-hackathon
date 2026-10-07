'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { post } from '@/lib/api';
import type { Job } from '@/lib/types';
import { Panel } from '@/components/ui';

export default function NewTaskPage() {
  const router = useRouter();
  const [task, setTask] = useState('');
  const [skills, setSkills] = useState('');
  const [budget, setBudget] = useState('');
  const [deadline, setDeadline] = useState('');
  const [location, setLocation] = useState('');
  const [remoteOk, setRemoteOk] = useState(true);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!task.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const job = await post<Job>('/api/jobs', {
        brief: {
          task: task.trim(),
          skills: skills.split(',').map((s) => s.trim()).filter(Boolean),
          budgetUsd: budget ? Number(budget) : undefined,
          deadlineDays: deadline ? Number(deadline) : undefined,
          location: location.trim() || undefined,
          remoteOk,
          notes: notes.trim() || undefined,
        },
      });
      router.push(`/dashboard/jobs/${job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const field = 'w-full rounded-2xl border border-edge bg-ink/60 px-3.5 py-2 text-sm outline-none placeholder:text-soft/70 focus:border-accent';

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Give your agent <span className="text-accent">hands</span></h1>
        <p className="text-sm text-soft">Describe what you need; the agent searches every connected platform and comes back with a shortlist.</p>
      </div>

      <Panel title="Brief">
        <div className="space-y-4">
          <label className="block text-sm">
            <span className="text-soft">What do you need done?</span>
            <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} className={`${field} mt-1`} placeholder="e.g. Design a 1-page landing site for a token launch" />
          </label>
          <label className="block text-sm">
            <span className="text-soft">Skills (comma-separated)</span>
            <input value={skills} onChange={(e) => setSkills(e.target.value)} className={`${field} mt-1`} placeholder="figma, webflow" />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="text-soft">Budget (USD)</span>
              <input value={budget} onChange={(e) => setBudget(e.target.value)} type="number" min="1" className={`${field} mt-1`} placeholder="200" />
            </label>
            <label className="block text-sm">
              <span className="text-soft">Deadline (days)</span>
              <input value={deadline} onChange={(e) => setDeadline(e.target.value)} type="number" min="1" className={`${field} mt-1`} placeholder="7" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-soft">Location (optional)</span>
            <input value={location} onChange={(e) => setLocation(e.target.value)} className={`${field} mt-1`} placeholder="Singapore" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={remoteOk} onChange={(e) => setRemoteOk(e.target.checked)} className="accent-[var(--color-accent)]" />
            Remote work is fine
          </label>
          <label className="block text-sm">
            <span className="text-soft">Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${field} mt-1`} />
          </label>
          {error && <p className="text-sm text-bad">{error}</p>}
          <button
            onClick={submit}
            disabled={busy || !task.trim()}
            className="w-full rounded-full bg-accent px-4 py-3 text-sm font-bold text-white hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Starting…' : 'Start the agent'}
          </button>
        </div>
      </Panel>
    </div>
  );
}

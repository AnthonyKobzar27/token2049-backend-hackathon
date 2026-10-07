'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLive } from '@/lib/api';
import type { CandidateEntry } from '@/lib/types';
import { CandidateCard } from '@/components/candidate-card';
import { Empty, LiveDot, StatusBadge } from '@/components/ui';

export default function PeoplePage() {
  const { data, connected } = useLive<CandidateEntry[]>('/api/candidates');
  const [query, setQuery] = useState('');

  const entries = (data ?? []).filter((e) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    const p = e.candidate.profile;
    return [p.name, p.headline, p.platform, e.task, ...p.skills].join(' ').toLowerCase().includes(q);
  });

  const byJob = new Map<string, CandidateEntry[]>();
  for (const e of entries) byJob.set(e.jobId, [...(byJob.get(e.jobId) ?? []), e]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">People the agent is <span className="text-accent">looking at</span></h1>
          <p className="text-sm text-soft">Every shortlisted freelancer across your tasks, with why the agent rates them.</p>
        </div>
        <LiveDot connected={connected} />
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by name, skill, platform or task…"
        className="card-shadow w-full rounded-full border border-edge bg-panel px-4 py-2.5 text-sm outline-none placeholder:text-soft/70 focus:border-accent"
      />

      {byJob.size === 0 ? (
        <div className="card-shadow rounded-3xl bg-panel">
          <Empty mascot>No candidates yet. The agent fills this in as it searches.</Empty>
        </div>
      ) : (
        [...byJob.entries()].map(([jobId, list]) => (
          <section key={jobId} className="space-y-3">
            <div className="flex items-center gap-3">
              <Link href={`/dashboard/jobs/${jobId}`} className="truncate font-semibold hover:text-accent">
                {list[0]?.task}
              </Link>
              <StatusBadge status={list[0]?.jobStatus ?? 'running'} />
              <span className="text-xs text-soft">round {list[0]?.round} · {list.length} candidate{list.length === 1 ? '' : 's'}</span>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {list.map((e) => (
                <CandidateCard key={`${jobId}:${e.candidate.profile.id}`} candidate={e.candidate} selected={e.selected} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

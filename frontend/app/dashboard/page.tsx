'use client';

import Link from 'next/link';
import { useLive } from '@/lib/api';
import type { Job, Overview } from '@/lib/types';
import { ActivityFeed, AgentNow } from '@/components/activity-feed';
import { ApprovalsPanel } from '@/components/approvals';
import { WantsToHirePanel } from '@/components/shortlist-panel';
import { Empty, LiveDot, Panel, StatCard, StatusBadge, TimeAgo } from '@/components/ui';

export default function OverviewPage() {
  const { data: jobs, connected, error } = useLive<Job[]>('/api/jobs');
  const { data: overview } = useLive<Overview>('/api/overview');
  const open = (jobs ?? []).filter((j) => j.status === 'running' || j.status === 'awaiting_input' || j.status === 'awaiting_payment');
  const closed = (jobs ?? []).filter((j) => !open.includes(j));
  const awaiting = open.filter((j) => j.status === 'awaiting_input');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight">
            Your agent thinks. <span className="text-accent">These are its hands.</span>
          </h1>
          <p className="mt-1 text-sm font-medium text-soft">
            Open tasks and anything waiting on you. The full record lives in <Link href="/dashboard/history" className="text-accent hover:underline">History</Link>.
          </p>
        </div>
        <LiveDot connected={connected} />
      </div>

      {error && (
        <p className="rounded-2xl bg-peach px-4 py-3 text-sm font-semibold text-bad">
          Cannot reach the agent ({error}). Start it with <code className="rounded bg-panel px-1">pnpm start</code>.
        </p>
      )}

      {overview && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Running tasks" value={overview.jobs.running} tone="bg-lilac" active={overview.jobs.running > 0} />
          <StatCard label="Needs your input" value={overview.jobs.awaitingInput} tone="bg-butter" active={overview.jobs.awaitingInput > 0} />
          <StatCard label="Pending approvals" value={overview.pendingApprovals} tone="bg-peach" active={overview.pendingApprovals > 0} />
          <StatCard label="Open bookings" value={overview.openBookings} tone="bg-mint" active={overview.openBookings > 0} />
        </div>
      )}

      <AgentNow />

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          {awaiting.slice(0, 2).map((job) => (
            <WantsToHirePanel key={job.id} job={job} />
          ))}

          <Panel
            title="Open tasks"
            action={<Link href="/dashboard/new" className="rounded-full bg-accent px-4 py-1.5 text-sm font-bold text-white hover:brightness-110">New task</Link>}
          >
            {open.length === 0 ? (
              <Empty mascot>Nothing in flight. Start a task and watch the agent work.</Empty>
            ) : (
              <ul className="divide-y divide-edge">
                {open.map((job) => (
                  <li key={job.id} className="animate-in">
                    <Link href={`/dashboard/jobs/${job.id}`} className="flex items-center gap-3 rounded-2xl px-2 py-3 hover:bg-ink/60">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{job.brief.task}</p>
                        <p className="text-xs text-soft">
                          {job.round > 1 ? `round ${job.round} · ` : ''}updated <TimeAgo ms={job.updatedAt} />
                        </p>
                      </div>
                      {job.brief.budgetUsd !== undefined && <span className="text-sm font-semibold text-soft">≤ ${job.brief.budgetUsd}</span>}
                      <StatusBadge status={job.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {closed.length > 0 && (
            <Panel title="Finished" action={<Link href="/dashboard/history" className="text-sm font-semibold text-accent hover:underline">Full history</Link>}>
              <ul className="divide-y divide-edge">
                {closed.slice(0, 5).map((job) => (
                  <li key={job.id}>
                    <Link href={`/dashboard/jobs/${job.id}`} className="flex items-center gap-3 rounded-2xl px-2 py-3 hover:bg-ink/60">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{job.brief.task}</p>
                        {job.result?.summary && <p className="truncate text-xs text-soft">{job.result.summary}</p>}
                      </div>
                      <StatusBadge status={job.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <div className="space-y-6 lg:col-span-2">
          <ApprovalsPanel />
          <ActivityFeed />
          {overview && overview.sources.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-2 text-xs font-semibold text-soft">
              <span>Searching across</span>
              {overview.sources.filter((s) => s.enabled).map((s) => (
                <span key={s.name} className="rounded-full bg-panel px-2.5 py-1 shadow-sm">{s.name}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

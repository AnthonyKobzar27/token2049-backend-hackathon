'use client';

import Link from 'next/link';
import { describeEvent, useActivity } from '@/lib/api';
import type { ActivityEntry } from '@/lib/types';
import { Mascot } from './mascot';
import { Empty, LiveDot, Panel, TimeAgo } from './ui';

/** Dot colour per event type so the feed reads at a glance. */
const EVENT_DOT: Record<string, string> = {
  'job.progress': 'bg-accent',
  'job.updated': 'bg-accent',
  'shortlist.ready': 'bg-good',
  'booking.updated': 'bg-good',
  'escrow.updated': 'bg-warn',
  'approval.requested': 'bg-warn',
  'approval.resolved': 'bg-good',
  'conversation.message': 'bg-accent/50',
  'operator.attention': 'bg-bad',
};

export function ActivityFeed({ jobId }: { jobId?: string }) {
  const { entries, connected } = useActivity();
  const visible = (jobId ? entries.filter((e) => describeEvent(e.event).jobId === jobId) : entries).slice().reverse();

  return (
    <Panel title="Activity" action={<LiveDot connected={connected} />}>
      {visible.length === 0 ? (
        <Empty mascot>Nothing yet. Events appear here the moment the agent moves.</Empty>
      ) : (
        <ul className="max-h-[32rem] space-y-3 overflow-y-auto pr-1">
          {visible.map((entry) => {
            const d = describeEvent(entry.event);
            return (
              <li key={entry.seq} className="animate-in flex gap-3 text-sm">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${EVENT_DOT[entry.event.type] ?? 'bg-accent'}`} />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{d.title}</span>
                    <span className="shrink-0 text-xs text-soft"><TimeAgo ms={entry.at} /></span>
                  </div>
                  {d.detail && <p className="truncate text-soft">{d.detail}</p>}
                  {d.jobId && !jobId && !d.jobId.startsWith('intake:') && (
                    <Link href={`/dashboard/jobs/${d.jobId}`} className="text-xs text-accent hover:underline">
                      view task
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** What the agent said while actually working (not chat chatter). */
const isWorkEvent = (e: ActivityEntry) => e.event.type !== 'conversation.message';

/**
 * Hero strip for the overview: the latest thing the agent did, live, with the
 * few moves before it fading out underneath — a readable ticker.
 */
export function AgentNow() {
  const { entries, connected } = useActivity();
  const work = entries.filter(isWorkEvent);
  const latest = work[work.length - 1];
  const prior = work.slice(-4, -1).reverse();
  const working = latest !== undefined;

  return (
    <section className="card-shadow animate-in overflow-hidden rounded-3xl bg-panel">
      <div className="flex items-center gap-4 px-5 py-4">
        <div className="relative shrink-0">
          <Mascot size={48} />
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5">
            {connected && <span className="live-ping absolute h-full w-full rounded-full bg-good" />}
            <span className={`relative h-3.5 w-3.5 rounded-full border-2 border-panel ${connected ? 'bg-good' : 'bg-bad'}`} />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-bold tracking-widest text-accent uppercase ${working ? 'animate-breathe' : ''}`}>
              {working ? 'Agent at work' : 'Agent idle'}
            </span>
            <LiveDot connected={connected} />
          </div>
          {latest ? (
            (() => {
              const d = describeEvent(latest.event);
              return (
                <div key={latest.seq} className="animate-in mt-0.5 min-w-0">
                  <p className="truncate font-display text-lg font-bold">
                    {d.title}
                    {d.detail && <span className="font-body text-sm font-medium text-soft"> — {d.detail}</span>}
                  </p>
                  <p className="text-xs font-semibold text-soft">
                    <TimeAgo ms={latest.at} />
                    {d.jobId && !d.jobId.startsWith('intake:') && (
                      <>
                        {' · '}
                        <Link href={`/dashboard/jobs/${d.jobId}`} className="text-accent hover:underline">view task</Link>
                      </>
                    )}
                  </p>
                </div>
              );
            })()
          ) : (
            <p className="mt-0.5 text-sm font-medium text-soft">
              All quiet. <Link href="/dashboard/new" className="font-bold text-accent hover:underline">Give it a task</Link> and watch this strip light up.
            </p>
          )}
        </div>
      </div>

      {prior.length > 0 && (
        <div className="space-y-1 border-t border-edge bg-ink/40 px-5 py-2.5">
          {prior.map((entry, i) => {
            const d = describeEvent(entry.event);
            return (
              <p key={entry.seq} className="truncate text-xs text-soft" style={{ opacity: 1 - i * 0.28 }}>
                <span className="font-bold">{d.title}</span>
                {d.detail ? ` — ${d.detail}` : ''}
                <span className="font-semibold"> · <TimeAgo ms={entry.at} /></span>
              </p>
            );
          })}
        </div>
      )}
    </section>
  );
}

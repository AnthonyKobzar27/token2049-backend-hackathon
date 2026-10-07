'use client';

import Link from 'next/link';
import { usd, useLive } from '@/lib/api';
import type { History } from '@/lib/types';
import { Empty, LiveDot, Panel, StatusBadge, TimeAgo } from '@/components/ui';

const KIND_STYLE: Record<string, string> = {
  task: 'bg-lilac',
  shortlist: 'bg-lilac',
  hire: 'bg-mint',
  approved: 'bg-mint',
  done: 'bg-mint',
  approval: 'bg-butter',
  denied: 'bg-peach',
  failed: 'bg-peach',
};

const AVATAR_TONES = ['bg-peach', 'bg-mint', 'bg-butter', 'bg-lilac'];

export default function HistoryPage() {
  const { data, connected, error } = useLive<History>('/api/history');
  const hires = data?.hires ?? [];
  const totalUsd = hires.reduce((sum, h) => sum + h.priceUsd, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            What your agent <span className="text-accent">has done</span>
          </h1>
          <p className="mt-1 text-sm font-medium text-soft">Everyone it hired and why, and every step it took along the way.</p>
        </div>
        <LiveDot connected={connected} />
      </div>

      {error && <p className="rounded-2xl bg-peach px-4 py-3 text-sm font-semibold text-bad">Cannot reach the agent ({error}).</p>}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-display text-xl font-bold tracking-tight">People hired</h2>
          {hires.length > 0 && (
            <span className="rounded-full bg-mint px-3 py-1 text-xs font-bold text-good">
              {hires.length} hire{hires.length === 1 ? '' : 's'} · {usd(totalUsd)} committed
            </span>
          )}
        </div>

        {hires.length === 0 ? (
          <div className="card-shadow rounded-3xl bg-panel">
            <Empty mascot>Nobody hired yet. When the agent books someone, they show up here with its reasoning.</Empty>
          </div>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {hires.map((h, i) => (
              <li key={h.bookingId} className="card-shadow animate-in flex flex-col rounded-3xl border border-edge bg-panel p-5">
                <div className="flex items-start gap-3">
                  <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-display text-lg font-bold ${AVATAR_TONES[i % AVATAR_TONES.length]}`}>
                    {h.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {h.url ? (
                        <a href={h.url} target="_blank" rel="noreferrer" className="truncate font-display text-lg font-bold hover:text-accent">{h.name}</a>
                      ) : (
                        <span className="truncate font-display text-lg font-bold">{h.name}</span>
                      )}
                      <span className="rounded-full bg-lilac px-2 py-0.5 text-xs font-semibold">{h.platform}</span>
                      <StatusBadge status={h.status} />
                    </div>
                    {h.headline && <p className="truncate text-sm text-soft">{h.headline}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-display text-xl font-bold text-accent">{usd(h.priceUsd)}</div>
                    {h.score !== undefined && <div className="text-xs font-bold text-soft">{h.score}/100 match</div>}
                  </div>
                </div>

                {h.reason && (
                  <p className="mt-3 rounded-2xl bg-ink/60 px-3.5 py-2.5 text-sm italic">
                    <span className="font-bold text-soft not-italic">Why: </span>“{h.reason}”
                  </p>
                )}

                <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-3 text-xs font-semibold text-soft">
                  {h.rating !== undefined && <span>★ {h.rating.toFixed(1)}{h.reviewCount !== undefined ? ` (${h.reviewCount})` : ''}</span>}
                  <span>hired <TimeAgo ms={h.hiredAt} /></span>
                  {h.task && (
                    <Link href={`/dashboard/jobs/${h.jobId}`} className="truncate text-accent hover:underline">for “{h.task}”</Link>
                  )}
                  {h.url && (
                    <a href={h.url} target="_blank" rel="noreferrer" className="ml-auto text-accent hover:underline">profile ↗</a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Panel title="Action log" action={data && data.events.length > 0 ? <span className="text-xs font-semibold text-soft">{data.events.length} steps</span> : undefined}>
        {!data || data.events.length === 0 ? (
          <Empty mascot>No actions yet. Every step the agent takes lands here, newest first.</Empty>
        ) : (
          <ul className="relative ml-3 space-y-4 border-l-2 border-edge pl-6">
            {data.events.map((e, i) => (
              <li key={`${e.at}-${i}`} className="animate-in relative">
                <span className={`absolute top-1 -left-[1.95rem] h-4 w-4 rounded-full border-2 border-panel ${KIND_STYLE[e.kind] ?? 'bg-edge'}`} />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-semibold">{e.title}</span>
                  <span className="text-xs text-soft"><TimeAgo ms={e.at} /></span>
                </div>
                {e.detail && <p className="text-sm text-soft">{e.detail}</p>}
                {e.task && e.jobId && (
                  <Link href={`/dashboard/jobs/${e.jobId}`} className="text-xs font-semibold text-accent hover:underline">{e.task}</Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

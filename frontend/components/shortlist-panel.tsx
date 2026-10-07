'use client';

// Overview panel for a job that is awaiting_input: the shortlist the agent
// came back with, one row per candidate, bookable right here. Fetches the job
// detail with a plain request keyed on job.updatedAt (the jobs list above it
// is already live over SSE) so it does not burn another EventSource slot.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, post, usd } from '@/lib/api';
import type { Job, JobDetail } from '@/lib/types';
import { StatusBadge, TimeAgo } from './ui';

export function WantsToHirePanel({ job }: { job: Job }) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<JobDetail>(`/api/jobs/${job.id}`)
      .then((d) => alive && setDetail(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [job.id, job.updatedAt]);

  const shortlist = detail?.shortlist;
  if (!shortlist || shortlist.candidates.length === 0) return null;

  const sendInput = async (input: { action: 'confirm'; profileId: string } | { action: 'refine'; feedback: string }) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/jobs/${job.id}/input`, input);
      if (input.action === 'refine') setFeedback('');
      // The jobs list refreshes over SSE; this panel re-fetches on updatedAt.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card-shadow animate-in rounded-3xl bg-panel ring-2 ring-warn/30">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-1">
        <h2 className="font-display text-lg font-bold tracking-tight">
          Wants to hire <span className="text-warn">· your pick</span>
        </h2>
        <StatusBadge status="awaiting_input" />
      </div>
      <div className="p-5 pt-2">
        <p className="truncate text-sm font-semibold text-soft">
          for <Link href={`/dashboard/jobs/${job.id}`} className="text-accent hover:underline">{job.brief.task}</Link>
          {' · '}round {shortlist.round} · <TimeAgo ms={shortlist.createdAt} />
        </p>

        {error && <p className="mt-2 rounded-xl bg-peach px-3 py-2 text-sm font-semibold text-bad">{error}</p>}

        <ul className="mt-3 space-y-3">
          {shortlist.candidates.map((c) => {
            const p = c.profile;
            const pricing = c.pricingIndex !== undefined ? p.pricing[c.pricingIndex] : p.pricing[0];
            const price = c.quoteUsd ?? pricing?.amountUsd;
            return (
              <li key={p.id} className="rounded-2xl bg-ink/60 p-4">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent font-display text-sm font-bold text-white">
                    {Math.round(c.score)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <a href={p.url} target="_blank" rel="noreferrer" className="truncate font-bold hover:text-accent">{p.name}</a>
                      <span className="shrink-0 rounded-full bg-lilac px-2 py-0.5 text-xs font-semibold">{p.platform}</span>
                      {p.rating !== undefined && <span className="shrink-0 text-xs font-semibold text-soft">★ {p.rating.toFixed(1)}</span>}
                    </div>
                    {p.headline && <p className="truncate text-xs text-soft">{p.headline}</p>}
                  </div>
                  {price !== undefined && (
                    <span className="shrink-0 font-display text-lg font-bold text-accent">
                      {usd(price)}
                      {pricing?.kind === 'hourly' && c.quoteUsd === undefined ? <span className="text-xs font-semibold text-soft">/h</span> : null}
                    </span>
                  )}
                </div>
                {c.reason && <p className="mt-2 text-sm text-soft italic">“{c.reason}”</p>}
                <button
                  onClick={() => sendInput({ action: 'confirm', profileId: p.id })}
                  disabled={busy}
                  className="mt-2.5 rounded-full bg-accent px-4 py-1.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-50"
                >
                  Book {p.name.split(' ')[0]}{price !== undefined ? ` · ${usd(price)}` : ''}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-3 flex gap-2">
          <input
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && feedback.trim() && sendInput({ action: 'refine', feedback: feedback.trim() })}
            placeholder="None of these? Tell it what to look for instead…"
            className="min-w-0 flex-1 rounded-full border border-edge bg-ink/60 px-4 py-2 text-sm outline-none placeholder:text-soft/70 focus:border-accent"
          />
          <button
            onClick={() => sendInput({ action: 'refine', feedback: feedback.trim() })}
            disabled={busy || !feedback.trim()}
            className="shrink-0 rounded-full bg-lilac px-4 py-1.5 text-sm font-bold text-accent hover:brightness-95 disabled:opacity-50"
          >
            Refine
          </button>
        </div>
      </div>
    </section>
  );
}

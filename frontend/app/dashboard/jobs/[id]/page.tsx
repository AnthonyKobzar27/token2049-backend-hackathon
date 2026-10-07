'use client';

import { use, useState } from 'react';
import { post, usd, useLive } from '@/lib/api';
import type { JobDetail } from '@/lib/types';
import { ActivityFeed } from '@/components/activity-feed';
import { CandidateCard } from '@/components/candidate-card';
import { Empty, Panel, StatusBadge, TimeAgo } from '@/components/ui';

/** Chat bubble style and label per sender; you sit on the right. */
const BUBBLE: Record<string, string> = {
  hirer: 'ml-auto bg-lilac',
  operator: 'ml-auto bg-butter',
  agent: 'bg-ink/60',
  freelancer: 'bg-mint',
};
const SENDER_LABEL: Record<string, string> = {
  hirer: 'you',
  operator: 'operator',
  agent: 'agent',
  freelancer: 'freelancer',
};

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, refresh } = useLive<JobDetail>(`/api/jobs/${id}`);
  const [draft, setDraft] = useState('');
  const [refineDraft, setRefineDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!data) return <p className="text-sm text-soft">Loading…</p>;

  const { job, shortlist, bookings, escrows, messages } = data;
  const canAct = job.status === 'awaiting_input';

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pick = (profileId: string) => act(() => post(`/api/jobs/${job.id}/input`, { action: 'confirm', profileId }));
  const refine = () =>
    act(async () => {
      if (!refineDraft.trim()) return;
      await post(`/api/jobs/${job.id}/input`, { action: 'refine', feedback: refineDraft.trim() });
      setRefineDraft('');
    });
  const cancel = () => act(() => post(`/api/jobs/${job.id}/input`, { action: 'cancel' }));
  const send = () =>
    act(async () => {
      if (!draft.trim()) return;
      await post(`/api/jobs/${job.id}/message`, { text: draft.trim() });
      setDraft('');
    });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-3xl font-bold tracking-tight">{job.brief.task}</h1>
          <p className="mt-1 text-sm text-soft">
            <span className="font-mono">{job.id}</span> · round {job.round} · updated <TimeAgo ms={job.updatedAt} />
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={job.status} />
          {canAct && (
            <button onClick={cancel} disabled={busy} className="rounded-full bg-peach px-4 py-1.5 text-sm font-bold text-bad hover:brightness-95 disabled:opacity-50">
              Cancel task
            </button>
          )}
        </div>
      </div>

      {actionError && <p className="rounded-2xl bg-peach px-4 py-2.5 text-sm font-semibold text-bad">{actionError}</p>}
      {job.error && <p className="rounded-2xl bg-peach px-4 py-2.5 text-sm font-semibold text-bad">{job.error}</p>}
      {job.result && (
        <p className="rounded-2xl bg-mint px-4 py-2.5 text-sm font-semibold text-good">
          {job.result.summary}{' '}
          {job.result.bookingUrl && (
            <a href={job.result.bookingUrl} target="_blank" rel="noreferrer" className="underline">Open booking</a>
          )}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Panel title={`Candidates${shortlist ? ` · round ${shortlist.round}` : ''}`}>
            {!shortlist || shortlist.candidates.length === 0 ? (
              <Empty mascot>
                {job.status === 'running' ? 'The agent is out searching the platforms…' : 'No candidates yet.'}
              </Empty>
            ) : (
              <div className="space-y-4">
                {shortlist.sources.length > 0 && (
                  <p className="text-xs text-soft">
                    Sources: {shortlist.sources.map((s) => `${s.source}${s.ok ? ` (${s.count})` : ' (unavailable)'}`).join(' · ')}
                  </p>
                )}
                {shortlist.candidates.map((c) => (
                  <CandidateCard
                    key={c.profile.id}
                    candidate={c}
                    selected={job.selectedProfileId === c.profile.id}
                    action={
                      canAct ? (
                        <button
                          onClick={() => pick(c.profile.id)}
                          disabled={busy}
                          className="rounded-full bg-accent px-4 py-2 text-sm font-bold text-white hover:brightness-110 disabled:opacity-50"
                        >
                          Book {c.profile.name}{c.quoteUsd !== undefined ? ` · ${usd(c.quoteUsd)}` : ''}
                        </button>
                      ) : undefined
                    }
                  />
                ))}
                {canAct && (
                  <div className="flex gap-2 rounded-2xl bg-ink/60 p-3">
                    <input
                      value={refineDraft}
                      onChange={(e) => setRefineDraft(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && refine()}
                      placeholder="None of these? Tell the agent what to change…"
                      className="min-w-0 flex-1 rounded-full border border-edge bg-panel px-4 py-2 text-sm outline-none placeholder:text-soft/70 focus:border-accent"
                    />
                    <button
                      onClick={refine}
                      disabled={busy || !refineDraft.trim()}
                      className="shrink-0 rounded-full bg-lilac px-4 py-1.5 text-sm font-bold text-accent hover:brightness-95 disabled:opacity-50"
                    >
                      Refine search
                    </button>
                  </div>
                )}
              </div>
            )}
          </Panel>

          {bookings.length > 0 && (
            <Panel title="Booking">
              <ul className="space-y-3">
                {bookings.map((b) => {
                  const escrow = escrows.find((e) => e.bookingId === b.id);
                  return (
                    <li key={b.id} className="rounded-2xl bg-ink/60 p-4 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-soft">{b.id}</span>
                        <StatusBadge status={b.status} />
                      </div>
                      <p className="mt-1">
                        {b.platform} · {usd(b.priceUsd)}
                        {b.url && (
                          <>
                            {' · '}
                            <a href={b.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">open on platform</a>
                          </>
                        )}
                      </p>
                      {b.note && <p className="mt-1 text-soft">{b.note}</p>}
                      {escrow && escrow.status === 'awaiting_deposit' && escrow.payUrl ? (
                        <div className="animate-in mt-2 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-butter px-4 py-3">
                          <div>
                            <p className="font-bold">Escrow is waiting on your deposit</p>
                            <p className="text-xs font-semibold text-soft">
                              {escrow.amount} {escrow.currency} · held until you approve the work
                            </p>
                          </div>
                          <a
                            href={escrow.payUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 rounded-full bg-accent px-5 py-2.5 font-display text-sm font-bold text-white hover:brightness-110"
                          >
                            Fund escrow · {escrow.amount} {escrow.currency}
                          </a>
                        </div>
                      ) : (
                        escrow && (
                          <p className="mt-1 text-soft">
                            Escrow {escrow.status.replaceAll('_', ' ')}: {escrow.amount} {escrow.currency}
                            {escrow.explorerUrl && (
                              <>
                                {' · '}
                                <a href={escrow.explorerUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">transaction</a>
                              </>
                            )}
                          </p>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}

          <Panel title="Conversation">
            {messages.length === 0 ? (
              <Empty mascot>No messages on this task yet. The agent, the freelancer and you all talk here.</Empty>
            ) : (
              <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
                {messages.map((m) => (
                  <li key={m.id} className={`animate-in max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${BUBBLE[m.from] ?? 'bg-ink/60'}`}>
                    <p className="flex items-baseline gap-1.5 text-xs font-semibold text-soft">
                      {SENDER_LABEL[m.from] ?? m.from}
                      {m.thread === 'freelancer' && (
                        <span className="rounded-full bg-panel/80 px-1.5 py-px text-[10px] font-bold">freelancer thread</span>
                      )}
                      · <TimeAgo ms={m.createdAt} />
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap">{m.text}</p>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                placeholder={canAct ? 'Reply — your message is used to refine the search' : 'Message the agent about this task'}
                className="flex-1 rounded-full border border-edge bg-ink/60 px-4 py-2 text-sm outline-none placeholder:text-soft/70 focus:border-accent"
              />
              <button onClick={send} disabled={busy || !draft.trim()} className="rounded-full bg-accent px-5 py-2 text-sm font-bold text-white hover:brightness-110 disabled:opacity-50">
                Send
              </button>
            </div>
          </Panel>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Panel title="Brief">
            <dl className="space-y-2 text-sm">
              {([
                ['Budget', job.brief.budgetUsd !== undefined ? usd(job.brief.budgetUsd) : undefined],
                ['Deadline', job.brief.deadlineDays !== undefined ? `${job.brief.deadlineDays} days` : undefined],
                ['Location', job.brief.location],
                ['Remote', job.brief.remoteOk ? 'yes' : 'must be on site'],
                ['Hours', job.brief.hoursNeeded !== undefined ? `${job.brief.hoursNeeded}h` : undefined],
                ['Language', job.brief.language],
                ['Notes', job.brief.notes],
              ] as const).map(([label, value]) =>
                value === undefined ? null : (
                  <div key={label} className="flex justify-between gap-4">
                    <dt className="text-soft">{label}</dt>
                    <dd className="text-right">{value}</dd>
                  </div>
                ),
              )}
              {job.brief.skills.length > 0 && (
                <div>
                  <dt className="text-soft">Skills</dt>
                  <dd className="mt-1 flex flex-wrap gap-1">
                    {job.brief.skills.map((s, i) => (
                      <span key={s} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${['bg-peach', 'bg-mint', 'bg-butter', 'bg-lilac'][i % 4]}`}>{s}</span>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </Panel>
          <ActivityFeed jobId={job.id} />
        </div>
      </div>
    </div>
  );
}

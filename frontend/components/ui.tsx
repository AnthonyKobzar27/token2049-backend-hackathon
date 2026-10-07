'use client';

import { timeAgo } from '@/lib/api';
import type { BookingStatus, JobStatus } from '@/lib/types';
import { useEffect, useState } from 'react';
import { Mascot } from './mascot';

const STATUS_STYLE: Record<string, string> = {
  running: 'bg-accent/15 text-accent',
  awaiting_input: 'bg-warn/15 text-warn',
  awaiting_payment: 'bg-warn/15 text-warn',
  awaiting_approval: 'bg-warn/15 text-warn',
  pending_escrow: 'bg-warn/15 text-warn',
  pending: 'bg-warn/15 text-warn',
  completed: 'bg-good/15 text-good',
  placed: 'bg-good/15 text-good',
  delivered: 'bg-good/15 text-good',
  escrowed: 'bg-good/15 text-good',
  approved: 'bg-good/15 text-good',
  failed: 'bg-bad/15 text-bad',
  cancelled: 'bg-bad/15 text-bad',
  refunded: 'bg-bad/15 text-bad',
  denied: 'bg-bad/15 text-bad',
  expired: 'bg-soft/15 text-soft',
  handoff: 'bg-accent/15 text-accent',
  in_progress: 'bg-accent/15 text-accent',
  in_revision: 'bg-warn/15 text-warn',
};

export function StatusBadge({ status }: { status: JobStatus | BookingStatus | string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_STYLE[status] ?? 'bg-soft/15 text-soft'}`}>
      {status.replaceAll('_', ' ')}
    </span>
  );
}

export function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card-shadow rounded-3xl bg-panel">
      <div className="flex items-center justify-between px-5 pt-4 pb-1">
        <h2 className="font-display text-lg font-bold tracking-tight">{title}</h2>
        {action}
      </div>
      <div className="p-5 pt-3">{children}</div>
    </section>
  );
}

export function Empty({ children, mascot = false }: { children: React.ReactNode; mascot?: boolean }) {
  if (!mascot) return <p className="py-6 text-center text-sm text-soft">{children}</p>;
  return (
    <div className="flex flex-col items-center gap-2.5 py-8 text-center">
      <span className="opacity-70 saturate-[0.85]">
        <Mascot size={46} />
      </span>
      <p className="max-w-xs text-sm font-medium text-soft">{children}</p>
    </div>
  );
}

/** Re-renders every 30s so "2m ago" stays honest. Renders nothing until mounted (avoids hydration drift). */
export function TimeAgo({ ms }: { ms: number }) {
  const [, setTick] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return <span suppressHydrationWarning>{mounted ? timeAgo(ms) : ''}</span>;
}

export function LiveDot({ connected }: { connected: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-semibold text-soft">
      <span className="relative flex h-2 w-2">
        {connected && <span className="live-ping absolute inline-flex h-full w-full rounded-full bg-good" />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${connected ? 'bg-good' : 'bg-bad'}`} />
      </span>
      {connected ? 'live' : 'reconnecting'}
    </span>
  );
}

/** Compact pastel stat card for the overview strip. */
export function StatCard({
  label,
  value,
  tone = 'bg-lilac',
  active = false,
}: {
  label: string;
  value: number | string;
  tone?: string;
  active?: boolean;
}) {
  return (
    <div className={`card-shadow rounded-3xl px-5 py-4 ${tone} ${active ? 'ring-2 ring-accent/50' : ''}`}>
      <div className="font-display text-3xl leading-none font-bold">{value}</div>
      <div className="mt-1.5 text-[11px] font-bold tracking-wide text-bright/60 uppercase">{label}</div>
    </div>
  );
}

export function ScoreBar({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 text-soft">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-edge">
        {value !== null && <div className="h-full rounded bg-accent" style={{ width: `${Math.round(value * 100)}%` }} />}
      </div>
      <span className="w-8 text-right text-soft">{value === null ? '—' : Math.round(value * 100)}</span>
    </div>
  );
}

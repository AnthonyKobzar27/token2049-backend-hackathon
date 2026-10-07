'use client';

// Thin client for the HAAS dashboard API (src/api/dashboard.ts). All pages are
// client-rendered: data is local and live, so there is nothing to render ahead.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityEntry, HaasEvent } from './types';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const post = <T,>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });

/**
 * Fetches `path` once, then refetches whenever the backend emits an event
 * (debounced) and every `intervalMs` as a safety net while connected.
 */
export function useLive<T>(path: string, intervalMs = 15_000): {
  data: T | null;
  error: string | null;
  connected: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    api<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [path]);

  useEffect(() => {
    refresh();
    const source = new EventSource(`${API_URL}/api/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(refresh, 250);
    };
    const interval = setInterval(refresh, intervalMs);
    return () => {
      source.close();
      clearInterval(interval);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh, intervalMs]);

  return { data, error, connected, refresh };
}

/** Streams the activity feed: replayed buffer first, then live events. */
export function useActivity(limit = 100): { entries: ActivityEntry[]; connected: boolean } {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (msg) => {
      const entry = JSON.parse(msg.data) as ActivityEntry;
      setEntries((prev) => {
        if (prev.some((e) => e.seq === entry.seq)) return prev;
        return [...prev, entry].slice(-limit);
      });
    };
    return () => source.close();
  }, [limit]);

  return { entries, connected };
}

// ------------------------------------------------------------- formatting

export const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** One human line per event, for the activity feed. */
export function describeEvent(event: HaasEvent): { title: string; detail?: string; jobId?: string } {
  switch (event.type) {
    case 'job.updated':
      return { title: `Job ${event.job.status.replace('_', ' ')}`, detail: event.job.brief.task, jobId: event.job.id };
    case 'job.progress':
      return { title: 'Working', detail: event.message, jobId: event.jobId };
    case 'shortlist.ready':
      return {
        title: `Shortlist ready · ${event.shortlist.candidates.length} candidate${event.shortlist.candidates.length === 1 ? '' : 's'}`,
        detail: event.job.brief.task,
        jobId: event.job.id,
      };
    case 'booking.updated':
      return { title: `Booking ${event.booking.status.replace('_', ' ')}`, detail: `${event.booking.platform} · ${usd(event.booking.priceUsd)}`, jobId: event.booking.jobId };
    case 'escrow.updated':
      return { title: `Escrow ${event.escrow.status.replace('_', ' ')}`, detail: `${event.escrow.amount} ${event.escrow.currency}` };
    case 'approval.requested':
      return { title: 'Approval needed', detail: event.approval.summary, jobId: event.approval.jobId };
    case 'approval.resolved':
      return { title: `Approval ${event.approval.status}`, detail: event.approval.summary, jobId: event.approval.jobId };
    case 'conversation.message':
      return { title: `Message from ${event.message.from}`, detail: event.message.text, jobId: event.message.jobId };
    case 'operator.attention':
      return { title: `Needs you · ${event.source}`, detail: event.message };
    default:
      return { title: 'Event' };
  }
}

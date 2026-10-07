'use client';

import { useState } from 'react';
import { post, useLive } from '@/lib/api';
import type { Approval } from '@/lib/types';
import { Empty, Panel, TimeAgo } from './ui';

export function ApprovalsPanel() {
  const { data, refresh } = useLive<Approval[]>('/api/approvals?status=pending');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (id: string, approved: boolean) => {
    setBusy(id);
    setError(null);
    try {
      await post(`/api/approvals/${id}/decide`, { approved, by: 'dashboard' });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const pending = data ?? [];
  return (
    <Panel
      title="Approvals"
      action={
        pending.length > 0 ? (
          <span className="animate-breathe rounded-full bg-warn/15 px-2.5 py-0.5 text-xs font-bold text-warn">
            {pending.length} pending
          </span>
        ) : undefined
      }
    >
      {error && <p className="mb-2 text-sm text-bad">{error}</p>}
      {pending.length === 0 ? (
        <Empty mascot>No approvals waiting on you. The agent asks before it spends.</Empty>
      ) : (
        <ul className="space-y-3">
          {pending.map((a) => (
            <li key={a.id} className="animate-in rounded-2xl bg-ink/60 p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{a.action.replaceAll('_', ' ')}</span>
                <span className="text-xs text-soft"><TimeAgo ms={a.createdAt} /></span>
              </div>
              <p className="mt-1 text-sm text-soft">{a.summary}</p>
              {a.detail && <p className="mt-1 text-xs text-soft">{a.detail}</p>}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => decide(a.id, true)}
                  disabled={busy === a.id}
                  className="rounded-full bg-mint px-4 py-1.5 text-sm font-bold text-good hover:brightness-95 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  onClick={() => decide(a.id, false)}
                  disabled={busy === a.id}
                  className="rounded-full bg-peach px-4 py-1.5 text-sm font-bold text-bad hover:brightness-95 disabled:opacity-50"
                >
                  Deny
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

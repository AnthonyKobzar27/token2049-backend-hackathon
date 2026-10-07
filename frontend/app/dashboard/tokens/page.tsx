'use client';

import { useState } from 'react';
import { API_URL, post, useLive } from '@/lib/api';
import type { TokenInfo } from '@/lib/types';
import { Empty, Panel, TimeAgo } from '@/components/ui';

function claudeSnippet(secret: string): string {
  return [
    'You can hire real people for me through HumanRouter, my human-in-the-loop service.',
    `Base URL: ${API_URL}`,
    `Send every request with the header: Authorization: Bearer ${secret}`,
    '',
    'POST /api/jobs            {"brief":{"task":"...","budgetUsd":200}}   start a task',
    'GET  /api/jobs            list my tasks and their statuses',
    'GET  /api/jobs/{id}       one task: shortlist, candidates, reasons',
    'POST /api/jobs/{id}/input {"action":"confirm","profileId":"..."}    book a candidate',
    'POST /api/jobs/{id}/input {"action":"refine","feedback":"..."}      ask for different people',
    'GET  /api/history         who was hired and why',
  ].join('\n');
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded-full bg-accent px-4 py-1.5 text-sm font-bold text-white hover:brightness-110"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

export default function TokensPage() {
  const { data: tokens, refresh } = useLive<TokenInfo[]>('/api/tokens');
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<TokenInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      setMinted(await post<TokenInfo>('/api/tokens', { name: name.trim() || 'my claude' }));
      setName('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await post(`/api/tokens/${id}/revoke`, {});
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Plug this into <span className="text-accent">your Claude</span>
        </h1>
        <p className="mt-1 text-sm font-medium text-soft">
          Mint a token, hand it to your Claude, and it can hire real people through this agent — start tasks, read shortlists, book candidates.
        </p>
      </div>

      {error && <p className="rounded-2xl bg-peach px-4 py-2.5 text-sm font-semibold text-bad">{error}</p>}

      <Panel title="Mint a token">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && mint()}
            placeholder="Name it, e.g. “Claude Desktop” or “work laptop”"
            className="flex-1 rounded-full border border-edge bg-ink/60 px-4 py-2 text-sm outline-none placeholder:text-soft/70 focus:border-accent"
          />
          <button onClick={mint} disabled={busy} className="rounded-full bg-accent px-5 py-2 text-sm font-bold text-white hover:brightness-110 disabled:opacity-50">
            Mint token
          </button>
        </div>

        {minted?.secret && (
          <div className="mt-4 space-y-3 rounded-2xl bg-butter p-4">
            <p className="text-sm font-bold">
              Here is your token — copy it now, it is shown only once.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-xl bg-panel px-3 py-2 text-xs">{minted.secret}</code>
              <CopyButton text={minted.secret} />
            </div>
            <p className="text-sm font-bold">Then paste this into your Claude (a message, or CLAUDE.md):</p>
            <div className="flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl bg-panel px-3 py-2 text-xs leading-relaxed">{claudeSnippet(minted.secret)}</pre>
              <CopyButton text={claudeSnippet(minted.secret)} />
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Your tokens">
        {!tokens || tokens.length === 0 ? (
          <Empty>No tokens yet. Mint one above to connect a Claude.</Empty>
        ) : (
          <ul className="divide-y divide-edge">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-1 py-3">
                <div className="min-w-0 flex-1">
                  <p className={`font-semibold ${t.revoked ? 'text-soft line-through' : ''}`}>{t.name}</p>
                  <p className="text-xs text-soft">
                    <code>{t.prefix}…</code> · minted <TimeAgo ms={t.createdAt} />
                    {t.lastUsedAt ? <> · last used <TimeAgo ms={t.lastUsedAt} /></> : ' · never used'}
                  </p>
                </div>
                {t.revoked ? (
                  <span className="rounded-full bg-edge px-3 py-1 text-xs font-semibold text-soft">revoked</span>
                ) : (
                  <button onClick={() => revoke(t.id)} className="rounded-full bg-peach px-4 py-1.5 text-sm font-bold text-bad hover:brightness-95">
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

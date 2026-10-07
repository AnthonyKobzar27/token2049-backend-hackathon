'use client';

import { usd } from '@/lib/api';
import type { Candidate } from '@/lib/types';
import { ScoreBar } from './ui';

export function CandidateCard({
  candidate,
  selected,
  action,
}: {
  candidate: Candidate;
  selected?: boolean;
  action?: React.ReactNode;
}) {
  const p = candidate.profile;
  const pricing = candidate.pricingIndex !== undefined ? p.pricing[candidate.pricingIndex] : p.pricing[0];
  return (
    <div className={`card-shadow rounded-3xl border bg-panel p-5 ${selected ? 'border-good' : 'border-edge'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <a href={p.url} target="_blank" rel="noreferrer" className="truncate font-semibold hover:text-accent">
              {p.name}
            </a>
            <span className="rounded-full bg-lilac px-2 py-0.5 text-xs font-semibold">{p.platform}</span>
            {selected && <span className="rounded-full bg-mint px-2 py-0.5 text-xs font-semibold text-good">selected</span>}
          </div>
          {p.headline && <p className="mt-0.5 truncate text-sm text-soft">{p.headline}</p>}
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-accent">{Math.round(candidate.score)}</div>
          <div className="text-xs text-soft">score</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-soft">
        {candidate.quoteUsd !== undefined && <span className="text-bright">{usd(candidate.quoteUsd)} quote</span>}
        {pricing && <span>{pricing.kind === 'hourly' ? `${usd(pricing.amountUsd)}/h` : usd(pricing.amountUsd)}{pricing.label ? ` · ${pricing.label}` : ''}</span>}
        {p.rating !== undefined && <span>★ {p.rating.toFixed(1)}{p.reviewCount !== undefined ? ` (${p.reviewCount})` : ''}</span>}
        {pricing?.deliveryDays !== undefined && <span>{pricing.deliveryDays}d delivery</span>}
        {(p.city || p.country) && <span>{[p.city, p.country].filter(Boolean).join(', ')}</span>}
        {p.level && <span>{p.level}</span>}
      </div>

      {candidate.reason && <p className="mt-2 text-sm italic text-soft">“{candidate.reason}”</p>}

      <div className="mt-3 space-y-1">
        <ScoreBar label="fit" value={candidate.subscores.suitability} />
        <ScoreBar label="price" value={candidate.subscores.price} />
        <ScoreBar label="rating" value={candidate.subscores.rating} />
        <ScoreBar label="speed" value={candidate.subscores.speed} />
      </div>

      {p.skills.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {p.skills.slice(0, 8).map((skill, i) => (
            <span key={skill} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${['bg-peach', 'bg-mint', 'bg-butter', 'bg-lilac'][i % 4]}`}>{skill}</span>
          ))}
        </div>
      )}

      {candidate.unknowns.length > 0 && (
        <p className="mt-2 text-xs text-soft">Not published: {candidate.unknowns.join(', ')}</p>
      )}

      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

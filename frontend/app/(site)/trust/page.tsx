import { Cta, Eyebrow, Headline, Lead, Section, StepCard } from '@/components/site';

const wont = [
  'Spend a cent without an approval — every booking and payment passes the gate first.',
  'Write to a freelancer first — the agent replies, it never cold-messages on your behalf.',
  'Invent facts, prices or deadlines in your name — unknowns get escalated to you.',
  'Finish a card payment itself — when a platform needs a card, you get a handoff link.',
];

export default function TrustPage() {
  return (
    <>
      <Section className="pt-16">
        <Eyebrow>Trust and safety</Eyebrow>
        <Headline>
          Built so you can
          <br />
          trust a stranger
        </Headline>
        <Lead>
          Hiring a person you have never met, picked by software, with your money — only works when every
          step is held by something stronger than good intentions.
        </Lead>
      </Section>

      <Section className="mt-16">
        <Headline className="text-3xl">Where your money is</Headline>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <StepCard n={1} title="Locked">
            Your budget moves into on-chain escrow before anyone is booked. Not the freelancer&apos;s, not
            ours — locked.
          </StepCard>
          <StepCard n={2} title="Checked">
            Delivery comes to you. Accept it, request a revision, or reject it — the agent cannot accept
            on your behalf.
          </StepCard>
          <StepCard n={3} title="Released or refunded">
            Acceptance releases escrow to the worker. Rejection after the fix-round refunds you. Every
            transaction has an explorer link.
          </StepCard>
        </div>
      </Section>

      <Section className="mt-16">
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <div className="glass rounded-3xl p-8">
            <h3 className="font-display text-xl font-bold text-creamtext">Identity and record</h3>
            <p className="mt-2 text-sm font-medium leading-relaxed text-lavmute">
              Candidates come from platforms with verified profiles, ratings and review history — and
              every hire adds to a record you can audit: who was hired, for how much, why, and how it
              ended. Nothing is ever deleted from the history.
            </p>
          </div>
          <div className="glass rounded-3xl bg-black/25 p-8">
            <h3 className="font-display text-xl font-bold text-creamtext">What we will not do</h3>
            <ul className="mt-3 space-y-2.5 text-sm font-medium leading-relaxed text-lavmute">
              {wont.map((w) => (
                <li key={w} className="flex gap-2.5">
                  <span aria-hidden className="text-lav/50">—</span>
                  {w}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section className="mt-16">
        <Headline className="text-3xl">If something goes wrong</Headline>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <StepCard title="One chance to fix it">
            A delivery you reject goes back for one revision round with your notes, on the original
            price.
          </StepCard>
          <StepCard title="Automatic refund">
            No delivery, failed booking, or a revision that still misses — escrow returns to your wallet.
          </StepCard>
          <StepCard title="You decide">
            Pause the agent on any booking with one tap. While paused, nothing moves without your word.
          </StepCard>
        </div>
        <div className="mt-10">
          <Cta href="/try">Try the agent</Cta>
        </div>
      </Section>
    </>
  );
}

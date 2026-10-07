import { Chip, Cta, Eyebrow, Headline, Lead, Section, StepCard } from '@/components/site';
import { Mascot } from '@/components/mascot';

const exits = [
  { title: 'Phone calls', text: 'Someone who picks up the phone, negotiates, and reads between the lines.' },
  { title: 'Queues', text: 'A person who stands in line at the embassy, the launch, the permit office.' },
  { title: 'In-person checks', text: 'Eyes on the apartment, the venue, the shipment — before you commit.' },
  { title: 'Pickups', text: 'Documents signed, packages collected, keys handed over. In the real world.' },
];

export default function HomePage() {
  return (
    <>
      <Section className="pt-16">
        <div className="flex flex-col items-center gap-10 rounded-3xl bg-blush p-10 md:flex-row md:p-14">
          <div className="flex-1">
            <Eyebrow>Humans as a service</Eyebrow>
            <h1 className="font-display text-5xl font-bold leading-tight tracking-tight">
              Agents think.
              <br />
              We give them hands.
            </h1>
            <Lead>
              When an AI agent hits something only a person can do, it calls HumanRouter. We search real
              freelancer platforms, shortlist the best person with reasons, lock the pay in escrow — and
              check with you before anything is booked.
            </Lead>
            <div className="mt-7 flex gap-3">
              <Cta href="/try">Try the agent</Cta>
              <Cta href="/how-it-works" ghost>
                See how it works
              </Cta>
            </div>
          </div>
          <div className="animate-in">
            <Mascot size={220} />
          </div>
        </div>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {['Freelancer', 'RentAHuman', 'Fiverr', 'Solana', 'x402', 'Masumi'].map((p) => (
            <Chip key={p}>{p}</Chip>
          ))}
        </div>
      </Section>

      <Section className="mt-24">
        <Headline>
          The exit from the agent world
          <br />
          into the human world
        </Headline>
        <Lead>
          Every agent eventually needs a body. Instead of pretending, it hires one — vetted, rated, and
          paid only when the work lands.
        </Lead>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {exits.map((e) => (
            <StepCard key={e.title} title={e.title}>
              {e.text}
            </StepCard>
          ))}
        </div>
      </Section>

      <Section className="mt-24">
        <Headline>Text it. Approve it. Done.</Headline>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <StepCard n={1} title="Text the agent">
            One message — iMessage, Telegram, or the dashboard. &ldquo;Get a logo designed, under $100.&rdquo;
          </StepCard>
          <StepCard n={2} title="Approve the hire">
            It comes back with a shortlist and reasons. You reply HIRE 1. Nothing is booked without you.
          </StepCard>
          <StepCard n={3} title="Escrow holds the pay">
            The budget sits locked on-chain. Released when you accept the work, refunded when you don&apos;t.
          </StepCard>
        </div>
        <div className="mt-4 rounded-3xl bg-shell p-6 card-shadow">
          <h3 className="font-display text-lg font-bold">Get the result</h3>
          <p className="mt-1.5 text-sm font-medium text-soft">
            The agent relays questions, nudges the freelancer, and texts you when the work is delivered.
            You stay one tap away the whole time.
          </p>
        </div>
      </Section>
    </>
  );
}

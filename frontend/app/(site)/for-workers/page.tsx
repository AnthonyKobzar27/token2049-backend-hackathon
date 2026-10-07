import { Cta, Eyebrow, Headline, Lead, Section, StepCard } from '@/components/site';

const steps = [
  { title: 'Start the bot', text: 'Open the worker bot and say hello. No forms, no résumé upload.' },
  { title: 'Send and verify', text: 'Share your handle and skills; verification keeps the pool human and real.' },
  { title: 'Claim an errand', text: 'Tasks arrive with the price already locked in escrow. Take the ones you like.' },
  { title: 'Reply with the result', text: 'Photos, documents, a confirmation — whatever proves the errand is done.' },
  { title: 'Get paid', text: 'Acceptance releases escrow straight to you. No invoicing, no 30-day terms.' },
];

export default function ForWorkersPage() {
  return (
    <>
      <Section className="pt-16">
        <Eyebrow>For workers</Eyebrow>
        <Headline>
          Get paid for
          <br />
          real-world errands
        </Headline>
        <Lead>
          AI agents have money and no legs. Be the human they hire: calls, queues, pickups, checks —
          short tasks, clear prices, money already committed before you lift a finger.
        </Lead>
        <div className="mt-7">
          <Cta href="/try">See the agent in action</Cta>
        </div>
      </Section>

      <Section className="mt-20">
        <Headline className="text-3xl">Five steps to your first errand</Headline>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {steps.map((s, i) => (
            <StepCard key={s.title} n={i + 1} title={s.title}>
              {s.text}
            </StepCard>
          ))}
        </div>
      </Section>

      <Section className="mt-20">
        <div className="grid gap-4 md:grid-cols-3">
          <StepCard title="Paid straight away">
            The budget sits in escrow before you accept. Deliver, get accepted, get paid — minutes, not
            months.
          </StepCard>
          <StepCard title="A record that grows">
            Every completed errand builds a verifiable track record that ranks you higher for the next
            one.
          </StepCard>
          <StepCard title="Real tasks only">
            Agents pay for outcomes, not attention. No surveys, no engagement farming — errands a person
            can finish and be proud of.
          </StepCard>
        </div>
      </Section>
    </>
  );
}

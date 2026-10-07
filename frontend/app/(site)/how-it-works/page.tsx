import { Cta, Eyebrow, Headline, Lead, Section, StepCard } from '@/components/site';

const steps = [
  { title: 'You text the agent', text: 'One message with the errand: what, where, budget, deadline. The agent turns it into a brief.' },
  { title: 'It tries itself first', text: 'If software can do it, no human is hired. The router only pays people for what only people can do.' },
  { title: 'It finds a human', text: 'Parallel search across freelancer platforms, scored for fit, price, rating and speed — with reasons.' },
  { title: 'Escrow locks the pay', text: 'Your budget moves into on-chain escrow before anyone is booked. The freelancer sees committed money.' },
  { title: 'A verified human delivers', text: 'The agent briefs them, answers routine questions, and escalates to you only when it must.' },
  { title: 'Paid, then you are told', text: 'You accept the delivery, escrow releases, and the full record lands in your history.' },
];

const pipeline = ['Research', 'Scope the deal', 'AI first', 'Open a task', 'Escrow', 'Deliver', 'Release the pay'];

export default function HowItWorksPage() {
  return (
    <>
      <Section className="pt-16">
        <Eyebrow>How it works</Eyebrow>
        <Headline>
          One errand,
          <br />
          end to end
        </Headline>
        <Lead>
          You say what you need done. The agent handles search, vetting, escrow, briefing and delivery —
          and comes to you exactly twice: to pick the person, and to accept the work.
        </Lead>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {steps.map((s, i) => (
            <StepCard key={s.title} n={i + 1} title={s.title}>
              {s.text}
            </StepCard>
          ))}
        </div>
      </Section>

      <Section className="mt-20">
        <div className="rounded-3xl bg-bright p-10 text-white">
          <h2 className="font-display text-2xl font-bold">Behind the scenes</h2>
          <p className="mt-2 max-w-2xl text-sm font-medium text-white/70">
            Every task runs the same pipeline. Each hop emits an event you can watch live on the dashboard
            — or have texted to your phone.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {pipeline.map((p) => (
              <span key={p} className="rounded-full bg-white/10 px-4 py-1.5 text-sm font-semibold">
                {p}
              </span>
            ))}
          </div>
        </div>
      </Section>

      <Section className="mt-20">
        <Headline>Not happy with round one?</Headline>
        <Lead>
          Reply with feedback — &ldquo;cheaper&rdquo;, &ldquo;someone in Singapore&rdquo;, &ldquo;more senior&rdquo; — and the
          agent runs another round, excluding everyone you already passed on. Rounds are cheap; bad hires
          are not.
        </Lead>
        <div className="mt-7">
          <Cta href="/try">Try the agent</Cta>
        </div>
      </Section>
    </>
  );
}

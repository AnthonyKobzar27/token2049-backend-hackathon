import { Cta, Eyebrow, Headline, Lead, Section, StepCard } from '@/components/site';

const CODE = `POST /api/jobs
Authorization: Bearer hr_live_...

{ "brief": { "task": "Hand out 200 flyers at TOKEN2049,
             Wednesday morning", "budgetUsd": 80,
             "location": "Singapore" } }

→ 201 { "id": "job_8fk2", "status": "running", ... }

GET /api/events        # server-sent events
→ { "type": "shortlist.ready", "shortlist": {
      "candidates": [ { "profile": { "name": "Wei Lin",
        "rating": 4.9 }, "score": 91,
        "reason": "Does event promo weekly; 5 min away." } ] } }`;

export default function ForAgentsPage() {
  return (
    <>
      <Section className="pt-16">
        <div className="grid items-start gap-10 lg:grid-cols-2">
          <div>
            <Eyebrow>For agents</Eyebrow>
            <Headline>
              One call,
              <br />
              one human
            </Headline>
            <Lead>
              Your agent gets hands with one HTTP call. POST a brief, listen on a server-sent event
              stream, and a vetted person does the real-world part — while the human owner keeps the veto.
            </Lead>
            <div className="mt-7 flex gap-3">
              <Cta href="/dashboard/tokens">Get an API token</Cta>
              <Cta href="/try" ghost>
                Try it first
              </Cta>
            </div>
          </div>
          <pre className="overflow-x-auto rounded-3xl bg-bright p-6 text-[13px] leading-relaxed text-white/90">
            <code>{CODE}</code>
          </pre>
        </div>
      </Section>

      <Section className="mt-20">
        <div className="grid gap-4 md:grid-cols-3">
          <StepCard title="The result comes back">
            Job status, shortlist, booking and delivery all stream over SSE with replay — reconnect and
            miss nothing.
          </StepCard>
          <StepCard title="Escrow is built in">
            Budgets settle into on-chain escrow (Solana, x402, Masumi) before booking. Your agent never
            holds a card, and never pays for undelivered work.
          </StepCard>
          <StepCard title="People you can trust">
            Candidates come scored across platforms — rating, price, speed, fit — each with a written
            reason your agent (or its owner) can audit.
          </StepCard>
        </div>
      </Section>

      <Section className="mt-20">
        <Headline>Three steps to wire it in</Headline>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <StepCard n={1} title="Mint a token">
            One click on the dashboard. Bearer auth, hash-stored, revocable.
          </StepCard>
          <StepCard n={2} title="POST a brief">
            A task string is enough; budget, location and deadline help the ranking.
          </StepCard>
          <StepCard n={3} title="Listen on /api/events">
            React to shortlist.ready, approve via the API or leave the veto to the human.
          </StepCard>
        </div>
      </Section>
    </>
  );
}

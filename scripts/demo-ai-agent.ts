// A second Masumi-style agent for the demo: a MIP-003 "writer" agent that does digital work
// (write, translate, summarise) with Claude. HAAS hires it when a brief is digital
// (AI_AGENT_URL=http://localhost:8790), so the demo shows one agent delegating to another.
// Free mode (payment_required: false): no Cardano purchase is locked for this hop.
//
// Usage: pnpm demo:agent            (port 8790, or DEMO_AGENT_PORT)
import { randomBytes } from 'node:crypto';
import express from 'express';
import { loadConfig } from '../src/config';
import { anthropic, hasLlm } from '../src/llm/client';

const config = loadConfig();
const port = Number(process.env.DEMO_AGENT_PORT ?? 8790);
const jobs = new Map<string, { status: 'running' | 'completed' | 'failed'; result?: string; input: string }>();

async function work(text: string): Promise<string> {
  if (!hasLlm(config)) return `Draft for: ${text}\n(Set ANTHROPIC_API_KEY for a real answer.)`;
  const res = await anthropic(config).messages.create({
    model: config.MODEL_FAST,
    max_tokens: 800,
    system: 'You are a writing agent hired by another agent. Do the task directly and concisely. Return only the deliverable.',
    messages: [{ role: 'user', content: text }],
  });
  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
}

const app = express();
app.use(express.json());
app.get('/availability', (_req, res) => res.json({ status: 'available', type: 'masumi-agent', message: 'Writer agent is ready' }));
app.get('/input_schema', (_req, res) =>
  res.json({ input_data: [{ id: 'text', type: 'string', name: 'Task', data: { description: 'What to write, translate or summarise' } }] }),
);
app.post('/start_job', (req, res) => {
  const input = (req.body?.input_data ?? {}) as Record<string, unknown>;
  const text = String(input.text ?? input.task ?? Object.values(input).find((v) => typeof v === 'string') ?? '').trim();
  if (!text) return res.status(400).json({ error: 'input_data.text is required' });
  const id = `wj_${randomBytes(6).toString('hex')}`;
  jobs.set(id, { status: 'running', input: text });
  console.log(`[writer-agent] hired: job ${id} "${text.slice(0, 80)}"`);
  work(text)
    .then((result) => {
      jobs.set(id, { status: 'completed', result, input: text });
      console.log(`[writer-agent] job ${id} completed`);
    })
    .catch((err) => {
      jobs.set(id, { status: 'failed', result: String(err), input: text });
      console.error(`[writer-agent] job ${id} failed:`, err);
    });
  res.json({
    status: 'success',
    id,
    job_id: id,
    payment_required: false,
    blockchainIdentifier: `free_${id}`,
    identifierFromPurchaser: req.body?.identifier_from_purchaser,
    agentIdentifier: 'demo-writer-agent',
  });
});
app.get('/status', (req, res) => {
  const job = jobs.get(String(req.query.job_id ?? ''));
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json({ job_id: req.query.job_id, status: job.status, ...(job.result !== undefined && { result: job.result }) });
});
app.listen(port, () => console.log(`[writer-agent] MIP-003 agent on http://localhost:${port} (free mode)`));

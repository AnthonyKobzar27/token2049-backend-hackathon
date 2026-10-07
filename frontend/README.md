# HAAS dashboard

Next.js UI for watching the agent work: tasks and their live status, every
freelancer the agent is considering (with scores and reasons), pending
approvals, bookings and the activity stream.

## Run

Start the backend first (`pnpm start` in the repository root), then:

```sh
cd frontend
pnpm install
pnpm dev
```

Open http://localhost:3000. The UI talks straight to the backend API at
`http://localhost:8787`; set `NEXT_PUBLIC_API_URL` to point elsewhere.

## Pages

- `/` — overview: stats, task list, pending approvals (approve/deny), live activity feed (SSE from `/api/events`).
- `/jobs/[id]` — one task: brief, shortlist with per-candidate score breakdowns, pick/cancel, booking and escrow state, conversation thread with a send box. While the task is at a check-in, a sent message doubles as refine feedback and triggers a new search round.
- `/people` — everyone the agent is looking at, across all tasks, filterable.
- `/new` — start a task from the browser.

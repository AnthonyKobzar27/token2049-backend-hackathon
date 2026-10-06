import type { Config } from '../config';
import { newId, now } from '../domain/ids';
import type { ApprovalGate, AutonomyPolicy, EventBus, Store } from '../domain/ports';
import type { Approval } from '../domain/types';

type Outcome = { approved: boolean; approval?: Approval };

export function createApprovalGate(deps: { store: Store; bus: EventBus; policy: AutonomyPolicy; config: Config }): ApprovalGate {
  const { store, bus, policy, config } = deps;
  const waiting = new Map<string, { done: (o: Outcome) => void; timer: ReturnType<typeof setTimeout> | undefined }>();

  // Headless local run (no bot, no operator): nobody could ever answer, so approve
  // after emitting the events. Production setups with a token always wait for a person.
  const headless = !config.TELEGRAM_OPERATOR_ID && !config.TELEGRAM_BOT_TOKEN;

  // Approvals left pending by a previous process can no longer be answered.
  for (const a of store.listApprovals({ status: 'pending' })) {
    store.updateApproval(a.id, { status: 'expired', decidedAt: now() });
  }

  function settle(id: string, patch: Partial<Approval>): Approval | undefined {
    const current = store.getApproval(id);
    if (!current || current.status !== 'pending') return undefined;
    const approval = store.updateApproval(id, { ...patch, decidedAt: now() });
    bus.emit({ type: 'approval.resolved', approval });
    const w = waiting.get(id);
    if (w) {
      if (w.timer) clearTimeout(w.timer);
      waiting.delete(id);
      w.done({ approved: approval.status === 'approved', approval });
    }
    return approval;
  }

  return {
    request(req) {
      if (!policy.requiresApproval(req.action, req.bookingId)) return Promise.resolve({ approved: true });

      const approval: Approval = {
        id: newId('apr'),
        action: req.action,
        jobId: req.jobId,
        bookingId: req.bookingId,
        summary: req.summary,
        detail: req.detail,
        status: 'pending',
        createdAt: now(),
      };
      store.insertApproval(approval);
      bus.emit({ type: 'approval.requested', approval });

      if (headless) {
        console.log(`[approvals] headless: auto-approving ${req.action}: ${req.summary}`);
        const done = settle(approval.id, { status: 'approved', decidedBy: 'headless' });
        return Promise.resolve({ approved: true, approval: done ?? approval });
      }

      const timeoutMs = req.timeoutMs ?? config.APPROVAL_TIMEOUT_MIN * 60_000;
      return new Promise<Outcome>((done) => {
        const timer = setTimeout(() => settle(approval.id, { status: 'expired' }), timeoutMs);
        waiting.set(approval.id, { done, timer });
      });
    },

    resolve(approvalId, decision) {
      settle(approvalId, {
        status: decision.approved ? 'approved' : 'denied',
        decidedBy: decision.by,
        note: decision.note,
      });
    },
  };
}

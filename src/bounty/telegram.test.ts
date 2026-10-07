import { describe, expect, it } from 'vitest';
import { createWorkerCommands } from './telegram';
import { setupBoard } from './testkit';

describe('Telegram worker commands', () => {
  it('links, lists, claims and submits; the second claimer loses', async () => {
    const h = setupBoard();
    const cmd = createWorkerCommands(h.board);
    const ana = h.board.getWorker('w_ana')!;
    const ben = h.board.getWorker('w_ben')!;
    expect(await cmd.handle('tasks', { chatId: '1', args: '' })).toMatch(/not linked/);
    expect(await cmd.handle('link', { chatId: '1', args: ana.linkCode })).toMatch(/^Hi Ana/);
    await cmd.handle('link', { chatId: '2', args: ben.linkCode });

    const b = h.post();
    expect(await cmd.handle('tasks', { chatId: '1', args: '' })).toContain(b.code);
    expect(await cmd.handle('claim', { chatId: '1', args: b.code.toLowerCase() })).toMatch(/It's yours/);
    expect(await cmd.handle('claim', { chatId: '2', args: b.code })).toBe('Someone else already claimed this task');

    expect(await cmd.handle('submit', { chatId: '1', args: `${b.code} date=2026-10-08 time=15:00` })).toMatch(/^Not submitted: Reference number is required/);
    expect(await cmd.handle('submit', { chatId: '1', args: `${b.code} date=2026-10-08 time=15:00 reference=88213 | bring NRIC` })).toContain('Booked: Thursday 3pm, ref 88213');
    expect(h.board.get(b.id)).toMatchObject({ status: 'submitted', workerId: 'w_ana', result: { notes: 'bring NRIC' } });
  });

  it('does not let a worker act on a task not offered to them', async () => {
    const h = setupBoard({ BOUNTY_MODE: 'direct' });
    const cmd = createWorkerCommands(h.board);
    await cmd.handle('link', { chatId: '2', args: h.board.getWorker('w_ben')!.linkCode });
    const b = h.post({ workerId: 'w_ana' });
    expect(await cmd.handle('claim', { chatId: '2', args: b.code })).toMatch(/^No task/);
  });
});

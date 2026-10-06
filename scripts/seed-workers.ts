// Registers the demo worker pool (the team, around Singapore) in the HAAS database, so the
// bounty source has verified people to offer tasks to. Safe to run again: it updates in place
// and keeps each worker's Telegram link code.
//
//   pnpm seed:workers
//
// Contact details and payout wallets come from WORKER_<ID>_TELEGRAM / _CARDANO / _SOLANA
// (see src/bounty/seed.ts); without them, workers link their chat with /link <code>.
import { createBountyBoard } from '../src/bounty/board';
import { createConsoleNotifier } from '../src/bounty/notifier';
import { teamFromEnv } from '../src/bounty/seed';
import { loadConfig } from '../src/config';
import { createStore } from '../src/db/db';
import { createEventBus } from '../src/domain/events';

const config = loadConfig();
const store = createStore(config.DB_PATH);
const board = createBountyBoard({ store, bus: createEventBus(), config, notifier: createConsoleNotifier() });

console.log(`Seeding workers into ${config.DB_PATH}\n`);
for (const input of teamFromEnv()) {
  const w = board.registerWorker(input);
  const where = `${w.location.area ?? w.location.city} (${w.location.lat.toFixed(4)}, ${w.location.lng.toFixed(4)})`;
  const reach = w.contact.telegramId ? `telegram ${w.contact.telegramId}` : `send /link ${w.linkCode} to the bot`;
  console.log(`${w.verified ? '✔' : '✖'} ${w.name.padEnd(8)} ${where.padEnd(42)} ${reach}`);
}
console.log(`\n${board.listWorkers().filter((w) => w.verified).length} verified workers. ✖ = not verified, never offered a bounty.`);
store.close();

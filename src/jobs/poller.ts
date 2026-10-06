/** Runs each task on an interval; a task never overlaps itself and a failure never stops the loop. */
export function createPoller(tasks: Record<string, () => Promise<void>>, intervalMs = 15_000) {
  const running = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const runAll = () => {
    for (const [name, task] of Object.entries(tasks)) {
      if (running.has(name)) continue;
      running.add(name);
      task()
        .catch((err) => console.error(`[poller] ${name} failed:`, err))
        .finally(() => running.delete(name));
    }
  };

  return {
    start() {
      runAll();
      timer = setInterval(runAll, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

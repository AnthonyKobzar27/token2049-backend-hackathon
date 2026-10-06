import type { HaasEvent } from './types';
import type { EventBus } from './ports';

export function createEventBus(): EventBus {
  const handlers = new Set<(event: HaasEvent) => void>();
  return {
    emit(event) {
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (err) {
          console.error(`[bus] handler failed on ${event.type}:`, err);
        }
      }
    },
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

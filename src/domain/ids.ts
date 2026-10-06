import { randomBytes } from 'node:crypto';

/** Short, URL-safe id such as "job_k3f9x2a1bq". */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('base64url').replace(/[-_]/g, '').slice(0, 10).toLowerCase()}`;
}

export const now = (): number => Date.now();

// Connection to a KERIA agent through signify-ts. HAAS holds its issuer keys client-side (Signify):
// the passcode (bran) derives them, KERIA only stores encrypted state and runs the agent.
//
// SignifyPort is the slice of SignifyClient HAAS uses. Tests pass a fake; production wraps the real
// client (structurally compatible, see connectSignify).

import { ready, SignifyClient, Tier } from 'signify-ts';

/** Long-running KERIA operation as returned by every write. */
export interface KeriaOperation<T = unknown> {
  name: string;
  done?: boolean;
  error?: unknown;
  response?: T;
  metadata?: Record<string, unknown>;
}

/** A Serder as signify-ts returns it: `sad` is the JSON body, `raw` the serialized bytes. */
export interface SerderLike {
  sad: Record<string, any>;
  raw?: string;
}

export interface HabState {
  name: string;
  prefix: string;
  state?: { s?: string; d?: string };
}

export interface SignifyPort {
  readonly agent?: { pre: string } | null;
  fetch(path: string, method: string, data: unknown, extraHeaders?: Headers): Promise<Response>;
  identifiers(): {
    get(name: string): Promise<HabState>;
    create(name: string, args?: Record<string, unknown>): Promise<{ op(): Promise<KeriaOperation> }>;
    addEndRole(name: string, role: string, eid?: string): Promise<{ op(): Promise<KeriaOperation> }>;
    addLocScheme(name: string, args: { url: string; scheme?: string; eid?: string }): Promise<{ op(): Promise<KeriaOperation> }>;
  };
  oobis(): {
    get(name: string, role?: string): Promise<{ role?: string; oobis: string[] }>;
    resolve(oobi: string, alias?: string): Promise<KeriaOperation>;
  };
  operations(): {
    wait<T extends KeriaOperation>(op: T, options?: { signal?: AbortSignal; minSleep?: number; maxSleep?: number }): Promise<any>;
    delete(name: string): Promise<void>;
  };
  registries(): {
    list(name: string): Promise<Array<{ name: string; regk: string }>>;
    create(args: { name: string; registryName: string; noBackers?: boolean; nonce?: string }): Promise<{ op(): Promise<KeriaOperation> }>;
  };
  credentials(): {
    get(said: string): Promise<any>;
    issue(name: string, args: { ri: string; s: string; a: Record<string, unknown>; u?: string }): Promise<{ acdc: SerderLike; anc: SerderLike; iss: SerderLike; op: KeriaOperation }>;
    revoke(name: string, said: string, datetime?: string): Promise<{ op: KeriaOperation }>;
    state(ri: string, said: string): Promise<{ et: string; s?: string; dt?: string; [k: string]: unknown }>;
  };
  ipex(): {
    grant(args: { senderName: string; recipient: string; message?: string; datetime?: string; acdc: any; anc: any; iss: any }): Promise<[any, string[], string]>;
    submitGrant(name: string, exn: any, sigs: string[], atc: string, recp: string[]): Promise<KeriaOperation>;
  };
  notifications(): {
    list(start?: number, end?: number): Promise<{ notes: Array<{ i: string; dt: string; r: boolean; a: { r: string; d?: string; m?: string } }> }>;
    mark(said: string): Promise<string>;
  };
  exchanges(): {
    get(said: string): Promise<{ exn: { i: string; p?: string; e?: Record<string, any>; [k: string]: any } }>;
  };
}

export interface KeriaConnection {
  url: string;
  bootUrl: string;
  passcode: string;
}

/**
 * Connects to the KERIA agent for `passcode`, booting it on first use (POST to the boot port).
 * Throws with a readable message when KERIA is unreachable.
 */
export async function connectSignify(conn: KeriaConnection): Promise<SignifyPort> {
  if (conn.passcode.length < 21) throw new Error('VERIDIAN_PASSCODE must be at least 21 characters (signify-ts randomPasscode() makes one)');
  await ready();
  const client = new SignifyClient(conn.url, conn.passcode, Tier.low, conn.bootUrl);
  try {
    await client.connect();
  } catch (first) {
    let booted: Response;
    try {
      booted = await client.boot();
    } catch (err) {
      throw new Error(`KERIA boot endpoint ${conn.bootUrl} is unreachable: ${(err as Error).message}`);
    }
    // 409: the agent already exists, so the first connect failed for another reason.
    if (!booted.ok && booted.status !== 409) throw new Error(`KERIA boot failed (${booted.status}): ${await booted.text()}`);
    if (booted.status === 409) throw first;
    await client.connect();
  }
  return client as unknown as SignifyPort;
}

/** A fresh 21-character passcode (bran) for a new KERIA agent. */
export async function newPasscode(): Promise<string> {
  await ready();
  const { randomPasscode } = await import('signify-ts');
  return randomPasscode();
}

/** Waits for a KERIA operation with a deadline, then deletes it from the agent. */
export async function waitOp<T = unknown>(client: SignifyPort, op: KeriaOperation, timeoutMs: number): Promise<KeriaOperation<T>> {
  if (op.done) return op as KeriaOperation<T>;
  const signal = AbortSignal.timeout(timeoutMs);
  let done: KeriaOperation<T>;
  try {
    done = (await client.operations().wait(op, { signal, minSleep: 50, maxSleep: 1000 })) as KeriaOperation<T>;
  } catch (err) {
    if (signal.aborted) throw new Error(`KERIA operation ${op.name} did not finish within ${timeoutMs} ms`);
    throw err;
  }
  if (done.error) throw new Error(`KERIA operation ${op.name} failed: ${JSON.stringify(done.error)}`);
  await client
    .operations()
    .delete(op.name)
    .catch(() => undefined);
  return done;
}

/** KERIA answers 404 for an unknown identifier or credential; signify-ts surfaces it as an Error message. */
export const isNotFound = (err: unknown): boolean => /\b404\b|not found/i.test(String((err as Error)?.message ?? err));

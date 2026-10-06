import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ready } from 'signify-ts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../domain/ports';
import { onchainBoost, onchainReason } from '../../router/match';
import { mountVeridian } from './api';
import { createFakeKeria, fakeAid } from './fake';
import { createVeridianCredentialIssuer } from './issuer';
import { HAAS_WORKER_SCHEMA_SAID } from './schema';
import { combineSignals, createVeridianService } from './service';

beforeAll(async () => {
  await ready();
});

const kvStore = () => {
  const kv = new Map<string, string>();
  return { getKv: (k: string) => kv.get(k) ?? null, setKv: (k: string, v: string) => void kv.set(k, v) } as unknown as Store;
};

const wallet = fakeAid('wallet');
const walletOobi = `http://wallet.test/oobi/${wallet}/agent/${fakeAid('wallet-agent')}`;
const onboarding = { workerId: 'freelancer:7', platformsVerified: ['freelancer'], verificationMethod: 'profile-challenge' };

function setup(opts: { now?: () => number; ttlMs?: number } = {}) {
  const keria = createFakeKeria();
  const issuer = createVeridianCredentialIssuer(keria, { opTimeoutMs: 2_000 });
  const svc = createVeridianService({ issuer, store: kvStore(), verifyTimeoutMs: 100, log: () => {}, ...opts });
  return { keria, issuer, svc };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('onboarding', () => {
  it('goes from awaiting-wallet to granted to admitted', async () => {
    const { keria, svc } = setup();
    const s = await svc.start(onboarding);
    expect(s).toMatchObject({ status: 'awaiting-wallet', workerId: 'freelancer:7' });
    expect(s.issuerOobi).toContain('?name=HAAS');
    expect(s.id).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const granted = await svc.connect(s.id, walletOobi);
    expect(granted).toMatchObject({ status: 'granted', holderAid: wallet });
    expect(keria.grants[0]?.recipient).toBe(wallet);
    expect(svc.credentialOf('freelancer:7')?.said).toBe(granted.credentialSaid);

    keria.deliver('/exn/ipex/admit', { i: wallet, p: granted.grantSaid });
    expect((await svc.get(s.id))?.status).toBe('admitted');
    // Connecting again does not issue a second credential.
    await svc.connect(s.id, walletOobi);
    expect(keria.grants).toHaveLength(1);
  });

  it('validates input and records failures', async () => {
    const { svc } = setup();
    await expect(svc.start({ ...onboarding, workerId: ' ' })).rejects.toThrow(/workerId/);
    await expect(svc.start({ ...onboarding, verificationMethod: '' })).rejects.toThrow(/verificationMethod/);
    await expect(svc.connect('nope', walletOobi)).rejects.toThrow(/unknown onboarding/);
    const s = await svc.start(onboarding);
    expect((await svc.connect(s.id, 'not a url')).status).toBe('failed');
  });
});

describe('credential-verified cache for the router', () => {
  it('marks an issued worker verified without waiting on KERIA', async () => {
    const { svc } = setup();
    const s = await svc.start(onboarding);
    await svc.connect(s.id, walletOobi);
    expect(svc.signals(['freelancer:7', 'freelancer:8'])).toEqual(new Map([['freelancer:7', { verified: true, jobsCompleted: 0, veridian: true }]]));
  });

  it('re-verifies stale entries in the background and drops revoked credentials', async () => {
    let t = 1_000_000;
    const { keria, svc } = setup({ now: () => t, ttlMs: 60_000 });
    const s = await svc.start(onboarding);
    const { credentialSaid } = await svc.connect(s.id, walletOobi);
    keria.setState(credentialSaid!, 'rev');
    t += 120_000;
    // Still the cached verdict now; the refresh runs behind the call.
    expect(svc.signals(['freelancer:7']).get('freelancer:7')?.verified).toBe(true);
    await flush();
    expect(svc.signals(['freelancer:7']).has('freelancer:7')).toBe(false);
    expect(svc.checkOf('freelancer:7')?.result).toMatchObject({ valid: false, registryState: 'rev' });
  });

  it('keeps the last verdict when KERIA times out, and returns at once', async () => {
    let t = 1_000_000;
    const { keria, svc } = setup({ now: () => t, ttlMs: 60_000 });
    const s = await svc.start(onboarding);
    await svc.connect(s.id, walletOobi);
    keria.hang('credentials.get');
    t += 120_000;
    const t0 = Date.now();
    expect(svc.signals(['freelancer:7']).get('freelancer:7')?.verified).toBe(true);
    expect(Date.now() - t0).toBeLessThan(50);
    await new Promise((r) => setTimeout(r, 200));
    expect(svc.checkOf('freelancer:7')).toMatchObject({ result: { valid: true }, error: expect.stringMatching(/timed out/) });
    expect(svc.signals(['freelancer:7']).get('freelancer:7')?.verified).toBe(true);
  });

  it('caches presentations received over IPEX', async () => {
    const { keria, issuer, svc } = setup();
    const cred = await issuer.issueToHolder(wallet, { workerId: 'fiverr:ada', platformsVerified: ['fiverr'], verificationMethod: 'platform-oauth' });
    const held = await keria.credentials().get(cred.said);
    keria.deliver('/exn/ipex/grant', { i: wallet, e: { acdc: held.sad, iss: held.iss } });
    expect(await svc.pollPresentations()).toBe(1);
    expect(svc.checkOf('fiverr:ada')?.result).toMatchObject({ valid: true, holderProven: true });
    expect(svc.signals(['fiverr:ada']).get('fiverr:ada')?.veridian).toBe(true);
  });

  it('refuses a credential presented for another worker', async () => {
    const { svc } = setup();
    const s = await svc.start(onboarding);
    const { credentialSaid } = await svc.connect(s.id, walletOobi);
    expect(await svc.verify({ workerId: 'freelancer:99', said: credentialSaid! })).toMatchObject({ valid: false, reason: expect.stringMatching(/belongs to freelancer:7/) });
    expect(svc.signals(['freelancer:99']).size).toBe(0);
  });

  it('combines with Cardano signals and changes the ranking note', () => {
    const cardano = { signals: () => new Map([['w', { verified: true, jobsCompleted: 4, avgRating: 4.5 }]]) };
    const veridian = { signals: () => new Map([['w', { verified: true, jobsCompleted: 0, veridian: true }], ['v', { verified: true, jobsCompleted: 0, veridian: true }]]) };
    const broken = {
      signals: (): Map<string, never> => {
        throw new Error('down');
      },
    };
    const m = combineSignals(cardano, broken, veridian).signals(['w', 'v']);
    expect(m.get('w')).toEqual({ verified: true, jobsCompleted: 4, avgRating: 4.5, veridian: true });
    expect(onchainReason(m.get('v'))).toBe('Veridian KERI credential verified HAAS worker');
    expect(onchainReason(m.get('w'))).toBe('Veridian KERI credential verified, 4 jobs completed on HAAS');
    expect(onchainBoost(m.get('v'))).toBe(3);
  });
});

describe('HTTP API', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function serve(adminToken?: string) {
    const ctx = setup();
    const app = express();
    app.use(express.json());
    mountVeridian(app, ctx.svc, { publicUrl: 'http://haas.test', ...(adminToken ? { adminToken } : {}) });
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { ...ctx, base };
  }
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('serves the schema as a data OOBI', async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/oobi/${HAAS_WORKER_SCHEMA_SAID}`);
    expect(res.headers.get('content-type')).toMatch(/application\/schema\+json/);
    expect((await res.json()).$id).toBe(HAAS_WORKER_SCHEMA_SAID);
    expect((await fetch(`${base}/oobi/${fakeAid('other')}`)).status).toBe(404);
  });

  it('runs onboarding end to end and verifies', async () => {
    const { base, keria } = await serve('s3cret');
    expect((await post(`${base}/veridian/onboarding`, onboarding)).status).toBe(401);
    const started = await post(`${base}/veridian/onboarding`, onboarding, { authorization: 'Bearer s3cret' });
    expect(started.status).toBe(201);
    const body = (await started.json()) as { session: { id: string }; qr: string; connectUrl: string };
    expect(body.qr).toMatch(/^data:image\/png;base64,/);
    expect(body.connectUrl).toBe(`http://haas.test/veridian/connect/${body.session.id}`);

    const page = await (await fetch(`${base}/veridian/connect/${body.session.id}`)).text();
    expect(page).toContain('Connect your Veridian wallet');
    expect(page).toContain('freelancer:7');

    expect((await post(`${base}/veridian/onboarding/${body.session.id}/wallet`, {})).status).toBe(400);
    const granted = await (await post(`${base}/veridian/onboarding/${body.session.id}/wallet`, { oobi: walletOobi })).json();
    expect(granted.status).toBe('granted');

    const said = granted.credentialSaid as string;
    const ok = await post(`${base}/veridian/verify`, { said });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ valid: true, workerId: 'freelancer:7' });

    const held = await keria.credentials().get(said);
    const tampered = await post(`${base}/veridian/verify`, { acdc: { ...held.sad, a: { ...held.sad.a, workerId: 'x' } }, iss: held.iss });
    expect(tampered.status).toBe(422);

    const worker = await (await fetch(`${base}/veridian/workers/freelancer:7`)).json();
    expect(worker).toMatchObject({ verified: true, credential: { said } });
    expect((await fetch(`${base}/veridian/workers/nobody`)).status).toBe(404);
  });

  it('allows onboarding only from loopback when no token is set, and 503s when disabled', async () => {
    const { base } = await serve();
    expect((await post(`${base}/veridian/onboarding`, onboarding)).status).toBe(201);

    const app = express();
    app.use(express.json());
    mountVeridian(app, null, { publicUrl: 'http://haas.test' });
    const off = app.listen(0);
    const res = await post(`http://127.0.0.1:${(off.address() as AddressInfo).port}/veridian/verify`, { said: 'x' });
    off.close();
    expect(res.status).toBe(503);
  });
});

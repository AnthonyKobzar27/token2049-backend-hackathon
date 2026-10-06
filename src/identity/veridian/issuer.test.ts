import { ready } from 'signify-ts';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFakeKeria, fakeAid } from './fake';
import { createVeridianCredentialIssuer } from './issuer';
import { HAAS_WORKER_SCHEMA, HAAS_WORKER_SCHEMA_SAID, schemaSaidIsValid } from './schema';

beforeAll(async () => {
  await ready();
});

const worker = fakeAid('worker-wallet');
const attrs = { workerId: 'freelancer:42', platformsVerified: ['freelancer', 'fiverr'], verificationMethod: 'platform-oauth', issuedAt: '2026-10-06T10:00:00.000Z' };

function setup(extra: Parameters<typeof createVeridianCredentialIssuer>[1] = {}) {
  const keria = createFakeKeria();
  const issuer = createVeridianCredentialIssuer(keria, { schemaOobiUrl: `http://haas.test/oobi/${HAAS_WORKER_SCHEMA_SAID}`, oobiBaseUrl: 'http://haas.test', opTimeoutMs: 2_000, ...extra });
  return { keria, issuer };
}

describe('HAAS Verified Worker schema', () => {
  it('carries a SAID that matches its content', async () => {
    expect(HAAS_WORKER_SCHEMA_SAID).toMatch(/^E[A-Za-z0-9_-]{43}$/);
    expect(await schemaSaidIsValid(HAAS_WORKER_SCHEMA)).toBe(true);
  });

  it('detects an edit made without recomputing the SAID', async () => {
    expect(await schemaSaidIsValid({ ...HAAS_WORKER_SCHEMA, title: 'Edited' })).toBe(false);
  });
});

describe('VeridianCredentialIssuer', () => {
  it('creates the issuer AID, end roles, registry and resolves the schema once', async () => {
    const { keria, issuer } = setup();
    const first = await issuer.init();
    await issuer.init();
    expect(first.schemaSaid).toBe(HAAS_WORKER_SCHEMA_SAID);
    const methods = keria.calls.map((c) => c.method);
    expect(methods.filter((m) => m === 'identifiers.create')).toHaveLength(1);
    expect(methods.filter((m) => m === 'registries.create')).toHaveLength(1);
    const roles = keria.calls.filter((c) => c.method === 'identifiers.addEndRole').map((c) => c.args[1]);
    expect(roles).toEqual(['agent', 'indexer']);
    expect(keria.calls.find((c) => c.method === 'identifiers.addLocScheme')?.args[1]).toEqual({ url: 'http://haas.test', scheme: 'http' });
    expect(keria.calls.some((c) => c.method === 'oobis.resolve' && String(c.args[0]).endsWith(HAAS_WORKER_SCHEMA_SAID))).toBe(true);

    // A second process with the same passcode loads, not recreates.
    const again = createVeridianCredentialIssuer(keria, {});
    expect((await again.init()).issuerAid).toBe(first.issuerAid);
    expect(keria.calls.filter((c) => c.method === 'identifiers.create')).toHaveLength(1);
  });

  it('returns an agent OOBI the wallet can scan, named HAAS', async () => {
    const { issuer } = setup();
    const oobi = await issuer.issuerOobi();
    expect(oobi).toMatch(/^http:\/\/keria\.test:3902\/oobi\/E.{43}\/agent\/E.{43}\?name=HAAS$/);
  });

  it('resolves a wallet OOBI to its AID', async () => {
    const { issuer } = setup();
    expect(await issuer.resolveHolder(`http://wallet.test/oobi/${worker}/agent/${fakeAid('wallet-agent')}?name=Ada`)).toBe(worker);
    expect(await issuer.resolveHolder(worker)).toBe(worker);
  });

  it('issues the credential to the worker AID and IPEX-grants it', async () => {
    const { keria, issuer } = setup();
    const cred = await issuer.issueToHolder(worker, { ...attrs, cardanoReputationAsset: 'abc123' });
    const { issuerAid, registryId } = await issuer.init();
    expect(cred).toMatchObject({ issuer: 'veridian', workerId: 'freelancer:42', holderAid: worker, walletAddress: worker, issuerAid, registryId, schemaSaid: HAAS_WORKER_SCHEMA_SAID, policyId: HAAS_WORKER_SCHEMA_SAID });
    expect(cred.said).toBe(cred.assetName);
    const issued = keria.calls.find((c) => c.method === 'credentials.issue')!.args[1] as { a: Record<string, unknown>; s: string };
    expect(issued.s).toBe(HAAS_WORKER_SCHEMA_SAID);
    expect(issued.a).toEqual({ i: worker, workerId: 'freelancer:42', platformsVerified: ['freelancer', 'fiverr'], verificationMethod: 'platform-oauth', issuedAt: attrs.issuedAt, cardanoReputationAsset: 'abc123' });
    expect(keria.grants).toEqual([{ said: cred.grantSaid, recipient: worker, acdc: expect.objectContaining({ d: cred.said }) }]);
  });

  it('implements CredentialIssuer.issue and status', async () => {
    const { keria, issuer } = setup();
    const cred = await issuer.issue({ workerId: 'w1', walletAddress: `http://wallet.test/oobi/${worker}` });
    expect(cred.walletAddress).toBe(worker);
    expect(await issuer.status(cred)).toEqual({ valid: true, bound: true, holder: worker });
    keria.setState(cred.assetName, 'rev');
    expect(await issuer.status(cred)).toMatchObject({ valid: false, bound: false });
  });

  it('notices the wallet admitting the grant', async () => {
    const { keria, issuer } = setup();
    const cred = await issuer.issueToHolder(worker, attrs);
    expect(await issuer.admitted(cred.grantSaid)).toBe(false);
    keria.deliver('/exn/ipex/admit', { i: worker, p: cred.grantSaid });
    expect(await issuer.admitted(cred.grantSaid)).toBe(true);
  });

  describe('verify (presented ACDC + iss event)', () => {
    async function presented() {
      const s = setup();
      const cred = await s.issuer.issueToHolder(worker, attrs);
      const held = await s.keria.credentials().get(cred.said);
      return { ...s, cred, acdc: held.sad as Record<string, any>, iss: held.iss as Record<string, any> };
    }

    it('accepts a credential HAAS issued, after KERIA parses it', async () => {
      const { keria, issuer, acdc, iss } = await presented();
      const res = await issuer.verify({ acdc, iss }, { expectedHolder: worker });
      expect(res).toMatchObject({ valid: true, workerId: 'freelancer:42', holderAid: worker, platformsVerified: ['freelancer', 'fiverr'], registryState: 'iss', holderProven: false });
      expect(keria.calls.some((c) => c.method === 'fetch' && c.args[0] === '/credentials/verify')).toBe(true);
    });

    it('rejects tampered attributes without asking KERIA', async () => {
      const { keria, issuer, acdc, iss } = await presented();
      const before = keria.calls.length;
      const res = await issuer.verify({ acdc: { ...acdc, a: { ...acdc.a, workerId: 'freelancer:mallory' } }, iss });
      expect(res).toMatchObject({ valid: false, reason: expect.stringMatching(/SAID does not match/) });
      expect(keria.calls.slice(before).some((c) => c.method === 'fetch')).toBe(false);
    });

    it('rejects other schemas, untrusted issuers and the wrong holder', async () => {
      const { issuer, acdc, iss } = await presented();
      expect((await issuer.verify({ acdc: { ...acdc, s: fakeAid('other-schema') }, iss })).reason).toMatch(/not a HAAS Verified Worker/);
      expect((await issuer.verify({ acdc: { ...acdc, i: fakeAid('mallory') }, iss })).reason).toMatch(/not trusted/);
      expect((await issuer.verify({ acdc, iss }, { expectedHolder: fakeAid('someone') })).reason).toMatch(/issued to/);
      expect((await issuer.verify({ acdc, iss: { ...iss, i: fakeAid('x') } })).reason).toMatch(/issuance event/);
    });

    it('reports revocation and KERIA rejections', async () => {
      const { keria, issuer, acdc, iss, cred } = await presented();
      await issuer.revoke(cred.said);
      expect(await issuer.verify({ acdc, iss })).toMatchObject({ valid: false, reason: 'credential was revoked', registryState: 'rev' });
      keria.verifyStatus = 400;
      expect((await issuer.verify({ acdc, iss })).reason).toMatch(/KERIA rejected/);
    });
  });

  describe('verifySaid (router cache)', () => {
    it('is valid for an issued credential and invalid once revoked', async () => {
      const { keria, issuer } = setup();
      const cred = await issuer.issueToHolder(worker, attrs);
      expect(await issuer.verifySaid(cred.said)).toMatchObject({ valid: true, workerId: 'freelancer:42' });
      keria.setState(cred.said, 'rev');
      expect(await issuer.verifySaid(cred.said)).toMatchObject({ valid: false, reason: 'credential was revoked' });
      expect(await issuer.verifySaid(fakeAid('unknown'))).toMatchObject({ valid: false, reason: 'unknown credential' });
    });

    it('gives up after the timeout instead of hanging', async () => {
      const { keria, issuer } = setup();
      const cred = await issuer.issueToHolder(worker, attrs);
      keria.hang('credentials.get');
      const t0 = Date.now();
      const res = await issuer.verifySaid(cred.said, { timeoutMs: 50 });
      expect(res).toMatchObject({ valid: false, reason: expect.stringMatching(/timed out/) });
      expect(Date.now() - t0).toBeLessThan(1_000);
    });
  });

  describe('presentations (IPEX grant from the worker)', () => {
    it('proves the holder when the issuee sends the grant, ignoring our own outbound grants', async () => {
      const { keria, issuer } = setup();
      const cred = await issuer.issueToHolder(worker, attrs);
      const held = await keria.credentials().get(cred.said);
      keria.deliver('/exn/ipex/grant', { i: worker, e: { acdc: held.sad, iss: held.iss } });
      const out = await issuer.presentations();
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ sender: worker, result: { valid: true, holderProven: true, workerId: 'freelancer:42' } });
      expect(await issuer.presentations()).toEqual([]);
    });

    it('rejects a credential forwarded by someone other than its holder', async () => {
      const { keria, issuer } = setup();
      const cred = await issuer.issueToHolder(worker, attrs);
      const held = await keria.credentials().get(cred.said);
      const thief = fakeAid('thief');
      keria.deliver('/exn/ipex/grant', { i: thief, e: { acdc: held.sad, iss: held.iss } });
      const [p] = await issuer.presentations();
      expect(p?.result).toMatchObject({ valid: false, reason: expect.stringMatching(/presented by .* but issued to/) });
    });
  });
});

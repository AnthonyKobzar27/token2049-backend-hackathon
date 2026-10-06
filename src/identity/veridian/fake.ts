// In-memory stand-in for a KERIA agent behind signify-ts, for tests. ACDCs and TEL events are built
// and SAIDified exactly as signify-ts does, so the issuer's content checks run for real; signatures,
// KELs and witnesses are not modelled.

import { Ilks, Protocols, Saider, Serials, versify } from 'signify-ts';
import type { KeriaOperation, SignifyPort } from './client';

const aid = (seed: string) => `E${seed.replace(/[^A-Za-z0-9_-]/g, '_').padEnd(43, '_').slice(0, 43)}`;

export interface FakeKeria extends SignifyPort {
  calls: Array<{ method: string; args: unknown[] }>;
  /** Grants HAAS sent, by recipient. */
  grants: Array<{ said: string; recipient: string; acdc: Record<string, any> }>;
  /** Simulates the worker's wallet: an inbound exn and its notification. */
  deliver(route: '/exn/ipex/admit' | '/exn/ipex/grant', exn: Record<string, any>): string;
  setState(said: string, et: string): void;
  /** Makes the next calls to `method` hang (for timeout tests). */
  hang(method: string): void;
  /** Answer for POST /credentials/verify. */
  verifyStatus: number;
}

export function createFakeKeria(opts: { agentPre?: string; host?: string } = {}): FakeKeria {
  const agentPre = opts.agentPre ?? aid('agent');
  const host = opts.host ?? 'http://keria.test:3902';
  const habs = new Map<string, { name: string; prefix: string; state: { s: string; d: string } }>();
  const regs = new Map<string, Array<{ name: string; regk: string }>>();
  const creds = new Map<string, { sad: Record<string, any>; iss: Record<string, any>; anc: Record<string, any> }>();
  const states = new Map<string, string>();
  const notes: Array<{ i: string; dt: string; r: boolean; a: { r: string; d: string } }> = [];
  const exns = new Map<string, Record<string, any>>();
  const hanging = new Set<string>();
  let n = 0;
  const calls: FakeKeria['calls'] = [];
  const grants: FakeKeria['grants'] = [];
  const op = (name: string, response?: unknown): KeriaOperation => ({ name: `${name}.${++n}`, done: true, ...(response !== undefined ? { response } : {}) });
  const rec = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
    if (hanging.has(method)) return new Promise<never>(() => {});
    return undefined;
  };
  const notFound = (what: string) => new Error(`HTTP GET ${what} - 404 Not Found`);

  const fake: FakeKeria = {
    agent: { pre: agentPre },
    calls,
    grants,
    verifyStatus: 202,
    hang: (m) => void hanging.add(m),
    setState: (said, et) => void states.set(said, et),
    deliver(route, exn) {
      const d = exn.d ?? aid(`exn${++n}`);
      exns.set(d, { ...exn, d });
      notes.push({ i: aid(`note${++n}`), dt: new Date().toISOString(), r: false, a: { r: route, d } });
      return d;
    },

    async fetch(path, method, data) {
      await rec('fetch', path, method, data);
      if (path === '/credentials/verify' && method === 'POST') {
        const body = data as { acdc: Record<string, any> };
        return new Response(JSON.stringify(op(`credential.${body.acdc.d}`)), { status: fake.verifyStatus });
      }
      return new Response('not found', { status: 404 });
    },

    identifiers: () => ({
      async get(name) {
        const h = habs.get(name);
        if (!h) throw notFound(`/identifiers/${name}`);
        return h;
      },
      async create(name, args) {
        rec('identifiers.create', name, args);
        habs.set(name, { name, prefix: aid(`aid-${name}`), state: { s: '0', d: aid(`icp-${name}`) } });
        return { op: async () => op('witness') };
      },
      async addEndRole(name, role, eid) {
        rec('identifiers.addEndRole', name, role, eid);
        return { op: async () => op('endrole') };
      },
      async addLocScheme(name, args) {
        rec('identifiers.addLocScheme', name, args);
        return { op: async () => op('locscheme') };
      },
    }),

    oobis: () => ({
      async get(name, role) {
        const h = habs.get(name);
        if (!h) throw notFound(`/identifiers/${name}/oobis`);
        return { role, oobis: [`${host}/oobi/${h.prefix}/agent/${agentPre}`] };
      },
      async resolve(oobi, alias) {
        rec('oobis.resolve', oobi, alias);
        const seg = new URL(oobi).pathname.split('/').filter(Boolean);
        return op('oobi', seg[1]?.length === 44 ? { i: seg[1] } : {});
      },
    }),

    operations: () => ({
      async wait(o) {
        const h = rec('operations.wait', o);
        if (h) return h;
        return { ...o, done: true };
      },
      async delete() {},
    }),

    registries: () => ({
      async list(name) {
        return regs.get(name) ?? [];
      },
      async create({ name, registryName }) {
        rec('registries.create', name, registryName);
        regs.set(name, [...(regs.get(name) ?? []), { name: registryName, regk: aid(`reg-${registryName}`) }]);
        return { op: async () => op('registry') };
      },
    }),

    credentials: () => ({
      async get(said) {
        const h = rec('credentials.get', said);
        if (h) return h;
        const c = creds.get(said);
        if (!c) throw notFound(`/credentials/${said}`);
        return { sad: c.sad, iss: c.iss, anc: c.anc, status: { et: states.get(said) ?? 'iss' } };
      },
      async issue(name, args) {
        rec('credentials.issue', name, args);
        const hab = habs.get(name);
        if (!hab) throw notFound(`/identifiers/${name}`);
        const [, subject] = Saider.saidify({ d: '', ...args.a, dt: new Date().toISOString().replace('Z', '000+00:00') });
        const [, acdc] = Saider.saidify({ v: versify(Protocols.ACDC, undefined, Serials.JSON, 0), d: '', i: hab.prefix, ri: args.ri, s: args.s, a: subject });
        const [, iss] = Saider.saidify({ v: versify(Protocols.KERI, undefined, Serials.JSON, 0), t: Ilks.iss, d: '', i: acdc.d, s: '0', ri: args.ri, dt: subject.dt });
        const anc = { t: 'ixn', i: hab.prefix, a: [{ i: iss.i, s: iss.s, d: iss.d }] };
        creds.set(acdc.d, { sad: acdc, iss, anc });
        states.set(acdc.d, 'iss');
        return { acdc: { sad: acdc }, iss: { sad: iss }, anc: { sad: anc }, op: op('credential') };
      },
      async revoke(name, said) {
        rec('credentials.revoke', name, said);
        states.set(said, 'rev');
        return { op: op('revoke') };
      },
      async state(_ri, said) {
        const h = rec('credentials.state', said);
        if (h) return h;
        const et = states.get(said);
        if (!et) throw notFound(`/registries/${_ri}/${said}`);
        return { et };
      },
    }),

    ipex: () => ({
      async grant(args) {
        rec('ipex.grant', args);
        const said = aid(`grant${++n}`);
        return [{ sad: { d: said, i: habs.get(args.senderName)?.prefix, e: { acdc: args.acdc.sad, iss: args.iss.sad } } }, ['sig'], 'atc'];
      },
      async submitGrant(name, exn, _sigs, _atc, recp) {
        rec('ipex.submitGrant', name, recp);
        grants.push({ said: exn.sad.d, recipient: recp[0]!, acdc: exn.sad.e.acdc });
        // KERIA 0.4 notifies the sender of its own grant too.
        fake.deliver('/exn/ipex/grant', { d: exn.sad.d, i: exn.sad.i, e: exn.sad.e });
        return op('exchange');
      },
    }),

    notifications: () => ({
      async list() {
        return { notes: notes.map((x) => ({ ...x, a: { ...x.a } })) };
      },
      async mark(id) {
        const x = notes.find((y) => y.i === id);
        if (x) x.r = true;
        return '';
      },
    }),

    exchanges: () => ({
      async get(said) {
        const exn = exns.get(said);
        if (!exn) throw notFound(`/exchanges/${said}`);
        return { exn: exn as { i: string } };
      },
    }),
  };
  return fake;
}

/** A plausible 44-character AID for tests. */
export const fakeAid = aid;

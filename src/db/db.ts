import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from '../domain/ports';
import type { Approval, Booking, EscrowRecord, FreelancerProfile, Job, SuitabilityScore } from '../domain/types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, client TEXT NOT NULL, client_ref TEXT, created_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS shortlists (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, round INTEGER NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shortlists_job ON shortlists(job_id);
CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_cache (source TEXT NOT NULL, query_key TEXT NOT NULL, fetched_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (source, query_key));
CREATE TABLE IF NOT EXISTS suitability (brief_key TEXT NOT NULL, profile_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (brief_key, profile_id));
CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bookings_job ON bookings(job_id);
CREATE INDEX IF NOT EXISTS bookings_status ON bookings(status);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, booking_id TEXT, thread TEXT NOT NULL, external_id TEXT, created_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_job ON messages(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_external ON messages(COALESCE(booking_id, ''), external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS escrows (id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS escrows_booking ON escrows(booking_id);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Row = Record<string, unknown>;
type Param = string | number | null;

export function createStore(dbPath: string): Store {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const run = (sql: string, ...params: Param[]) => db.prepare(sql).run(...params);
  const all = (sql: string, ...params: Param[]): Row[] => db.prepare(sql).all(...params) as Row[];
  const one = (sql: string, ...params: Param[]): Row | undefined => db.prepare(sql).get(...params) as Row | undefined;
  const parse = <T>(row: Row | undefined): T | null => (row ? (JSON.parse(row.data as string) as T) : null);
  const parseAll = <T>(rows: Row[]): T[] => rows.map((r) => JSON.parse(r.data as string) as T);

  /** Reads, merges and rewrites one JSON row; `index` re-derives the key columns. */
  function patchRow<T extends { updatedAt?: number }>(
    table: string,
    id: string,
    patch: Partial<T>,
    stamp: boolean,
    index: (v: T) => Record<string, Param>,
  ): T {
    const cur = parse<T>(one(`SELECT data FROM ${table} WHERE id = ?`, id));
    if (!cur) throw new Error(`${table.slice(0, -1)} not found: ${id}`);
    const next = { ...cur, ...patch, id } as T;
    if (stamp) next.updatedAt = Date.now();
    const cols = index(next);
    const sets = [...Object.keys(cols).map((c) => `${c} = ?`), 'data = ?'].join(', ');
    run(`UPDATE ${table} SET ${sets} WHERE id = ?`, ...Object.values(cols), JSON.stringify(next), id);
    return next;
  }

  const jobCols = (j: Job) => ({ status: j.status, client: j.client, client_ref: j.clientRef ?? null });
  const bookingCols = (b: Booking) => ({ job_id: b.jobId, status: b.status });
  const escrowCols = (e: EscrowRecord) => ({ booking_id: e.bookingId, status: e.status });
  const approvalCols = (a: Approval) => ({ status: a.status });

  const upsertProfile = (p: FreelancerProfile) =>
    run('INSERT INTO profiles (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', p.id, JSON.stringify(p));

  return {
    insertJob(job) {
      run('INSERT INTO jobs (id, status, client, client_ref, created_at, data) VALUES (?, ?, ?, ?, ?, ?)', job.id, job.status, job.client, job.clientRef ?? null, job.createdAt, JSON.stringify(job));
    },
    updateJob: (id, patch) => patchRow<Job>('jobs', id, patch, true, jobCols),
    getJob: (id) => parse<Job>(one('SELECT data FROM jobs WHERE id = ?', id)),
    listJobs(filter = {}) {
      const where: string[] = [];
      const params: Param[] = [];
      if (filter.status) (where.push('status = ?'), params.push(filter.status));
      if (filter.client) (where.push('client = ?'), params.push(filter.client));
      if (filter.clientRef) (where.push('client_ref = ?'), params.push(filter.clientRef));
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return parseAll<Job>(all(`SELECT data FROM jobs ${clause} ORDER BY created_at, rowid`, ...params));
    },

    insertShortlist(s) {
      run('INSERT INTO shortlists (id, job_id, round, created_at, data) VALUES (?, ?, ?, ?, ?)', s.id, s.jobId, s.round, s.createdAt, JSON.stringify(s));
    },
    getShortlist: (id) => parse(one('SELECT data FROM shortlists WHERE id = ?', id)),
    latestShortlist: (jobId) => parse(one('SELECT data FROM shortlists WHERE job_id = ? ORDER BY round DESC, created_at DESC, rowid DESC LIMIT 1', jobId)),
    listShortlists: (jobId) => parseAll(all('SELECT data FROM shortlists WHERE job_id = ? ORDER BY round, created_at, rowid', jobId)),

    putProfiles(source, queryKey, profiles) {
      db.exec('BEGIN');
      try {
        run(
          'INSERT INTO profile_cache (source, query_key, fetched_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(source, query_key) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data',
          source, queryKey, Date.now(), JSON.stringify(profiles),
        );
        for (const p of profiles) upsertProfile(p);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    getCachedProfiles(source, queryKey, maxAgeMs) {
      const row = one('SELECT fetched_at, data FROM profile_cache WHERE source = ? AND query_key = ?', source, queryKey);
      if (!row || Date.now() - (row.fetched_at as number) > maxAgeMs) return null;
      return JSON.parse(row.data as string) as FreelancerProfile[];
    },
    getProfile: (id) => parse(one('SELECT data FROM profiles WHERE id = ?', id)),

    getSuitability: (briefKey, profileId) => parse<SuitabilityScore>(one('SELECT data FROM suitability WHERE brief_key = ? AND profile_id = ?', briefKey, profileId)),
    putSuitability(briefKey, profileId, score) {
      run('INSERT INTO suitability (brief_key, profile_id, data) VALUES (?, ?, ?) ON CONFLICT(brief_key, profile_id) DO UPDATE SET data = excluded.data', briefKey, profileId, JSON.stringify(score));
    },

    insertBooking(b) {
      run('INSERT INTO bookings (id, job_id, status, data) VALUES (?, ?, ?, ?)', b.id, b.jobId, b.status, JSON.stringify(b));
    },
    updateBooking: (id, patch) => patchRow<Booking>('bookings', id, patch, true, bookingCols),
    getBooking: (id) => parse(one('SELECT data FROM bookings WHERE id = ?', id)),
    listBookings(filter = {}) {
      const where: string[] = [];
      const params: Param[] = [];
      if (filter.status) {
        if (filter.status.length === 0) return [];
        where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
        params.push(...filter.status);
      }
      if (filter.jobId) (where.push('job_id = ?'), params.push(filter.jobId));
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return parseAll<Booking>(all(`SELECT data FROM bookings ${clause} ORDER BY rowid`, ...params));
    },

    addMessage(m) {
      const res = db
        .prepare('INSERT OR IGNORE INTO messages (id, job_id, booking_id, thread, external_id, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(m.id, m.jobId, m.bookingId ?? null, m.thread, m.externalId ?? null, m.createdAt, JSON.stringify(m));
      return Number(res.changes) > 0;
    },
    listMessages(filter) {
      const where: string[] = [];
      const params: Param[] = [];
      if (filter.jobId) (where.push('job_id = ?'), params.push(filter.jobId));
      if (filter.bookingId) (where.push('booking_id = ?'), params.push(filter.bookingId));
      if (filter.thread) (where.push('thread = ?'), params.push(filter.thread));
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return parseAll(all(`SELECT data FROM messages ${clause} ORDER BY created_at, rowid`, ...params));
    },

    insertApproval(a) {
      run('INSERT INTO approvals (id, status, data) VALUES (?, ?, ?)', a.id, a.status, JSON.stringify(a));
    },
    updateApproval: (id, patch) => patchRow<Approval & { updatedAt?: number }>('approvals', id, patch, false, approvalCols),
    getApproval: (id) => parse(one('SELECT data FROM approvals WHERE id = ?', id)),
    listApprovals(filter = {}) {
      const rows = filter.status
        ? all('SELECT data FROM approvals WHERE status = ? ORDER BY rowid', filter.status)
        : all('SELECT data FROM approvals ORDER BY rowid');
      return parseAll<Approval>(rows);
    },

    insertEscrow(e) {
      run('INSERT INTO escrows (id, booking_id, status, data) VALUES (?, ?, ?, ?)', e.id, e.bookingId, e.status, JSON.stringify(e));
    },
    updateEscrow: (id, patch) => patchRow<EscrowRecord>('escrows', id, patch, true, escrowCols),
    getEscrow: (id) => parse(one('SELECT data FROM escrows WHERE id = ?', id)),
    getEscrowByBooking: (bookingId) => parse(one('SELECT data FROM escrows WHERE booking_id = ? ORDER BY rowid DESC LIMIT 1', bookingId)),
    listEscrows(filter = {}) {
      if (filter.status) {
        if (filter.status.length === 0) return [];
        return parseAll<EscrowRecord>(all(`SELECT data FROM escrows WHERE status IN (${filter.status.map(() => '?').join(',')}) ORDER BY rowid`, ...filter.status));
      }
      return parseAll<EscrowRecord>(all('SELECT data FROM escrows ORDER BY rowid'));
    },

    getKv: (key) => (one('SELECT value FROM kv WHERE key = ?', key)?.value as string | undefined) ?? null,
    setKv(key, value) {
      run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
    },

    close() {
      db.close();
    },
  };
}

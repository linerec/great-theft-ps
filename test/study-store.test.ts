// SPDX-License-Identifier: AGPL-3.0-only
//
// Keeping the scores of the mouse-feel study on the server: the file, the checks, whose they are, and what a person on the
// internet cannot do with them.

import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CENTER, DEFAULT_GAME, parseRating, type FeelRating } from '../src/engine/feel-study.ts';
import { AccountStore } from '../src/bridge/accounts.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';
import { MAX_PER_USER, StudyStore } from '../src/bridge/study-store.ts';
import { ConsoleStore } from '../src/console/store.ts';
import { FakeLink } from './support/fake-link.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const bridges: Bridge[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'gtp-study-'));
  dirs.push(d);
  return d;
};
after(async () => {
  for (const b of bridges) await b.close();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const NOW = Date.parse('2026-11-25T15:00:00Z');
function rating(id: string, over: Record<string, unknown> = {}): FeelRating {
  const parsed = parseRating({
    id, at: '2026-11-25T14:00:00.000Z', round: 'r1', preset: 'r1-07', feel: { degPerCount: 0.05, ...CENTER }, changed: false, score: 7, flags: { stop: -1 }, scene: 'aim', note: '',
    playout: 'balanced', delayMs: 40, latencyMs: 80, game: { ...DEFAULT_GAME, measured: false }, trial: { seconds: 40, speedShare: [0.1, 0.2, 0.3, 0.2, 0.1, 0.05, 0.05] }, ...over,
  }, NOW);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.rating;
}

describe('the file of study ratings', () => {
  it('keeps a rating across a restart, in a file only this user can read', () => {
    const dir = tmp();
    const a = new StudyStore(path.join(dir, 'study'), () => NOW);
    assert.equal(a.add('owner', rating('aaaaaaaa1')), 'stored');
    const b = new StudyStore(path.join(dir, 'study'), () => NOW);
    assert.equal(b.list('owner').length, 1);
    assert.equal(b.list('owner')[0]!.rating.score, 7);
    if (process.platform !== 'win32') assert.equal(statSync(a.file).mode & 0o777, 0o600);
  });

  it('knows a rating it has already kept (a page sends again what it is not sure arrived)', () => {
    const s = new StudyStore(path.join(tmp(), 'study'), () => NOW);
    assert.equal(s.add('owner', rating('aaaaaaaa1')), 'stored');
    assert.equal(s.add('owner', rating('aaaaaaaa1', { score: 2 })), 'duplicate');
    assert.equal(s.list('owner').length, 1);
    assert.equal(s.list('owner')[0]!.rating.score, 7, 'the first one stays');
    assert.equal(s.add('kid', rating('aaaaaaaa1')), 'stored', 'the same id from somebody else is somebody else\'s');
  });

  it('keeps each person\'s ratings apart, oldest first', () => {
    const s = new StudyStore(path.join(tmp(), 'study'), () => NOW);
    s.add('owner', rating('aaaaaaaa2', { at: '2026-11-25T14:05:00Z' }));
    s.add('owner', rating('aaaaaaaa1', { at: '2026-11-25T14:00:00Z' }));
    s.add('kid', rating('bbbbbbbb1'));
    assert.deepEqual(s.list('owner').map((x) => x.rating.id), ['aaaaaaaa1', 'aaaaaaaa2']);
    assert.equal(s.list('kid').length, 1);
    assert.equal(s.list().length, 3);
  });

  it('takes back only a person\'s own rating, and keeps the file in step', () => {
    const dir = path.join(tmp(), 'study');
    const s = new StudyStore(dir, () => NOW);
    s.add('owner', rating('aaaaaaaa1'));
    s.add('kid', rating('aaaaaaaa1'));
    assert.equal(s.remove('owner', 'nonexistent'), false);
    assert.equal(s.remove('owner', 'aaaaaaaa1'), true);
    assert.equal(s.list('kid').length, 1, 'the kid\'s one with the same id is still there');
    assert.equal(new StudyStore(dir, () => NOW).list().length, 1);
  });

  it('skips a damaged or doctored line and keeps the others', () => {
    const dir = path.join(tmp(), 'study');
    const s = new StudyStore(dir, () => NOW);
    s.add('owner', rating('aaaaaaaa1'));
    appendFileSync(s.file, 'this is not json\n');
    appendFileSync(s.file, `${JSON.stringify({ user: 'owner', receivedAt: 'x', rating: { ...rating('aaaaaaaa2'), score: 99 } })}\n`);
    s.add('owner', rating('aaaaaaaa3'));
    assert.deepEqual(new StudyStore(dir, () => NOW).list('owner').map((x) => x.rating.id), ['aaaaaaaa1', 'aaaaaaaa3']);
  });

  it('stops taking more from one person at a limit (the disk of a server on the internet is not for this)', () => {
    const s = new StudyStore(path.join(tmp(), 'study'), () => NOW);
    for (let i = 0; i < MAX_PER_USER; i++) s.add('owner', rating(`id${String(i).padStart(8, '0')}`));
    assert.equal(s.add('owner', rating('one-too-many')), 'full');
    assert.equal(s.add('kid', rating('kids-one-fits')), 'stored');
    assert.equal(readFileSync(s.file, 'utf8').split('\n').filter(Boolean).length, MAX_PER_USER + 1);
  });
});

describe('the study API', () => {
  async function rig(): Promise<{ call(method: string, url: string, body?: unknown, as?: string): Promise<{ status: number; data: any }>; owner: string; kid: string; study: StudyStore }> {
    const dir = tmp();
    const accounts = new AccountStore({ dir: path.join(dir, 'accounts'), scryptCost: { n: 1024, r: 8, p: 1 } });
    await accounts.acceptInvite(accounts.invite('owner', { role: 'owner' }).code, 'owner-password');
    await accounts.acceptInvite(accounts.invite('kid', { dailyMinutes: 30 }).code, 'kid-password-1');
    const study = new StudyStore(path.join(dir, 'study'));
    const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, accounts, study, store: new ConsoleStore(path.join(dir, 'consoles.json')), createLink: () => new FakeLink() });
    bridges.push(bridge);
    const base = `http://127.0.0.1:${bridge.port}`;
    const call = async (method: string, url: string, body?: unknown, as?: string): Promise<{ status: number; data: any }> => {
      const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(as ? { Cookie: `gtp_session=${as}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : null };
    };
    const login = async (name: string, password: string): Promise<string> => {
      const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password }) });
      return /gtp_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
    };
    return { call, owner: await login('owner', 'owner-password'), kid: await login('kid', 'kid-password-1'), study };
  }
  // A rating made now, because the server checks the time against its own clock.
  const fresh = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...rating(id, over), at: new Date().toISOString() });

  it('needs a login', async () => {
    const r = await rig();
    assert.equal((await r.call('GET', '/api/study/ratings')).status, 401);
    assert.equal((await r.call('POST', '/api/study/ratings', { ratings: [fresh('aaaaaaaa1')] })).status, 401);
  });

  it('keeps what passes the check, says what did not, and gives each person their own back', async () => {
    const r = await rig();
    const sent = await r.call('POST', '/api/study/ratings', { ratings: [fresh('aaaaaaaa1'), fresh('aaaaaaaa2', { score: 4 }), { ...fresh('aaaaaaaa3'), score: 42 }] }, r.kid);
    assert.equal(sent.status, 200);
    assert.deepEqual({ stored: sent.data.stored, duplicates: sent.data.duplicates, full: sent.data.full }, { stored: 2, duplicates: 0, full: 0 });
    assert.deepEqual(sent.data.rejected, [{ id: 'aaaaaaaa3', error: 'score' }]);
    const again = await r.call('POST', '/api/study/ratings', { ratings: [fresh('aaaaaaaa1')] }, r.kid);
    assert.equal(again.data.duplicates, 1);
    const mine = await r.call('GET', '/api/study/ratings', undefined, r.kid);
    assert.deepEqual(mine.data.ratings.map((x: FeelRating) => x.id), ['aaaaaaaa1', 'aaaaaaaa2']);
    assert.equal((await r.call('GET', '/api/study/ratings', undefined, r.owner)).data.ratings.length, 0, 'the owner does not see the kid\'s in their own list');
  });

  it('lets the owner read everybody\'s, and nobody else', async () => {
    const r = await rig();
    await r.call('POST', '/api/study/ratings', { ratings: [fresh('aaaaaaaa1')] }, r.kid);
    await r.call('POST', '/api/study/ratings', { ratings: [fresh('bbbbbbbb1')] }, r.owner);
    const all = await r.call('GET', '/api/study/ratings?user=all', undefined, r.owner);
    assert.equal(all.status, 200);
    assert.deepEqual(all.data.ratings.map((x: { user: string }) => x.user).sort(), ['kid', 'owner']);
    assert.equal((await r.call('GET', '/api/study/ratings?user=kid', undefined, r.owner)).data.ratings.length, 1);
    assert.equal((await r.call('GET', '/api/study/ratings?user=all', undefined, r.kid)).status, 403);
    assert.equal((await r.call('GET', '/api/study/ratings?user=owner', undefined, r.kid)).status, 403);
  });

  it('refuses a body that is not a list of one to forty scores', async () => {
    const r = await rig();
    for (const body of [{}, { ratings: [] }, { ratings: 'x' }, { ratings: Array.from({ length: 41 }, (_, i) => fresh(`id${String(i).padStart(8, '0')}`)) }]) {
      assert.equal((await r.call('POST', '/api/study/ratings', body, r.kid)).status, 400, JSON.stringify(body).slice(0, 40));
    }
  });

  it('lets a person take back their own score and nobody else\'s', async () => {
    const r = await rig();
    await r.call('POST', '/api/study/ratings', { ratings: [fresh('aaaaaaaa1')] }, r.kid);
    assert.equal((await r.call('DELETE', '/api/study/ratings/aaaaaaaa1', undefined, r.owner)).status, 404, 'the owner\'s own list does not have it');
    assert.equal((await r.call('DELETE', '/api/study/ratings/aaaaaaaa1', undefined, r.kid)).status, 200);
    assert.equal(r.study.list().length, 0);
  });

  it('is off (404) on a bridge that was not given a store', async () => {
    const dir = tmp();
    const accounts = new AccountStore({ dir: path.join(dir, 'accounts'), scryptCost: { n: 1024, r: 8, p: 1 } });
    await accounts.acceptInvite(accounts.invite('owner', { role: 'owner' }).code, 'owner-password');
    const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, accounts, store: new ConsoleStore(path.join(dir, 'consoles.json')), createLink: () => new FakeLink() });
    bridges.push(bridge);
    const login = await fetch(`http://127.0.0.1:${bridge.port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'owner', password: 'owner-password' }) });
    const cookie = /gtp_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1]!;
    assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/api/study/ratings`, { headers: { Cookie: `gtp_session=${cookie}` } })).status, 404);
  });
});

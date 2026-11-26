// SPDX-License-Identifier: AGPL-3.0-only
//
// A console registered for more than one PSN account, and each person choosing which one they play as: the store and
// the /api/ endpoints. Registration and the session request are stubs here.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeLink } from './support/fake-link.ts';
import { AccountStore } from '../src/bridge/accounts.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';
import type { ConsoleLink, LinkStartOptions } from '../src/bridge/console-link.ts';
import { Ps5Link } from '../src/bridge/ps5-link.ts';
import { DEFAULT_QUALITY } from '../src/bridge/quality.ts';
import type { RegisteredConsole } from '../src/console/regist.ts';
import type { SessionRequestOptions } from '../src/console/session.ts';
import { accountHint, cleanLabel, ConsoleStore, profileIdOf, UNKNOWN_PROFILE } from '../src/console/store.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const bridges: Bridge[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'gtp-profiles-'));
  dirs.push(d);
  return d;
};
after(async () => {
  for (const b of bridges) await b.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const MAC = '0123456789ab';
// Two account ids: the numbers 258 and 123456789, as base64 of their 8 bytes.
const A = 'AgEAAAAAAAA=';
const B = 'Fc1bBwAAAAA=';
const KEY_A = '61616161616161610000000000000000';
const KEY_B = '62626262626262620000000000000000';
const reg = (registKey: string, over: Partial<RegisteredConsole> = {}): RegisteredConsole => ({
  target: 'ps5-1',
  mac: MAC,
  nickname: 'Living room',
  registKey: Buffer.from(registKey, 'hex'),
  rpKeyType: 2,
  rpKey: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
  ...over,
});
const two = (file = path.join(tmp(), 'consoles.json')): ConsoleStore => {
  const store = new ConsoleStore(file);
  store.put(reg(KEY_A), '192.168.1.50', { accountId: A, label: 'Dad' });
  store.put(reg(KEY_B), '192.168.1.50', { accountId: B });
  return store;
};

describe('a console registered for two PSN accounts', () => {
  it('keeps both registrations, shows the console once, and never shows the account ids', () => {
    const store = two();
    assert.equal(store.list().length, 1, 'one console');
    const profiles = store.profiles(MAC);
    assert.deepEqual(profiles.map((p) => [p.id, p.label, p.hint]), [[profileIdOf(A), 'Dad', '258'], [profileIdOf(B), '', '6789']]);
    assert.ok(!JSON.stringify(profiles).includes(A) && !JSON.stringify(profiles).includes(KEY_A));
    assert.equal(store.get(MAC)?.registKey, KEY_A, 'without a choice: the first registration');
    assert.equal(store.get(MAC, profileIdOf(B))?.registKey, KEY_B);
    assert.equal(store.get(MAC, 'ffffffff'), undefined);
    assert.equal(new ConsoleStore(store.file).profiles(MAC).length, 2, 'survives a restart');
  });

  it('registering an account again replaces only that account, keeps its label and its place', () => {
    const store = two();
    store.put(reg('63636363636363630000000000000000'), '192.168.1.51', { accountId: A });
    assert.deepEqual(store.profiles(MAC).map((p) => p.label), ['Dad', '']);
    assert.equal(store.get(MAC)?.registKey, '63636363636363630000000000000000', 'still the first');
    assert.equal(store.get(MAC, profileIdOf(B))?.registKey, KEY_B);
    assert.equal(store.get(MAC, profileIdOf(B))?.host, '192.168.1.51', 'the address is the console\'s, so both follow it');
  });

  it('lets each person choose, and falls back to the first when the chosen one is gone', () => {
    const store = two();
    assert.equal(store.chosen('kid', MAC), profileIdOf(A));
    assert.equal(store.choose('kid', MAC, profileIdOf(B)), true);
    assert.equal(store.choose('kid', MAC, 'ffffffff'), false, 'not something that is not registered');
    assert.equal(store.chosen('kid', MAC), profileIdOf(B));
    assert.equal(store.chosen('owner', MAC), profileIdOf(A), 'one person\'s choice is not another\'s');
    assert.equal(store.getFor(MAC, 'kid')?.registKey, KEY_B);
    assert.equal(new ConsoleStore(store.file).getFor(MAC, 'kid')?.registKey, KEY_B, 'the choice is kept');
    assert.equal(store.choose('__proto__', MAC, profileIdOf(B)), true, 'a strange name is a name');
    assert.equal(store.chosen('constructor', MAC), profileIdOf(A));

    assert.equal(store.remove(MAC, profileIdOf(B)), true);
    assert.equal(store.profiles(MAC).length, 1);
    assert.equal(store.getFor(MAC, 'kid')?.registKey, KEY_A);
    assert.equal(store.remove(MAC), true, 'without a profile the console goes as a whole');
    assert.equal(store.chosen('kid', MAC), undefined);
  });

  it('marks as verified the registration that was used, and moves both to a new address', () => {
    const store = two();
    assert.equal(store.markVerified(MAC, '192.168.1.60', profileIdOf(B)), true);
    const [a, b] = store.profiles(MAC);
    assert.equal(a!.verifiedAt, undefined);
    assert.ok(b!.verifiedAt);
    assert.equal(store.get(MAC)?.host, '192.168.1.60');
    store.setHost(MAC, '192.168.1.61');
    assert.equal(store.get(MAC, profileIdOf(B))?.host, '192.168.1.61');
  });

  it('names and renames an account, as one short line', () => {
    const store = two();
    assert.equal(store.setLabel(MAC, profileIdOf(B), '  Kids\n\tprofile  '), true);
    assert.equal(store.profiles(MAC)[1]!.label, 'Kids  profile');
    assert.equal(store.setLabel(MAC, 'ffffffff', 'x'), false);
    assert.equal(cleanLabel('가'.repeat(60)).length, 40);
    assert.equal(cleanLabel(7), '');
  });

  it('reads a file from before accounts were kept: the registration belongs to the saved account id', () => {
    const file = path.join(tmp(), 'consoles.json');
    const old = { version: 1, accountId: A, consoles: [{ mac: MAC, nickname: 'Living room', target: 'ps5-1', host: '192.168.1.50', registKey: KEY_A, rpKeyType: 2, rpKey: '00112233445566778899aabbccddeeff', registeredAt: '2026-01-01T00:00:00.000Z' }] };
    writeFileSync(file, JSON.stringify(old));
    const store = new ConsoleStore(file);
    assert.deepEqual(store.profiles(MAC).map((p) => p.id), [profileIdOf(A)]);
    // The second account is added next to it, and registering the first again does not make a third.
    store.put(reg(KEY_B), '192.168.1.50', { accountId: B });
    store.put(reg(KEY_A), '192.168.1.50', { accountId: A });
    assert.deepEqual(store.profiles(MAC).map((p) => p.id), [profileIdOf(A), profileIdOf(B)]);

    const noId = path.join(tmp(), 'consoles.json');
    writeFileSync(noId, JSON.stringify({ ...old, accountId: undefined }));
    assert.deepEqual(new ConsoleStore(noId).profiles(MAC).map((p) => [p.id, p.hint]), [[UNKNOWN_PROFILE, '']]);
    assert.equal(accountHint('nonsense'), '');
  });

  it('a backup carries both registrations but not who plays as which', () => {
    const from = two();
    from.choose('kid', MAC, profileIdOf(B));
    const to = new ConsoleStore(path.join(tmp(), 'consoles.json'));
    const r = to.merge(from.snapshot());
    assert.equal(r.added.length, 2);
    assert.deepEqual(to.profiles(MAC).map((p) => p.label), ['Dad', '']);
    assert.equal(to.chosen('kid', MAC), profileIdOf(A));
    assert.equal(to.merge(from.snapshot()).kept.length, 2, 'the same copy again changes nothing');
    assert.ok(!readFileSync(to.file, 'utf8').includes('choices'));
  });

  it('drops choices that are not well formed', () => {
    const file = path.join(tmp(), 'consoles.json');
    const store = two(file);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.choices = { kid: { [MAC]: profileIdOf(B), zz: 'x' }, bad: 5, worse: { [MAC]: 7 } };
    writeFileSync(file, JSON.stringify(data));
    const again = new ConsoleStore(file);
    assert.equal(again.chosen('kid', MAC), profileIdOf(B));
    assert.deepEqual(again.snapshot().choices, { kid: { [MAC]: profileIdOf(B) } });
    assert.ok(store);
  });
});

// ------------------------------------------------------------------ the endpoints

async function setup(o: { accounts?: boolean } = {}) {
  const dir = tmp();
  const store = new ConsoleStore(path.join(dir, 'consoles.json'));
  const lines: string[] = [];
  const sessions: SessionRequestOptions[] = [];
  let accounts: AccountStore | undefined;
  if (o.accounts) {
    accounts = new AccountStore({ dir: path.join(dir, 'accounts'), scryptCost: { n: 1024, r: 8, p: 1 } });
    await accounts.acceptInvite(accounts.invite('owner', { role: 'owner' }).code, 'owner-password');
    await accounts.acceptInvite(accounts.invite('kid', { dailyMinutes: 60 }).code, 'kid-password-1');
  }
  let nextKey = KEY_A;
  const bridge = await startBridge({
    host: '127.0.0.1', port: 0, root, store, createLink: () => new FakeLink(), log: (l) => lines.push(l),
    ...(accounts ? { accounts } : {}),
    api: {
      discover: async () => ({ hosts: [{ address: '192.168.1.50', state: 'ready', statusCode: 200, hostName: 'PS5-TEST', hostType: 'PS5', hostId: MAC.toUpperCase(), isPs5: true, target: 'ps5-1' }] }),
      register: async () => reg(nextKey),
      session: async (s) => void sessions.push(s),
    },
  });
  bridges.push(bridge);
  const call = async (method: string, url: string, body?: unknown, as?: string): Promise<{ status: number; data: any }> => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}${url}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(as ? { Cookie: `gtp_session=${as}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  const login = async (name: string, password: string): Promise<string> => (await accounts!.login(name, password))!.session;
  return { store, lines, sessions, call, login, registerWith: (key: string) => (nextKey = key) };
}

describe('/api/ with more than one PSN account', () => {
  it('registers a second account next to the first, with a name, and lists both', async () => {
    const { store, call, registerWith, lines } = await setup();
    const first = await call('POST', '/api/register', { host: '192.168.1.50', pin: '12345678', accountId: '258', label: 'Dad' });
    assert.equal(first.status, 200);
    assert.equal(first.data.registered, profileIdOf(A));
    registerWith(KEY_B);
    const second = await call('POST', '/api/register', { host: '192.168.1.50', pin: '12345678', accountId: '123456789', label: 'Kids' });
    assert.equal(second.status, 200);
    assert.deepEqual(second.data.console.profiles.map((p: { label: string }) => p.label), ['Dad', 'Kids']);
    assert.equal(store.get(MAC, profileIdOf(B))?.registKey, KEY_B);
    assert.equal(store.get(MAC)?.registKey, KEY_A, 'the first registration was not replaced');

    const list = await call('GET', '/api/consoles');
    assert.equal(list.data.consoles.length, 1);
    assert.equal(list.data.consoles[0].profile, profileIdOf(A));
    assert.equal(list.data.accountHint, '6789', 'the account the next registration would be for');
    for (const secret of [A, B, KEY_A, KEY_B]) assert.ok(!JSON.stringify([first.data, second.data, list.data, lines]).includes(secret), `${secret} stays on this side`);
  });

  it('switches the account, and the check and the removal follow it', async () => {
    const { store, call, sessions } = await setup();
    store.put(reg(KEY_A), '192.168.1.50', { accountId: A });
    store.put(reg(KEY_B), '192.168.1.50', { accountId: B });

    assert.equal((await call('POST', '/api/consoles/profile', { mac: MAC, profile: 'ffffffff' })).status, 404);
    assert.equal((await call('POST', '/api/consoles/profile', { mac: MAC, profile: 'NOT VALID' })).status, 400);
    assert.equal((await call('POST', '/api/consoles/profile', { mac: MAC, profile: profileIdOf(B) })).status, 200);
    assert.equal((await call('GET', '/api/consoles')).data.consoles[0].profile, profileIdOf(B));

    const check = await call('POST', '/api/session-check', { mac: MAC });
    assert.equal(check.status, 200);
    assert.equal(check.data.profile, profileIdOf(B));
    assert.equal(Buffer.from(sessions[0]!.registKey).toString('hex'), KEY_B, 'asked with the chosen account\'s registration');
    await call('POST', '/api/session-check', { mac: MAC, profile: profileIdOf(A) });
    assert.equal(Buffer.from(sessions[1]!.registKey).toString('hex'), KEY_A, 'or with the one named');

    const renamed = await call('POST', '/api/consoles/profile-label', { mac: MAC, profile: profileIdOf(B), label: 'Kids' });
    assert.equal(renamed.data.profiles[1].label, 'Kids');

    assert.equal((await call('DELETE', `/api/consoles/${MAC}?profile=${profileIdOf(B)}`)).status, 200);
    assert.deepEqual(store.profiles(MAC).map((p) => p.id), [profileIdOf(A)]);
    assert.equal((await call('GET', '/api/consoles')).data.consoles[0].profile, profileIdOf(A), 'back to the one that is left');
    assert.equal((await call('DELETE', `/api/consoles/${MAC}?profile=${profileIdOf(B)}`)).status, 404);
  });

  it('with logins: everyone chooses their own, only the owner chooses for others, renames or removes', async () => {
    const { store, call, login } = await setup({ accounts: true });
    store.put(reg(KEY_A), '192.168.1.50', { accountId: A });
    store.put(reg(KEY_B), '192.168.1.50', { accountId: B });
    const owner = await login('owner', 'owner-password');
    const kid = await login('kid', 'kid-password-1');
    const b = profileIdOf(B);

    assert.equal((await call('POST', '/api/consoles/profile', { mac: MAC, profile: b })).status, 401, 'not without a login');
    assert.equal((await call('POST', '/api/consoles/profile', { mac: MAC, profile: b }, kid)).status, 200);
    assert.equal((await call('GET', '/api/consoles', undefined, kid)).data.consoles[0].profile, b);
    assert.equal((await call('GET', '/api/consoles', undefined, owner)).data.consoles[0].profile, profileIdOf(A), 'the owner still plays as the first');

    assert.equal((await call('POST', '/api/consoles/profile', { mac: MAC, profile: b, user: 'owner' }, kid)).status, 403);
    assert.equal((await call('POST', '/api/consoles/profile-label', { mac: MAC, profile: b, label: 'Mine' }, kid)).status, 403);
    assert.equal((await call('DELETE', `/api/consoles/${MAC}?profile=${b}`, undefined, kid)).status, 403);
    assert.equal(store.profiles(MAC)[1]!.label, '');

    assert.equal((await call('POST', '/api/consoles/profile', { mac: MAC, profile: profileIdOf(A), user: 'kid' }, owner)).status, 200);
    assert.equal(store.chosen('kid', MAC), profileIdOf(A));
    assert.equal((await call('POST', '/api/consoles/profile', { mac: MAC, profile: b, user: 'nobody' }, owner)).status, 404);
  });
});

// ------------------------------------------------------------------ the connection

describe('connecting as the chosen PSN account', () => {
  /** The link up to its session request: which registration it asked the console with. */
  async function askedWith(store: ConsoleStore, options: LinkStartOptions): Promise<string> {
    let key = '';
    const link = new Ps5Link({
      store, wake: false,
      session: async (s) => {
        key = Buffer.from(s.registKey).toString('hex');
        throw new Error('far enough');
      },
    });
    await link.start({ onVideo: () => {}, onStatus: () => {} }, DEFAULT_QUALITY, options).catch(() => {});
    await link.stop();
    return key;
  }

  it('asks the console with the registration of the account the person chose', async () => {
    const store = two();
    store.choose('kid', MAC, profileIdOf(B));
    assert.equal(await askedWith(store, { user: 'kid' }), KEY_B);
    assert.equal(await askedWith(store, { user: 'owner' }), KEY_A, 'who has not chosen plays as the first');
    assert.equal(await askedWith(store, {}), KEY_A);
  });

  it('the bridge tells the link who is playing: the login name, or "local" without logins', async () => {
    const seen: LinkStartOptions[] = [];
    const recording = (): ConsoleLink => {
      const link = new FakeLink();
      const start = link.start.bind(link);
      link.start = (h, q, o) => (seen.push(o ?? {}), start(h, q, o));
      return link;
    };
    const play = async (port: number, cookie?: string): Promise<void> => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, cookie ? ({ headers: { Cookie: `gtp_session=${cookie}` } } as never) : undefined);
      const n = seen.length;
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', client: 'test' }));
        ws.onerror = () => reject(new Error('websocket error'));
        const timer = setInterval(() => seen.length > n && (clearInterval(timer), resolve()), 20);
      });
      const closed = new Promise((r) => (ws.onclose = r));
      ws.close();
      await closed;
    };

    const dir = tmp();
    const plain = await startBridge({ host: '127.0.0.1', port: 0, root, store: new ConsoleStore(path.join(dir, 'a.json')), createLink: recording });
    bridges.push(plain);
    await play(plain.port);
    assert.equal(seen.at(-1)!.user, 'local');

    const accounts = new AccountStore({ dir: path.join(dir, 'accounts'), scryptCost: { n: 1024, r: 8, p: 1 } });
    await accounts.acceptInvite(accounts.invite('owner', { role: 'owner' }).code, 'owner-password');
    await accounts.acceptInvite(accounts.invite('kid', { dailyMinutes: 60 }).code, 'kid-password-1');
    const withLogins = await startBridge({ host: '127.0.0.1', port: 0, root, accounts, store: new ConsoleStore(path.join(dir, 'b.json')), createLink: recording });
    bridges.push(withLogins);
    await play(withLogins.port, (await accounts.login('kid', 'kid-password-1'))!.session);
    assert.equal(seen.at(-1)!.user, 'kid');
  });
});

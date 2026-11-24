// SPDX-License-Identifier: AGPL-3.0-only
//
// Logging in to a bridge: the /api/ side, the WebSocket, and minutes per day.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ConsoleStore } from '../src/console/store.ts';
import { AccountStore } from '../src/bridge/accounts.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';
import { FakeLink } from './support/fake-link.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const bridges: Bridge[] = [];
after(async () => {
  for (const b of bridges) await b.close();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

interface Rig {
  bridge: Bridge;
  accounts: AccountStore;
  base: string;
  /** Call the API; `as` is a session value (sent as the cookie). */
  call(method: string, url: string, body?: unknown, o?: { as?: string; headers?: Record<string, string> }): Promise<{ status: number; data: any; cookie: string | null }>;
  /** Log in and give the session value. */
  session(name: string, password: string): Promise<string>;
}

async function rig(o: { token?: string } = {}): Promise<Rig> {
  const dir = mkdtempSync(path.join(tmpdir(), 'gtp-auth-'));
  dirs.push(dir);
  const accounts = new AccountStore({ dir: path.join(dir, 'accounts') });
  const owner = accounts.invite('owner', { role: 'owner' });
  await accounts.acceptInvite(owner.code, 'owner-password');
  const kid = accounts.invite('kid', { dailyMinutes: 1 });
  await accounts.acceptInvite(kid.code, 'kid-password-1');
  const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, accounts, ...(o.token ? { token: o.token } : {}), store: new ConsoleStore(path.join(dir, 'consoles.json')), createLink: () => new FakeLink() });
  bridges.push(bridge);
  const base = `http://127.0.0.1:${bridge.port}`;
  const call: Rig['call'] = async (method, url, body, opt = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opt.as ? { Cookie: `gtp_session=${opt.as}` } : {}), ...opt.headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie') };
  };
  const session = async (name: string, password: string): Promise<string> => {
    const r = await call('POST', '/api/login', { name, password });
    assert.equal(r.status, 200);
    return /gtp_session=([^;]+)/.exec(r.cookie ?? '')![1]!;
  };
  return { bridge, accounts, base, call, session };
}

describe('logging in over the API', () => {
  it('asks for a login before anything else, and says so in the answer', async () => {
    const r = await rig();
    const me = await r.call('GET', '/api/me');
    assert.equal(me.status, 401);
    assert.equal(me.data.login, true);
    assert.equal((await r.call('GET', '/api/consoles')).status, 401);
    assert.equal((await r.call('GET', '/api/discover')).status, 401);
    assert.equal((await r.call('GET', '/api/consoles', undefined, { as: 'forged' })).status, 401);
  });

  it('logs in, sets a cookie a script cannot read, and then answers', async () => {
    const r = await rig();
    const login = await r.call('POST', '/api/login', { name: 'kid', password: 'kid-password-1' });
    assert.equal(login.status, 200);
    assert.match(login.cookie!, /^gtp_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/, 'not Secure on plain http');
    const sess = /gtp_session=([^;]+)/.exec(login.cookie!)![1]!;
    const me = await r.call('GET', '/api/me', undefined, { as: sess });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.name, 'kid');
    assert.equal(me.data.remainingSeconds, 60);
    assert.equal((await r.call('GET', '/api/consoles', undefined, { as: sess })).status, 200);
    const out = await r.call('POST', '/api/logout', {}, { as: sess });
    assert.match(out.cookie!, /Max-Age=0/);
    assert.equal((await r.call('GET', '/api/consoles', undefined, { as: sess })).status, 401, 'the session is over');
  });

  it('marks the cookie Secure when a proxy on this computer says the page came over HTTPS', async () => {
    const r = await rig();
    const login = await r.call('POST', '/api/login', { name: 'kid', password: 'kid-password-1' }, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(login.cookie!, /; Secure$/);
  });

  it('slows down wrong guesses per name and per address, and a right login after the wait still works', async () => {
    const r = await rig();
    for (let i = 0; i < 6; i++) assert.equal((await r.call('POST', '/api/login', { name: 'kid', password: `wrong-guess-${i}` })).status, 401);
    const held = await r.call('POST', '/api/login', { name: 'kid', password: 'kid-password-1' });
    assert.equal(held.status, 429, 'even the right password waits');
    assert.ok(held.data.retryAfterSeconds >= 1);
    // The address is held up as well, whatever name is tried.
    assert.equal((await r.call('POST', '/api/login', { name: 'someone', password: 'whatever-it-is' })).status, 429);
    // Behind a proxy the address is the one the proxy reports, so one visitor does not hold everybody up.
    const other = await r.call('POST', '/api/login', { name: 'owner', password: 'owner-password' }, { headers: { 'X-Real-IP': '203.0.113.9' } });
    assert.equal(other.status, 200);
  });

  it('refuses a cross-site page and a form post', async () => {
    const r = await rig();
    assert.equal((await r.call('POST', '/api/login', { name: 'kid', password: 'kid-password-1' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const form = await fetch(`${r.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=kid&password=kid-password-1' });
    assert.equal(form.status, 415);
  });
});

describe('who may do what', () => {
  it('lets only the owner register or forget consoles, set tuning and manage people', async () => {
    const r = await rig();
    const owner = await r.session('owner', 'owner-password');
    const kid = await r.session('kid', 'kid-password-1');
    for (const [method, url, body] of [['POST', '/api/register', { host: '192.0.2.1', pin: '12345678' }], ['DELETE', '/api/consoles/aabbccddeeff', undefined], ['POST', '/api/stream/tuning', {}], ['POST', '/api/session-check', { mac: 'aabbccddeeff' }], ['GET', '/api/users', undefined], ['POST', '/api/users/invite', { name: 'x' }]] as const) {
      const denied = await r.call(method, url, body, { as: kid });
      assert.equal(denied.status, 403, `${method} ${url} is not for members`);
      assert.notEqual((await r.call(method, url, body, { as: owner })).status, 403, `${method} ${url} is for the owner`);
    }
    // What a member does need stays open to them.
    assert.equal((await r.call('GET', '/api/consoles', undefined, { as: kid })).status, 200);
    assert.equal((await r.call('GET', '/api/handover', undefined, { as: kid })).status, 200);
  });

  it('lets the owner invite, change minutes, switch off and remove people', async () => {
    const r = await rig();
    const owner = await r.session('owner', 'owner-password');
    const invited = await r.call('POST', '/api/users/invite', { name: 'guest', minutes: 45 }, { as: owner });
    assert.equal(invited.status, 200);
    assert.equal(invited.data.user.dailyMinutes, 45);
    const code: string = invited.data.code;
    assert.equal((await r.call('POST', '/api/invite-info', { code })).data.name, 'guest');
    const bad = await r.call('POST', '/api/accept-invite', { code, password: 'short' });
    assert.equal(bad.status, 400);
    const accepted = await r.call('POST', '/api/accept-invite', { code, password: 'guest-password' });
    assert.equal(accepted.status, 200);
    assert.match(accepted.cookie!, /gtp_session=/, 'accepting the invitation logs in');
    assert.equal((await r.call('POST', '/api/accept-invite', { code, password: 'guest-password' })).status, 404, 'a code works once');
    assert.equal((await r.call('POST', '/api/users/minutes', { name: 'guest', minutes: null }, { as: owner })).data.user.dailyMinutes, null);
    assert.equal((await r.call('POST', '/api/users/minutes', { name: 'guest', minutes: 9999 }, { as: owner })).status, 400);
    assert.equal((await r.call('POST', '/api/users/disable', { name: 'guest', disabled: true }, { as: owner })).data.user.disabled, true);
    assert.equal((await r.call('POST', '/api/login', { name: 'guest', password: 'guest-password' })).status, 401);
    assert.equal((await r.call('POST', '/api/users/disable', { name: 'owner', disabled: true }, { as: owner })).status, 400, 'not oneself');
    assert.equal((await r.call('POST', '/api/users/remove', { name: 'guest' }, { as: owner })).status, 200);
    const list = await r.call('GET', '/api/users', undefined, { as: owner });
    assert.deepEqual(list.data.users.map((u: { name: string }) => u.name).sort(), ['kid', 'owner']);
    assert.ok(!JSON.stringify(list.data).includes('scrypt'), 'no hash is ever sent');
  });

  it('keeps the token for tools: it works as the owner, but only where one is set', async () => {
    const r = await rig({ token: 'tool-token' });
    assert.equal((await r.call('GET', '/api/consoles', undefined, { headers: { Authorization: 'Bearer tool-token' } })).status, 200);
    assert.equal((await r.call('GET', '/api/consoles', undefined, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await r.call('DELETE', '/api/consoles/aabbccddeeff', undefined, { headers: { Authorization: 'Bearer tool-token' } })).status, 404);
  });

  it('is not there at all on a bridge without accounts', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gtp-auth-'));
    dirs.push(dir);
    const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, store: new ConsoleStore(path.join(dir, 'c.json')), createLink: () => new FakeLink() });
    bridges.push(bridge);
    const me = await fetch(`http://127.0.0.1:${bridge.port}/api/me`);
    assert.deepEqual(await me.json(), { accounts: false });
    assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/api/consoles`)).status, 200);
  });
});

/** A WebSocket client for these tests; `cookie` is the session value. */
function open(port: number, cookie?: string): Promise<{ ws: WebSocket; messages: any[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, cookie ? ({ headers: { Cookie: `gtp_session=${cookie}` } } as never) : undefined);
    const messages: any[] = [];
    const closed = new Promise<number>((res) => (ws.onclose = (e) => res(e.code)));
    ws.onmessage = (e) => typeof e.data === 'string' && messages.push(JSON.parse(e.data));
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', client: 'test' }));
      resolve({ ws, messages, closed });
    };
    ws.onerror = () => reject(new Error('websocket error'));
  });
}
const until = async (f: () => boolean, ms = 6000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    assert.ok(Date.now() < end, 'timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('playing with a login', () => {
  it('refuses a page that is not logged in', async () => {
    const r = await rig();
    const c = await open(r.bridge.port);
    assert.equal(await c.closed, 4401);
    assert.equal(c.messages[0].code, 'unauthorized');
  });

  it('lets the owner play with no limit (the time is still written down, it just never ends the stream)', async () => {
    const r = await rig();
    const owner = await r.session('owner', 'owner-password');
    const c = await open(r.bridge.port, owner);
    await until(() => c.messages.some((m) => m.type === 'ready'));
    await until(() => c.messages.some((m) => m.type === 'quota'));
    assert.equal(c.messages.find((m) => m.type === 'quota').remainingSeconds, null);
    c.ws.close();
    await c.closed;
    assert.ok(r.accounts.usedSeconds('owner') <= 2);
    assert.equal(r.accounts.remainingSeconds('owner'), null);
  });

  it('counts a member\'s seconds, tells the page how many are left, and ends the stream when they run out', async () => {
    const r = await rig(); // kid: 1 minute a day
    r.accounts.addUsage('kid', 57); // 3 seconds left
    const kid = await r.session('kid', 'kid-password-1');
    const c = await open(r.bridge.port, kid);
    await until(() => c.messages.some((m) => m.type === 'ready'));
    await until(() => c.messages.some((m) => m.type === 'quota'));
    assert.ok(c.messages.find((m) => m.type === 'quota').remainingSeconds <= 3);
    assert.equal(await c.closed, 4403, 'ended by the bridge when the minutes are up');
    assert.ok(c.messages.some((m) => m.code === 'quota-ended'));
    assert.ok(r.accounts.usedSeconds('kid') >= 59, `used ${r.accounts.usedSeconds('kid')}`);
    assert.equal(r.accounts.remainingSeconds('kid'), 0);
  });

  it('does not even start the console when no time is left', async () => {
    const r = await rig();
    r.accounts.addUsage('kid', 60);
    const kid = await r.session('kid', 'kid-password-1');
    const c = await open(r.bridge.port, kid);
    assert.equal(await c.closed, 4403);
    assert.ok(c.messages.some((m) => m.code === 'quota-exhausted'));
    assert.ok(!c.messages.some((m) => m.type === 'ready'));
  });

  it('keeps the seconds already played when the member leaves early', async () => {
    const r = await rig();
    const kid = await r.session('kid', 'kid-password-1');
    const c = await open(r.bridge.port, kid);
    await until(() => c.messages.some((m) => m.type === 'ready'));
    await new Promise((res) => setTimeout(res, 2300));
    c.ws.close();
    await c.closed;
    await until(() => r.accounts.usedSeconds('kid') >= 2);
    assert.ok(r.accounts.usedSeconds('kid') <= 4);
  });
});

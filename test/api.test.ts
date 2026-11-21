// SPDX-License-Identifier: AGPL-3.0-only
//
// The console store and the /api/ endpoints the page uses to register consoles. Discovery and registration are
// replaced by stubs here; the real registration flow is covered in regist.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MockConsole } from '../src/bridge/mock-console.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';
import type { DiscoveredHost } from '../src/console/discovery.ts';
import { RegistError, type RegisterOptions, type RegisteredConsole } from '../src/console/regist.ts';
import { ConsoleStore } from '../src/console/store.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const bridges: Bridge[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'gtp-store-'));
  dirs.push(d);
  return d;
};
after(async () => {
  for (const b of bridges) await b.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const RP_KEY_HEX = '00112233445566778899aabbccddeeff';
const REGIST_KEY_HEX = '61626364656667680000000000000000';
const registered = (over: Partial<RegisteredConsole> = {}): RegisteredConsole => ({
  target: 'ps5-1',
  mac: '0123456789ab',
  nickname: 'Living room',
  registKey: Buffer.from(REGIST_KEY_HEX, 'hex'),
  rpKeyType: 2,
  rpKey: Buffer.from(RP_KEY_HEX, 'hex'),
  ...over,
});

describe('console store', () => {
  it('keeps secrets in the file and shows only the public part', () => {
    const file = path.join(tmp(), 'sub', 'consoles.json');
    const store = new ConsoleStore(file);
    assert.deepEqual(store.list(), []);
    const pub = store.put(registered(), '192.168.1.50');
    assert.deepEqual(Object.keys(pub).sort(), ['host', 'mac', 'nickname', 'registeredAt', 'target']);
    assert.deepEqual(Object.keys(store.list()[0]!).sort(), ['host', 'mac', 'nickname', 'registeredAt', 'target']);
    assert.equal(store.get('0123456789AB')?.rpKey, RP_KEY_HEX, 'lookup ignores case, and the full record has the key');
    assert.ok(readFileSync(file, 'utf8').includes(RP_KEY_HEX));
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, 'owner-only file');
    assert.equal(new ConsoleStore(file).list().length, 1, 'survives a restart');
  });

  it('replaces a console registered again, forgets one on request, remembers the account id', () => {
    const file = path.join(tmp(), 'consoles.json');
    const store = new ConsoleStore(file);
    store.put(registered(), '192.168.1.50');
    store.put(registered({ nickname: 'Renamed' }), '192.168.1.51');
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]!.nickname, 'Renamed');
    store.setAccountId('AQIDBAUGBwg=');
    assert.equal(new ConsoleStore(file).accountId, 'AQIDBAUGBwg=');
    assert.equal(store.remove('0123456789ab'), true);
    assert.equal(store.remove('0123456789ab'), false);
    assert.equal(store.list().length, 0);
  });

  it('refuses to silently overwrite a file it cannot read, and drops malformed entries', () => {
    const dir = tmp();
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    assert.throws(() => new ConsoleStore(bad), /not valid JSON/);
    const partial = path.join(dir, 'partial.json');
    writeFileSync(partial, JSON.stringify({ version: 1, accountId: 'nonsense', consoles: [{ mac: 'zz' }, null, 5] }));
    const s = new ConsoleStore(partial);
    assert.deepEqual(s.list(), []);
    assert.equal(s.accountId, undefined);
  });
});

// ------------------------------------------------------------------ the endpoints

interface Reply {
  status: number;
  text: string;
  json: () => any;
}

function call(port: number, method: string, urlPath: string, o: { body?: unknown; headers?: Record<string, string>; json?: boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    const headers: Record<string, string> = { ...(payload !== undefined && o.json !== false ? { 'Content-Type': 'application/json' } : {}), ...o.headers };
    const req = request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const host = (over: Partial<DiscoveredHost> = {}): DiscoveredHost => ({
  address: '192.168.1.50', state: 'ready', statusCode: 200, hostName: 'PS5-TEST', hostType: 'PS5', hostId: '0123456789AB', isPs5: true, target: 'ps5-1', ...over,
});

async function apiBridge(o: { token?: string; register?: (r: RegisterOptions) => Promise<RegisteredConsole>; hosts?: DiscoveredHost[] } = {}) {
  const store = new ConsoleStore(path.join(tmp(), 'consoles.json'));
  const calls: RegisterOptions[] = [];
  const lines: string[] = [];
  const bridge = await startBridge({
    host: '127.0.0.1', port: 0, root, store, createLink: () => new MockConsole(), log: (l) => lines.push(l),
    ...(o.token !== undefined ? { token: o.token } : {}),
    api: {
      discover: async () => ({ hosts: o.hosts ?? [host()] }),
      register: async (r) => {
        calls.push(r);
        return (o.register ?? (async () => registered()))(r);
      },
    },
  });
  bridges.push(bridge);
  return { bridge, store, calls, lines };
}

describe('/api/ endpoints', () => {
  it('registers a console, keeps the keys on this side and remembers the account id', async () => {
    const { bridge, store, calls, lines } = await apiBridge();
    const PIN = '24680135'; // must not occur inside the test MAC or keys, or the "not leaked" checks below would be meaningless
    const first = await call(bridge.port, 'POST', '/api/register', { body: { host: '192.168.1.50', pin: PIN, accountId: '258' } });
    assert.equal(first.status, 200);
    assert.equal(first.json().console.nickname, 'Living room');
    for (const secret of [RP_KEY_HEX, REGIST_KEY_HEX, PIN]) assert.ok(!first.text.includes(secret), `no secret in the response: ${secret.slice(0, 4)}...`);
    assert.equal(calls[0]!.pin, PIN, 'the PIN did reach the registration call');
    assert.equal(calls[0]!.target, 'ps5-1', 'the target comes from discovery when the page does not send one');
    assert.equal(store.get('0123456789ab')?.rpKey, RP_KEY_HEX);
    assert.equal(store.accountId, 'AgEAAAAAAAA=', 'saved normalised as base64 of the 8 bytes');
    assert.ok(!lines.join('\n').includes(PIN), 'the PIN is not logged');

    const second = await call(bridge.port, 'POST', '/api/register', { body: { host: '192.168.1.50', pin: '87654321' } });
    assert.equal(second.status, 200, 'the saved account id is used when none is sent');
    assert.equal(calls[1]!.accountId, 'AgEAAAAAAAA=');

    const list = await call(bridge.port, 'GET', '/api/consoles');
    assert.deepEqual(list.json().consoles.map((c: { mac: string }) => c.mac), ['0123456789ab']);
    assert.equal(list.json().accountIdSaved, true);
    assert.ok(!list.text.includes(RP_KEY_HEX));
  });

  it('needs an account id the first time', async () => {
    const { bridge, calls } = await apiBridge();
    const r = await call(bridge.port, 'POST', '/api/register', { body: { host: '192.168.1.50', pin: '12345678' } });
    assert.equal(r.status, 400);
    assert.equal(r.json().error, 'account-id-needed');
    assert.equal(calls.length, 0);
  });

  it('reports a rejection from the console and stores nothing', async () => {
    const { bridge, store } = await apiBridge({
      register: async () => {
        throw new RegistError('rejected', 'The console answered 403: Registration failed, most likely a wrong or expired PIN', 0x80108b09);
      },
    });
    const r = await call(bridge.port, 'POST', '/api/register', { body: { host: '192.168.1.50', pin: '00000000', accountId: '1' } });
    assert.equal(r.status, 403);
    assert.equal(r.json().reason, 0x80108b09);
    assert.match(r.json().message, /PIN/);
    assert.deepEqual(store.list(), []);
    assert.equal(store.accountId, undefined, 'a failed attempt does not save the account id');
  });

  it('marks discovered consoles that are already registered', async () => {
    const { bridge, store } = await apiBridge({ hosts: [host(), host({ hostId: 'FFEEDDCCBBAA', address: '192.168.1.51', hostName: 'OTHER' })] });
    store.put(registered(), '192.168.1.50');
    const r = await call(bridge.port, 'GET', '/api/discover');
    assert.deepEqual(r.json().hosts.map((h: { registered: boolean }) => h.registered), [true, false]);
    assert.equal((await call(bridge.port, 'GET', '/api/discover?host=not-an-ip')).status, 400);
  });

  it('forgets a registration', async () => {
    const { bridge, store } = await apiBridge();
    store.put(registered(), '192.168.1.50');
    assert.equal((await call(bridge.port, 'DELETE', '/api/consoles/0123456789ab')).status, 200);
    assert.equal((await call(bridge.port, 'DELETE', '/api/consoles/0123456789ab')).status, 404);
    assert.deepEqual(store.list(), []);
  });

  it('keeps other web pages out and wants JSON', async () => {
    const { bridge, calls } = await apiBridge();
    const body = { host: '192.168.1.50', pin: '12345678', accountId: '1' };
    assert.equal((await call(bridge.port, 'POST', '/api/register', { body, headers: { Origin: 'https://evil.example' } })).status, 403, 'cross-origin page');
    assert.equal((await call(bridge.port, 'GET', '/api/consoles', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call(bridge.port, 'POST', '/api/register', { body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain' }, json: false })).status, 415, 'a plain form post');
    assert.equal((await call(bridge.port, 'GET', '/api/consoles', { headers: { Host: 'evil.example' } })).status, 421, 'DNS rebinding');
    assert.equal((await call(bridge.port, 'GET', '/api/consoles', { headers: { Origin: `http://127.0.0.1:${bridge.port}` } })).status, 200, 'the page itself');
    assert.equal((await call(bridge.port, 'POST', '/api/register', { body: { ...body, host: 'example.com' } })).status, 400, 'host must be an IP address');
    assert.equal((await call(bridge.port, 'POST', '/api/register', { body: '{ nope' })).status, 500, 'garbage body does not crash it');
    assert.equal(calls.length, 0);
  });

  it('requires the token when one is configured', async () => {
    const { bridge } = await apiBridge({ token: 'secret-token' });
    assert.equal((await call(bridge.port, 'GET', '/api/consoles')).status, 401);
    assert.equal((await call(bridge.port, 'GET', '/api/consoles', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await call(bridge.port, 'GET', '/api/consoles', { headers: { Authorization: 'Bearer secret-token' } })).status, 200);
  });

  it('is simply absent when no store is given', async () => {
    const b = await startBridge({ host: '127.0.0.1', port: 0, root, createLink: () => new MockConsole() });
    bridges.push(b);
    assert.equal((await call(b.port, 'GET', '/api/consoles')).status, 404);
  });
});

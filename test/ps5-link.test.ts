// SPDX-License-Identifier: AGPL-3.0-only
//
// The link for a real PS5: which console it picks, what it says at each step, and that it stops honestly at the first step
// that is not built, rather than showing a picture that is not the console's. The session request itself is replaced here
// (it is covered in session.test.ts); nothing talks to a console.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startBridge, type Bridge } from '../src/bridge/server.ts';
import { Ps5Link } from '../src/bridge/ps5-link.ts';
import type { LinkStatus } from '../src/bridge/console-link.ts';
import { DEFAULT_QUALITY } from '../src/bridge/quality.ts';
import type { RegisteredConsole } from '../src/console/regist.ts';
import { initAuth } from '../src/console/rpcrypt.ts';
import { SessionError, type SessionRequestOptions } from '../src/console/session.ts';
import { ConsoleStore } from '../src/console/store.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const bridges: Bridge[] = [];
after(async () => {
  for (const b of bridges) await b.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const RP_KEY = '00112233445566778899aabbccddeeff';
const reg = (over: Partial<RegisteredConsole> = {}): RegisteredConsole => ({
  target: 'ps5-1', mac: '0123456789ab', nickname: 'Living room', registKey: Buffer.from('61626364656667680000000000000000', 'hex'), rpKeyType: 2, rpKey: Buffer.from(RP_KEY, 'hex'), ...over,
});
function storeWith(...consoles: Array<[RegisteredConsole, string]>): ConsoleStore {
  const d = mkdtempSync(path.join(tmpdir(), 'gtp-link-'));
  dirs.push(d);
  const s = new ConsoleStore(path.join(d, 'consoles.json'));
  for (const [c, host] of consoles) s.put(c, host);
  return s;
}
const grant = async (o: SessionRequestOptions) => ({ target: 'ps5-1' as const, nonce: new Uint8Array(16), crypt: initAuth('ps5-1', new Uint8Array(16), o.rpKey) });
const run = async (link: Ps5Link, mac?: string): Promise<{ statuses: LinkStatus[]; error: Error | null }> => {
  const statuses: LinkStatus[] = [];
  try {
    await link.start({ onVideo: () => assert.fail('no video can exist yet'), onStatus: (s) => statuses.push(s) }, DEFAULT_QUALITY, mac ? { mac } : {});
    return { statuses, error: null };
  } catch (e) {
    return { statuses, error: e as Error };
  }
};

describe('the PS5 link', () => {
  it('asks the registered console for a session with its stored keys, then says plainly that the rest is not built', async () => {
    const store = storeWith([reg(), '192.168.1.50']);
    const asked: SessionRequestOptions[] = [];
    const link = new Ps5Link({ store, session: async (o) => (asked.push(o), grant(o)) });
    const { statuses, error } = await run(link);

    assert.equal(link.name, 'ps5');
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.host, '192.168.1.50');
    assert.equal(asked[0]!.target, 'ps5-1');
    assert.equal(Buffer.from(asked[0]!.rpKey).toString('hex'), RP_KEY, 'the stored keys reach the request');
    assert.deepEqual(statuses.map((s) => s.state), ['connecting', 'connecting']);
    assert.match(statuses[0]!.detail!, /세션을 요청하는 중/);
    assert.match(statuses[1]!.detail!, /받아들였습니다/);
    assert.ok(error, 'it must not pretend to stream');
    assert.match(error!.message, /아직 구현 중/);
    assert.match(error!.message, /화면은 나오지 않습니다/);
    assert.ok(store.list()[0]!.verifiedAt, 'a console that accepted the session counts as verified');
  });

  it('picks the console it is asked for, and the first one otherwise', async () => {
    const store = storeWith([reg({ mac: 'aaaaaaaaaaaa', nickname: 'First' }), '192.168.1.10'], [reg({ mac: 'bbbbbbbbbbbb', nickname: 'Second' }), '192.168.1.11']);
    const hosts: string[] = [];
    const link = () => new Ps5Link({ store, session: async (o) => (hosts.push(o.host), grant(o)) });
    await run(link(), 'bbbbbbbbbbbb');
    await run(link());
    assert.deepEqual(hosts, ['192.168.1.11', '192.168.1.10']);
  });

  it('says what is missing instead of trying anything', async () => {
    const none = await run(new Ps5Link({ store: storeWith(), session: async () => assert.fail('no request without a console') }));
    assert.match(none.error!.message, /등록된 PS5가 없습니다/);
    assert.deepEqual(none.statuses, []);
    const wrong = await run(new Ps5Link({ store: storeWith([reg(), '192.168.1.50']), session: async () => assert.fail('no request for an unknown console') }), 'ffffffffffff');
    assert.match(wrong.error!.message, /선택한 콘솔/);
  });

  it('turns the console\'s refusal into a message that names the console and keeps the reason', async () => {
    const link = new Ps5Link({
      store: storeWith([reg(), '192.168.1.50']),
      session: async () => {
        throw new SessionError('rejected', 'The console answered 403: Registration failed, most likely a wrong or expired PIN (0x80108b09)', { reason: 0x80108b09 });
      },
    });
    const { error } = await run(link);
    assert.match(error!.message, /Living room.*세션을 받아들이지 않았습니다/);
    assert.match(error!.message, /0x80108b09/);
  });

  it('does not mark a console verified when it refused', async () => {
    const store = storeWith([reg(), '192.168.1.50']);
    await run(new Ps5Link({ store, session: async () => { throw new SessionError('timeout', 'no answer'); } }));
    assert.equal(store.list()[0]!.verifiedAt, undefined);
  });

  it('stays quiet when it is stopped while waiting for the console', async () => {
    const store = storeWith([reg(), '192.168.1.50']);
    let release!: () => void;
    const link = new Ps5Link({ store, session: (o) => new Promise((resolve) => (release = () => resolve(grant(o)))) });
    const started = run(link);
    await new Promise((r) => setTimeout(r, 20));
    await link.stop();
    release();
    const { error } = await started;
    assert.equal(error, null, 'a stopped link does not report an error nobody is waiting for');
  });
});

describe('through the bridge', () => {
  it('passes the chosen console to the link and delivers the plain message to the page', async () => {
    const store = storeWith([reg({ mac: 'aaaaaaaaaaaa', nickname: 'First' }), '192.168.1.10'], [reg({ mac: 'bbbbbbbbbbbb', nickname: 'Second' }), '192.168.1.11']);
    const hosts: string[] = [];
    const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, store, createLink: () => new Ps5Link({ store, session: async (o) => (hosts.push(o.host), grant(o)) }) });
    bridges.push(bridge);

    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
    const seen: Array<Record<string, any>> = [];
    let closeCode = 0;
    ws.onmessage = (e) => typeof e.data === 'string' && seen.push(JSON.parse(e.data));
    const closed = new Promise<void>((resolve) => (ws.onclose = (e) => ((closeCode = e.code), resolve())));
    await new Promise<void>((resolve, reject) => ((ws.onopen = () => resolve()), (ws.onerror = () => reject(new Error('ws error')))));
    ws.send(JSON.stringify({ type: 'hello', console: 'BBBBBBBBBBBB', client: 'test' })); // upper case is accepted and normalised
    await closed;

    assert.deepEqual(hosts, ['192.168.1.11'], 'the second console was the one asked');
    const error = seen.find((m) => m.type === 'error')!;
    assert.equal(error.code, 'link');
    assert.match(error.message, /아직 구현 중/);
    assert.equal(closeCode, 1011);
    assert.ok(!seen.some((m) => m.type === 'ready'), 'the page is never told it is ready');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// One bridge that answers on several addresses (BridgeOptions.also): this computer's own address without a token next to
// another one with TLS and a token, as `npm run dev` does for a phone.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeLink } from './support/fake-link.ts';
import { selfSigned } from './support/selfsigned.ts';
import { ConsoleStore } from '../src/console/store.ts';
import { portInUse } from '../src/bridge/ports.ts';
import { startBridge, type Bridge, type BridgeOptions } from '../src/bridge/server.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridges: Bridge[] = [];
const dirs: string[] = [];
const sockets: net.Server[] = [];
after(async () => {
  for (const b of bridges) await b.close();
  sockets.forEach((s) => s.close());
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const NAME = 'bridge.test';
const TOKEN = 'phone-secret';

async function start(extra: Partial<BridgeOptions> = {}, also?: BridgeOptions['also']): Promise<Bridge> {
  const dir = mkdtempSync(path.join(tmpdir(), 'gtp-faces-'));
  dirs.push(dir);
  const bridge = await startBridge({
    host: '127.0.0.1',
    port: 0,
    root,
    store: new ConsoleStore(path.join(dir, 'consoles.json')),
    createLink: () => new FakeLink(),
    ...(also ? { also } : { also: [{ host: '127.0.0.1', port: 0, token: TOKEN }] }),
    ...extra,
  });
  bridges.push(bridge);
  return bridge;
}

/** A page's connection: what the bridge said, its answer to the hello, and a way to close it. */
async function open(port: number, token?: string): Promise<{ ws: WebSocket; messages: Array<Record<string, any>>; result: Record<string, any> | undefined; closed: Promise<number> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: Array<Record<string, any>> = [];
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') messages.push(JSON.parse(e.data));
  };
  const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
  await new Promise<void>((resolve, reject) => ((ws.onopen = () => resolve()), (ws.onerror = () => reject(new Error('ws error')))));
  ws.send(JSON.stringify({ type: 'hello', client: 'test', ...(token !== undefined ? { token } : {}) }));
  const answered = (): Record<string, any> | undefined => messages.find((m) => m.type === 'ready' || m.type === 'error');
  for (let i = 0; i < 100 && !answered(); i++) await sleep(10);
  // `result` is the bridge's answer to the hello: ready, or an error (the status messages that come first are not it).
  return { ws, messages, result: answered(), closed };
}

describe('one bridge, more than one address', () => {
  it('reports every address it answers on, with the scheme that address uses', async () => {
    const cert = selfSigned({ names: [NAME] });
    const b = await start({}, [{ host: '127.0.0.1', port: 0, token: TOKEN, trustedHosts: [NAME], tls: cert }]);
    assert.match(b.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(b.also.length, 1);
    assert.match(b.also[0]!.url, /^https:\/\/127\.0\.0\.1:\d+\/$/);
    assert.notEqual(b.port, b.also[0]!.port);
  });

  it('lets a page in without a token on the one address and asks for the token on the other', async () => {
    const b = await start();
    const own = await open(b.port);
    assert.equal(own.result?.type, 'ready', 'no token needed on the computer\'s own address');
    own.ws.close();
    await own.closed;
    await sleep(100);

    const without = await open(b.also[0]!.port);
    assert.equal(without.result?.code, 'unauthorized');
    assert.equal(await without.closed, 4401);

    const wrong = await open(b.also[0]!.port, 'not-the-token');
    assert.equal(wrong.result?.code, 'unauthorized');
    await wrong.closed;

    const right = await open(b.also[0]!.port, TOKEN);
    assert.equal(right.result?.type, 'ready');
    right.ws.close();
    await right.closed;
  });

  it('takes one client at a time across the addresses', async () => {
    const b = await start();
    const first = await open(b.port);
    assert.equal(first.result?.type, 'ready');
    const second = await open(b.also[0]!.port, TOKEN);
    assert.equal(second.result?.code, 'busy', 'a phone cannot join while a page on the computer has the console');
    assert.equal(await second.closed, 4409);
    first.ws.close();
    await first.closed;
    await sleep(150);
    const third = await open(b.also[0]!.port, TOKEN);
    assert.equal(third.result?.type, 'ready', 'and can once that one has let go');
    third.ws.close();
    await third.closed;
  });

  it('applies the API\'s token rule per address', async () => {
    const b = await start();
    const get = async (port: number, token?: string): Promise<number> => (await fetch(`http://127.0.0.1:${port}/api/consoles`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).status;
    assert.equal(await get(b.port), 200);
    assert.equal(await get(b.also[0]!.port), 401);
    assert.equal(await get(b.also[0]!.port, 'wrong'), 401);
    assert.equal(await get(b.also[0]!.port, TOKEN), 200);
  });

  it('serves HTTPS on the other address under its own name only', async () => {
    const cert = selfSigned({ names: [NAME] });
    const b = await start({}, [{ host: '127.0.0.1', port: 0, token: TOKEN, trustedHosts: [NAME], tls: cert }]);
    const get = (host: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port: b.also[0]!.port, ca: cert.cert, servername: NAME });
        let text = '';
        socket.on('secureConnect', () => socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
        socket.on('data', (d) => (text += d.toString('latin1')));
        socket.on('close', () => resolve(text.split('\r\n')[0] ?? ''));
        socket.on('error', reject);
      });
    assert.match(await get(`${NAME}:${b.also[0]!.port}`), /200/);
    assert.match(await get('evil.example'), /421/);
    // The computer's own address is plain HTTP, whatever the other one does.
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/`)).status, 200);
  });

  it('needs a token for an extra address, even on loopback', async () => {
    await assert.rejects(start({}, [{ host: '127.0.0.1', port: 0, token: '' }]), /needs a token/);
  });

  it('does not leave the first address running when the second cannot start', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    sockets.push(holder);
    const busy = (holder.address() as net.AddressInfo).port;
    const spare = net.createServer();
    await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
    const free = (spare.address() as net.AddressInfo).port;
    await new Promise((resolve) => spare.close(resolve));

    await assert.rejects(start({ port: free }, [{ host: '127.0.0.1', port: busy, token: TOKEN }]), /already in use/);
    await sleep(100);
    assert.equal(await portInUse('127.0.0.1', free), false, 'the first address was not left behind');
  });

  it('closes every address when the bridge closes', async () => {
    const b = await start();
    const ports = [b.port, b.also[0]!.port];
    await b.close();
    bridges.splice(bridges.indexOf(b), 1);
    for (const p of ports) assert.equal(await portInUse('127.0.0.1', p), false);
  });
});

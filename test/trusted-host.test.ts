// SPDX-License-Identifier: AGPL-3.0-only
//
// Reaching the bridge from another device through an HTTPS proxy on its own computer (for example `tailscale serve`):
// the bridge stays on loopback, accepts requests that name the trusted host, and then wants a token for everything.
// The requests here are made by hand, with the Host and Origin a proxy would send.

import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeLink } from './support/fake-link.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';
import { hostName, originAllowed } from '../src/bridge/static.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridges: Bridge[] = [];
after(async () => {
  for (const b of bridges) await b.close();
});

const NAME = 'gtp-home.example-tailnet.ts.net';
const TOKEN = 'correct-horse-battery-staple';

/** One raw HTTP exchange: returns the status line and the whole answer. */
function raw(port: number, lines: string[]): Promise<{ status: string; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let text = '';
    socket.on('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n`));
    socket.on('data', (d) => {
      text += d.toString('latin1');
      if (text.includes('\r\n\r\n')) socket.destroy();
    });
    socket.on('close', () => resolve({ status: text.split('\r\n')[0] ?? '', text }));
    socket.on('error', reject);
    setTimeout(() => socket.destroy(), 3000);
  });
}
const upgrade = (port: number, host: string, origin: string): Promise<{ status: string; text: string }> =>
  raw(port, ['GET /ws HTTP/1.1', `Host: ${host}`, `Origin: ${origin}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13']);

async function bridge(trustedHosts?: string[], token?: string): Promise<Bridge> {
  const b = await startBridge({ host: '127.0.0.1', port: 0, root, createLink: () => new FakeLink(), ...(trustedHosts ? { trustedHosts } : {}), ...(token ? { token } : {}) });
  bridges.push(b);
  return b;
}

describe('a bridge behind an HTTPS proxy on its own computer', () => {
  it('refuses to trust a host name without a token', async () => {
    await assert.rejects(startBridge({ host: '127.0.0.1', port: 0, root, createLink: () => new FakeLink(), trustedHosts: [NAME] }), /requires a token/);
  });

  it('answers requests that name the trusted host, and still not ones that name anything else', async () => {
    const b = await bridge([NAME], TOKEN);
    assert.match((await raw(b.port, ['GET / HTTP/1.1', `Host: ${NAME}`, 'Connection: close'])).status, / 200 /);
    assert.match((await raw(b.port, ['GET / HTTP/1.1', `Host: ${NAME.toUpperCase()}:443`, 'Connection: close'])).status, / 200 /, 'whatever the case and the port');
    assert.match((await raw(b.port, ['GET / HTTP/1.1', `Host: 127.0.0.1:${b.port}`, 'Connection: close'])).status, / 200 /, 'on the computer itself as before');
    assert.match((await raw(b.port, ['GET / HTTP/1.1', 'Host: evil.example', 'Connection: close'])).status, / 421 /);
    assert.match((await raw(b.port, ['GET / HTTP/1.1', `Host: not-${NAME}`, 'Connection: close'])).status, / 421 /);
  });

  it('without the option, a bridge on loopback answers to nothing but loopback', async () => {
    const b = await bridge();
    assert.match((await raw(b.port, ['GET / HTTP/1.1', `Host: ${NAME}`, 'Connection: close'])).status, / 421 /);
    assert.match((await upgrade(b.port, `127.0.0.1:${b.port}`, `https://${NAME}`)).status, / 403 /);
  });

  it('lets the page connect whether the proxy passes the public host on or replaces it with the local one', async () => {
    const b = await bridge([NAME], TOKEN);
    assert.match((await upgrade(b.port, NAME, `https://${NAME}`)).status, / 101 /, 'the proxy kept the Host');
    assert.match((await upgrade(b.port, `127.0.0.1:${b.port}`, `https://${NAME}`)).status, / 101 /, 'the proxy put its own Host in');
    assert.match((await upgrade(b.port, NAME, 'https://evil.example')).status, / 403 /, 'another page cannot');
    assert.match((await upgrade(b.port, `127.0.0.1:${b.port}`, 'https://evil.example')).status, / 403 /);
  });

  it('wants the token for the connection itself', async () => {
    const b = await bridge([NAME], TOKEN);
    const hello = (token?: string): Promise<{ type?: string; code?: string }> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws`);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', client: 'test', ...(token ? { token } : {}) }));
        ws.onmessage = (e) => {
          if (typeof e.data !== 'string') return;
          const m = JSON.parse(e.data) as { type?: string; code?: string };
          if (m.type === 'ready' || m.type === 'error') {
            resolve(m);
            ws.close();
          }
        };
      });
    assert.deepEqual((await hello()).code, 'unauthorized');
    assert.deepEqual((await hello('wrong')).code, 'unauthorized');
    assert.equal((await hello(TOKEN)).type, 'ready');
  });
});

describe('the origin check', () => {
  it('accepts the same origin and trusted names, and nothing else', () => {
    assert.equal(originAllowed(undefined, 'anything', []), true, 'not a browser: the token decides');
    assert.equal(originAllowed('http://127.0.0.1:8788', '127.0.0.1:8788', []), true);
    assert.equal(originAllowed('http://127.0.0.1:9999', '127.0.0.1:8788', []), false);
    assert.equal(originAllowed(`https://${NAME}`, '127.0.0.1:8788', [NAME]), true);
    assert.equal(originAllowed(`https://${NAME}:8443`, '127.0.0.1:8788', [NAME]), true);
    assert.equal(originAllowed(`https://x.${NAME}`, '127.0.0.1:8788', [NAME]), false, 'a name that only ends the same is another host');
    assert.equal(originAllowed('not a url', '127.0.0.1:8788', [NAME]), false);
    assert.equal(hostName('Name.TS.net:443'), 'name.ts.net');
  });
});

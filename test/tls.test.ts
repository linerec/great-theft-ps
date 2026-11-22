// SPDX-License-Identifier: AGPL-3.0-only
//
// The bridge serving HTTPS itself (src/bridge/tls.ts, --tls-cert and --tls-key), and the Host check that goes with
// reaching it from another device. Certificates are made inside the tests (test/support/selfsigned.ts): no key is kept
// in the repository.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeLink } from './support/fake-link.ts';
import { selfSigned } from './support/selfsigned.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';
import { hostAllowed } from '../src/bridge/static.ts';
import { describeExpiry, explainListenError, loadTls, namesNotCovered, TlsError } from '../src/bridge/tls.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridges: Bridge[] = [];
const dirs: string[] = [];
after(async () => {
  for (const b of bridges) await b.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const NAME = 'bridge.test';

function files(s: { cert: string; key: string }): { certFile: string; keyFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'gtp-tls-'));
  dirs.push(dir);
  const certFile = path.join(dir, 'c.crt');
  const keyFile = path.join(dir, 'c.key');
  writeFileSync(certFile, s.cert);
  writeFileSync(keyFile, s.key, { mode: 0o600 });
  return { certFile, keyFile };
}

describe('reading the certificate and key', () => {
  it('returns the names and the end of validity', () => {
    const notAfter = new Date('2031-03-04T05:06:07Z');
    const { certFile, keyFile } = files(selfSigned({ names: [NAME, 'other.test'], notAfter }));
    const m = loadTls(certFile, keyFile);
    assert.deepEqual(m.names, [NAME, 'other.test']);
    assert.equal(m.notAfter.toISOString(), notAfter.toISOString());
    assert.ok(Buffer.isBuffer(m.cert) && Buffer.isBuffer(m.key));
  });

  it('refuses a key that does not belong to the certificate', () => {
    const a = selfSigned({ names: [NAME] });
    const b = selfSigned({ names: [NAME] });
    const { certFile, keyFile } = files({ cert: a.cert, key: b.key });
    assert.throws(() => loadTls(certFile, keyFile), (e: unknown) => e instanceof TlsError && /does not belong/.test(e.message));
  });

  it('says what is wrong with a missing file and with files that are not PEM', () => {
    const s = selfSigned({ names: [NAME] });
    const { certFile, keyFile } = files(s);
    assert.throws(() => loadTls(`${certFile}.missing`, keyFile), /cannot read the certificate .*ENOENT/);
    assert.throws(() => loadTls(certFile, `${keyFile}.missing`), /cannot read the private key .*ENOENT/);
    const junk = files({ cert: 'not a certificate', key: 'not a key' });
    assert.throws(() => loadTls(junk.certFile, keyFile), /is not a certificate/);
    assert.throws(() => loadTls(certFile, junk.keyFile), /is not a private key/);
  });
});

describe('how long the certificate lasts', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const after = (ms: number): Date => new Date(now.getTime() + ms);
  const DAY = 86_400_000;

  it('is fine with weeks left', () => {
    const r = describeExpiry(after(32 * DAY + 3600_000), now);
    assert.equal(r.level, 'ok');
    assert.equal(r.days, 32);
    assert.match(r.text, /valid until 2026-12-23 \(32 days\)/);
  });

  it('warns in the last two weeks, in the singular for one day', () => {
    assert.equal(describeExpiry(after(14 * DAY + 3600_000), now).level, 'soon');
    assert.equal(describeExpiry(after(15 * DAY + 3600_000), now).level, 'ok');
    assert.match(describeExpiry(after(10 * DAY + 3600_000), now).text, /only 10 days more/);
    assert.match(describeExpiry(after(DAY + 3600_000), now).text, /only 1 day more/);
  });

  it('says expired once the time has passed', () => {
    const r = describeExpiry(after(-DAY), now);
    assert.equal(r.level, 'expired');
    assert.match(r.text, /expired on 2026-11-20/);
  });
});

describe('names a certificate is for', () => {
  it('finds trusted names it does not cover, wildcards standing for one label', () => {
    assert.deepEqual(namesNotCovered(['a.example.com', '*.ts.net'], ['a.example.com', 'x.ts.net', 'x.y.ts.net', 'other.org']), ['x.y.ts.net', 'other.org']);
    assert.deepEqual(namesNotCovered([NAME], [NAME]), []);
    assert.deepEqual(namesNotCovered([], [NAME]), [NAME]);
  });
});

describe('why listening failed', () => {
  const e = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
  it('names Tailscale when the address is not this computer\'s', () => {
    assert.match(explainListenError(e('EADDRNOTAVAIL'), '100.64.0.2', 8788).message, /100\.64\.0\.2.*Tailscale running/);
  });
  it('explains a port in use and a port that needs rights, and passes other errors on', () => {
    assert.match(explainListenError(e('EADDRINUSE'), '127.0.0.1', 8788).message, /port 8788 .* already in use/);
    assert.match(explainListenError(e('EACCES'), '127.0.0.1', 443).message, /below 1024/);
    assert.doesNotMatch(explainListenError(e('EACCES'), '127.0.0.1', 8788).message, /below 1024/);
    const other = e('EPIPE');
    assert.equal(explainListenError(other, '127.0.0.1', 8788), other);
  });
});

describe('which Host the bridge answers to', () => {
  const trusted = [NAME];

  it('bound to loopback: loopback names on its port, and the trusted names', () => {
    const o = { bound: '127.0.0.1', port: 8788, trusted };
    assert.equal(hostAllowed('127.0.0.1:8788', o), true);
    assert.equal(hostAllowed('localhost:8788', o), true);
    assert.equal(hostAllowed('[::1]:8788', o), true);
    assert.equal(hostAllowed('127.0.0.1:9999', o), false);
    assert.equal(hostAllowed('evil.example', o), false);
    assert.equal(hostAllowed(`${NAME}:443`, o), true);
    assert.equal(hostAllowed(undefined, o), false);
  });

  it('bound beyond loopback with nothing trusted: every name, as before (the token protects)', () => {
    const o = { bound: '100.64.0.2', port: 8788, trusted: [] };
    assert.equal(hostAllowed('anything.example', o), true);
    assert.equal(hostAllowed(undefined, o), true);
  });

  it('bound beyond loopback with names trusted: only those names and the address it is bound to', () => {
    const o = { bound: '100.64.0.2', port: 8788, trusted };
    assert.equal(hostAllowed(`${NAME}:8788`, o), true);
    assert.equal(hostAllowed('BRIDGE.TEST:8788', o), true, 'names are compared in lower case');
    assert.equal(hostAllowed('100.64.0.2:8788', o), true);
    assert.equal(hostAllowed('evil.example:8788', o), false, 'a page under another name that points here (DNS rebinding)');
    assert.equal(hostAllowed('127.0.0.1:8788', o), false);
    assert.equal(hostAllowed('192.168.1.20:8788', o), false);
    assert.equal(hostAllowed(undefined, o), false);
  });

  it('bound to every address with names trusted: those names and the loopback names on its port', () => {
    const o = { bound: '0.0.0.0', port: 8788, trusted };
    assert.equal(hostAllowed(`${NAME}:8788`, o), true);
    assert.equal(hostAllowed('127.0.0.1:8788', o), true);
    assert.equal(hostAllowed('127.0.0.1:9999', o), false);
    assert.equal(hostAllowed('192.168.1.20:8788', o), false);
  });

  it('an IPv6 address it is bound to is recognised with or without its brackets', () => {
    const o = { bound: 'fd7a:115c:a1e0::2', port: 8788, trusted };
    assert.equal(hostAllowed('[fd7a:115c:a1e0::2]:8788', o), true);
    assert.equal(hostAllowed('[fd7a:115c:a1e0::3]:8788', o), false);
  });
});

/** One raw exchange over TLS: the status line and the whole answer so far. */
function rawTls(port: number, ca: string, lines: string[]): Promise<{ status: string; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, ca, servername: NAME });
    let text = '';
    socket.on('secureConnect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n`));
    socket.on('data', (d) => {
      text += d.toString('latin1');
      if (text.includes('\r\n\r\n')) socket.destroy();
    });
    socket.on('close', () => resolve({ status: text.split('\r\n')[0] ?? '', text }));
    socket.on('error', reject);
    setTimeout(() => socket.destroy(), 3000);
  });
}

describe('a bridge that serves HTTPS', () => {
  const cert = selfSigned({ names: [NAME] });
  let port = 0;
  let url = '';

  it('starts with an https address and serves the page to a client that trusts the certificate', async () => {
    const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, createLink: () => new FakeLink(), tls: cert });
    bridges.push(bridge);
    port = bridge.port;
    url = bridge.url;
    assert.match(url, /^https:\/\/127\.0\.0\.1:\d+\/$/);
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: '/', ca: cert.cert, servername: NAME }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }).on('error', reject);
    });
    assert.equal(answer.status, 200);
    assert.match(answer.body, /<html/i);
  });

  it('is refused by a client that does not trust the certificate, so the certificate really is the one served', async () => {
    const code = await new Promise<string>((resolve) => {
      https.get({ host: '127.0.0.1', port, path: '/', servername: NAME }, () => resolve('connected')).on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    assert.equal(code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('accepts the WebSocket handshake over TLS (wss) from its own page and refuses one from another origin', async () => {
    const handshake = (origin: string): string[] => [
      'GET /ws HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      `Origin: ${origin}`,
    ];
    assert.match((await rawTls(port, cert.cert, handshake(`https://127.0.0.1:${port}`))).status, / 101 /);
    assert.match((await rawTls(port, cert.cert, handshake('https://evil.example'))).status, / 403 /);
  });

  it('answers a trusted name and refuses a name it was not told about', async () => {
    const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, token: 'secret', trustedHosts: [NAME], createLink: () => new FakeLink(), tls: cert });
    bridges.push(bridge);
    const get = (host: string) => rawTls(bridge.port, cert.cert, ['GET / HTTP/1.1', `Host: ${host}`, 'Connection: close']);
    assert.match((await get(`${NAME}:${bridge.port}`)).status, / 200 /);
    assert.match((await get('evil.example')).status, / 421 /);
  });
});

describe('a bridge without TLS options', () => {
  it('is plain http as before', async () => {
    const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, createLink: () => new FakeLink() });
    bridges.push(bridge);
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  });
});

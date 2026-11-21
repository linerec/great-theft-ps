// SPDX-License-Identifier: AGPL-3.0-only
//
// The session request. The key schedule is checked against chiaki-ng's own test vector (PS4 10, test/rpcrypt.c); the
// request and the reading of the answer against the reference's code; the whole exchange against a simulated console.
// The PS5 key schedule has no published vector: it shares the code and the extraction with the PS4 one, nothing more.

import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';

import { buildSessionRequest, readSessionResponse, registKeyHex, requestSession, SessionError } from '../src/console/session.ts';
import { brightAmbassador, initAuth } from '../src/console/rpcrypt.ts';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const REGIST_KEY = Buffer.concat([Buffer.from('abcdefgh', 'latin1'), Buffer.alloc(8)]); // as stored: zero padded to 16
const RP_KEY = hex('00112233445566778899aabbccddeeff');
const NONCE = hex('000102030405060708090a0b0c0d0e0f');

describe('session keys: chiaki-ng test vector (PS4 10)', () => {
  it('bright and ambassador from a nonce and the registration key', () => {
    const { bright, ambassador } = brightAmbassador(
      'ps4-10',
      hex('AE 92 E7 64 88 26 51 EF 89 01 8C FA 69 6C 69 38'),
      hex('74 A5 9C 96 93 C2 08 3B A6 A8 4B A0 50 FA 8E 5A'),
    );
    assert.deepEqual(Buffer.from(ambassador), hex('92 BE E2 19 B9 D5 B1 AB C6 49 45 77 A4 21 E9 BD'));
    assert.deepEqual(Buffer.from(bright), hex('67 40 8C 5E 65 66 5A D2 91 A8 32 EB E2 D9 0A BB'));
  });

  it('the PS5 schedule runs for every row of both tables and differs from the PS4 one', () => {
    for (const first of [0x00, 0x07, 0x08, 0xff]) {
      for (const eighth of [0x00, 0xf8, 0xff]) {
        const nonce = Buffer.from(NONCE);
        nonce[0] = first;
        nonce[7] = eighth;
        const ps5 = brightAmbassador('ps5-1', nonce, RP_KEY);
        const ps4 = brightAmbassador('ps4-10', nonce, RP_KEY);
        assert.equal(ps5.bright.length, 16);
        assert.equal(ps5.ambassador.length, 16);
        assert.notDeepEqual(Buffer.from(ps5.bright), Buffer.from(ps4.bright));
      }
    }
    const grant = initAuth('ps5-1', NONCE, RP_KEY);
    assert.equal(grant.target, 'ps5-1');
    assert.deepEqual(Buffer.from(grant.bright), Buffer.from(brightAmbassador('ps5-1', NONCE, RP_KEY).bright));
  });
});

describe('the request', () => {
  it('registration key in the header: hex of the bytes up to the first zero', () => {
    assert.equal(registKeyHex(REGIST_KEY), '6162636465666768');
    assert.equal(registKeyHex(Buffer.alloc(16, 0x41)), '41'.repeat(16));
    assert.equal(registKeyHex(Buffer.alloc(16)), '');
  });

  it('is laid out the way the reference sends it', () => {
    assert.equal(
      buildSessionRequest('192.168.1.50', 9295, 'ps5-1', REGIST_KEY).toString('latin1'),
      'GET /sie/ps5/rp/sess/init HTTP/1.1\r\nHost: 192.168.1.50:9295\r\nUser-Agent: remoteplay Windows\r\nConnection: close\r\nContent-Length: 0\r\nRP-Registkey: 6162636465666768\r\nRp-Version: 1.0\r\n\r\n',
    );
    assert.match(buildSessionRequest('h', 9295, 'ps4-10', REGIST_KEY).toString('latin1'), /^GET \/sie\/ps4\/rp\/sess\/init HTTP\/1\.1\r\n[\s\S]*Rp-Version: 10\.0\r\n/);
    assert.match(buildSessionRequest('h', 9295, 'ps4-9', REGIST_KEY).toString('latin1'), /^GET \/sce\/rp\/session HTTP\/1\.1\r\n[\s\S]*Rp-Version: 9\.0\r\n/);
  });
});

describe('reading the answer', () => {
  const http = (code: string, headers: Record<string, string>): Buffer =>
    Buffer.from(`HTTP/1.1 ${code}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`, 'latin1');
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      return e instanceof SessionError ? e.code : `other:${String(e)}`;
    }
    return 'none';
  };

  it('accepts 200 with a 16 byte nonce, whatever the case of the header name', () => {
    assert.deepEqual(Buffer.from(readSessionResponse(http('200 OK', { 'RP-Nonce': NONCE.toString('base64') }), 'ps5-1')), NONCE);
    assert.deepEqual(Buffer.from(readSessionResponse(http('200 OK', { 'rp-nonce': NONCE.toString('base64') }), 'ps5-1')), NONCE);
  });

  it('refuses a nonce of the wrong size or form, and a 200 without one', () => {
    assert.equal(code(() => readSessionResponse(http('200 OK', { 'RP-Nonce': Buffer.alloc(8).toString('base64') }), 'ps5-1')), 'invalid-response');
    assert.equal(code(() => readSessionResponse(http('200 OK', { 'RP-Nonce': '!!!not base64!!!' }), 'ps5-1')), 'invalid-response');
    assert.equal(code(() => readSessionResponse(http('200 OK', {}), 'ps5-1')), 'invalid-response');
    assert.equal(code(() => readSessionResponse(Buffer.from('not http at all\r\n\r\n'), 'ps5-1')), 'invalid-response');
    assert.equal(code(() => readSessionResponse(Buffer.from('HTTP/1.1 200 OK\r\n'), 'ps5-1')), 'invalid-response', 'head not finished');
  });

  it('reports the console\'s own reason when it says no', () => {
    try {
      readSessionResponse(http('403 Forbidden', { 'RP-Application-Reason': '80108b10' }), 'ps5-1');
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof SessionError);
      assert.equal(e.code, 'rejected');
      assert.equal(e.reason, 0x80108b10);
      assert.match(e.message, /already in use/);
    }
  });

  it('recognises a version mismatch and says which version the console speaks', () => {
    try {
      readSessionResponse(http('403 Forbidden', { 'RP-Application-Reason': '80108b11', 'RP-Version': '2.0' }), 'ps5-1');
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof SessionError);
      assert.equal(e.code, 'version-mismatch');
      assert.equal(e.serverVersion, '2.0');
    }
    assert.equal(code(() => readSessionResponse(http('403 Forbidden', { 'RP-Application-Reason': '80108b11', 'RP-Version': '1.0' }), 'ps5-1')), 'rejected', 'same version is not a mismatch');
  });
});

// ------------------------------------------------------------------ a simulated console (TCP only)

async function fakeConsole(handler: (request: string) => string | null): Promise<{ port: number; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let text = '';
    socket.on('data', (d: Buffer) => {
      text += d.toString('latin1');
      if (!text.includes('\r\n\r\n')) return;
      requests.push(text);
      const reply = handler(text);
      if (reply !== null) socket.end(reply);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        for (const s of sockets) s.destroy();
      }),
  };
}

describe('asking a simulated console for a session', () => {
  const accept = (req: string): string =>
    /RP-Registkey: 6162636465666768\r\n/.test(req) && req.startsWith('GET /sie/ps5/rp/sess/init ')
      ? `HTTP/1.1 200 OK\r\nRP-Nonce: ${NONCE.toString('base64')}\r\nContent-Length: 0\r\n\r\n`
      : 'HTTP/1.1 403 Forbidden\r\nRP-Application-Reason: 80108b09\r\nContent-Length: 0\r\n\r\n';
  const base = { host: '127.0.0.1', target: 'ps5-1' as const, registKey: REGIST_KEY, rpKey: RP_KEY, timeoutMs: 1500 };

  it('gets a grant whose keys follow from the nonce and the registration key, and logs no secret', async () => {
    const c = await fakeConsole(accept);
    const lines: string[] = [];
    try {
      const grant = await requestSession({ ...base, port: c.port, log: (l) => lines.push(l) });
      assert.deepEqual(Buffer.from(grant.nonce), NONCE);
      assert.deepEqual(Buffer.from(grant.crypt.bright), Buffer.from(brightAmbassador('ps5-1', NONCE, RP_KEY).bright));
      assert.equal(grant.crypt.target, 'ps5-1');
      const log = lines.join('\n');
      for (const secret of ['6162636465666768', RP_KEY.toString('hex'), NONCE.toString('base64'), NONCE.toString('hex')]) assert.ok(!log.includes(secret), `no ${secret.slice(0, 6)}... in the log`);
    } finally {
      await c.close();
    }
  });

  it('turns a console that does not know the key into a clear rejection', async () => {
    const c = await fakeConsole(accept);
    try {
      await assert.rejects(
        requestSession({ ...base, registKey: Buffer.alloc(16, 0x41), port: c.port }),
        (e: unknown) => e instanceof SessionError && e.code === 'rejected' && e.reason === 0x80108b09,
      );
    } finally {
      await c.close();
    }
  });

  it('reports a closed port as a refusal that says what to check', async () => {
    const probe = await fakeConsole(() => null);
    const port = probe.port;
    await probe.close();
    await assert.rejects(requestSession({ ...base, port }), (e: unknown) => e instanceof SessionError && e.code === 'refused' && /rest mode/.test(e.message));
  });

  it('times out when the console never answers', async () => {
    const c = await fakeConsole(() => null);
    try {
      await assert.rejects(requestSession({ ...base, port: c.port, timeoutMs: 300 }), (e: unknown) => e instanceof SessionError && e.code === 'timeout');
    } finally {
      await c.close();
    }
  });

  it('refuses generations it cannot handle and keys of the wrong size before touching the network', async () => {
    await assert.rejects(requestSession({ ...base, target: 'ps5-unknown' }), (e: unknown) => e instanceof SessionError && e.code === 'unsupported-target');
    await assert.rejects(requestSession({ ...base, rpKey: Buffer.alloc(8) }), RangeError);
  });
});

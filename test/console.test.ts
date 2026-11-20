// SPDX-License-Identifier: AGPL-3.0-only
//
// Console discovery tests. They run against a SIMULATED console (a local UDP socket that answers like the
// reference implementation expects), so they prove the code is consistent with its source, not that a real
// PlayStation answers this way.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { describe, it } from 'node:test';

import {
  broadcastOf, credentialFromRegistKey, discover, formatSrch, formatWakeup, parseSrchResponse, targetFromSystemVersion, wakeup,
} from '../src/console/discovery.ts';

const PS5_READY =
  'HTTP/1.1 200 Ok\n' +
  'host-id:A1B2C3D4E5F6\n' +
  'host-type:PS5\n' +
  'host-name:PS5-LIVINGROOM\n' +
  'host-request-port:997\n' +
  'device-discovery-protocol-version:00030010\n' +
  'system-version:09000000\n';

const PS4_STANDBY =
  'HTTP/1.1 620 Server Standby\r\n' +
  'host-id:00AABBCCDDEE\r\n' +
  'host-type:PS4\r\n' +
  'host-name:PS4-BEDROOM\r\n' +
  'host-request-port:997\r\n' +
  'device-discovery-protocol-version:00020020\r\n' +
  'system-version:09500001\r\n' +
  'running-app-titleid:CUSA00001\r\n' +
  'running-app-name:Some Game\r\n';

/** A simulated console: answers every datagram it receives with `answer(text)`, and records what it received. */
async function sim(answer: (received: string) => string | null): Promise<{ port: number; received: string[]; close(): void }> {
  const socket = dgram.createSocket('udp4');
  const received: string[] = [];
  socket.on('message', (msg, rinfo) => {
    const text = msg.toString('latin1');
    received.push(text);
    const reply = answer(text);
    if (reply !== null) socket.send(Buffer.from(reply, 'latin1'), rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()));
  return { port: socket.address().port, received, close: () => socket.close() };
}

describe('packet formats', () => {
  it('SRCH matches the reference bytes, including the trailing NUL', () => {
    assert.equal(formatSrch('00030010').toString('latin1'), 'SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n\0');
    assert.equal(formatSrch('00020020').at(-1), 0);
  });

  it('WAKEUP carries the credential as a decimal number', () => {
    const text = formatWakeup(credentialFromRegistKey('0a'), '00030010').toString('latin1');
    assert.equal(
      text,
      'WAKEUP * HTTP/1.1\nclient-type:vr\nauth-type:R\nmodel:w\napp-type:r\nuser-credential:10\ndevice-discovery-protocol-version:00030010\n\0',
    );
    assert.match(formatWakeup(credentialFromRegistKey('ffffffffffffffff'), '00020020').toString('latin1'), /user-credential:18446744073709551615\n/);
  });

  it('rejects an invalid registration key and an out of range credential', () => {
    for (const bad of ['', 'xyz', '123456789abcdef01', '12 34']) assert.throws(() => credentialFromRegistKey(bad), /hexadecimal/);
    assert.throws(() => formatWakeup(-1n, '00030010'), /range/);
    assert.throws(() => formatWakeup(1n << 64n, '00030010'), /range/);
  });
});

describe('parsing answers', () => {
  it('reads a PS5 in the ready state', () => {
    const h = parseSrchResponse(PS5_READY, '192.168.0.20')!;
    assert.equal(h.state, 'ready');
    assert.equal(h.statusCode, 200);
    assert.equal(h.isPs5, true);
    assert.equal(h.hostId, 'A1B2C3D4E5F6');
    assert.equal(h.hostName, 'PS5-LIVINGROOM');
    assert.equal(h.hostRequestPort, 997);
    assert.equal(h.systemVersion, '09000000');
    assert.equal(h.target, 'ps5-1');
    assert.equal(h.runningAppName, undefined);
  });

  it('reads a PS4 in rest mode with CRLF line ends and a running app', () => {
    const h = parseSrchResponse(PS4_STANDBY, '192.168.0.21')!;
    assert.equal(h.state, 'standby');
    assert.equal(h.statusCode, 620);
    assert.equal(h.isPs5, false);
    assert.equal(h.runningAppTitleId, 'CUSA00001');
    assert.equal(h.runningAppName, 'Some Game');
    assert.equal(h.target, 'ps4-10');
  });

  it('accepts a header without a space after the colon, a missing final newline and bytes after a NUL', () => {
    const h = parseSrchResponse('HTTP/1.1 200 Ok\nhost-id:ABC\nhost-name:X\0garbage', 'a')!;
    assert.equal(h.hostId, 'ABC');
    assert.equal(h.hostName, 'X');
    assert.equal(parseSrchResponse('HTTP/1.1 200 Ok\nhost-id: ABC\n', 'a')!.hostId, 'ABC');
  });

  it('refuses anything malformed', () => {
    const bad = [
      '',
      'HTTP/1.0 200 Ok\nhost-id:A\n',
      'hello',
      'HTTP/1.1 0 Zero\nhost-id:A\n',
      'HTTP/1.1 abc\nhost-id:A\n',
      'HTTP/1.1 200 Ok\nnocolonhere\n',
      'HTTP/1.1 200 Ok\n:novalue\n',
      'HTTP/1.1 200 Ok\nhost-id:\n',
    ];
    for (const text of bad) assert.equal(parseSrchResponse(text, 'a'), null, JSON.stringify(text));
  });

  it('keeps unknown status codes as "unknown"', () => {
    assert.equal(parseSrchResponse('HTTP/1.1 500 Err\nhost-id:A\n', 'a')!.state, 'unknown');
  });

  it('maps system versions to a console generation like the reference', () => {
    const cases: [string | undefined, boolean, string][] = [
      ['09000000', true, 'ps5-1'], ['08050001', true, 'ps5-1'], ['08050000', true, 'ps5-unknown'],
      ['08000000', true, 'ps4-10'], // a PS5 below 8.05 falls through to the PS4 table, as in the reference
      ['09500001', false, 'ps4-10'], ['07000000', false, 'ps4-9'], ['06500000', false, 'ps4-8'],
      ['00000000', false, 'ps4-unknown'], [undefined, false, 'ps4-unknown'], ['abc', true, 'ps4-unknown'],
    ];
    for (const [v, ps5, want] of cases) assert.equal(targetFromSystemVersion(v, ps5), want, `${v} ${ps5}`);
  });

  it('computes directed broadcast addresses', () => {
    assert.equal(broadcastOf('192.168.0.20', '255.255.255.0'), '192.168.0.255');
    assert.equal(broadcastOf('10.1.2.3', '255.255.0.0'), '10.1.255.255');
    assert.equal(broadcastOf('172.16.5.9', '255.255.255.128'), '172.16.5.127');
  });
});

describe('discovery against a simulated console', () => {
  it('finds a console, sends the right probe, and dedupes repeated answers', async () => {
    const ps5 = await sim((t) => (t.startsWith('SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010') ? PS5_READY : null));
    try {
      const result = await discover({ hosts: ['127.0.0.1'], ps4: false, ports: { ps4: 1, ps5: ps5.port }, timeoutMs: 400, repeat: 3 });
      assert.equal(result.hosts.length, 1, 'three probes, three answers, one host');
      assert.equal(result.hosts[0]!.hostName, 'PS5-LIVINGROOM');
      assert.equal(result.hosts[0]!.address, '127.0.0.1');
      assert.ok(ps5.received.length >= 3);
      assert.equal(ps5.received[0], 'SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n\0');
      assert.ok(result.localPort > 0);
      assert.deepEqual(result.sent, [`PS5 SRCH -> 127.0.0.1:${ps5.port}`]);
    } finally {
      ps5.close();
    }
  });

  it('probes both console types and finds each one on its own port', async () => {
    const ps5 = await sim((t) => (t.includes('00030010') ? PS5_READY : null));
    const ps4 = await sim((t) => (t.includes('00020020') ? PS4_STANDBY : null));
    try {
      // Two "consoles" on different loopback ports; the probe for each type goes to its own port.
      const result = await discover({ hosts: ['127.0.0.1'], ports: { ps4: ps4.port, ps5: ps5.port }, timeoutMs: 400, repeat: 1 });
      assert.deepEqual(result.hosts.map((h) => h.hostType).sort(), ['PS4', 'PS5']);
      assert.equal(result.hosts.find((h) => h.hostType === 'PS4')!.state, 'standby');
    } finally {
      ps5.close();
      ps4.close();
    }
  });

  it('ignores garbage and returns an empty list when nothing answers', async () => {
    const noisy = await sim(() => 'this is not a console');
    const silent = await sim(() => null);
    try {
      const a = await discover({ hosts: ['127.0.0.1'], ps4: false, ports: { ps4: 1, ps5: noisy.port }, timeoutMs: 300, repeat: 1 });
      assert.deepEqual(a.hosts, []);
      const b = await discover({ hosts: ['127.0.0.1'], ps4: false, ports: { ps4: 1, ps5: silent.port }, timeoutMs: 300, repeat: 1 });
      assert.deepEqual(b.hosts, []);
      assert.equal(b.sent.length, 1);
    } finally {
      noisy.close();
      silent.close();
    }
  });

  it('wakes a console with the expected packet', async () => {
    const ps5 = await sim(() => null);
    try {
      await wakeup('127.0.0.1', credentialFromRegistKey('1f'), true, { port: ps5.port, repeat: 2 });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(ps5.received.length, 2);
      assert.match(ps5.received[0]!, /^WAKEUP \* HTTP\/1\.1\nclient-type:vr\n/);
      assert.match(ps5.received[0]!, /user-credential:31\n/);
      assert.match(ps5.received[0]!, /device-discovery-protocol-version:00030010\n\0$/);
    } finally {
      ps5.close();
    }
  });
});

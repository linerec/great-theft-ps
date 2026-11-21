// SPDX-License-Identifier: AGPL-3.0-only
//
// Registration. The vectors in the first two groups are copied from chiaki-ng's own tests (test/rpcrypt.c and
// test/regist.c, commit 43728af); they pin the cipher, the key schedule and the request layout to the reference
// implementation. The rest runs the whole exchange against a simulated console, which can only show that the pieces
// agree with each other, not that a real console agrees with them.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import { describe, it } from 'node:test';

import {
  buildRegistPayload, buildRegistRequestHead, parseAccountId, parseHeaderBlock, parsePin, parseRegistPayload, register, RegistError,
} from '../src/console/regist.ts';
import {
  aeropausePs4Pre10, brightAmbassadorPs4Pre10, decrypt, encrypt, generateIv, initAuthPs4Pre10, initRegist, initRegistPs4Pre10,
  type KnownTarget,
} from '../src/console/rpcrypt.ts';
import { RP_KEYS_0_PS4, RP_KEYS_0_PS5, RP_KEYS_1_PS4, RP_KEYS_1_PS5 } from '../src/console/rp-tables.ts';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('key tables (generated from chiaki-ng by tools/extract-rp-tables.mjs)', () => {
  it('are the exact bytes that were extracted', () => {
    assert.equal(RP_KEYS_0_PS4.length, 512);
    assert.equal(RP_KEYS_0_PS5.length, 512);
    assert.equal(RP_KEYS_1_PS4.length, 512);
    assert.equal(RP_KEYS_1_PS5.length, 512);
    assert.equal(sha(RP_KEYS_0_PS4), 'e7d94548c4b9dba6076a89ba1dfb466cf7b635fcbc4e9efc8ec844d946c6df75');
    assert.equal(sha(RP_KEYS_0_PS5), '53b11608360076562655967ca89d6bd5e9b8c05220644075bb49876c95cd3965');
    assert.equal(sha(RP_KEYS_1_PS4), '4aacf71fe36d53b46faa277a04c73e3c115eb3d4b4ae7732e919a6d1b35f5f54');
    assert.equal(sha(RP_KEYS_1_PS5), '3299d292a30e9be23c16a79bdd1a7cf8862a973ead751fd20d6d7c48154edeb0');
  });
});

describe('cipher and key schedule: chiaki-ng test vectors (test/rpcrypt.c)', () => {
  const nonce = hex('43 09 67 ae 36 4b 1c 45 26 62 37 7a bf 3f e9 39');
  const morning = hex('d2 78 9f 51 85 a7 99 a2 44 52 77 9c 2b 83 cf 07');

  it('bright_ambassador_ps4_pre10', () => {
    const { bright, ambassador } = brightAmbassadorPs4Pre10(nonce, morning);
    assert.deepEqual(Buffer.from(bright), hex('a4 4e 2a 16 5e 20 d3 0f aa 11 8b c7 7c a7 dc 11'));
    assert.deepEqual(Buffer.from(ambassador), hex('1d a8 b9 1f 6e 26 64 2e bc 08 8b 00 4f 01 5b 52'));
  });

  it('IV generation (PS4 before 10)', () => {
    const rp = initAuthPs4Pre10(nonce, morning);
    assert.deepEqual(generateIv(rp, 0), hex('06 29 be 04 e9 91 1c 48 b4 5c 02 6d b7 b7 88 46'));
    assert.deepEqual(generateIv(rp, 0x0102030405060708n), hex('3f d0 83 0a c7 30 fc 56 75 2d be b8 2c 68 a7 04'));
  });

  const ambassadorA = hex('3e 7e 7a 82 59 73 ad ab 2f 69 43 46 bd 44 da b5');
  it('IV for registration, PS4 10 (HMAC key and table column 0)', () => {
    assert.deepEqual(generateIv(initRegist('ps4-10', ambassadorA, 0, 0), 0), hex('ac 48 99 77 f9 2a c5 5b b9 09 3c 33 b6 11 3c 46'));
  });
  it('IV for registration, PS5 (HMAC key and table column 0)', () => {
    assert.deepEqual(generateIv(initRegist('ps5-1', ambassadorA, 0, 0), 0), hex('90 44 40 82 73 f8 04 4d ca 76 7b 5a 16 39 4d 64'));
  });

  const ambassadorB = hex('dc a1 c8 4d fe 50 d6 57 22 da 09 65 42 31 e7 c2');
  it('registration key with a PIN, PS4 10 (column 0x1e, PIN mixed into the last four bytes)', () => {
    assert.deepEqual(Buffer.from(initRegist('ps4-10', ambassadorB, 0x1e, 78703893).bright), hex('ed fc 1d c5 a2 fe 2d 7f 09 19 85 75 33 6c 13 16'));
  });
  it('registration key with a PIN, PS5 (column 0x1e)', () => {
    assert.deepEqual(Buffer.from(initRegist('ps5-1', ambassadorB, 0x1e, 78703893).bright), hex('e2 9d 64 4c 14 1b 9d 61 74 31 a5 6d 34 cf c1 7f'));
  });

  it('encrypts every length class the same way the reference does', () => {
    const rp = initAuthPs4Pre10(nonce, morning);
    const counter = 0x0102030405060708n;
    const cases: Array<[string, string]> = [
      ['13 37 c0 ff ee', '40 48 63 eb b4'],
      ['df a8 a3 d2 6a d7 f3 4c 4f 87 4c eb 8c 57 fb 3f', '8c d7 00 c6 30 25 3a 18 15 20 eb 26 f7 ed ab 15'],
      ['08 0d 80 c7 b2 2b 9f f3 e2 d7 c8 a5 b0 92 d5 00 8d e6 d7 74', '5b 72 23 d3 e8 d9 56 a7 b8 70 6f 68 cb 28 85 2a 06 a5 d2 e0'],
      [
        'a1 06 91 1b 49 74 e0 73 03 e8 47 42 08 4d 83 4e f3 26 14 7b de 2d f6 7d 47 96 8c 3b 66 95 7e 5d',
        'f2 79 32 0f 13 86 29 27 59 4f e0 8f 73 f7 d3 64 9d 80 7e 90 d1 f5 d8 18 e7 be 16 29 fb 48 2b f8',
      ],
    ];
    for (const [plain, cipher] of cases) assert.deepEqual(encrypt(rp, counter, hex(plain)), hex(cipher), `length ${hex(plain).length}`);
  });

  it('decrypts every length class the same way the reference does', () => {
    const rp = initAuthPs4Pre10(nonce, morning);
    const counter = 0x0102030405060708n;
    const cases: Array<[string, string]> = [
      ['8d d2 1d fb', 'de ad be ef'],
      ['eb 22 4e b7 73 94 6a 31 6e dd e5 87 29 dc d5 6b', 'b8 5d ed a3 29 66 a3 65 34 7a 42 4a 52 66 85 41'],
      ['2b d8 1d 86 39 0e 2d d7 de 2d b5 bc ba 5e e9 78 ee c9 3b 18', '78 a7 be 92 63 fc e4 83 84 8a 12 71 c1 e4 b9 52 f2 bb cd 39'],
      [
        '2b 80 da a0 5e 8d 2e 1d e1 95 16 b1 ed d2 c3 8a b8 cc 6c 42 57 8d c5 7d f1 5c 04 42 97 25 3a 91',
        '78 ff 79 b4 04 7f e7 49 bb 32 b1 7c 96 68 93 a0 86 a6 56 38 79 2a a8 03 67 9b f2 82 2d 1a 08 29',
      ],
    ];
    for (const [cipher, plain] of cases) assert.deepEqual(decrypt(rp, counter, hex(cipher)), hex(plain), `length ${hex(cipher).length}`);
  });
});

describe('request layout: chiaki-ng test vectors (test/regist.c)', () => {
  const ambassador = hex('13 37 de ad be ef c0 ff ee 42 63 68 69 61 6b 69');
  const pin = 13374201;

  it('aeropause and the PIN key for PS4 before 10', () => {
    assert.deepEqual(Buffer.from(aeropausePs4Pre10(ambassador)), hex('0b e1 2f bb 4c 7c 99 4a 41 1e 2d 4c a4 19 f4 35'));
    assert.deepEqual(Buffer.from(initRegistPs4Pre10(ambassador, pin).bright), hex('3f d0 d6 4f dc bb 3e cc 50 ba ed ef 97 34 c7 c9'));
  });

  it('the whole request body for PS4 before 10, byte for byte', () => {
    const { payload } = buildRegistPayload({ target: 'ps4-9', ambassador, pin, onlineId: 'ChiakiNanami1337' });
    const expected = Buffer.alloc(534, 0x41);
    hex('0b e1 2f bb 4c 7c 99 4a 41 1e 2d 4c a4 19 f4 35').copy(expected, 0x11c);
    hex(
      'f2 fd 4d dc 86 21 da 3d 9f 35 f3 df 82 58 65 08 6f b5 ee d1 1e dd dd aa 5a ce 28 df 2f 13 9c 0c' +
        '66 6f ec 1c 5d d1 9f 08 15 dd 5c 61 57 e6 ad 69 60 12 67 2d 4b 64',
    ).copy(expected, 0x1e0);
    assert.equal(payload.length, expected.length);
    assert.deepEqual(Buffer.from(payload), expected);
  });
});

describe('request for PS5 and PS4 10 and later', () => {
  const ambassador = hex('13 37 de ad be ef c0 ff ee 42 63 68 69 61 6b 69');
  const accountId = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

  it('hides the key material at the offsets the reference uses and encrypts the account line', () => {
    const { payload, crypt } = buildRegistPayload({ target: 'ps5-1', ambassador, pin: 12345678, accountId });
    // The first 0x1e0 bytes are filler except for 16 hidden bytes, split over two places.
    const filler = Buffer.alloc(0x1e0, 0x41);
    const hidden = Buffer.concat([payload.subarray(0x191, 0x199), payload.subarray(0xc7, 0xcf)]);
    const body = Buffer.from(payload.subarray(0, 0x1e0));
    body.fill(0x41, 0xc7, 0xcf);
    body.fill(0x41, 0x191, 0x199);
    assert.deepEqual(body, filler);
    assert.notDeepEqual(hidden, Buffer.alloc(16, 0x41));
    const inner = decrypt(crypt, 0, payload.subarray(0x1e0)).toString('latin1');
    assert.match(inner, /^Client-Type: dabfa2ec[0-9a-f]+\r\nNp-AccountId: AQIDBAUGBwg=\r\n$/);
  });

  it('refuses to register without an account id', () => {
    assert.throws(() => buildRegistPayload({ target: 'ps5-1', ambassador, pin: 12345678 }), (e: unknown) => e instanceof RegistError && e.code === 'invalid-input');
  });

  it('formats the HTTP head the way the reference does (path, doubled version, RP-Version)', () => {
    const head = buildRegistRequestHead('ps5-1', 123).toString('latin1');
    assert.equal(
      head,
      'POST /sie/ps5/rp/sess/rgst HTTP/1.1\r\n HTTP/1.1\r\nHOST: 10.0.2.15\r\nUser-Agent: remoteplay Windows\r\nConnection: close\r\nContent-Length: 123\r\nRP-Version: 1.0\r\n\r\n',
    );
    assert.match(buildRegistRequestHead('ps4-10', 1).toString('latin1'), /^POST \/sie\/ps4\/rp\/sess\/rgst /);
    assert.match(buildRegistRequestHead('ps4-9', 1).toString('latin1'), /^POST \/sce\/rp\/regist [\s\S]*RP-Version: 9\.0\r\n/);
    assert.doesNotMatch(buildRegistRequestHead('ps4-8', 1).toString('latin1'), /RP-Version/);
  });
});

describe('inputs', () => {
  it('parsePin takes the 8 digits the console shows', () => {
    assert.equal(parsePin('12345678'), 12345678);
    assert.equal(parsePin('1234 5678'), 12345678);
    assert.equal(parsePin('00001234'), 1234);
    for (const bad of ['1234567', '123456789', 'abcdefgh', '']) assert.throws(() => parsePin(bad), RegistError, bad);
  });

  it('parseAccountId takes a decimal number or 8 bytes in base64, and nothing ambiguous', () => {
    assert.deepEqual(Buffer.from(parseAccountId('258')), Buffer.from([2, 1, 0, 0, 0, 0, 0, 0])); // little endian
    assert.deepEqual(Buffer.from(parseAccountId('AQIDBAUGBwg=')), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    assert.deepEqual(Buffer.from(parseAccountId(' 18446744073709551615 ')), Buffer.alloc(8, 0xff));
    for (const bad of ['18446744073709551616', 'deadbeefdeadbeef', 'AQID', '', 'not an id', 'AQIDBAUGBwgJ']) assert.throws(() => parseAccountId(bad), RegistError, bad);
  });

  it('parseHeaderBlock reads key: value lines and rejects broken ones', () => {
    const h = parseHeaderBlock('A: 1\r\nB:2\r\n\r\n');
    assert.equal(h.get('A'), '1');
    assert.equal(h.get('B'), '2');
    assert.throws(() => parseHeaderBlock('no colon here\r\n'), RegistError);
    assert.throws(() => parseHeaderBlock('Key:\r\n'), RegistError);
  });

  it('parseRegistPayload extracts the three required values and ignores the rest', () => {
    const r = parseRegistPayload(
      'AP-Ssid: x\r\nAP-Key: secret-wifi\r\nPS5-Nickname: Living room\r\nPS5-RegistKey: 4142434445464748\r\nRP-KeyType: 2\r\nRP-Key: 000102030405060708090a0b0c0d0e0f\r\nPS5-Mac: aabbccddeeff\r\nRP-SupportCmd: 1\r\n',
      'ps5-1',
    );
    assert.equal(r.mac, 'aabbccddeeff');
    assert.equal(r.nickname, 'Living room');
    assert.equal(r.rpKeyType, 2);
    assert.equal(Buffer.from(r.registKey).toString('hex'), '41424344454647480000000000000000', 'zero padded to 16 bytes');
    assert.equal(Buffer.from(r.rpKey).toString('hex'), '000102030405060708090a0b0c0d0e0f');
    assert.ok(!('ap' in r) && !JSON.stringify(r).includes('secret-wifi'), 'the console access point password is not kept');
    for (const missing of ['PS5-RegistKey', 'RP-Key', 'PS5-Mac']) {
      const text = 'PS5-RegistKey: 41\r\nRP-Key: 000102030405060708090a0b0c0d0e0f\r\nPS5-Mac: aabbccddeeff\r\n'.split('\r\n').filter((l) => !l.startsWith(missing)).join('\r\n');
      assert.throws(() => parseRegistPayload(text, 'ps5-1'), (e: unknown) => e instanceof RegistError && e.code === 'invalid-response', missing);
    }
  });
});

// ------------------------------------------------------------------ a simulated console

interface FakeOptions {
  target: KnownTarget;
  pin: number;
  accountId: Uint8Array;
  mode?: 'ok' | 'silent-udp' | 'garbage';
}

/** What a console does with the request, rebuilt from the same primitives. Shares the code's understanding, nothing more. */
async function fakeConsole(o: FakeOptions): Promise<{ port: number; seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const ps5 = o.target === 'ps5-1';
  const sockets = new Set<net.Socket>();
  const tcp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const chunks: Buffer[] = [];
    socket.on('data', (d: Buffer) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      const end = all.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = all.subarray(0, end).toString('latin1');
      const length = Number(/Content-Length: (\d+)/i.exec(head)?.[1] ?? 0);
      if (all.length < end + 4 + length) return;
      const body = all.subarray(end + 4, end + 4 + length);
      seen.push(head.split('\r\n')[0]!);
      if (o.mode === 'garbage') return void socket.end('this is not http');

      const key0Off = body[0x18d]! & 0x1f;
      const key1Off = body[0]! >> 3;
      const hidden = Buffer.concat([body.subarray(0x191, 0x199), body.subarray(0xc7, 0xcf)]);
      const table = ps5 ? RP_KEYS_1_PS5 : RP_KEYS_1_PS4;
      const wurzel = ps5 ? 0xd3 : 0x29;
      const ambassador = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) ambassador[i] = (((hidden[i]! - wurzel - i) & 0xff) ^ table[i * 0x20 + key1Off]!) & 0xff;
      const crypt = initRegist(o.target, ambassador, key0Off, o.pin); // the console knows the PIN it shows
      const inner = decrypt(crypt, 0, body.subarray(0x1e0)).toString('latin1');
      const expectedLine = `Np-AccountId: ${Buffer.from(o.accountId).toString('base64')}\r\n`;
      if (!inner.startsWith('Client-Type: ') || !inner.endsWith(expectedLine)) {
        return void socket.end('HTTP/1.1 403 Forbidden\r\nRP-Application-Reason: 80108b09\r\nContent-Length: 0\r\n\r\n');
      }
      const name = ps5 ? 'PS5' : 'PS4';
      const answer = encrypt(
        crypt,
        0,
        Buffer.from(
          `AP-Ssid: console-ap\r\nAP-Key: wifi-password\r\n${name}-Nickname: Test console\r\n${name}-RegistKey: 6162636465666768\r\nRP-KeyType: 2\r\n` +
            `RP-Key: 00112233445566778899aabbccddeeff\r\n${name}-Mac: 0123456789ab\r\n`,
          'latin1',
        ),
      );
      socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${answer.length}\r\n\r\n`, 'latin1'), answer]));
    });
    socket.on('error', () => {});
  });
  // A console answers on the same port number over TCP and UDP. The system hands out a free TCP port, but the UDP port
  // with that number can belong to somebody else (seen on Windows: a system service had it, the bind failed without
  // anybody listening for the error, and the whole test run hung). So: try again with another number.
  let port = 0;
  let udp!: dgram.Socket;
  for (let attempt = 0; ; attempt++) {
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    port = (tcp.address() as net.AddressInfo).port;
    const candidate = dgram.createSocket('udp4');
    const bound = await new Promise<boolean>((resolve) => {
      candidate.once('error', () => resolve(false));
      candidate.bind(port, '127.0.0.1', () => resolve(true));
    });
    if (bound) {
      udp = candidate;
      break;
    }
    candidate.close();
    await new Promise<void>((r) => tcp.close(() => r()));
    if (attempt >= 20) throw new Error('no port free for both TCP and UDP');
  }
  udp.on('error', () => {});
  udp.on('message', (msg, rinfo) => {
    seen.push(`UDP ${msg.toString('latin1').replace('\0', '\\0')}`);
    if (o.mode === 'silent-udp') return;
    udp.send(Buffer.from(ps5 ? 'RES3\0' : 'RES2\0', 'latin1'), rinfo.port, rinfo.address);
  });
  return {
    port,
    seen,
    close: async () => {
      udp.close();
      await new Promise<void>((r) => {
        tcp.close(() => r());
        for (const s of sockets) s.destroy();
      });
    },
  };
}

describe('registering against a simulated console', () => {
  const accountId = Buffer.from([0x39, 0x30, 0x10, 0x28, 0xc7, 0x1f, 0x05, 0x6b]);
  const accountDecimal = accountId.readBigUInt64LE().toString();
  const pin = 24681357;

  for (const target of ['ps5-1', 'ps4-10'] as const) {
    it(`completes a registration (${target}) and hands back the keys`, async () => {
      const console_ = await fakeConsole({ target, pin, accountId });
      const lines: string[] = [];
      try {
        const result = await register({ host: '127.0.0.1', target, pin: String(pin), accountId: accountDecimal, port: console_.port, log: (l) => lines.push(l) });
        assert.equal(result.target, target);
        assert.equal(result.mac, '0123456789ab');
        assert.equal(result.nickname, 'Test console');
        assert.equal(Buffer.from(result.rpKey).toString('hex'), '00112233445566778899aabbccddeeff');
        assert.equal(Buffer.from(result.registKey).subarray(0, 8).toString('latin1'), 'abcdefgh');
        assert.equal(result.rpKeyType, 2);
        assert.ok(console_.seen[0]!.startsWith('UDP SRC'), 'the search comes first');
        assert.match(console_.seen[1]!, target === 'ps5-1' ? /^POST \/sie\/ps5\/rp\/sess\/rgst/ : /^POST \/sie\/ps4\/rp\/sess\/rgst/);
        const everything = lines.join('\n') + JSON.stringify(lines);
        for (const secret of [String(pin), accountDecimal, accountId.toString('base64'), '00112233445566778899aabbccddeeff', 'wifi-password']) {
          assert.ok(!everything.includes(secret), `the log must not contain ${secret.slice(0, 4)}...`);
        }
      } finally {
        await console_.close();
      }
    });
  }

  it('a wrong PIN comes back as a rejection that says so', async () => {
    const console_ = await fakeConsole({ target: 'ps5-1', pin, accountId });
    try {
      await assert.rejects(
        register({ host: '127.0.0.1', target: 'ps5-1', pin: '11111111', accountId: accountDecimal, port: console_.port }),
        (e: unknown) => e instanceof RegistError && e.code === 'rejected' && e.reason === 0x80108b09 && /PIN/.test(e.message),
      );
    } finally {
      await console_.close();
    }
  });

  it('a wrong account id is also rejected', async () => {
    const console_ = await fakeConsole({ target: 'ps5-1', pin, accountId });
    try {
      await assert.rejects(
        register({ host: '127.0.0.1', target: 'ps5-1', pin: String(pin), accountId: '12345', port: console_.port }),
        (e: unknown) => e instanceof RegistError && e.code === 'rejected',
      );
    } finally {
      await console_.close();
    }
  });

  it('times out with advice when the console does not answer the search', async () => {
    const console_ = await fakeConsole({ target: 'ps5-1', pin, accountId, mode: 'silent-udp' });
    try {
      await assert.rejects(
        register({ host: '127.0.0.1', target: 'ps5-1', pin: String(pin), accountId: accountDecimal, port: console_.port, timeoutMs: 300 }),
        (e: unknown) => e instanceof RegistError && e.code === 'timeout' && /Link Device/.test(e.message),
      );
    } finally {
      await console_.close();
    }
  });

  it('rejects an answer that is not HTTP', async () => {
    const console_ = await fakeConsole({ target: 'ps5-1', pin, accountId, mode: 'garbage' });
    try {
      await assert.rejects(
        register({ host: '127.0.0.1', target: 'ps5-1', pin: String(pin), accountId: accountDecimal, port: console_.port, timeoutMs: 1000 }),
        (e: unknown) => e instanceof RegistError && (e.code === 'invalid-response' || e.code === 'network'),
      );
    } finally {
      await console_.close();
    }
  });

  it('refuses a console generation it cannot handle, and bad input, before touching the network', async () => {
    await assert.rejects(register({ host: '127.0.0.1', target: 'ps5-unknown', pin: '12345678', accountId: '1' }), (e: unknown) => e instanceof RegistError && e.code === 'unsupported-target');
    await assert.rejects(register({ host: '127.0.0.1', target: 'ps5-1', pin: '123', accountId: '1' }), (e: unknown) => e instanceof RegistError && e.code === 'invalid-input');
    await assert.rejects(register({ host: '127.0.0.1', target: 'ps5-1', pin: '12345678', accountId: 'x' }), (e: unknown) => e instanceof RegistError && e.code === 'invalid-input');
  });
});

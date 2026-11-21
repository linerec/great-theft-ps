// SPDX-License-Identifier: AGPL-3.0-only
//
// The control connection. The request is checked against the reference's code (order of encrypted values, counters,
// header layout); the exchange against a simulated console built from the same cipher. That shows the two sides of
// this code agree, not that a real console agrees: only a real console can show that.

import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';

import { buildCtrlRequest, Ctrl, CTRL_MESSAGE, CtrlError, DID_SIZE, fallbackSessionId, frameCtrlMessage, makeDid, readSessionId } from '../src/console/ctrl.ts';
import { decrypt, encrypt, initAuth, type KnownTarget, type RpCrypt } from '../src/console/rpcrypt.ts';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const REGIST_KEY = Buffer.concat([Buffer.from('abcdefgh', 'latin1'), Buffer.alloc(8)]);
const RP_KEY = hex('00112233445566778899aabbccddeeff');
const NONCE = hex('000102030405060708090a0b0c0d0e0f');
const crypt = (target: KnownTarget = 'ps5-1'): RpCrypt => initAuth(target, NONCE, RP_KEY);
const DID = Uint8Array.from({ length: DID_SIZE }, (_, i) => i);
const SESSION_ID = 'abcdefghijklmnopqrstuvwxyz012345';

const headerOf = (request: string, name: string): string => new RegExp(`^${name}: (.*)$`, 'm').exec(request.replace(/\r/g, ''))?.[1] ?? '';

describe('the control request', () => {
  it('encrypts each value with the next counter, in the reference\'s order, and lays the head out the same way (PS5)', () => {
    const { request, localCounter } = buildCtrlRequest({ host: '192.168.1.50', port: 9295, target: 'ps5-1', crypt: crypt(), registKey: REGIST_KEY, did: DID, codec: 'h264' });
    const text = request.toString('latin1');
    assert.match(text, /^GET \/sie\/ps5\/rp\/sess\/ctrl HTTP\/1\.1\r\nHost: 192\.168\.1\.50:9295\r\nUser-Agent: remoteplay Windows\r\nConnection: keep-alive\r\nContent-Length: 0\r\nRP-Auth: /);
    assert.deepEqual(
      text.split('\r\n').map((l) => l.split(':')[0]).filter((k) => k?.startsWith('RP-')),
      ['RP-Auth', 'RP-Version', 'RP-Did', 'RP-ControllerType', 'RP-ClientType', 'RP-OSType', 'RP-ConPath', 'RP-PadProcNo', 'RP-StartBitrate', 'RP-StreamingType'],
    );
    assert.ok(text.endsWith('\r\n\r\n'));
    const dec = (name: string, counter: number): Buffer => decrypt(crypt(), counter, Buffer.from(headerOf(text, name), 'base64'));
    assert.deepEqual(dec('RP-Auth', 0), REGIST_KEY, 'counter 0: the 16 byte registration key');
    assert.deepEqual(dec('RP-Did', 1), Buffer.from(DID), 'counter 1: the device id');
    assert.equal(dec('RP-OSType', 2).toString('latin1'), 'Win10.0.0\0', 'counter 2: the OS name with its terminating zero');
    assert.deepEqual(dec('RP-StartBitrate', 3), Buffer.alloc(4), 'counter 3: four zero bytes');
    assert.deepEqual(dec('RP-StreamingType', 4), Buffer.from([1, 0, 0, 0]), 'counter 4: streaming type 1 (H.264), little endian');
    assert.equal(headerOf(text, 'RP-Version'), '1.0');
    assert.equal(headerOf(text, 'RP-ControllerType'), '3');
    assert.equal(headerOf(text, 'RP-ClientType'), '11');
    assert.equal(headerOf(text, 'RP-ConPath'), '1');
    assert.equal(headerOf(text, 'RP-PadProcNo'), '3');
    assert.equal(localCounter, 5);
    assert.ok(!text.includes(REGIST_KEY.toString('base64')), 'the registration key is not sent in the clear');
  });

  it('adapts to the console generation', () => {
    const h265 = buildCtrlRequest({ host: 'h', port: 9295, target: 'ps5-1', crypt: crypt(), registKey: REGIST_KEY, did: DID, codec: 'h265' }).request.toString('latin1');
    assert.deepEqual(decrypt(crypt(), 4, Buffer.from(headerOf(h265, 'RP-StreamingType'), 'base64')), Buffer.from([2, 0, 0, 0]));
    const ps4 = buildCtrlRequest({ host: 'h', port: 9295, target: 'ps4-10', crypt: crypt('ps4-10'), registKey: REGIST_KEY, did: DID, codec: 'h264' });
    const t4 = ps4.request.toString('latin1');
    assert.match(t4, /^GET \/sie\/ps4\/rp\/sess\/ctrl /);
    assert.ok(!t4.includes('RP-PadProcNo') && !t4.includes('RP-StreamingType') && t4.includes('RP-StartBitrate'));
    assert.equal(ps4.localCounter, 4);
    const old = buildCtrlRequest({ host: 'h', port: 9295, target: 'ps4-9', crypt: crypt('ps4-9'), registKey: REGIST_KEY, did: DID, codec: 'h264' });
    assert.match(old.request.toString('latin1'), /^GET \/sce\/rp\/session\/ctrl /);
    assert.ok(!old.request.toString('latin1').includes('RP-StartBitrate'));
    assert.equal(old.localCounter, 3);
  });

  it('builds a device id the way the reference does', () => {
    const did = makeDid((n) => new Uint8Array(n).fill(0xaa));
    assert.equal(did.length, 32);
    assert.deepEqual(Buffer.from(did.subarray(0, 10)), hex('00 18 00 00 00 07 00 40 00 80'));
    assert.deepEqual(Buffer.from(did.subarray(10, 26)), Buffer.alloc(16, 0xaa));
    assert.deepEqual(Buffer.from(did.subarray(26)), Buffer.alloc(6));
    assert.notDeepEqual(Buffer.from(makeDid()), Buffer.from(makeDid()), 'random by default');
  });
});

describe('messages and the session id', () => {
  it('frames a message as length, type, two zero bytes, payload', () => {
    assert.deepEqual(frameCtrlMessage(0x1fe), hex('00000000 01fe 0000'));
    assert.deepEqual(frameCtrlMessage(0x33, hex('aabbcc')), hex('00000003 0033 0000 aabbcc'));
  });

  it('accepts a session id of 24 to 78 letters and digits after the first byte, and nothing else', () => {
    const wrap = (id: string): Buffer => Buffer.concat([Buffer.from([0x4a]), Buffer.from(id, 'latin1')]);
    assert.equal(readSessionId(wrap(SESSION_ID)), SESSION_ID);
    assert.equal(readSessionId(wrap('a'.repeat(24))), 'a'.repeat(24));
    assert.equal(readSessionId(wrap('a'.repeat(78))), 'a'.repeat(78));
    for (const bad of [wrap('a'.repeat(23)), wrap('a'.repeat(79)), wrap(`${'a'.repeat(30)}!`), wrap(`${'a'.repeat(30)} `), Buffer.from([0x4a]), Buffer.alloc(0)]) assert.equal(readSessionId(bad), null);
  });

  it('has the reference\'s fallback when the id is unusable', () => {
    const id = fallbackSessionId(1_700_000_123_456, (n) => new Uint8Array(n).fill(0));
    assert.equal(id, `1700000123${'A'.repeat(64)}`);
  });
});

// ------------------------------------------------------------------ a simulated console

interface Fake {
  port: number;
  /** Decrypted payloads of the messages the client sent, in order, with their types. */
  received: Array<{ type: number; payload: Buffer }>;
  requestHead: string;
  close(): Promise<void>;
}

async function fakeConsole(o: { key?: Uint8Array; status?: string; sessionPayload?: Buffer | null; silent?: boolean; askPin?: boolean; noServerType?: boolean } = {}): Promise<Fake> {
  const fake: Fake = { port: 0, received: [], requestHead: '', close: async () => {} };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const c = initAuth('ps5-1', NONCE, o.key ?? RP_KEY);
    let buffer = Buffer.alloc(0);
    let accepted = false;
    let clientCounter = 5; // a PS5 request uses counters 0 to 4
    let serverCounter = 0;
    const send = (type: number, payload?: Buffer): void => void socket.write(frameCtrlMessage(type, payload && payload.length ? encrypt(c, serverCounter++, payload) : undefined));
    socket.on('data', (d: Buffer) => {
      buffer = Buffer.concat([buffer, d]);
      if (!accepted) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        fake.requestHead = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        if (o.silent) return;
        const auth = decrypt(c, 0, Buffer.from(headerOf(fake.requestHead, 'RP-Auth'), 'base64'));
        if (o.status || !auth.equals(REGIST_KEY)) return void socket.end(`HTTP/1.1 ${o.status ?? '403 Forbidden'}\r\nRP-Application-Reason: 80108b09\r\n\r\n`);
        accepted = true;
        const serverType = o.noServerType ? '' : `RP-Server-Type: ${encrypt(c, serverCounter++, Buffer.concat([Buffer.from([2]), Buffer.alloc(15)])).toString('base64')}\r\n`;
        socket.write(`HTTP/1.1 200 OK\r\n${serverType}\r\n`);
        if (o.askPin) send(CTRL_MESSAGE.loginPinReq);
        if (o.sessionPayload !== null) send(CTRL_MESSAGE.sessionId, o.sessionPayload ?? Buffer.concat([Buffer.from([0x4a]), Buffer.from(SESSION_ID, 'latin1')]));
        send(CTRL_MESSAGE.heartbeatReq);
      }
      while (buffer.length >= 8) {
        const size = buffer.readUInt32BE(0);
        if (buffer.length < 8 + size) break;
        const type = buffer.readUInt16BE(4);
        const raw = buffer.subarray(8, 8 + size);
        buffer = buffer.subarray(8 + size);
        fake.received.push({ type, payload: size ? decrypt(c, clientCounter++, raw) : Buffer.alloc(0) });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.port = (server.address() as net.AddressInfo).port;
  fake.close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      for (const s of sockets) s.destroy();
    });
  return fake;
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};
const client = (port: number, over: Partial<ConstructorParameters<typeof Ctrl>[0]> = {}): Ctrl =>
  new Ctrl({ host: '127.0.0.1', port, target: 'ps5-1', crypt: crypt(), registKey: REGIST_KEY, did: DID, timeoutMs: 1500, ...over });

describe('the control connection against a simulated console', () => {
  it('connects, learns the console type and the session id, answers the heartbeat and sends what the reference sends next', async () => {
    const fake = await fakeConsole();
    const lines: string[] = [];
    const ctrl = client(fake.port, { log: (l) => lines.push(l) });
    try {
      await ctrl.connect();
      assert.equal(ctrl.serverType, 2, 'decrypted with the first remote counter');
      assert.equal(await ctrl.waitForSessionId(), SESSION_ID);
      await until(() => fake.received.length >= 4);
      // After the session id the client sends two microphone toggles and the display message; the heartbeat reply has no payload.
      const byType = (t: number) => fake.received.filter((m) => m.type === t);
      assert.deepEqual(byType(CTRL_MESSAGE.micToggle).map((m) => [...m.payload]), [[0, 1, 1, 89], [0, 1, 1, 89]], 'encrypted with counters 5 and 6');
      assert.deepEqual([...byType(CTRL_MESSAGE.displayDevices)[0]!.payload], [0, 0, 0, 0], 'counter 7');
      assert.equal(byType(CTRL_MESSAGE.heartbeatRep).length, 1);
      assert.equal(byType(CTRL_MESSAGE.heartbeatRep)[0]!.payload.length, 0, 'an empty payload uses no counter');
      const log = lines.join('\n');
      for (const secret of [SESSION_ID, RP_KEY.toString('hex'), REGIST_KEY.toString('hex'), Buffer.from(DID).toString('hex')]) assert.ok(!log.includes(secret), 'no secret in the log');
    } finally {
      ctrl.close();
      await fake.close();
    }
  });

  it('keeps its counters right when the console sends no server type', async () => {
    const fake = await fakeConsole({ noServerType: true });
    const ctrl = client(fake.port);
    try {
      await ctrl.connect();
      assert.equal(ctrl.serverType, undefined);
      assert.equal(await ctrl.waitForSessionId(), SESSION_ID, 'the session id then uses remote counter 0');
    } finally {
      ctrl.close();
      await fake.close();
    }
  });

  it('falls back like the reference when the session id is unusable', async () => {
    const fake = await fakeConsole({ sessionPayload: Buffer.concat([Buffer.from([0x4a]), Buffer.from('too short', 'latin1')]) });
    const ctrl = client(fake.port);
    try {
      await ctrl.connect();
      const id = await ctrl.waitForSessionId();
      assert.match(id, /^\d{1,15}[A-Za-z0-9+/=]{64}$/);
    } finally {
      ctrl.close();
      await fake.close();
    }
  });

  it('tells the caller when the console wants the account\'s login PIN, and sends it encrypted', async () => {
    const fake = await fakeConsole({ askPin: true, sessionPayload: null });
    const ctrl = client(fake.port);
    let asked = 0;
    ctrl.events.onLoginPinRequest = () => asked++;
    try {
      await ctrl.connect();
      await until(() => asked === 1);
      assert.equal(asked, 1);
      ctrl.sendLoginPin('1234');
      await until(() => fake.received.some((m) => m.type === CTRL_MESSAGE.loginPinRep));
      assert.equal(fake.received.find((m) => m.type === CTRL_MESSAGE.loginPinRep)!.payload.toString('latin1'), '1234');
    } finally {
      ctrl.close();
      await fake.close();
    }
  });

  it('a console that cannot read the request (wrong keys) refuses, and that is reported', async () => {
    const fake = await fakeConsole({ key: Buffer.alloc(16, 9) });
    const ctrl = client(fake.port);
    try {
      await assert.rejects(ctrl.connect(), (e: unknown) => e instanceof CtrlError && e.code === 'rejected' && /403/.test(e.message) && /80108b09/.test(e.message));
      assert.equal(ctrl.closed, true);
    } finally {
      await fake.close();
    }
  });

  it('times out on a console that never answers, and fails waiting callers when the connection drops', async () => {
    const silent = await fakeConsole({ silent: true });
    try {
      await assert.rejects(client(silent.port, { timeoutMs: 300 }).connect(), (e: unknown) => e instanceof CtrlError && e.code === 'timeout');
    } finally {
      await silent.close();
    }
    const fake = await fakeConsole({ sessionPayload: null });
    const ctrl = client(fake.port);
    let closedWith = '';
    ctrl.events.onClose = (r) => (closedWith = r);
    await ctrl.connect();
    const waiting = ctrl.waitForSessionId(5000);
    await fake.close();
    await assert.rejects(waiting, (e: unknown) => e instanceof CtrlError && e.code === 'closed');
    assert.ok(closedWith.length > 0, 'the owner is told once');
  });

  it('refuses a console generation it cannot handle', () => {
    assert.throws(() => new Ctrl({ host: 'h', target: 'ps5-unknown' as never, crypt: crypt(), registKey: REGIST_KEY }), (e: unknown) => e instanceof CtrlError && e.code === 'unsupported-target');
  });
});

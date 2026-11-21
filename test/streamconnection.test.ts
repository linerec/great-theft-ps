// SPDX-License-Identifier: AGPL-3.0-only
//
// The stream connection against a simulated console that plays the other side of the set-up with the same building
// blocks (protobuf, ECDH, the packet cipher). This shows the client side is self-consistent and follows the reference's
// order, channels and splitting. It cannot show that a real console agrees.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUTTON, emptyPadState } from '../src/engine/types.ts';
import type { TakionAvPacket } from '../src/console/av-packet.ts';
import { Ecdh } from '../src/console/ecdh.ts';
import { GKCrypt } from '../src/console/gkcrypt.ts';
import { encrypt, initAuth } from '../src/console/rpcrypt.ts';
import { StreamConnection, StreamError, type StreamTransport } from '../src/console/streamconnection.ts';
import { CONTROLLER_TYPE, decodeTakionMessage, encodeTakionMessage, TAKION_PAYLOAD_TYPE, type TakionMessage } from '../src/console/takion-proto.ts';

const SESSION_ID = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijkl'; // 74 characters, like a PS5's
const crypt = initAuth('ps5-1', Uint8Array.from({ length: 16 }, (_, i) => i), Uint8Array.from({ length: 16 }, (_, i) => 0x40 + i));
const VIDEO_HEADER = Uint8Array.from([0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 0, 1, 0x68, 4, 5]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Mode = 'ok' | 'refuse-version' | 'disconnect' | 'silent' | 'early-streaminfo';

/** The console's side of the transport. */
class FakeConsole implements StreamTransport {
  readonly version = 12;
  events: StreamTransport['events'] = {};
  mode: Mode;
  pieces: Array<{ cont: boolean; flags: number; channel: number; size: number }> = [];
  messages: Array<{ channel: number; msg: TakionMessage }> = [];
  launchSpec: Record<string, any> | null = null;
  big: TakionMessage | null = null;
  clientLocal: GKCrypt | null = null;
  consoleExpectsClientKey: Buffer | null = null;
  congestion: Array<[number, number]> = [];
  states: Uint8Array[] = [];
  history: Array<{ payload: Uint8Array; count: number }> = [];
  closed = 0;
  #partial: Buffer[] = [];

  constructor(mode: Mode = 'ok') {
    this.mode = mode;
  }
  async connect(): Promise<void> {}
  sendMessageData(flags: number, channel: number, payload: Uint8Array): void {
    this.pieces.push({ cont: false, flags, channel, size: payload.length });
    this.#piece(flags, channel, payload);
  }
  sendMessageDataCont(flags: number, channel: number, payload: Uint8Array): void {
    this.pieces.push({ cont: true, flags, channel, size: payload.length });
    this.#piece(flags, channel, payload);
  }
  setCrypt(local: GKCrypt): void {
    this.clientLocal = local;
  }
  sendCongestion(received: number, lost: number): void {
    this.congestion.push([received, lost]);
  }
  sendFeedbackState(_seq: number, payload: Uint8Array): void {
    this.states.push(payload);
  }
  sendFeedbackHistory(_seq: number, payload: Uint8Array, count: number): void {
    this.history.push({ payload, count });
  }
  close(): void {
    this.closed++;
  }
  toClient(msg: TakionMessage): void {
    queueMicrotask(() => this.events.onProtobuf?.(encodeTakionMessage(msg)));
  }
  #piece(flags: number, channel: number, payload: Uint8Array): void {
    this.#partial.push(Buffer.from(payload));
    if (flags !== 1) return;
    const msg = decodeTakionMessage(Buffer.concat(this.#partial.splice(0)));
    this.messages.push({ channel, msg });
    if (msg.type === TAKION_PAYLOAD_TYPE.BIG) this.#big(msg);
  }
  #streamInfo(): TakionMessage {
    return { type: TAKION_PAYLOAD_TYPE.STREAMINFO, streamInfoPayload: { resolution: [{ width: 1280, height: 720, videoHeader: VIDEO_HEADER }], audioHeader: new Uint8Array(14).fill(7), audioChannel: [] } };
  }
  #big(msg: TakionMessage): void {
    this.big = msg;
    const b = msg.bigPayload!;
    // Read the launch spec the way a console would: XOR with the key stream of counter 0.
    const enc = Buffer.from(b.launchSpec, 'base64');
    const stream = encrypt(crypt, 0, new Uint8Array(enc.length));
    const text = Buffer.from(enc.map((x, i) => x ^ stream[i]!)).toString('latin1');
    assert.equal(text.at(-1), '\0', 'the launch spec ends with a zero byte');
    this.launchSpec = JSON.parse(text.slice(0, -1));
    const handshakeKey = Buffer.from(this.launchSpec!.handshakeKey, 'base64');

    if (this.mode === 'silent') return;
    if (this.mode === 'disconnect') return this.toClient({ type: TAKION_PAYLOAD_TYPE.DISCONNECT, disconnectPayload: { reason: 'Server shutting down' } });
    if (this.mode === 'early-streaminfo') this.toClient(this.#streamInfo());

    const ecdh = new Ecdh();
    const mine = ecdh.getLocalPubKey(handshakeKey);
    const secret = ecdh.deriveSecret(b.ecdhPubKey!, handshakeKey, b.ecdhSig!);
    this.consoleExpectsClientKey = new GKCrypt(2, handshakeKey, secret).keyBase;
    this.toClient({
      type: TAKION_PAYLOAD_TYPE.BANG,
      bangPayload: { serverVersion: 12, token: 0, encryptedKeyAccepted: true, versionAccepted: this.mode !== 'refuse-version', sessionKey: b.sessionKey, ecdhPubKey: mine.publicKey, ecdhSig: mine.signature },
    });
    if (this.mode === 'ok') setTimeout(() => this.toClient(this.#streamInfo()), 5);
  }
}

const connection = (transport: FakeConsole, over: Partial<ConstructorParameters<typeof StreamConnection>[0]> = {}): StreamConnection =>
  new StreamConnection({
    transport, target: 'ps5-1', sessionId: SESSION_ID, sessionCrypt: crypt,
    video: { width: 1280, height: 720, maxFps: 60, bitrateKbps: 10000, codec: 'h264' },
    tuning: { heartbeatIntervalMs: 20, congestionIntervalMs: 20 },
    expectTimeoutMs: 300,
    ...over,
  });
const types = (f: FakeConsole, channel?: number): number[] => f.messages.filter((m) => channel === undefined || m.channel === channel).map((m) => m.msg.type);

describe('stream connection: set-up against a simulated console', () => {
  it('sends BIG, completes the key exchange, answers the stream info and keeps the stream alive', async () => {
    const fake = new FakeConsole();
    const lines: string[] = [];
    const c = connection(fake, { log: (l) => lines.push(l) });
    await c.start();
    try {
      assert.equal(c.state, 'streaming');
      // BIG as the reference builds it.
      const big = fake.big!.bigPayload!;
      assert.equal(big.clientVersion, 12);
      assert.equal(big.sessionKey, SESSION_ID);
      assert.deepEqual([...big.encryptedKey], [0, 0, 0, 0]);
      assert.equal(big.ecdhPubKey!.length, 65);
      assert.equal(big.ecdhSig!.length, 32);
      assert.deepEqual(fake.launchSpec!.streamResolutions[0], { resolution: { width: 1280, height: 720 }, maxFps: 60, score: 10 });
      assert.equal(fake.launchSpec!.network.bwKbpsSent, 10000);
      assert.equal(fake.launchSpec!.network.mtu, 1454);
      assert.equal(fake.launchSpec!.videoCodec, 'avc');
      // Both sides ended up with the same cipher for what the client sends.
      assert.deepEqual(fake.clientLocal!.keyBase, fake.consoleExpectsClientKey);
      assert.equal(fake.clientLocal!.index, 2);
      // The answers to the stream info: acknowledgement on channel 9, the rest on channel 1.
      assert.deepEqual(types(fake, 9), [TAKION_PAYLOAD_TYPE.STREAMINFOACK]);
      const ch1 = fake.messages.filter((m) => m.channel === 1).map((m) => m.msg);
      assert.equal(ch1[0]!.type, TAKION_PAYLOAD_TYPE.BIG);
      assert.deepEqual(ch1[1]!.controllerConnectionPayload, { connected: true, controllerType: CONTROLLER_TYPE.DUALSHOCK4 });
      assert.deepEqual([...ch1[2]!.streamInfoPayload!.audioHeader], [0x01, 0x10, 0x00, 0x00, 0xbb, 0x80, 0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x00, 0x01]);
      assert.deepEqual(c.profiles.map((p) => [p.width, p.height, p.header.length]), [[1280, 720, VIDEO_HEADER.length]]);
      await sleep(90);
      assert.ok(types(fake, 1).filter((t) => t === TAKION_PAYLOAD_TYPE.HEARTBEAT).length >= 2, 'heartbeats on channel 1');
      assert.ok(fake.congestion.length >= 2, 'congestion reports');
      assert.deepEqual(Object.keys(c.stats.stages).filter((k) => k !== 'first-frame'), ['transport', 'bang', 'streaminfo']);
      const log = lines.join('\n');
      for (const secret of [SESSION_ID, big.launchSpec.slice(0, 24), fake.launchSpec!.handshakeKey]) assert.ok(!log.includes(secret), 'no secret in the log');
    } finally {
      c.stop();
    }
  });

  it('splits BIG over the MTU the way the reference does', async () => {
    const fake = new FakeConsole();
    const c = connection(fake, { mtuIn: 600, mtuOut: 600 });
    await c.start();
    c.stop();
    const big = fake.pieces.filter((p) => p.channel === 1).slice(0, fake.pieces.findIndex((p) => p.flags === 1) + 1);
    assert.ok(big.length >= 3, 'needs several pieces at this MTU');
    assert.deepEqual([big[0]!.cont, big[0]!.flags, big[0]!.size], [false, 0, 600 - 50 - 26], 'first piece: MTU - 50 - 26, to be continued');
    for (const p of big.slice(1, -1)) assert.deepEqual([p.cont, p.flags, p.size], [true, 0, 600 - 50 - 25], 'middle pieces: MTU - 50 - 25');
    assert.deepEqual([big.at(-1)!.cont, big.at(-1)!.flags], [true, 1], 'last piece closes the message');
    assert.equal(fake.launchSpec!.network.mtu, 600);
  });

  it('accepts a stream info that arrives before the BANG', async () => {
    const fake = new FakeConsole('early-streaminfo');
    const c = connection(fake);
    await c.start();
    assert.equal(c.profiles.length, 1);
    c.stop();
  });

  it('reports what the console did when it does not go along', async () => {
    const refused = connection(new FakeConsole('refuse-version'));
    await assert.rejects(refused.start(), (e: unknown) => e instanceof StreamError && e.code === 'rejected' && /version/.test(e.message));
    const gone = new FakeConsole('disconnect');
    await assert.rejects(connection(gone).start(), (e: unknown) => e instanceof StreamError && e.code === 'disconnected' && /Server shutting down/.test(e.message));
    assert.equal(gone.closed, 1, 'the transport is closed');
    await assert.rejects(connection(new FakeConsole('silent')).start(), (e: unknown) => e instanceof StreamError && e.code === 'timeout' && /BANG/.test(e.message));
  });

  it('fails cleanly when the transport does not connect', async () => {
    const fake = new FakeConsole();
    fake.connect = async () => {
      throw new Error('no route');
    };
    await assert.rejects(connection(fake).start(), (e: unknown) => e instanceof StreamError && e.code === 'transport' && /no route/.test(e.message));
  });
});

describe('stream connection: while streaming', () => {
  it('sends a button press as a history event and a stick move as state', async () => {
    const fake = new FakeConsole();
    const c = connection(fake);
    await c.start();
    try {
      const pad = emptyPadState();
      pad.buttons = BUTTON.cross;
      pad.leftX = 0.5;
      c.setPad(pad);
      await sleep(60);
      assert.ok(fake.history.length >= 1, 'a history packet for the button');
      assert.ok(fake.history[0]!.count >= 1);
      assert.ok(fake.states.length >= 1, 'a state packet for the stick');
      assert.equal(fake.states.at(-1)!.length, 0x1c, 'the PS5 state layout');
    } finally {
      c.stop();
    }
  });

  it('asks for a key frame on channel 2 and counts it', async () => {
    const fake = new FakeConsole();
    const c = connection(fake);
    await c.start();
    c.requestKeyframe();
    assert.deepEqual(types(fake, 2), [TAKION_PAYLOAD_TYPE.IDRREQUEST]);
    assert.equal(c.stats.totals.idrRequests, 1);
    assert.ok(c.stats.snapshot().events.some((e) => e.kind === 'idr-request'));
    c.stop();
  });

  it('on stop: lets go of the buttons, tells the console, closes the transport, and does not call onClosed', async () => {
    const fake = new FakeConsole();
    let closedCalls = 0;
    const c = connection(fake, { onClosed: () => closedCalls++ });
    await c.start();
    const pad = emptyPadState();
    pad.buttons = BUTTON.cross;
    c.setPad(pad);
    await sleep(40);
    const before = fake.history.length;
    c.stop();
    assert.ok(fake.history.length > before, 'the release went out');
    const last = fake.messages.at(-1)!;
    assert.equal(last.msg.type, TAKION_PAYLOAD_TYPE.DISCONNECT);
    assert.equal(last.msg.disconnectPayload!.reason, 'Client Disconnecting');
    assert.equal(fake.closed, 1);
    assert.equal(c.state, 'closed');
    assert.equal(closedCalls, 0);
    const heartbeats = types(fake, 1).filter((t) => t === TAKION_PAYLOAD_TYPE.HEARTBEAT).length;
    await sleep(60);
    assert.equal(types(fake, 1).filter((t) => t === TAKION_PAYLOAD_TYPE.HEARTBEAT).length, heartbeats, 'nothing is sent after stop');
  });

  it('tells the owner when the console ends the stream', async () => {
    const fake = new FakeConsole();
    let reason = '';
    const c = connection(fake, { onClosed: (r) => (reason = r) });
    await c.start();
    fake.toClient({ type: TAKION_PAYLOAD_TYPE.DISCONNECT, disconnectPayload: { reason: 'Remote Play ended on the console' } });
    await sleep(20);
    assert.equal(c.state, 'closed');
    assert.match(reason, /Remote Play ended on the console/);
    assert.ok(c.stats.snapshot().events.some((e) => e.kind === 'console-disconnect'));
  });

  it('ignores audio/video packets before the key exchange and after closing', async () => {
    const fake = new FakeConsole('silent');
    const c = connection(fake);
    const started = c.start().catch(() => {});
    const packet: TakionAvPacket = { packetIndex: 0, frameIndex: 0, usesNaluInfoStructs: false, isVideo: true, isHaptics: false, unitIndex: 0, unitsInFrameTotal: 1, unitsInFrameFec: 0, codec: 0, wordAt0x18: 0, adaptiveStreamIndex: 0, byteAt0x2c: 0, keyPos: 0n, data: new Uint8Array(8) };
    fake.events.onAv?.(packet);
    await started;
    fake.events.onAv?.(packet);
    assert.equal(c.stats.totals.frames, 0);
  });
});

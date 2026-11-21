// SPDX-License-Identifier: AGPL-3.0-only
//
// The link for a real PS5: which console it picks, what it tells the page at each step, that it carries the stream
// through to video and input, and that it stops honestly when a step fails. The session request, the control connection
// and the transport are replaced here (each has its own tests); nothing talks to a console.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUTTON, emptyPadState } from '../src/engine/types.ts';
import type { LinkStatus } from '../src/bridge/console-link.ts';
import { encodePad } from '../src/bridge/protocol.ts';
import { Ps5Link, StreamResearch, type Ps5LinkOptions } from '../src/bridge/ps5-link.ts';
import { DEFAULT_QUALITY } from '../src/bridge/quality.ts';
import { startBridge, type Bridge } from '../src/bridge/server.ts';
import { CtrlError } from '../src/console/ctrl.ts';
import { Ecdh } from '../src/console/ecdh.ts';
import type { GKCrypt } from '../src/console/gkcrypt.ts';
import type { RegisteredConsole } from '../src/console/regist.ts';
import { encrypt, initAuth } from '../src/console/rpcrypt.ts';
import { SessionError, type SessionRequestOptions } from '../src/console/session.ts';
import { ConsoleStore } from '../src/console/store.ts';
import type { StreamTransport } from '../src/console/streamconnection.ts';
import { decodeTakionMessage, encodeTakionMessage, TAKION_PAYLOAD_TYPE, type TakionMessage } from '../src/console/takion-proto.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const bridges: Bridge[] = [];
after(async () => {
  for (const b of bridges) await b.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const RP_KEY = '00112233445566778899aabbccddeeff';
const SESSION_ID = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijkl';
const NONCE = new Uint8Array(16);
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
const grant = async (o: SessionRequestOptions) => ({ target: 'ps5-1' as const, nonce: NONCE, crypt: initAuth('ps5-1', NONCE, o.rpKey) });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The console's side of the stream transport: answers BIG with BANG and the stream info, and records what it gets. */
class FakeStream implements StreamTransport {
  readonly version = 12;
  events: StreamTransport['events'] = {};
  silent: boolean;
  messages: TakionMessage[] = [];
  history: number[] = [];
  closed = 0;
  #partial: Buffer[] = [];
  constructor(silent = false) {
    this.silent = silent;
  }
  async connect(): Promise<void> {}
  sendMessageData(flags: number, _channel: number, payload: Uint8Array): void {
    this.#piece(flags, payload);
  }
  sendMessageDataCont(flags: number, _channel: number, payload: Uint8Array): void {
    this.#piece(flags, payload);
  }
  setCrypt(_local: GKCrypt): void {}
  sendCongestion(): void {}
  sendFeedbackState(): void {}
  sendFeedbackHistory(_seq: number, _payload: Uint8Array, count: number): void {
    this.history.push(count);
  }
  close(): void {
    this.closed++;
  }
  #toClient(msg: TakionMessage): void {
    queueMicrotask(() => this.events.onProtobuf?.(encodeTakionMessage(msg)));
  }
  #piece(flags: number, payload: Uint8Array): void {
    this.#partial.push(Buffer.from(payload));
    if (flags !== 1) return;
    const msg = decodeTakionMessage(Buffer.concat(this.#partial.splice(0)));
    this.messages.push(msg);
    if (msg.type !== TAKION_PAYLOAD_TYPE.BIG || this.silent) return;
    const b = msg.bigPayload!;
    const crypt = initAuth('ps5-1', NONCE, Buffer.from(RP_KEY, 'hex'));
    const enc = Buffer.from(b.launchSpec, 'base64');
    const stream = encrypt(crypt, 0, new Uint8Array(enc.length));
    const spec = JSON.parse(Buffer.from(enc.map((x, i) => x ^ stream[i]!)).toString('latin1').slice(0, -1));
    const handshakeKey = Buffer.from(spec.handshakeKey, 'base64');
    const ecdh = new Ecdh();
    const mine = ecdh.getLocalPubKey(handshakeKey);
    ecdh.deriveSecret(b.ecdhPubKey!, handshakeKey, b.ecdhSig!);
    this.#toClient({ type: TAKION_PAYLOAD_TYPE.BANG, bangPayload: { serverVersion: 12, token: 0, encryptedKeyAccepted: true, versionAccepted: true, sessionKey: b.sessionKey, ecdhPubKey: mine.publicKey, ecdhSig: mine.signature } });
    setTimeout(() => this.#toClient({ type: TAKION_PAYLOAD_TYPE.STREAMINFO, streamInfoPayload: { resolution: [{ width: 960, height: 540, videoHeader: Uint8Array.from([0, 0, 0, 1, 0x67]) }], audioHeader: new Uint8Array(14), audioChannel: [] } }), 3);
  }
}

interface Rig {
  link: Ps5Link;
  store: ConsoleStore;
  research: StreamResearch;
  stream: FakeStream;
  ctrlClosed: () => number;
  asked: SessionRequestOptions[];
  ctrlEvents: { onLoginPinRequest?: () => void; onClose?: (r: string) => void };
}
function rig(o: { store?: ConsoleStore; silentStream?: boolean; ctrlFails?: Error; ctrlFailsFirst?: Error; askPin?: boolean; session?: Ps5LinkOptions['session']; handover?: Ps5LinkOptions['handover'] } = {}): Rig {
  const store = o.store ?? storeWith([reg(), '192.168.1.50']);
  const research = new StreamResearch();
  const stream = new FakeStream(o.silentStream);
  const asked: SessionRequestOptions[] = [];
  let closed = 0;
  let ctrlConnects = 0;
  const ctrlEvents: Rig['ctrlEvents'] = {};
  const link = new Ps5Link({
    store, research, streamTimeoutMs: 200, inUseRetryWaitMs: 5, ...(o.handover ? { handover: o.handover } : {}),
    session: o.session ?? (async (s) => (asked.push(s), grant(s))),
    createCtrl: () => ({
      events: ctrlEvents,
      connect: async () => {
        if (o.askPin) ctrlEvents.onLoginPinRequest?.();
        if (o.ctrlFails) throw o.ctrlFails;
        if (o.ctrlFailsFirst && ++ctrlConnects === 1) throw o.ctrlFailsFirst;
      },
      waitForSessionId: async () => {
        if (o.askPin) throw new CtrlError('timeout', 'The console did not send a session id in time');
        return SESSION_ID;
      },
      close: () => void closed++,
    }),
    createTransport: () => stream,
  });
  return { link, store, research, stream, ctrlClosed: () => closed, asked, ctrlEvents };
}
const run = async (link: Ps5Link, mac?: string): Promise<{ statuses: LinkStatus[]; frames: number; error: Error | null }> => {
  const statuses: LinkStatus[] = [];
  let frames = 0;
  try {
    await link.start({ onVideo: () => frames++, onStatus: (s) => statuses.push(s) }, DEFAULT_QUALITY, mac ? { mac } : {});
    return { statuses, frames, error: null };
  } catch (e) {
    return { statuses, frames, error: e as Error };
  }
};

describe('the PS5 link', () => {
  it('goes through session, control connection and stream, and tells the page about each step', async () => {
    const r = rig();
    const { statuses, error } = await run(r.link);
    try {
      assert.equal(error, null);
      assert.equal(r.link.name, 'ps5');
      assert.equal(r.asked[0]!.host, '192.168.1.50');
      assert.equal(Buffer.from(r.asked[0]!.rpKey).toString('hex'), RP_KEY, 'the stored keys reach the session request');
      assert.deepEqual(statuses.map((s) => s.state), ['connecting', 'connecting', 'connecting', 'streaming']);
      assert.match(statuses[0]!.detail!, /세션을 요청하는 중/);
      assert.match(statuses[1]!.detail!, /제어 연결을 여는 중/);
      assert.match(statuses[2]!.detail!, /영상 스트림을 여는 중/);
      assert.match(statuses[3]!.detail!, /Living room · 960×540/);
      // What was asked of the console follows the quality request.
      assert.deepEqual(r.research.video, { width: DEFAULT_QUALITY.width, height: DEFAULT_QUALITY.height, maxFps: DEFAULT_QUALITY.fps, bitrateKbps: DEFAULT_QUALITY.bitrateKbps, codec: 'h264' });
      assert.equal(r.research.state, 'streaming');
      assert.deepEqual(Object.keys(r.research.stats!.stages), ['session', 'control', 'transport', 'bang', 'streaminfo']);
      assert.equal(r.stream.messages[0]!.bigPayload!.sessionKey, SESSION_ID, 'the session id from the control connection goes into BIG');
      assert.ok(r.store.list()[0]!.verifiedAt);
    } finally {
      await r.link.stop();
    }
    assert.equal(r.stream.closed, 1);
    assert.equal(r.ctrlClosed(), 1);
    assert.equal(r.stream.messages.at(-1)!.type, TAKION_PAYLOAD_TYPE.DISCONNECT, 'the console is told');
    assert.equal(r.research.state, 'ended');
  });

  it('sends pad state to the console once the stream runs', async () => {
    const r = rig();
    await run(r.link);
    try {
      const pad = emptyPadState();
      pad.buttons = BUTTON.cross;
      r.link.sendPad(7, pad);
      await sleep(60);
      assert.ok(r.stream.history.length >= 1, 'the button press went out as a history event');
    } finally {
      await r.link.stop();
    }
  });

  it('picks the console it is asked for, and the first one otherwise', async () => {
    const store = storeWith([reg({ mac: 'aaaaaaaaaaaa', nickname: 'First' }), '192.168.1.10'], [reg({ mac: 'bbbbbbbbbbbb', nickname: 'Second' }), '192.168.1.11']);
    const a = rig({ store });
    await run(a.link, 'bbbbbbbbbbbb');
    await a.link.stop();
    const b = rig({ store });
    await run(b.link);
    await b.link.stop();
    assert.deepEqual([a.asked[0]!.host, b.asked[0]!.host], ['192.168.1.11', '192.168.1.10']);
  });

  it('says what is missing instead of trying anything', async () => {
    const none = await run(rig({ store: storeWith(), session: async () => assert.fail('no request without a console') }).link);
    assert.match(none.error!.message, /등록된 PS5가 없습니다/);
    assert.deepEqual(none.statuses, []);
    const wrong = await run(rig({ session: async () => assert.fail('no request for an unknown console') }).link, 'ffffffffffff');
    assert.match(wrong.error!.message, /선택한 콘솔/);
  });

  it('stops with the console\'s own reason when the session is refused, and records why', async () => {
    const r = rig({
      session: async () => {
        throw new SessionError('rejected', 'The console answered 403: Registration failed, most likely a wrong or expired PIN (0x80108b09)', { reason: 0x80108b09 });
      },
    });
    const { error } = await run(r.link);
    assert.match(error!.message, /Living room.*세션을 받아들이지 않았습니다/);
    assert.match(error!.message, /0x80108b09/);
    assert.equal(r.research.state, 'ended');
    assert.equal(r.research.lastError, error!.message);
    assert.equal(r.store.list()[0]!.verifiedAt, undefined, 'a refusal is not recorded as verified');
  });

  it('asks again when the console says Remote Play is in use: it says so for a few seconds after a disconnect', async () => {
    const inUse = (): SessionError => new SessionError('rejected', 'The console answered 403: Remote Play is already in use on the console (0x80108b10)', { reason: 0x80108b10 });
    let calls = 0;
    const r = rig({
      session: async (s) => {
        if (++calls <= 2) throw inUse();
        return grant(s);
      },
    });
    const { statuses, error } = await run(r.link);
    try {
      assert.equal(error, null);
      assert.equal(calls, 3);
      assert.deepEqual(statuses.map((s) => s.state), ['connecting', 'connecting', 'connecting', 'connecting', 'connecting', 'streaming']);
      assert.match(statuses[1]!.detail!, /정리하는 중입니다.*다시 시도합니다 \(1\/18\)/);
      assert.match(statuses[2]!.detail!, /\(2\/18\)/);
      assert.equal(r.research.stats!.events.filter((e) => e.kind === 'session-in-use').length, 2, 'the waiting shows in the measurements');
    } finally {
      await r.link.stop();
    }

    // Still in use after every try: then another device really is connected, and the link says so.
    let tries = 0;
    const busy = rig({
      session: async () => {
        tries++;
        throw inUse();
      },
    });
    const refused = await run(busy.link);
    assert.equal(tries, 19, 'the first request and eighteen more: a little longer than the console holds an abandoned session');
    assert.match(refused.error!.message, /이미 사용 중입니다/);
    assert.equal(busy.research.state, 'ended');
  });

  it('starts over once when the console accepts the session but then says nothing on the control connection', async () => {
    // What happened on a real PS5: session accepted, no answer to the control request. The session it gave then blocks
    // the next request for half a minute, so the link has to do the waiting, not the person.
    let calls = 0;
    const r = rig({
      ctrlFailsFirst: new CtrlError('timeout', 'The console did not answer the control request in time'),
      session: async (s) => {
        calls++;
        if (calls === 2 || calls === 3) throw new SessionError('rejected', 'The console answered 403: Remote Play is already in use on the console (0x80108b10)', { reason: 0x80108b10 });
        return grant(s);
      },
    });
    const { statuses, error } = await run(r.link);
    try {
      assert.equal(error, null);
      assert.equal(calls, 4, 'one that led nowhere, two refusals while the console let go, one that worked');
      assert.equal(statuses.at(-1)!.state, 'streaming');
      assert.ok(statuses.some((s) => /제어 연결에 답하지 않아 처음부터 다시/.test(s.detail ?? '')));
      assert.equal(r.ctrlClosed(), 1, 'the control connection that led nowhere was closed');
      assert.deepEqual(r.research.stats!.events.filter((e) => e.kind === 'control-retry').map((e) => e.detail), ['timeout']);
    } finally {
      await r.link.stop();
    }

    // It does that once, not for ever.
    const never = rig({ ctrlFails: new CtrlError('timeout', 'The console did not answer the control request in time') });
    const failed = await run(never.link);
    assert.match(failed.error!.message, /제어 연결을 열지 못했습니다/);
    assert.equal(never.asked.length, 2);
  });

  it('says that the console does not answer, not that it refused, when nothing comes back', async () => {
    for (const code of ['timeout', 'network', 'refused'] as const) {
      const r = rig({
        session: async () => {
          throw new SessionError(code, 'The console did not answer the session request');
        },
      });
      const { error } = await run(r.link);
      assert.match(error!.message, /응답하지 않습니다.*대기 모드/, code);
      assert.doesNotMatch(error!.message, /받아들이지 않았습니다/);
      assert.equal(r.research.lastError, error!.message);
    }
  });

  it('stops at the control connection when that fails, closing what it opened', async () => {
    const r = rig({ ctrlFails: new CtrlError('rejected', 'The console answered 403 to the control request') });
    const { error, statuses } = await run(r.link);
    assert.match(error!.message, /제어 연결을 열지 못했습니다.*403/);
    assert.equal(statuses.at(-1)!.state, 'connecting');
    assert.equal(r.ctrlClosed(), 1);
    assert.equal(r.stream.messages.length, 0, 'the stream is never started');
  });

  it('explains a console that wants the account\'s login PIN', async () => {
    const { error } = await run(rig({ askPin: true }).link);
    assert.match(error!.message, /로그인 암호\(PIN\)/);
  });

  it('stops at the stream when the console does not answer it, and leaves nothing open', async () => {
    const r = rig({ silentStream: true });
    const { error } = await run(r.link);
    assert.match(error!.message, /영상 스트림을 열지 못했습니다.*\[timeout\]/);
    assert.equal(r.stream.closed, 1);
    assert.equal(r.ctrlClosed(), 1);
    assert.equal(r.research.state, 'ended');
    assert.deepEqual(Object.keys(r.research.stats!.stages), ['session', 'control', 'transport'], 'the measurements show how far it got');
  });

  it('tells the page when the control connection drops while streaming', async () => {
    const r = rig();
    const statuses: LinkStatus[] = [];
    await r.link.start({ onVideo: () => {}, onStatus: (s) => statuses.push(s) }, DEFAULT_QUALITY);
    r.ctrlEvents.onClose?.('the control connection was closed');
    assert.equal(statuses.at(-1)!.state, 'closed');
    assert.match(statuses.at(-1)!.detail!, /제어 연결이 끊어졌습니다/);
    assert.equal(r.stream.closed, 1);
    await r.link.stop();
  });
});

describe('stream settings for study', () => {
  it('accepts sensible values for the next connection and refuses the rest without changing anything', () => {
    const research = new StreamResearch();
    assert.deepEqual(research.setTuning({ enableIdrOnFecFailure: true, packetLossMax: 0.2, congestionIntervalMs: 100, heartbeatIntervalMs: 500 }), []);
    assert.deepEqual(research.tuning, { enableIdrOnFecFailure: true, packetLossMax: 0.2, congestionIntervalMs: 100, heartbeatIntervalMs: 500 });
    const problems = research.setTuning({ packetLossMax: 2, congestionIntervalMs: 'fast', nonsense: 1 });
    assert.equal(problems.length, 3);
    assert.equal(research.tuning.packetLossMax, 0.2, 'nothing changes when anything is wrong');
    assert.deepEqual(research.snapshot().stream, null, 'no stream yet');
  });
});

describe('handing the console over to another client of this project', () => {
  const inUse = (): SessionError => new SessionError('rejected', 'The console answered 403: Remote Play is already in use on the console (0x80108b10)', { reason: 0x80108b10 });
  /** Stands in for the handover service: answers a request as told, and remembers who holds what. */
  function fakeHandover(answer: { result: 'yielded' | 'locked'; name: string } | { result: 'none' }) {
    const held: Array<{ mac: string; locked: boolean; release: (by: string) => void }> = [];
    const asked: string[] = [];
    const locks: Array<[string, boolean]> = [];
    return {
      held, asked, locks,
      ask: async (mac: string) => (asked.push(mac), answer),
      hold: (mac: string, h: { locked: boolean; release: (by: string) => void }) => {
        const entry = { mac, ...h };
        held.push(entry);
        return () => void held.splice(held.indexOf(entry), 1);
      },
      setLocked: (mac: string, locked: boolean) => void locks.push([mac, locked]),
    };
  }

  it('asks the client that has the console to let go, then waits for the console and connects', async () => {
    const handover = fakeHandover({ result: 'yielded', name: 'Mac Studio' });
    let calls = 0;
    const r = rig({ handover, session: async (s) => (++calls <= 2 ? Promise.reject(inUse()) : grant(s)) });
    const { statuses, error } = await run(r.link);
    try {
      assert.equal(error, null);
      assert.deepEqual(handover.asked, ['0123456789ab'], 'asked once, not on every retry');
      assert.match(statuses[1]!.detail!, /Mac Studio이\(가\) 자리를 내주었습니다/);
      assert.equal(statuses.at(-1)!.state, 'streaming');
      // Now this one has the console, unlocked: the next client that asks gets it.
      assert.equal(handover.held.length, 1);
      assert.equal(handover.held[0]!.locked, false);
      handover.held[0]!.release('Desk PC');
      assert.equal(statuses.at(-1)!.state, 'closed');
      assert.match(statuses.at(-1)!.detail!, /다른 내 기기\(Desk PC\)에 자리를 내주었습니다/);
      assert.equal(r.stream.closed, 1, 'the stream was ended, so the console is free for the other one');
      assert.equal(r.stream.messages.at(-1)!.type, TAKION_PAYLOAD_TYPE.DISCONNECT);
      assert.equal(handover.held.length, 0);
    } finally {
      await r.link.stop();
    }
  });

  it('stops at once when the client that has the console is locked, and says where', async () => {
    const handover = fakeHandover({ result: 'locked', name: 'Mac Studio' });
    let calls = 0;
    const r = rig({ handover, session: async () => (calls++, Promise.reject(inUse())) });
    const { error } = await run(r.link);
    assert.equal(calls, 1, 'no waiting around: a locked client does not let go');
    assert.match(error!.message, /Mac Studio에서 잠금 상태로 사용 중입니다/);
  });

  it('keeps waiting as before when no client of this project answers (another program has the console, or it is still letting go)', async () => {
    const handover = fakeHandover({ result: 'none' });
    let calls = 0;
    const r = rig({ handover, session: async (s) => (++calls <= 3 ? Promise.reject(inUse()) : grant(s)) });
    const { statuses, error } = await run(r.link);
    await r.link.stop();
    assert.equal(error, null);
    assert.equal(handover.asked.length, 1);
    assert.match(statuses[1]!.detail!, /정리하는 중입니다/);
  });

  it('holds the console locked when the page asked for that, and follows the switch on the page', async () => {
    const handover = fakeHandover({ result: 'none' });
    const r = rig({ handover });
    await r.link.start({ onVideo: () => {}, onStatus: () => {} }, DEFAULT_QUALITY, { locked: true });
    try {
      assert.equal(handover.held[0]!.locked, true);
      r.link.setLocked(false);
      assert.deepEqual(handover.locks, [['0123456789ab', false]]);
    } finally {
      await r.link.stop();
    }
    assert.equal(handover.held.length, 0, 'stopping gives the place up');
  });
});

describe('what the page reports about its screen', () => {
  it('is kept second by second with totals, and nonsense is bounded instead of believed', () => {
    const research = new StreamResearch();
    assert.equal(research.snapshot().display, null, 'nothing before the page reports');
    research.addDisplay({ type: 'display', mode: 'smooth', delayMs: 47.5, intervalMs: 16.683, worstLateMs: 44, waiting: 3, shown: 60, gapMaxMs: 17.2, hitches: 0, underruns: 1, skipped: 0, lateMaxMs: 44 });
    research.addDisplay({ type: 'display', mode: 'smooth', delayMs: 47.4, intervalMs: 16.683, worstLateMs: 44, waiting: 3, shown: 59, gapMaxMs: 61, hitches: 1, underruns: 0, skipped: 2, lateMaxMs: 3 });
    research.addDisplay({ type: 'display', mode: 'turbo', shown: 'many', hitches: -5, gapMaxMs: 1e15, delayMs: Number.NaN });
    research.addDisplay('not an object');
    const d = research.snapshot().display as { mode: string; totals: Record<string, number>; samples: Array<Record<string, number>> };
    assert.equal(d.mode, 'smooth');
    assert.deepEqual(d.totals, { shown: 119, hitches: 1, underruns: 1, skipped: 2, maxGapMs: 600000, maxLateMs: 44, maxDecodeMs: 0, resyncs: 0 });
    assert.equal(d.samples.length, 3);
    assert.deepEqual([d.samples[2]!.shown, d.samples[2]!.hitches, d.samples[2]!.delayMs], [0, 0, 0]);
    assert.equal((research.snapshot(1).display as { samples: unknown[] }).samples.length, 1);
    // A new stream starts with an empty record.
    research.begin({ width: 960, height: 540, maxFps: 30, bitrateKbps: 4000, codec: 'h264' });
    assert.equal(research.snapshot().display, null);
  });
});

describe('through the bridge', () => {
  it('starts the stream with the quality the page asked for, and keeps what the page reports about its screen', async () => {
    const store = storeWith([reg(), '192.168.1.50']);
    const research = new StreamResearch();
    const stream = new FakeStream();
    const bridge = await startBridge({
      host: '127.0.0.1', port: 0, root, store, research,
      createLink: () =>
        new Ps5Link({
          store, research, streamTimeoutMs: 200, session: grant, createTransport: () => stream,
          createCtrl: () => ({ events: {}, connect: async () => {}, waitForSessionId: async () => SESSION_ID, close: () => {} }),
        }),
    });
    bridges.push(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
    const seen: Array<Record<string, any>> = [];
    ws.onmessage = (e) => typeof e.data === 'string' && seen.push(JSON.parse(e.data));
    await new Promise<void>((resolve, reject) => ((ws.onopen = () => resolve()), (ws.onerror = () => reject(new Error('ws error')))));
    ws.send(JSON.stringify({ type: 'hello', client: 'test', quality: { preset: 'quality' } }));
    for (let i = 0; i < 100 && !seen.some((m) => m.type === 'ready'); i++) await sleep(10);
    assert.deepEqual(research.video, { width: 1920, height: 1080, maxFps: 60, bitrateKbps: 15000, codec: 'h264' }, 'not the default: what the page chose');
    assert.equal(seen.find((m) => m.type === 'ready')?.quality.preset, 'quality');

    ws.send(JSON.stringify({ type: 'display', mode: 'smooth', delayMs: 47.5, intervalMs: 16.683, shown: 60, gapMaxMs: 17.2, hitches: 0, underruns: 1, skipped: 0, lateMaxMs: 44 }));
    for (let i = 0; i < 50 && research.display.samples.length === 0; i++) await sleep(10);
    assert.equal(research.display.totals.shown, 60);
    assert.equal(research.display.totals.underruns, 1);
    ws.close();
    await sleep(60);
    assert.equal(research.display.totals.shown, 60, 'the record stays readable after the stream ended');
  });

  it('passes the chosen console to the link, reports ready, and relays pad input to the console', async () => {
    const store = storeWith([reg({ mac: 'aaaaaaaaaaaa', nickname: 'First' }), '192.168.1.10'], [reg({ mac: 'bbbbbbbbbbbb', nickname: 'Second' }), '192.168.1.11']);
    const rigs: Rig[] = [];
    const bridge = await startBridge({
      host: '127.0.0.1', port: 0, root, store,
      createLink: () => {
        const r = rig({ store });
        rigs.push(r);
        return r.link;
      },
    });
    bridges.push(bridge);

    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
    ws.binaryType = 'arraybuffer';
    const seen: Array<Record<string, any>> = [];
    ws.onmessage = (e) => typeof e.data === 'string' && seen.push(JSON.parse(e.data));
    await new Promise<void>((resolve, reject) => ((ws.onopen = () => resolve()), (ws.onerror = () => reject(new Error('ws error')))));
    ws.send(JSON.stringify({ type: 'hello', console: 'BBBBBBBBBBBB', client: 'test' }));
    for (let i = 0; i < 100 && !seen.some((m) => m.type === 'ready'); i++) await sleep(10);

    assert.equal(seen.find((m) => m.type === 'ready')?.link, 'ps5');
    assert.equal(rigs[0]!.asked[0]!.host, '192.168.1.11', 'the second console was the one asked');
    assert.ok(seen.some((m) => m.type === 'status' && m.state === 'streaming'));

    const pad = emptyPadState();
    pad.buttons = BUTTON.cross;
    ws.send(encodePad(1, pad, false));
    await sleep(80);
    assert.ok(rigs[0]!.stream.history.length >= 1, 'the page\'s button press reached the console side');
    ws.close();
    await sleep(60);
    assert.equal(rigs[0]!.stream.closed, 1, 'closing the page closes the stream');
  });
});

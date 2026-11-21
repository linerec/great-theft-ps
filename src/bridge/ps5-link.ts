// SPDX-License-Identifier: AGPL-3.0-only
//
// The console link for a real PS5, built on this project's TypeScript port of Remote Play (src/console/).
//
// A connection goes through these steps, and the page is told about each one:
//   1. pick the registered console
//   2. session request over TCP 9295                (session.ts)          confirmed on a real PS5
//   3. control connection, session id               (ctrl.ts)             confirmed on a real PS5
//   4. stream connection over UDP 9296              (streamconnection.ts over takion.ts): key exchange, stream info
//   5. video frames to the page, pad state to the console
// Steps 4 and 5 are written and tested against simulated consoles only. Nothing here shows a picture that is not the
// console's: when a step fails, the link stops and says which one and why.
//
// It also keeps what a study of the stream needs: the measurements of the current (or last) stream, and the settings
// that can be changed between connections (see StreamResearch).

import { Ctrl, CtrlError } from '../console/ctrl.ts';
import { isPs5Target } from '../console/rpcrypt.ts';
import { requestSession, SessionError, type SessionGrant, type SessionRequestOptions } from '../console/session.ts';
import type { ConsoleStore } from '../console/store.ts';
import { DEFAULT_TUNING, StreamConnection, StreamError, type StreamFrame, type StreamTransport, type StreamTuning, type StreamVideoRequest } from '../console/streamconnection.ts';
import { StreamStats } from '../console/streamstats.ts';
import { takionTransport } from '../console/takion-transport.ts';
import type { VirtualPadState } from '../engine/types.ts';
import type { ConsoleLink, LinkHandlers, LinkStartOptions } from './console-link.ts';
import { CODEC } from './protocol.ts';
import type { QualityRequest } from './quality.ts';

/** What can be read and changed to study the stream. One per bridge; links come and go, this stays. */
export class StreamResearch {
  tuning: StreamTuning = { ...DEFAULT_TUNING };
  /** The measurements of the stream that is running, or of the last one. Null before the first connection. */
  stats: StreamStats | null = null;
  /** What was asked of the console for that stream. */
  video: StreamVideoRequest | null = null;
  state: 'idle' | 'connecting' | 'streaming' | 'ended' = 'idle';
  /** Why the last stream ended or could not start, in plain words. */
  lastError = '';

  /** Change settings for the next connection. Returns what was not understood. */
  setTuning(input: Record<string, unknown>): string[] {
    const problems: string[] = [];
    const next = { ...this.tuning };
    const num = (key: 'packetLossMax' | 'congestionIntervalMs' | 'heartbeatIntervalMs', min: number, max: number): void => {
      if (!(key in input)) return;
      const v = input[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) problems.push(`${key} must be a number from ${min} to ${max}`);
      else next[key] = v;
    };
    num('packetLossMax', 0, 1);
    num('congestionIntervalMs', 20, 5000);
    num('heartbeatIntervalMs', 100, 10000);
    if ('enableIdrOnFecFailure' in input) {
      if (typeof input.enableIdrOnFecFailure !== 'boolean') problems.push('enableIdrOnFecFailure must be true or false');
      else next.enableIdrOnFecFailure = input.enableIdrOnFecFailure;
    }
    for (const k of Object.keys(input)) if (!(k in next)) problems.push(`unknown setting: ${k}`);
    if (problems.length === 0) this.tuning = next;
    return problems;
  }

  snapshot(sampleCount?: number): Record<string, unknown> {
    return {
      state: this.state,
      lastError: this.lastError,
      video: this.video,
      tuning: this.tuning,
      stream: this.stats ? this.stats.snapshot(sampleCount) : null,
    };
  }
}

export interface Ps5LinkOptions {
  store: ConsoleStore;
  research?: StreamResearch;
  log?: (line: string) => void;
  /** Replaced by tests. */
  session?: (opts: SessionRequestOptions) => Promise<SessionGrant>;
  createCtrl?: (opts: ConstructorParameters<typeof Ctrl>[0]) => Pick<Ctrl, 'connect' | 'waitForSessionId' | 'close' | 'events'>;
  createTransport?: (opts: { host: string; protocolVersion: number; log?: (line: string) => void }) => StreamTransport;
  /** How long to wait for each answer while the stream is set up. Default: the reference's 5000 ms. */
  streamTimeoutMs?: number;
}

export class Ps5Link implements ConsoleLink {
  readonly name = 'ps5';
  #opts: Ps5LinkOptions;
  #research: StreamResearch;
  #stopped = false;
  #ctrl: Pick<Ctrl, 'connect' | 'waitForSessionId' | 'close' | 'events'> | null = null;
  #stream: StreamConnection | null = null;
  #lastSeq = 0;
  #startedAt = 0;

  constructor(opts: Ps5LinkOptions) {
    this.#opts = opts;
    this.#research = opts.research ?? new StreamResearch();
  }

  async start(handlers: LinkHandlers, quality: QualityRequest, options: LinkStartOptions = {}): Promise<void> {
    const log = this.#opts.log ?? (() => {});
    const store = this.#opts.store;
    const research = this.#research;
    const list = store.list();
    const chosen = options.mac ? list.find((c) => c.mac === options.mac) : list[0];
    if (!chosen) throw new Error(list.length === 0 ? '등록된 PS5가 없습니다. 먼저 콘솔을 등록하세요.' : '선택한 콘솔의 등록 정보가 이 컴퓨터에 없습니다.');
    const record = store.get(chosen.mac);
    if (!record) throw new Error('등록 정보를 읽지 못했습니다.');
    const name = chosen.nickname || 'PS5';
    const registKey = Buffer.from(record.registKey, 'hex');
    const step = (detail: string): void => handlers.onStatus({ state: 'connecting', detail });
    const fail = (message: string): never => {
      research.state = 'ended';
      research.lastError = message;
      this.#cleanup();
      throw new Error(message);
    };
    research.state = 'connecting';
    research.lastError = '';
    research.stats = new StreamStats();
    research.video = { width: quality.width, height: quality.height, maxFps: quality.fps, bitrateKbps: quality.bitrateKbps, codec: quality.codec === 'hevc' ? 'h265' : 'h264' };

    // 2. session request
    step(`${name}에 세션을 요청하는 중`);
    let grant: SessionGrant;
    try {
      grant = await (this.#opts.session ?? requestSession)({ host: record.host, target: record.target, registKey, rpKey: Buffer.from(record.rpKey, 'hex'), log });
    } catch (e) {
      if (e instanceof SessionError) return fail(`${name}이(가) 세션을 받아들이지 않았습니다. ${e.message}`);
      throw e;
    }
    if (this.#stopped) return;
    store.markVerified(record.mac, record.host);
    research.stats.stage('session');

    // 3. control connection and session id
    step(`${name}이(가) 세션 요청을 받아들였습니다. 제어 연결을 여는 중`);
    const ctrlOptions = { host: record.host, target: record.target, crypt: grant.crypt, registKey, codec: research.video.codec, log };
    const ctrl = this.#opts.createCtrl ? this.#opts.createCtrl(ctrlOptions) : new Ctrl(ctrlOptions);
    this.#ctrl = ctrl;
    let pinAsked = false;
    ctrl.events.onLoginPinRequest = () => (pinAsked = true);
    let sessionId: string;
    try {
      await ctrl.connect();
      sessionId = await ctrl.waitForSessionId(8000);
    } catch (e) {
      if (pinAsked) return fail(`${name}의 계정에 로그인 암호(PIN)가 걸려 있어 콘솔이 암호를 요구합니다. 아직 지원하지 않습니다.`);
      if (e instanceof CtrlError) return fail(`${name}과(와) 제어 연결을 열지 못했습니다. ${e.message}`);
      throw e;
    }
    if (this.#stopped) return this.#cleanup();
    research.stats.stage('control');
    ctrl.events.onClose = (reason) => this.#ended(handlers, `제어 연결이 끊어졌습니다 (${reason})`);

    // 4. stream connection
    step('제어 연결이 열렸습니다. 영상 스트림을 여는 중');
    const protocolVersion = isPs5Target(record.target) ? 12 : 9;
    const transport = this.#opts.createTransport ? this.#opts.createTransport({ host: record.host, protocolVersion, log }) : takionTransport({ host: record.host, protocolVersion, log });
    this.#startedAt = Date.now();
    const stream = new StreamConnection({
      transport, target: record.target, sessionId, sessionCrypt: grant.crypt, video: research.video, tuning: research.tuning, stats: research.stats, log,
      ...(this.#opts.streamTimeoutMs !== undefined ? { expectTimeoutMs: this.#opts.streamTimeoutMs } : {}),
      onFrame: (frame) => this.#frame(handlers, frame),
      onClosed: (reason) => this.#ended(handlers, reason),
    });
    this.#stream = stream;
    try {
      await stream.start();
    } catch (e) {
      if (e instanceof StreamError) return fail(`${name}과(와) 영상 스트림을 열지 못했습니다. ${e.message} [${e.code}]`);
      throw e;
    }
    if (this.#stopped) return this.#cleanup();
    research.state = 'streaming';
    handlers.onStatus({ state: 'streaming', detail: `${name} · ${stream.profiles.map((p) => `${p.width}×${p.height}`).join(', ') || '프로필 없음'}` });
  }

  #frame(handlers: LinkHandlers, frame: StreamFrame): void {
    if (this.#stopped) return;
    handlers.onVideo({
      header: { codec: this.#research.video?.codec === 'h264' ? CODEC.H264 : CODEC.HEVC, key: frame.key, frameId: frame.frameIndex, inputSeq: this.#lastSeq, ptsMs: Date.now() - this.#startedAt },
      data: frame.data,
    });
  }

  #ended(handlers: LinkHandlers, reason: string): void {
    if (this.#stopped) return;
    this.#research.state = 'ended';
    this.#research.lastError = reason;
    this.#cleanup();
    handlers.onStatus({ state: 'closed', detail: reason });
  }

  #cleanup(): void {
    this.#stream?.stop();
    this.#stream = null;
    this.#ctrl?.close();
    this.#ctrl = null;
  }

  sendPad(seq: number, state: VirtualPadState): void {
    this.#lastSeq = seq;
    this.#stream?.setPad(state);
  }

  setQuality(_quality: QualityRequest): void {
    /* resolution, frame rate and bitrate are fixed when the stream starts: a change applies to the next connection */
  }

  requestKeyframe(): void {
    this.#stream?.requestKeyframe();
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#research.state === 'streaming' || this.#research.state === 'connecting') this.#research.state = 'ended';
    this.#cleanup();
  }
}

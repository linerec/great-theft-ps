// SPDX-License-Identifier: AGPL-3.0-only
//
// The console link for a real PS5, built on this project's TypeScript port of Remote Play (src/console/).
//
// A connection goes through these steps, and the page is told about each one:
//   1. pick the registered console
//   2. session request over TCP 9295                (session.ts)          confirmed on a real PS5
//   3. control connection, session id               (ctrl.ts)             confirmed on a real PS5
//   4. stream connection over UDP 9296              (streamconnection.ts over takion.ts): key exchange, stream info
//                                                                          confirmed on a real PS5
//   5. video frames to the page, pad state to the console                  confirmed on a real PS5 (H.264 960x540,
//                                                                          d-pad presses from the page)
// Not built: audio, the login PIN prompt, HEVC in the page. Nothing here shows a picture that is not the console's:
// when a step fails, the link stops and says which one and why.
//
// It also keeps what a study of the stream needs: the measurements of the current (or last) stream, and the settings
// that can be changed between connections (see StreamResearch).

import { Ctrl, CtrlError } from '../console/ctrl.ts';
import { APPLICATION_REASON } from '../console/regist.ts';
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

  /**
   * What the page put on the screen, second by second: the other end of the same stream. `stream` below says how
   * frames arrived at the bridge; this says what the viewer saw after the page paced them.
   */
  display: DisplayReport = emptyDisplay();

  /** A new stream starts: its measurements start empty. */
  begin(video: StreamVideoRequest): StreamStats {
    this.state = 'connecting';
    this.lastError = '';
    this.video = video;
    this.stats = new StreamStats();
    this.display = emptyDisplay();
    return this.stats;
  }

  /** One report from the page (untrusted: only known numbers are kept, within sane bounds). */
  addDisplay(input: unknown): void {
    if (typeof input !== 'object' || input === null) return;
    const m = input as Record<string, unknown>;
    const num = (key: string, max: number): number => {
      const v = m[key];
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0;
    };
    const d = this.display;
    const sample: DisplaySecond = {
      t: this.stats ? Math.round(this.stats.snapshot(0).elapsedMs / 1000) : d.samples.length,
      shown: num('shown', 1000), gapMaxMs: num('gapMaxMs', 600000), hitches: num('hitches', 1000), underruns: num('underruns', 1000),
      skipped: num('skipped', 1000), lateMaxMs: num('lateMaxMs', 600000), delayMs: num('delayMs', 1000), waiting: num('waiting', 1000),
      decodeMaxMs: num('decodeMaxMs', 600000), decodeQueueMax: num('decodeQueueMax', 10000), resyncs: num('resyncs', 1000),
    };
    d.mode = m.mode === 'immediate' ? 'immediate' : 'smooth';
    d.delayMs = sample.delayMs;
    d.intervalMs = num('intervalMs', 1000);
    d.worstLateMs = num('worstLateMs', 600000);
    d.totals.shown += sample.shown;
    d.totals.hitches += sample.hitches;
    d.totals.underruns += sample.underruns;
    d.totals.skipped += sample.skipped;
    d.totals.maxGapMs = Math.max(d.totals.maxGapMs, sample.gapMaxMs);
    d.totals.maxLateMs = Math.max(d.totals.maxLateMs, sample.lateMaxMs);
    d.totals.maxDecodeMs = Math.max(d.totals.maxDecodeMs, sample.decodeMaxMs);
    d.totals.resyncs += sample.resyncs;
    d.samples.push(sample);
    if (d.samples.length > 600) d.samples.shift();
  }

  snapshot(sampleCount?: number): Record<string, unknown> {
    const d = this.display;
    return {
      state: this.state,
      lastError: this.lastError,
      video: this.video,
      tuning: this.tuning,
      stream: this.stats ? this.stats.snapshot(sampleCount) : null,
      display: d.samples.length === 0 ? null : { ...d, totals: { ...d.totals }, samples: sampleCount === undefined ? [...d.samples] : sampleCount > 0 ? d.samples.slice(-sampleCount) : [] },
    };
  }
}

/** One second on the screen, as the page reported it. */
export interface DisplaySecond {
  /** Seconds since the stream started, by the bridge's clock. */
  t: number;
  shown: number;
  gapMaxMs: number;
  hitches: number;
  underruns: number;
  skipped: number;
  lateMaxMs: number;
  /** The delay the page was holding frames back by. */
  delayMs: number;
  /** Decoded frames waiting for their turn. */
  waiting: number;
  /** The longest a frame spent in the decoder, the most frames inside it, and restarts from a key frame because it was too far behind. */
  decodeMaxMs: number;
  decodeQueueMax: number;
  resyncs: number;
}

export interface DisplayReport {
  mode: 'smooth' | 'immediate';
  delayMs: number;
  intervalMs: number;
  worstLateMs: number;
  totals: { shown: number; hitches: number; underruns: number; skipped: number; maxGapMs: number; maxLateMs: number; maxDecodeMs: number; resyncs: number };
  samples: DisplaySecond[];
}

const emptyDisplay = (): DisplayReport => ({ mode: 'smooth', delayMs: 0, intervalMs: 0, worstLateMs: 0, totals: { shown: 0, hitches: 0, underruns: 0, skipped: 0, maxGapMs: 0, maxLateMs: 0, maxDecodeMs: 0, resyncs: 0 }, samples: [] });

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
  /** How often to ask again when the console says Remote Play is in use, and how long to wait in between. Default: 18 times, 2000 ms (the console holds an abandoned session for about 30 s). */
  inUseRetries?: number;
  inUseRetryWaitMs?: number;
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
    const video: StreamVideoRequest = { width: quality.width, height: quality.height, maxFps: quality.fps, bitrateKbps: quality.bitrateKbps, codec: quality.codec === 'hevc' ? 'h265' : 'h264' };
    const stats = research.begin(video);

    // 2 and 3. session request, then the control connection and the session id.
    //
    // Measured on a real PS5: after a connection ends the console answers "Remote Play is already in use" for about
    // 6 s, and after a session request it accepted but that was not followed up, for about 30 s. So that answer is
    // asked again for a little longer than that before it is believed. And when the console accepts the session but
    // then does not answer on the control connection (seen once, cause unknown), the whole thing is tried once more:
    // without that, the next attempt by hand runs into the 30 s of the failed one.
    const retries = this.#opts.inUseRetries ?? 18;
    const retryWaitMs = this.#opts.inUseRetryWaitMs ?? 2000;
    let asked = 0;
    let grant: SessionGrant;
    let ctrl: Pick<Ctrl, 'connect' | 'waitForSessionId' | 'close' | 'events'>;
    let sessionId: string;
    for (let attempt = 1; ; attempt++) {
      step(attempt === 1 ? `${name}에 세션을 요청하는 중` : `${name}이(가) 제어 연결에 답하지 않아 처음부터 다시 연결하는 중`);
      for (;;) {
        try {
          grant = await (this.#opts.session ?? requestSession)({ host: record.host, target: record.target, registKey, rpKey: Buffer.from(record.rpKey, 'hex'), log });
          break;
        } catch (e) {
          if (!(e instanceof SessionError)) throw e;
          if (e.reason !== APPLICATION_REASON.inUse) return fail(`${name}이(가) 세션을 받아들이지 않았습니다. ${e.message}`);
          if (asked >= retries) return fail(`${name}에서 원격 플레이가 이미 사용 중입니다. 다른 기기의 연결을 끊은 뒤 다시 시도하세요.`);
          asked++;
          stats.event('session-in-use', `asking again (${asked} of ${retries})`);
          step(`${name}이(가) 앞선 원격 플레이 연결을 정리하는 중입니다 (길면 30초쯤). 다시 시도합니다 (${asked}/${retries})`);
          await new Promise((r) => setTimeout(r, retryWaitMs));
          if (this.#stopped) return;
        }
      }
      if (this.#stopped) return;
      store.markVerified(record.mac, record.host);
      stats.stage('session');

      step(`${name}이(가) 세션 요청을 받아들였습니다. 제어 연결을 여는 중`);
      const ctrlOptions = { host: record.host, target: record.target, crypt: grant.crypt, registKey, codec: video.codec, log, timeoutMs: attempt === 1 ? 5000 : 10000 };
      ctrl = this.#opts.createCtrl ? this.#opts.createCtrl(ctrlOptions) : new Ctrl(ctrlOptions);
      this.#ctrl = ctrl;
      let pinAsked = false;
      ctrl.events.onLoginPinRequest = () => (pinAsked = true);
      try {
        await ctrl.connect();
        sessionId = await ctrl.waitForSessionId(8000);
        break;
      } catch (e) {
        if (pinAsked) return fail(`${name}의 계정에 로그인 암호(PIN)가 걸려 있어 콘솔이 암호를 요구합니다. 아직 지원하지 않습니다.`);
        if (!(e instanceof CtrlError)) throw e;
        const silent = e.code === 'timeout' || e.code === 'network' || e.code === 'closed';
        if (!silent || attempt >= 2 || this.#stopped) return fail(`${name}과(와) 제어 연결을 열지 못했습니다. ${e.message}`);
        stats.event('control-retry', e.code);
        ctrl.close();
        this.#ctrl = null;
      }
    }
    if (this.#stopped) return this.#cleanup();
    stats.stage('control');
    ctrl.events.onClose = (reason) => this.#ended(handlers, `제어 연결이 끊어졌습니다 (${reason})`);

    // 4. stream connection
    step('제어 연결이 열렸습니다. 영상 스트림을 여는 중');
    const protocolVersion = isPs5Target(record.target) ? 12 : 9;
    const transport = this.#opts.createTransport ? this.#opts.createTransport({ host: record.host, protocolVersion, log }) : takionTransport({ host: record.host, protocolVersion, log });
    this.#startedAt = Date.now();
    const stream = new StreamConnection({
      transport, target: record.target, sessionId, sessionCrypt: grant.crypt, video, tuning: research.tuning, stats, log,
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

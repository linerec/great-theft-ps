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
import type { Located } from '../console/locate.ts';
import { wakeConsole, type WakeDeps, type WakeOptions } from '../console/wake.ts';
import type { VirtualPadState } from '../engine/types.ts';
import { langOf, translate } from '../i18n/index.ts';
import type { ConsoleLink, LinkHandlers, LinkStartOptions } from './console-link.ts';
import type { Handover } from './handover.ts';
import { CODEC } from './protocol.ts';
import type { QualityRequest } from './quality.ts';
import type { ClientKind, TailscalePath } from './runlog.ts';

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
  /** Who watched the stream, coarsely (set by the server, see runlog.ts). Null before a page has connected to it. */
  client: RunClient | null = null;
  /** The way from the bridge to the page, second by second (the other half of `stream`, which is the way from the console). */
  leg: LegReport = emptyLeg();
  /** Called once when a stream ends, with everything measured: the bridge keeps it (see runlog.ts). */
  onFinished: ((snapshot: Record<string, unknown>) => void) | null = null;

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
    this.client = null;
    this.leg = emptyLeg();
    return this.stats;
  }

  /** Seconds since the stream started, by the bridge's clock. */
  #elapsedS(): number {
    return this.stats ? Math.round(this.stats.snapshot(0).elapsedMs / 1000) : 0;
  }

  /** Who is watching this stream. Called by the server right after the page's connection is accepted. */
  setClient(client: { kind: ClientKind; device: string }): void {
    this.client = { kind: client.kind, device: client.device, paths: [] };
  }

  /** What the way to the page looked like at this moment (direct or through a relay). A few are kept: it can change. */
  notePath(path: TailscalePath): void {
    if (!this.client || this.client.paths.length >= 4) return;
    this.client.paths.push({ t: this.#elapsedS(), path: path.path, os: path.os });
  }

  /** One second of the way to the page: frames and bits sent, frames left out because the page was behind. */
  addLeg(sample: { frames: number; kbps: number; dropped: number }): void {
    if (this.state !== 'streaming') return;
    const l = this.leg;
    l.totals.frames += sample.frames;
    l.totals.dropped += sample.dropped;
    l.samples.push({ t: this.#elapsedS(), frames: sample.frames, kbps: sample.kbps, dropped: sample.dropped });
    if (l.samples.length > 600) l.samples.shift();
  }

  /** The stream is over (once): it is handed to `onFinished` to be kept. A failure there must not get in the way of ending. */
  finish(reason?: string): void {
    if (this.state !== 'connecting' && this.state !== 'streaming') return;
    this.state = 'ended';
    if (reason !== undefined) this.lastError = reason;
    try {
      this.onFinished?.(this.snapshot());
    } catch {
      /* not kept */
    }
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
      t: this.stats ? this.#elapsedS() : d.samples.length,
      shown: num('shown', 1000), gapMaxMs: num('gapMaxMs', 600000), hitches: num('hitches', 1000), underruns: num('underruns', 1000),
      skipped: num('skipped', 1000), lateMaxMs: num('lateMaxMs', 600000), delayMs: num('delayMs', 1000), waiting: num('waiting', 1000),
      decodeMaxMs: num('decodeMaxMs', 600000), decodeQueueMax: num('decodeQueueMax', 10000), resyncs: num('resyncs', 1000),
      rttMs: num('rttMs', 60000),
    };
    if (typeof m.sound === 'string' && /^(idle|unsupported|playing|muted|hidden)$/.test(m.sound)) d.sound = m.sound;
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
      client: this.client,
      leg: this.leg.samples.length === 0 ? null : { totals: { ...this.leg.totals }, samples: sampleCount === undefined ? [...this.leg.samples] : sampleCount > 0 ? this.leg.samples.slice(-sampleCount) : [] },
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
  /** The page's own round trip to the bridge at that moment, ms (0: not known yet). */
  rttMs: number;
}

/** Who watched a stream: where the page connected from, the kind of device, and how the way to it looked (see runlog.ts). */
export interface RunClient {
  kind: ClientKind;
  device: string;
  paths: Array<{ t: number; path: string; os: string }>;
}

/** One second of the way from the bridge to the page. */
export interface LegSecond {
  t: number;
  frames: number;
  kbps: number;
  /** Frames left out because the page was not taking them as fast as they came. */
  dropped: number;
}

export interface LegReport {
  totals: { frames: number; dropped: number };
  samples: LegSecond[];
}

const emptyLeg = (): LegReport => ({ totals: { frames: 0, dropped: 0 }, samples: [] });

export interface DisplayReport {
  /** The page's sound as it last reported it: idle, unsupported, playing, muted or hidden ('' before any report). */
  sound: string;
  mode: 'smooth' | 'immediate';
  delayMs: number;
  intervalMs: number;
  worstLateMs: number;
  totals: { shown: number; hitches: number; underruns: number; skipped: number; maxGapMs: number; maxLateMs: number; maxDecodeMs: number; resyncs: number };
  samples: DisplaySecond[];
}

const emptyDisplay = (): DisplayReport => ({ sound: '', mode: 'smooth', delayMs: 0, intervalMs: 0, worstLateMs: 0, totals: { shown: 0, hitches: 0, underruns: 0, skipped: 0, maxGapMs: 0, maxLateMs: 0, maxDecodeMs: 0, resyncs: 0 }, samples: [] });

export interface Ps5LinkOptions {
  store: ConsoleStore;
  research?: StreamResearch;
  log?: (line: string) => void;
  /** Replaced by tests. */
  session?: (opts: SessionRequestOptions) => Promise<SessionGrant>;
  createCtrl?: (opts: ConstructorParameters<typeof Ctrl>[0]) => Pick<Ctrl, 'connect' | 'waitForSessionId' | 'close' | 'events'>;
  createTransport?: (opts: { host: string; protocolVersion: number; log?: (line: string) => void }) => StreamTransport;
  /** Lets this project's clients hand the console over among themselves. Without it this link neither asks nor lets go. */
  handover?: Pick<Handover, 'ask' | 'hold' | 'setLocked'>;
  /** How long to wait for each answer while the stream is set up. Default: the reference's 5000 ms. */
  streamTimeoutMs?: number;
  /** How often to ask again when the console says Remote Play is in use, and how long to wait in between. Default: 18 times, 2000 ms (the console holds an abandoned session for about 30 s). */
  inUseRetries?: number;
  inUseRetryWaitMs?: number;
  /** Wake a console that is in rest mode before connecting (default true). */
  wake?: boolean;
  /** Timing of the waking (see WakeOptions). */
  wakeOptions?: Pick<WakeOptions, 'timeoutMs' | 'pollMs' | 'resendMs' | 'settleMs'>;
  /** Replaced by tests. */
  wakeDeps?: WakeDeps;
  /**
   * Finds the console again when it is no longer at the address its registration has (see locate.ts). Without it the
   * stored address is used as it is. The bridge passes the real one; tests leave it out.
   */
  locate?: (rec: { mac: string; host: string }) => Promise<Located>;
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
  #mac = '';
  #locked = false;
  #unhold: (() => void) | null = null;

  constructor(opts: Ps5LinkOptions) {
    this.#opts = opts;
    this.#research = opts.research ?? new StreamResearch();
  }

  async start(handlers: LinkHandlers, quality: QualityRequest, options: LinkStartOptions = {}): Promise<void> {
    // What this link says to the person (the steps, and why a step failed) is in their language: the bridge serves many at once.
    const lang = langOf(options.lang);
    const log = this.#opts.log ?? (() => {});
    const store = this.#opts.store;
    const research = this.#research;
    const list = store.list();
    const chosen = options.mac ? list.find((c) => c.mac === options.mac) : list[0];
    if (!chosen) throw new Error(list.length === 0 ? translate(lang, 'No PS5 is registered. Register a console first.') : translate(lang, 'The registration of the chosen console is not on this computer.'));
    const record = store.get(chosen.mac);
    if (!record) throw new Error(translate(lang, 'The registration could not be read.'));
    const name = chosen.nickname || 'PS5';
    const registKey = Buffer.from(record.registKey, 'hex');
    const step = (detail: string): void => handlers.onStatus({ state: 'connecting', detail });
    const fail = (message: string): never => {
      research.finish(message);
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
    let yieldedBy = '';
    this.#mac = record.mac;
    this.#locked = !!options.locked;

    // 1a. The console may have been given another address by the router since it was registered: find it by its id.
    if (this.#opts.locate) {
      const where = await this.#opts.locate({ mac: record.mac, host: record.host }).catch((): Located => ({ result: 'absent' }));
      if (this.#stopped) return;
      if (where.result === 'moved') {
        log(`${name} moved from ${record.host} to ${where.host}`);
        stats.event('moved', `address changed to ${where.host}`);
        store.setHost(record.mac, where.host);
        record.host = where.host;
        step(translate(lang, 'Found that the address of {name} has changed', { name }));
      }
    }

    // 1b. A console in rest mode is woken first, so that "connect" is one press, at home and away from it.
    if (this.#opts.wake !== false) {
      const woken = await wakeConsole(
        { host: record.host, target: record.target, registKey: record.registKey },
        {
          ...this.#opts.wakeOptions,
          stopped: () => this.#stopped,
          onSent: () => step(translate(lang, '{name} is in rest mode. Waking it up', { name })),
          onState: (presence, seconds) => step(presence === 'standby' ? translate(lang, 'Waking {name} up ({seconds} s)', { name, seconds }) : translate(lang, '{name} is starting up ({seconds} s)', { name, seconds })),
        },
        this.#opts.wakeDeps,
      );
      if (this.#stopped || woken.result === 'cancelled') return;
      if (woken.result === 'error') return fail(translate(lang, 'Could not wake {name}. {detail}', { name, detail: woken.message }));
      if (woken.result === 'timeout') {
        return fail(translate(lang, '{name} did not wake up after {seconds} s. Check that "Enable Turning On PS5 from Network" is on (PS5 Settings > System > Power Saving > Features Available in Rest Mode) and that you are on the same home network.', { name, seconds: woken.seconds }));
      }
      if (woken.result === 'woke') {
        stats.event('wake', `woke after ${woken.seconds} s`);
        step(translate(lang, '{name} is on ({seconds} s). Connecting', { name, seconds: woken.seconds }));
      }
    }

    let grant: SessionGrant;
    let ctrl: Pick<Ctrl, 'connect' | 'waitForSessionId' | 'close' | 'events'>;
    let sessionId: string;
    for (let attempt = 1; ; attempt++) {
      step(attempt === 1 ? translate(lang, 'Asking {name} for a session', { name }) : translate(lang, '{name} did not answer on the control connection. Connecting again from the start', { name }));
      for (;;) {
        try {
          grant = await (this.#opts.session ?? requestSession)({ host: record.host, target: record.target, registKey, rpKey: Buffer.from(record.rpKey, 'hex'), log });
          break;
        } catch (e) {
          if (!(e instanceof SessionError)) throw e;
          // No answer at all is not a refusal: the console is off, asleep, or not where it was.
          if (e.code === 'timeout' || e.code === 'network' || e.code === 'refused') {
            return fail(translate(lang, '{name} is not answering. It may be off or in rest mode, or its address may have changed. ({detail})', { name, detail: e.message }));
          }
          if (e.reason !== APPLICATION_REASON.inUse) return fail(translate(lang, '{name} did not accept the session. {detail}', { name, detail: e.message }));
          if (asked >= retries) return fail(translate(lang, 'Remote Play is already in use on {name}. If an app other than Great Theft P.S (the official app, chiaki and so on) is connected, disconnect it there.', { name }));
          asked++;
          stats.event('session-in-use', `asking again (${asked} of ${retries})`);
          if (asked === 1 && this.#opts.handover) {
            // Is it one of this project's own clients that has the console? Then it lets go when asked, unless locked.
            const answer = await this.#opts.handover.ask(record.mac);
            if (this.#stopped) return;
            if (answer.result === 'locked') return fail(translate(lang, 'The console is in use on {device} and locked. Unlock it or disconnect it on that device, and you can take it over.', { device: answer.name }));
            if (answer.result === 'yielded') {
              yieldedBy = answer.name;
              stats.event('handover', 'another client let go');
            }
          }
          step(yieldedBy ? translate(lang, '{device} let go of the console. Waiting while {name} cleans up that connection ({asked}/{retries})', { device: yieldedBy, name, asked, retries }) : translate(lang, '{name} is clearing up the earlier Remote Play connection (up to about 30 s). Trying again ({asked}/{retries})', { name, asked, retries }));
          await new Promise((r) => setTimeout(r, retryWaitMs));
          if (this.#stopped) return;
        }
      }
      if (this.#stopped) return;
      store.markVerified(record.mac, record.host);
      stats.stage('session');

      step(translate(lang, '{name} accepted the session request. Opening the control connection', { name }));
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
        if (pinAsked) return fail(translate(lang, 'The account on {name} is protected by a login PIN, so the console asks for it. That is not supported yet.', { name }));
        if (!(e instanceof CtrlError)) throw e;
        const silent = e.code === 'timeout' || e.code === 'network' || e.code === 'closed';
        if (!silent || attempt >= 2 || this.#stopped) return fail(translate(lang, 'Could not open the control connection to {name}. {detail}', { name, detail: e.message }));
        stats.event('control-retry', e.code);
        ctrl.close();
        this.#ctrl = null;
      }
    }
    if (this.#stopped) return this.#cleanup();
    stats.stage('control');
    ctrl.events.onClose = (reason) => this.#ended(handlers, translate(lang, 'The control connection was lost ({reason})', { reason }));

    // 4. stream connection
    step(translate(lang, 'The control connection is open. Opening the video stream'));
    const protocolVersion = isPs5Target(record.target) ? 12 : 9;
    const transport = this.#opts.createTransport ? this.#opts.createTransport({ host: record.host, protocolVersion, log }) : takionTransport({ host: record.host, protocolVersion, log });
    this.#startedAt = Date.now();
    const stream = new StreamConnection({
      transport, target: record.target, sessionId, sessionCrypt: grant.crypt, video, tuning: research.tuning, stats, log,
      ...(this.#opts.streamTimeoutMs !== undefined ? { expectTimeoutMs: this.#opts.streamTimeoutMs } : {}),
      onFrame: (frame) => this.#frame(handlers, frame),
      onAudioHeader: (h) => !this.#stopped && handlers.onAudioHeader?.({ channels: h.channels, bits: h.bits, rate: h.rate, frameSize: h.frameSize }),
      onAudio: (frame) => !this.#stopped && handlers.onAudio?.(frame),
      onClosed: (reason) => this.#ended(handlers, reason),
    });
    this.#stream = stream;
    try {
      await stream.start();
    } catch (e) {
      if (e instanceof StreamError) return fail(translate(lang, 'Could not open the video stream to {name}. {detail} [{code}]', { name, detail: e.message, code: e.code }));
      throw e;
    }
    if (this.#stopped) return this.#cleanup();
    research.state = 'streaming';
    // From here on another of this project's clients can ask for the console, and gets it unless this one is locked.
    this.#unhold = this.#opts.handover?.hold(record.mac, { locked: this.#locked, release: (by) => this.#ended(handlers, translate(lang, 'Handed the console over to your other device ({device}).', { device: by })) }) ?? null;
    handlers.onStatus({ state: 'streaming', detail: `${name} · ${stream.profiles.map((p) => `${p.width}×${p.height}`).join(', ') || translate(lang, 'no profiles')}` });
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
    this.#research.finish(reason);
    this.#cleanup();
    handlers.onStatus({ state: 'closed', detail: reason });
  }

  #cleanup(): void {
    this.#unhold?.();
    this.#unhold = null;
    this.#stream?.stop();
    this.#stream = null;
    this.#ctrl?.close();
    this.#ctrl = null;
  }

  sendPad(seq: number, state: VirtualPadState): void {
    this.#lastSeq = seq;
    this.#stream?.setPad(state);
  }

  setLocked(locked: boolean): void {
    this.#locked = locked;
    if (this.#mac) this.#opts.handover?.setLocked(this.#mac, locked);
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
    this.#research.finish();
    this.#cleanup();
  }
}

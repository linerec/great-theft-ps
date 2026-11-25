// SPDX-License-Identifier: AGPL-3.0-only
//
// Plays the console's sound in the page. This project's own.
//
// The bridge sends the sound as Opus frames (about 10 ms each) and tells the page the format once. Here they are
// decoded with the browser's WebCodecs AudioDecoder and played with Web Audio, each piece placed on the sound card's
// clock by AudioScheduler so that the pieces follow each other seamlessly and the delay stays near a target that follows
// the picture's delay (the picture is held back a little to show it evenly; the sound has to be held back the same).
//
// What can go wrong, and what is done:
//  - A browser lets a page make sound only after a tap or click. unlock() makes the audio context and must be called in
//    the tap that connects. On an iPhone the silent switch mutes Web Audio unless the audio session is set to
//    "playback" (navigator.audioSession, where there is one).
//  - AudioDecoder does not exist everywhere: Safari has it from version 26 (iOS 26), earlier ones do not. And browsers
//    decode Opus only up to 2 channels. Then there is no sound, and `reason` says why in words for the page.
//  - A frame that never came (null from the bridge) is time that passes in silence.
//  - A hidden tab is not listened to: nothing is decoded, and when it is shown again the schedule starts afresh.
//
// STATUS: the logic is tested with a stand-in decoder and audio context (test/audio-player.test.ts). NOT yet heard with
// a real console's sound, and not yet tried on an iPhone.

import { AudioScheduler } from './audio-schedule.ts';

export interface AudioInfo {
  channels: number;
  bits: number;
  rate: number;
  frameSize: number;
}

// The parts of the browser that are used, as small interfaces, so that tests can stand in for them.
export interface AudioDataLike {
  numberOfFrames: number;
  numberOfChannels: number;
  sampleRate: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32-planar' }): void;
  close(): void;
}
export interface AudioDecoderLike {
  readonly decodeQueueSize: number;
  configure(config: { codec: 'opus'; sampleRate: number; numberOfChannels: number }): void;
  decode(chunk: unknown): void;
  close(): void;
}
export interface AudioBufferLike {
  copyToChannel(source: Float32Array, channel: number): void;
}
export interface AudioNodeLike {
  connect(to: unknown): void;
}
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioNodeLike & { buffer: unknown; start(when: number): void };
  createGain(): AudioNodeLike & { gain: { value: number } };
  /** A destination that makes a MediaStream of what reaches it (for recording a clip). Not every browser has it. */
  createMediaStreamDestination?(): AudioNodeLike & { stream: unknown };
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

export interface AudioPlayerDeps {
  createContext?: () => AudioContextLike;
  /** Whether this browser can decode that Opus stream (AudioDecoder.isConfigSupported). Undefined: no AudioDecoder here. */
  isConfigSupported?: (config: { codec: 'opus'; sampleRate: number; numberOfChannels: number }) => Promise<boolean>;
  createDecoder?: (init: { output: (data: AudioDataLike) => void; error: (e: Error) => void }) => AudioDecoderLike;
  createChunk?: (init: { type: 'key'; timestamp: number; data: Uint8Array }) => unknown;
  /** Set the audio session to "playback" so that a phone's silent switch does not mute the page. */
  configureSession?: () => void;
}

export type AudioState = 'idle' | 'unsupported' | 'playing' | 'muted' | 'hidden';

export interface AudioStats {
  state: AudioState;
  /** Why there is no sound, in words for the page (empty when there is). */
  reason: string;
  info: AudioInfo | null;
  frames: number;
  concealed: number;
  decoded: number;
  /** Pieces dropped because the sound was running behind (a burst, or a decoder that fell behind). */
  dropped: number;
  underruns: number;
  errors: number;
  /** How much sound is waiting to be played, ms. */
  delayMs: number;
}

/** WebCodecs decodes Opus up to two channels in the browsers that have it. */
const MAX_CHANNELS = 2;
/** A decoder that has this many frames waiting has fallen behind: new ones are left out until it catches up. */
const MAX_DECODE_QUEUE = 20;
const MIN_DELAY_SEC = 0.04;
const MAX_DELAY_SEC = 0.3;
const DEFAULT_DELAY_SEC = 0.08;

const realDeps = (): Required<AudioPlayerDeps> => ({
  createContext: () => {
    const Ctx: typeof AudioContext | undefined = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) throw new Error('AudioContext가 없는 브라우저');
    return new Ctx({ latencyHint: 'interactive' }) as unknown as AudioContextLike;
  },
  isConfigSupported: async (config) => {
    const Decoder = (globalThis as { AudioDecoder?: typeof AudioDecoder }).AudioDecoder;
    if (!Decoder) return false;
    try {
      return (await Decoder.isConfigSupported(config)).supported === true;
    } catch {
      return false;
    }
  },
  createDecoder: (init) => new AudioDecoder(init as AudioDecoderInit) as unknown as AudioDecoderLike,
  createChunk: (init) => new EncodedAudioChunk(init),
  configureSession: () => {
    try {
      const session = (navigator as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = 'playback';
    } catch {
      /* not there, or not allowed: the silent switch may mute the page */
    }
  },
});

export class AudioPlayer {
  #deps: Required<AudioPlayerDeps>;
  #ctx: AudioContextLike | null = null;
  #gain: (AudioNodeLike & { gain: { value: number } }) | null = null;
  #tap: (AudioNodeLike & { stream: unknown }) | null = null;
  #decoder: AudioDecoderLike | null = null;
  #scheduler = new AudioScheduler({ targetDelaySec: DEFAULT_DELAY_SEC });
  #frameSec = 0.01;
  #frameIndex = 0;
  #muted = false;
  #volume = 1;
  #visible = true;
  #unsupportedReason = '';
  #generation = 0;
  stats: AudioStats = { state: 'idle', reason: '', info: null, frames: 0, concealed: 0, decoded: 0, dropped: 0, underruns: 0, errors: 0, delayMs: 0 };

  constructor(deps: AudioPlayerDeps = {}) {
    this.#deps = { ...realDeps(), ...deps };
  }

  /**
   * Make the audio context. Browsers only allow sound after a tap or click, so call this inside the handler of the tap
   * that connects, before anything is awaited. Safe to call again. Returns false when no sound is possible here.
   */
  unlock(): boolean {
    try {
      this.#deps.configureSession();
      if (!this.#ctx) {
        this.#ctx = this.#deps.createContext();
        this.#gain = this.#ctx.createGain();
        this.#gain.connect(this.#ctx.destination);
        this.#applyGain();
      }
      void this.#ctx.resume().catch(() => {});
      // An iPhone is fully unlocked by playing something, even a single silent sample, inside the tap.
      const silent = this.#ctx.createBuffer(1, 1, 22050);
      const source = this.#ctx.createBufferSource();
      source.buffer = silent;
      source.connect(this.#ctx.destination);
      source.start(0);
      return true;
    } catch (error) {
      this.#setUnsupported(`이 브라우저는 소리를 낼 수 없습니다 (${(error as Error).message})`);
      return false;
    }
  }

  /** The bridge told the format: set up the decoder. Call after unlock(). */
  async start(info: AudioInfo): Promise<void> {
    const generation = ++this.#generation;
    this.#closeDecoder();
    this.stats.info = info;
    this.#frameIndex = 0;
    this.#scheduler.reset();
    this.#frameSec = info.rate > 0 ? info.frameSize / info.rate : 0.01;
    if (!this.#ctx) return this.#setUnsupported('소리가 아직 풀리지 않았습니다 (연결 버튼을 누를 때 풀립니다)');
    if (info.channels < 1 || info.channels > MAX_CHANNELS) {
      return this.#setUnsupported(`PS5가 보내는 소리는 ${info.channels}채널이고, 브라우저는 ${MAX_CHANNELS}채널까지만 풀 수 있습니다`);
    }
    const config = { codec: 'opus' as const, sampleRate: info.rate, numberOfChannels: info.channels };
    if (!(await this.#deps.isConfigSupported(config))) {
      return this.#setUnsupported('이 브라우저는 소리(Opus)를 풀 수 없습니다. iPhone은 iOS 26 이상이어야 합니다');
    }
    if (generation !== this.#generation) return; // a newer start() or a close() came while we waited
    try {
      const decoder = this.#deps.createDecoder({ output: (data) => this.#decoded(data, generation), error: () => void this.stats.errors++ });
      decoder.configure(config);
      this.#decoder = decoder;
    } catch (error) {
      return this.#setUnsupported(`소리 디코더를 만들지 못했습니다 (${(error as Error).message})`);
    }
    this.#unsupportedReason = '';
    this.#refreshState();
  }

  /** One Opus frame from the bridge, or (lost) the news that a frame never came. */
  push(lost: boolean, payload: Uint8Array): void {
    if (!this.#ctx || !this.#decoder || this.#muted || !this.#visible) return;
    if (lost) {
      this.stats.concealed++;
      this.#scheduler.skip(this.#frameSec);
      this.#frameIndex++;
      return;
    }
    this.stats.frames++;
    if (this.#decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      this.#queueDropped++;
      this.stats.dropped = this.#queueDropped + this.#scheduler.dropped;
      this.#frameIndex++;
      return;
    }
    try {
      this.#decoder.decode(this.#deps.createChunk({ type: 'key', timestamp: Math.round(this.#frameIndex * this.#frameSec * 1e6), data: payload }));
    } catch {
      this.stats.errors++;
    }
    this.#frameIndex++;
  }

  #decoded(data: AudioDataLike, generation: number): void {
    try {
      const ctx = this.#ctx;
      if (!ctx || generation !== this.#generation || this.#muted || !this.#visible) return;
      this.stats.decoded++;
      const start = this.#scheduler.place(ctx.currentTime, data.numberOfFrames / data.sampleRate);
      this.stats.underruns = this.#scheduler.underruns;
      this.stats.dropped = this.#queueDropped + this.#scheduler.dropped;
      this.stats.delayMs = Math.round(this.#scheduler.bufferedSec(ctx.currentTime) * 1000);
      if (start === null) return;
      const channels = Math.min(data.numberOfChannels, MAX_CHANNELS);
      const buffer = ctx.createBuffer(channels, data.numberOfFrames, data.sampleRate);
      const plane = new Float32Array(data.numberOfFrames);
      for (let c = 0; c < channels; c++) {
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        buffer.copyToChannel(plane, c);
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.#gain ?? ctx.destination);
      source.start(start);
    } finally {
      data.close();
    }
  }
  /** Frames left out because the decoder had fallen behind. */
  #queueDropped = 0;

  /** Where the sound should lag, ms: the picture's own delay plus a little. Browsers differ, so it is only a target. */
  setTargetDelayMs(ms: number): void {
    this.#scheduler.setTarget(Math.min(MAX_DELAY_SEC, Math.max(MIN_DELAY_SEC, ms / 1000)));
  }

  setMuted(muted: boolean): void {
    if (muted === this.#muted) return;
    this.#muted = muted;
    if (!muted) this.#scheduler.reset(); // what was not played is gone; start afresh
    this.#applyGain();
    this.#refreshState();
  }

  get muted(): boolean {
    return this.#muted;
  }

  /**
   * The audio context's state: 'running', 'suspended' (no tap yet, or a hidden tab), 'interrupted' (an iPhone after a
   * call or an alarm), or 'none' (no context made yet). Anything but 'running' while the stream is up means silence
   * until unlock() is called again, in a tap.
   */
  get contextState(): string {
    return this.#ctx?.state ?? 'none';
  }

  /** 0 to 1. */
  setVolume(volume: number): void {
    this.#volume = Math.min(1, Math.max(0, volume));
    this.#applyGain();
  }

  /**
   * The sound as a MediaStream, for a recorder to put into a clip. It is taken after the volume and the mute, so a clip
   * has what the person hears. Null when there is no audio context yet (nothing was played) or the browser cannot make one.
   */
  captureStream(): unknown {
    const ctx = this.#ctx;
    if (!ctx || !this.#gain || !ctx.createMediaStreamDestination) return null;
    try {
      this.#tap ??= ctx.createMediaStreamDestination();
      this.#gain.connect(this.#tap); // connecting the same two nodes again changes nothing
      return this.#tap.stream;
    } catch {
      return null;
    }
  }

  /** Nobody listens to a hidden tab: nothing is decoded; shown again, the schedule starts afresh. */
  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    this.#scheduler.reset();
    if (this.#ctx) void (visible ? this.#ctx.resume() : this.#ctx.suspend()).catch(() => {});
    this.#refreshState();
  }

  /** The connection ended: stop decoding. The audio context stays, so that the next connection needs no new tap. */
  close(): void {
    this.#generation++;
    this.#closeDecoder();
    this.#scheduler.reset();
    this.stats = { state: this.#unsupportedReason ? 'unsupported' : 'idle', reason: this.#unsupportedReason, info: null, frames: 0, concealed: 0, decoded: 0, dropped: 0, underruns: 0, errors: 0, delayMs: 0 };
    this.#queueDropped = 0;
    this.#scheduler.underruns = 0;
    this.#scheduler.dropped = 0;
  }

  /** Give the audio context back (the page is closing). */
  destroy(): void {
    this.close();
    const ctx = this.#ctx;
    this.#ctx = null;
    this.#gain = null;
    this.#tap = null;
    if (ctx) void ctx.close().catch(() => {});
  }

  #applyGain(): void {
    if (this.#gain) this.#gain.gain.value = this.#muted ? 0 : this.#volume;
  }

  #closeDecoder(): void {
    try {
      this.#decoder?.close();
    } catch {
      /* already closed */
    }
    this.#decoder = null;
  }

  #setUnsupported(reason: string): void {
    this.#unsupportedReason = reason;
    this.stats.state = 'unsupported';
    this.stats.reason = reason;
  }

  #refreshState(): void {
    if (this.#unsupportedReason && !this.#decoder) return;
    this.stats.reason = '';
    this.stats.state = !this.#decoder ? 'idle' : this.#muted ? 'muted' : !this.#visible ? 'hidden' : 'playing';
  }
}

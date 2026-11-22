// SPDX-License-Identifier: AGPL-3.0-only
//
// The page's sound player (web/audio-player.ts) with a stand-in audio context and decoder. What these tests do not
// show is what a real browser makes of it, and what a real console's sound is like.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AudioPlayer, type AudioContextLike, type AudioDataLike, type AudioDecoderLike, type AudioInfo, type AudioPlayerDeps } from '../web/audio-player.ts';

const INFO: AudioInfo = { channels: 2, bits: 16, rate: 48000, frameSize: 480 };

interface Piece {
  when: number;
  channels: number;
  frames: number;
  /** What was copied into each channel: the fake decoder fills channel c with the value c + 1. */
  first: number[];
}

function world(over: { supported?: boolean; contextFails?: boolean; decoderFails?: boolean; queue?: number; autoOutput?: boolean } = {}): {
  deps: AudioPlayerDeps;
  ctx: AudioContextLike & { time: number; pieces: Piece[]; silentStarts: number; resumed: number; suspended: number; closed: number; contexts: number; gain: { value: number } };
  decoders: Array<{ configured: unknown; chunks: Array<{ timestamp: number }>; closed: boolean; emit: (data?: Partial<AudioDataLike>) => void }>;
  data: { closed: number };
  sessions: number;
  configs: unknown[];
} {
  const pieces: Piece[] = [];
  const gain = { value: 1 };
  const ctx = {
    time: 10,
    pieces,
    silentStarts: 0,
    resumed: 0,
    suspended: 0,
    closed: 0,
    contexts: 0,
    gain,
    get currentTime() {
      return this.time;
    },
    state: 'running',
    destination: { destination: true },
    createBuffer(channels: number, length: number) {
      const buffer = { channels, length, planes: [] as number[][], copyToChannel(source: Float32Array, channel: number) { buffer.planes[channel] = [source[0]!]; } };
      return buffer;
    },
    createBufferSource() {
      const node = { buffer: null as any, connect() {}, start(when: number) {
        if (node.buffer && node.buffer.length > 1) pieces.push({ when, channels: node.buffer.channels, frames: node.buffer.length, first: node.buffer.planes.map((p: number[]) => p[0]!) });
        else ctx.silentStarts++;
      } };
      return node;
    },
    createGain() {
      return { gain, connect() {} };
    },
    async resume() {
      ctx.resumed++;
    },
    async suspend() {
      ctx.suspended++;
    },
    async close() {
      ctx.closed++;
    },
  };
  const decoders: ReturnType<typeof world>['decoders'] = [];
  const data = { closed: 0 };
  const w = {
    ctx: ctx as any,
    decoders,
    data,
    sessions: 0,
    configs: [] as unknown[],
    deps: {} as AudioPlayerDeps,
  };
  w.deps = {
    createContext: () => {
      if (over.contextFails) throw new Error('no audio here');
      ctx.contexts++;
      return ctx as unknown as AudioContextLike;
    },
    isConfigSupported: async (config) => {
      w.configs.push(config);
      return over.supported ?? true;
    },
    createDecoder: (init) => {
      if (over.decoderFails) throw new Error('decoder refused');
      const d = {
        configured: null as unknown,
        chunks: [] as Array<{ timestamp: number }>,
        closed: false,
        emit: (partial: Partial<AudioDataLike> = {}) =>
          init.output({
            numberOfFrames: 480, numberOfChannels: (d.configured as { numberOfChannels?: number } | null)?.numberOfChannels ?? 2, sampleRate: 48000,
            copyTo: (dest, { planeIndex }) => dest.fill(planeIndex + 1),
            close: () => void data.closed++,
            ...partial,
          }),
      };
      const decoder: AudioDecoderLike = {
        get decodeQueueSize() {
          return over.queue ?? 0;
        },
        configure: (config) => void (d.configured = config),
        decode: (chunk) => {
          d.chunks.push(chunk as { timestamp: number });
          if (over.autoOutput !== false) d.emit();
        },
        close: () => void (d.closed = true),
      };
      decoders.push(d);
      return decoder;
    },
    createChunk: (init) => ({ timestamp: init.timestamp, bytes: init.data.length }),
    configureSession: () => void w.sessions++,
  };
  return w;
}

const frame = (n = 1): Uint8Array => new Uint8Array(n);
const started = async (over: Parameters<typeof world>[0] = {}, info = INFO) => {
  const w = world(over);
  const p = new AudioPlayer(w.deps);
  p.unlock();
  await p.start(info);
  return { w, p };
};

describe('unlocking the sound in a tap', () => {
  it('makes the audio context once, sets the audio session, resumes it and plays a silent sample to unlock an iPhone', () => {
    const w = world();
    const p = new AudioPlayer(w.deps);
    assert.equal(p.unlock(), true);
    assert.equal(p.unlock(), true);
    assert.equal(w.ctx.contexts, 1, 'one context, however many taps');
    assert.equal(w.sessions, 2, 'the session is set at every tap, which is cheap');
    assert.ok(w.ctx.resumed >= 2);
    assert.equal(w.ctx.silentStarts, 2);
  });

  it('reports the state of the audio context, so that the page can say when the browser is blocking the sound', () => {
    const w = world();
    const p = new AudioPlayer(w.deps);
    assert.equal(p.contextState, 'none');
    p.unlock();
    assert.equal(p.contextState, 'running');
    (w.ctx as { state: string }).state = 'interrupted'; // an iPhone after a call
    assert.equal(p.contextState, 'interrupted');
  });

  it('says so when this browser cannot make sound at all', () => {
    const w = world({ contextFails: true });
    const p = new AudioPlayer(w.deps);
    assert.equal(p.unlock(), false);
    assert.equal(p.stats.state, 'unsupported');
    assert.match(p.stats.reason, /소리를 낼 수 없습니다.*no audio here/);
  });
});

describe('starting the decoder', () => {
  it('configures Opus with the format the bridge announced and reports "playing"', async () => {
    const { w, p } = await started();
    assert.deepEqual(w.configs, [{ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }]);
    assert.deepEqual(w.decoders[0]!.configured, { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
    assert.equal(p.stats.state, 'playing');
    assert.deepEqual(p.stats.info, INFO);
  });

  it('says why when there are more channels than a browser can decode', async () => {
    const { w, p } = await started({}, { ...INFO, channels: 6 });
    assert.equal(p.stats.state, 'unsupported');
    assert.match(p.stats.reason, /6채널.*2채널까지만/);
    assert.equal(w.decoders.length, 0);
    p.push(false, frame());
    assert.equal(w.ctx.pieces.length, 0);
  });

  it('says why when the browser cannot decode Opus, naming the iOS version that can', async () => {
    const { p } = await started({ supported: false });
    assert.equal(p.stats.state, 'unsupported');
    assert.match(p.stats.reason, /Opus.*iOS 26/);
  });

  it('reports a decoder that cannot be made, and asks for the tap first when there is no context', async () => {
    const { p } = await started({ decoderFails: true });
    assert.match(p.stats.reason, /디코더를 만들지 못했습니다.*decoder refused/);
    const w = world();
    const early = new AudioPlayer(w.deps);
    await early.start(INFO);
    assert.match(early.stats.reason, /아직 풀리지 않았습니다/);
  });

  it('lets the newest start() win when an older one is still waiting for the browser', async () => {
    const w = world();
    let release: (v: boolean) => void = () => {};
    const slow = new Promise<boolean>((r) => (release = r));
    let calls = 0;
    w.deps.isConfigSupported = async () => (++calls === 1 ? slow : true);
    const p = new AudioPlayer(w.deps);
    p.unlock();
    const first = p.start(INFO);
    await p.start(INFO);
    release(true);
    await first;
    assert.equal(w.decoders.length, 1, 'the older start() made no decoder of its own');
  });
});

describe('playing', () => {
  it('places the decoded pieces on the clock, seamlessly, copying each channel', async () => {
    const { w, p } = await started();
    for (let i = 0; i < 3; i++) p.push(false, frame(80));
    assert.equal(w.ctx.pieces.length, 3);
    assert.ok(Math.abs(w.ctx.pieces[0]!.when - 10.08) < 1e-9, 'the first piece is the default delay ahead of now');
    assert.ok(Math.abs(w.ctx.pieces[1]!.when - 10.09) < 1e-9);
    assert.ok(Math.abs(w.ctx.pieces[2]!.when - 10.1) < 1e-9);
    assert.deepEqual(w.ctx.pieces[0]!, { when: w.ctx.pieces[0]!.when, channels: 2, frames: 480, first: [1, 2] });
    assert.equal(p.stats.frames, 3);
    assert.equal(p.stats.decoded, 3);
    assert.equal(w.data.closed, 3, 'every decoded piece is given back');
    assert.deepEqual(w.decoders[0]!.chunks.map((c) => c.timestamp), [0, 10000, 20000], 'timestamps follow the frame length');
  });

  it('lets a lost frame pass in silence, so the sound after it keeps its place in time', async () => {
    const { w, p } = await started();
    p.push(false, frame());
    p.push(true, new Uint8Array(0));
    p.push(false, frame());
    assert.equal(p.stats.concealed, 1);
    assert.ok(Math.abs(w.ctx.pieces[1]!.when - (w.ctx.pieces[0]!.when + 0.02)) < 1e-9);
  });

  it('plays a mono source as one channel', async () => {
    const { w, p } = await started({}, { ...INFO, channels: 1 });
    p.push(false, frame());
    assert.equal(w.ctx.pieces[0]!.channels, 1);
  });

  it('drops pieces that pile up instead of falling behind, and counts them', async () => {
    const { w, p } = await started();
    for (let i = 0; i < 40; i++) p.push(false, frame()); // a burst within one instant of the clock
    assert.ok(w.ctx.pieces.length < 40);
    assert.ok(p.stats.dropped > 0);
    assert.equal(w.data.closed, 40, 'dropped pieces are given back too');
    assert.ok(p.stats.delayMs <= 160);
  });

  it('leaves frames out while the decoder is far behind, and says so', async () => {
    const { w, p } = await started({ queue: 50 });
    p.push(false, frame());
    assert.equal(w.decoders[0]!.chunks.length, 0);
    assert.equal(p.stats.dropped, 1);
  });

  it('counts a gap in the sound when the pieces stop coming and then come again', async () => {
    const { w, p } = await started();
    p.push(false, frame());
    w.ctx.time = 12; // two seconds of nothing
    p.push(false, frame());
    assert.equal(p.stats.underruns, 1);
    assert.ok(Math.abs(w.ctx.pieces[1]!.when - 12.08) < 1e-9, 'it starts again with the cushion');
  });

  it('follows the picture\'s delay, within limits', async () => {
    const { w, p } = await started();
    p.setTargetDelayMs(150);
    p.push(false, frame());
    assert.ok(Math.abs(w.ctx.pieces[0]!.when - 10.15) < 1e-9);
    p.close();
    p.setTargetDelayMs(5);
    await p.start(INFO);
    p.push(false, frame());
    assert.ok(Math.abs(w.ctx.pieces.at(-1)!.when - 10.04) < 1e-9, 'never less than 40 ms');
  });
});

describe('muting, volume and a hidden tab', () => {
  it('plays nothing while muted, and starts afresh when unmuted', async () => {
    const { w, p } = await started();
    p.push(false, frame());
    p.setMuted(true);
    assert.equal(w.ctx.gain.value, 0);
    assert.equal(p.stats.state, 'muted');
    w.ctx.time = 11;
    for (let i = 0; i < 5; i++) p.push(false, frame());
    assert.equal(w.ctx.pieces.length, 1, 'nothing was decoded or scheduled while muted');
    p.setMuted(false);
    assert.equal(w.ctx.gain.value, 1);
    p.push(false, frame());
    assert.ok(Math.abs(w.ctx.pieces[1]!.when - 11.08) < 1e-9);
    assert.equal(p.stats.state, 'playing');
  });

  it('sets the volume, 0 to 1, and keeps a muted page silent', async () => {
    const { w, p } = await started();
    p.setVolume(0.4);
    assert.equal(w.ctx.gain.value, 0.4);
    p.setVolume(7);
    assert.equal(w.ctx.gain.value, 1);
    p.setMuted(true);
    p.setVolume(0.5);
    assert.equal(w.ctx.gain.value, 0, 'a volume change does not unmute');
  });

  it('suspends for a hidden tab, plays nothing meanwhile and starts afresh when it is shown again', async () => {
    const { w, p } = await started();
    p.push(false, frame());
    p.setVisible(false);
    assert.equal(w.ctx.suspended, 1);
    assert.equal(p.stats.state, 'hidden');
    p.push(false, frame());
    assert.equal(w.ctx.pieces.length, 1);
    w.ctx.time = 30;
    p.setVisible(true);
    assert.ok(w.ctx.resumed >= 2);
    p.push(false, frame());
    assert.ok(Math.abs(w.ctx.pieces[1]!.when - 30.08) < 1e-9);
    assert.equal(p.stats.underruns, 0, 'coming back is not counted as a gap');
  });
});

describe('ending', () => {
  it('stops the decoder and clears the numbers on close, but keeps the audio context for the next connection', async () => {
    const { w, p } = await started();
    p.push(false, frame());
    p.close();
    assert.equal(w.decoders[0]!.closed, true);
    assert.equal(w.ctx.closed, 0);
    assert.equal(p.stats.frames, 0);
    assert.equal(p.stats.state, 'idle');
    p.push(false, frame());
    assert.equal(w.ctx.pieces.length, 1, 'nothing plays after close');
    await p.start(INFO);
    p.push(false, frame());
    assert.equal(w.ctx.contexts, 1, 'the same context');
    assert.equal(w.ctx.pieces.length, 2);
  });

  it('gives the audio context back on destroy', async () => {
    const { w, p } = await started();
    p.destroy();
    assert.equal(w.ctx.closed, 1);
  });

  it('forgets decoded audio that arrives after a close (the decoder is asynchronous)', async () => {
    const { w, p } = await started({ autoOutput: false });
    p.push(false, frame());
    p.close();
    w.decoders[0]!.emit();
    assert.equal(w.ctx.pieces.length, 0);
    assert.equal(w.data.closed, 1, 'and it is still given back');
  });
});

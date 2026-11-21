// SPDX-License-Identifier: AGPL-3.0-only
//
// Draws the frames a bridge sends onto a canvas. Handles PNG (test frames) and H.264 Annex B
// through WebCodecs (a real console). HEVC is not handled: ask the console for H.264 when using a browser.
//
// Decoded frames are not drawn the moment they are ready: they go out on the pace the console made them at, a little
// later than the earliest possible, so that a frame which arrives late does not show as a freeze (see playout.ts).
// That can be switched off (mode 'immediate'), and what the viewer actually saw is counted either way.

import { findSpsCodec } from '../src/bridge/h264.ts';
import { DisplayMeter, Playout, type PlayoutOptions } from '../src/bridge/playout.ts';
import { CODEC, type VideoHeader } from '../src/bridge/protocol.ts';

/**
 * How far the decoder may fall behind before the stream is cut and started again from a key frame, in ms of stream.
 * That restart is the last resort, because it costs more than what it cures: measured on a real PS5, the key frame
 * comes 0.85 to 0.95 s after it is asked for, and the picture stands still until then. After a stall on the network
 * all the frames that were held up arrive at once, and a decoder works through them in a fraction of the time they
 * cover, so the right answer to a backlog is almost always to let it. (This limit was 6 frames, then half a second:
 * both turned stalls of 0.1 to 0.7 s into freezes of a second.) Only a decoder that cannot keep up at all gets here.
 */
const MAX_BEHIND_MS = 2000;
const MIN_QUEUE = 30;
/** Decoded frames waiting for their turn above this count: the oldest goes (a hidden tab draws nothing). */
const MAX_WAITING = 12;

interface Waiting {
  frame: VideoFrame;
  dueAt: number;
  header: VideoHeader | undefined;
}

export class VideoPlayer {
  decoded = 0;
  dropped = 0;
  lastFrameAt = 0;
  error = '';
  /** Give the canvas the size of the decoded picture, so a console's picture is not scaled down before it is shown. */
  fitCanvas = false;
  /** Called when the stream needs a keyframe to continue (start, error, or after dropping frames). */
  onNeedKeyframe: () => void = () => {};
  /** Called for every frame that was drawn, with the header it arrived with. */
  onFrame: (header: VideoHeader) => void = () => {};
  /** When frames are shown. Replace it with setPlayout(). */
  playout = new Playout();
  /** What went on the screen, for the page's readout and the bridge's measurements. */
  readonly meter = new DisplayMeter();

  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #decoder: VideoDecoder | null = null;
  #codec = '';
  #waitKey = true;
  #busy = false;
  #pending = new Map<number, { header: VideoHeader; at: number }>();
  /** Times the decoder fell so far behind that the stream had to restart from a key frame. Several in a row mean this device cannot decode this quality in time. */
  resyncs = 0;
  #playoutOptions: PlayoutOptions = {};
  #waiting: Waiting[] = [];
  #raf = 0;
  /** How far apart the screen's refreshes are, learned from the animation callbacks, in ms. */
  #refreshMs = 16.7;
  #lastTick = 0;
  #visible = true;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  }

  /** Change how frames are paced. Takes effect at once; what is waiting is shown on the next refresh. */
  setPlayout(options: PlayoutOptions): void {
    this.#playoutOptions = options;
    this.playout = new Playout(options);
  }

  get playoutOptions(): PlayoutOptions {
    return this.#playoutOptions;
  }

  /**
   * Tell the player whether anybody can see the picture. A browser stops a hidden tab from drawing and may hold all of
   * its work back for seconds at a time; frames decoded or counted then are wasted work and false alarms. While
   * hidden nothing is decoded; on coming back the stream continues from a fresh key frame, paced afresh.
   */
  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    for (const w of this.#waiting.splice(0)) w.frame.close();
    this.#waitKey = true;
    this.playout = new Playout(this.#playoutOptions);
    this.meter.pause();
    if (visible) this.onNeedKeyframe();
  }

  /** Decoded frames waiting for their turn. */
  get waiting(): number {
    return this.#waiting.length;
  }

  push(header: VideoHeader, data: Uint8Array): void {
    if (!this.#visible && header.codec !== CODEC.PNG) return; // nobody is looking: see setVisible()
    if (header.codec === CODEC.PNG) void this.#png(header, data);
    else if (header.codec === CODEC.H264) this.#h264(header, data);
    else this.error = `unsupported codec ${header.codec}: request H.264 for a browser`;
  }

  close(): void {
    try {
      this.#decoder?.close();
    } catch {
      /* already closed */
    }
    this.#decoder = null;
    this.#codec = '';
    this.#waitKey = true;
    this.#pending.clear();
    for (const w of this.#waiting.splice(0)) w.frame.close();
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.playout = new Playout(this.#playoutOptions); // a new stream has its own pace
    this.meter.pause();
  }

  async #png(header: VideoHeader, data: Uint8Array): Promise<void> {
    if (this.#busy) {
      this.dropped++;
      return;
    }
    this.#busy = true;
    try {
      const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }));
      this.#ctx.drawImage(bitmap, 0, 0, this.#canvas.width, this.#canvas.height);
      bitmap.close();
      this.#drawn(header);
    } catch (e) {
      this.error = String(e);
    } finally {
      this.#busy = false;
    }
  }

  #drawn(header: VideoHeader): void {
    this.decoded++;
    this.lastFrameAt = performance.now();
    this.onFrame(header);
  }

  /** Put a decoded frame on the canvas. */
  #show(w: Waiting, now: number): void {
    const frame = w.frame;
    if (this.fitCanvas && (this.#canvas.width !== frame.displayWidth || this.#canvas.height !== frame.displayHeight)) {
      this.#canvas.width = frame.displayWidth;
      this.#canvas.height = frame.displayHeight;
    }
    this.#ctx.drawImage(frame, 0, 0, this.#canvas.width, this.#canvas.height);
    frame.close();
    this.meter.shown(now, this.playout.intervalMs);
    if (w.header) this.#drawn(w.header);
  }

  /** A decoded frame is ready: decide when it goes out. */
  #ready(frame: VideoFrame, header: VideoHeader | undefined): void {
    const now = performance.now();
    const decision = this.playout.schedule(header?.frameId ?? 0, now);
    this.meter.arrived(decision);
    const w: Waiting = { frame, dueAt: decision.dueAt, header };
    if (decision.dueAt <= now + 0.5) {
      // Due now: whatever was still waiting is older and is not shown any more.
      this.#skip(this.#waiting.splice(0));
      this.#show(w, now);
      return;
    }
    this.#waiting.push(w);
    if (this.#waiting.length > MAX_WAITING) this.#skip(this.#waiting.splice(0, this.#waiting.length - MAX_WAITING));
    if (!this.#raf) this.#raf = requestAnimationFrame(this.#tick);
  }

  #skip(list: Waiting[]): void {
    for (const w of list) w.frame.close();
    if (list.length) this.meter.skipped(list.length);
  }

  /** Once per screen refresh: show the newest frame whose time has come. */
  #tick = (now: number): void => {
    this.#raf = 0;
    if (this.#lastTick > 0) {
      const d = now - this.#lastTick;
      if (d > 3 && d < 50) this.#refreshMs += (d - this.#refreshMs) * 0.1;
    }
    this.#lastTick = now;
    // A frame due before the middle of the coming refresh goes out with this one.
    const horizon = now + this.#refreshMs / 2;
    let due = 0;
    while (due < this.#waiting.length && this.#waiting[due]!.dueAt <= horizon) due++;
    if (due > 0) {
      const ready = this.#waiting.splice(0, due);
      const newest = ready.pop()!;
      this.#skip(ready);
      this.#show(newest, now);
    }
    if (this.#waiting.length) this.#raf = requestAnimationFrame(this.#tick);
    else this.#lastTick = 0;
  };

  #configure(codec: string): void {
    this.close();
    this.#codec = codec;
    const decoder = new VideoDecoder({
      output: (frame) => {
        const sent = this.#pending.get(frame.timestamp);
        this.#pending.delete(frame.timestamp);
        if (sent) this.meter.decoded(performance.now() - sent.at, decoder.decodeQueueSize);
        this.#ready(frame, sent?.header);
      },
      error: (e) => {
        this.error = String(e);
        this.#decoder = null;
        this.#codec = '';
        this.#waitKey = true;
        this.onNeedKeyframe();
      },
    });
    decoder.configure({ codec, optimizeForLatency: true });
    this.#decoder = decoder;
    this.#waitKey = true;
  }

  #h264(header: VideoHeader, data: Uint8Array): void {
    if (typeof VideoDecoder === 'undefined') {
      this.error = 'WebCodecs is not available in this browser';
      return;
    }
    if (header.key) {
      const codec = findSpsCodec(data);
      if (codec && (codec !== this.#codec || !this.#decoder)) this.#configure(codec);
    }
    if (!this.#decoder) {
      this.dropped++;
      this.onNeedKeyframe();
      return;
    }
    if (this.#waitKey && !header.key) {
      this.dropped++;
      return;
    }
    const interval = this.playout.intervalMs || 1000 / 30;
    if (this.#decoder.decodeQueueSize > Math.max(MIN_QUEUE, MAX_BEHIND_MS / interval) && !header.key) {
      this.dropped++;
      this.resyncs++;
      this.meter.resync();
      this.playout = new Playout(this.#playoutOptions); // what follows the key frame is paced afresh
      this.#waitKey = true;
      this.onNeedKeyframe();
      return;
    }
    if (header.key) this.#waitKey = false;
    const timestamp = Math.round(header.ptsMs * 1000);
    this.#pending.set(timestamp, { header, at: performance.now() });
    if (this.#pending.size > 64) this.#pending.delete(this.#pending.keys().next().value as number);
    this.#decoder.decode(new EncodedVideoChunk({ type: header.key ? 'key' : 'delta', timestamp, data }));
  }
}

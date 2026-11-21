// SPDX-License-Identifier: AGPL-3.0-only
//
// Draws the frames a bridge sends onto a canvas. Handles PNG (test frames) and H.264 Annex B
// through WebCodecs (a real console). HEVC is not handled: ask the console for H.264 when using a browser.

import { findSpsCodec } from '../src/bridge/h264.ts';
import { CODEC, type VideoHeader } from '../src/bridge/protocol.ts';

/** Frames waiting in the decoder above this count mean we are falling behind: drop and ask for a keyframe. */
const MAX_QUEUE = 6;

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

  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #decoder: VideoDecoder | null = null;
  #codec = '';
  #waitKey = true;
  #busy = false;
  #pending = new Map<number, VideoHeader>();

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  }

  push(header: VideoHeader, data: Uint8Array): void {
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

  #configure(codec: string): void {
    this.close();
    this.#codec = codec;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.fitCanvas && (this.#canvas.width !== frame.displayWidth || this.#canvas.height !== frame.displayHeight)) {
          this.#canvas.width = frame.displayWidth;
          this.#canvas.height = frame.displayHeight;
        }
        this.#ctx.drawImage(frame, 0, 0, this.#canvas.width, this.#canvas.height);
        const header = this.#pending.get(frame.timestamp);
        this.#pending.delete(frame.timestamp);
        frame.close();
        if (header) this.#drawn(header);
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
    if (this.#decoder.decodeQueueSize > MAX_QUEUE && !header.key) {
      this.dropped++;
      this.#waitKey = true;
      this.onNeedKeyframe();
      return;
    }
    if (header.key) this.#waitKey = false;
    const timestamp = Math.round(header.ptsMs * 1000);
    this.#pending.set(timestamp, header);
    if (this.#pending.size > 64) this.#pending.delete(this.#pending.keys().next().value as number);
    this.#decoder.decode(new EncodedVideoChunk({ type: header.key ? 'key' : 'delta', timestamp, data }));
  }
}

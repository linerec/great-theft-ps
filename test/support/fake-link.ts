// SPDX-License-Identifier: AGPL-3.0-only
//
// FakeLink: a TEST DOUBLE for a console link. It is not part of the app and is never offered to a user: it exists so the bridge's\n// relay logic (authentication, pad handling, backpressure, quality changes) can be tested without a PlayStation.
// It streams real PNG frames that draw the pad state it RECEIVED (sticks, triggers, buttons), the frame number
// and the last input sequence it applied. So you can see, and measure, the whole path: keyboard and mouse ->
// mapping -> bridge -> console -> picture -> browser.
//
// It honours resolution (capped to 960x540) and frame rate from a quality request. It ignores the bitrate
// (PNG frames have no rate control), so it cannot show the data savings of a real H.264 stream.

import { BUTTON_NAMES, BUTTON, emptyPadState, type VirtualPadState } from '../../src/engine/types.ts';
import type { ConsoleLink, LinkHandlers } from '../../src/bridge/console-link.ts';
import { encodePng } from './png.ts';
import { CODEC } from '../../src/bridge/protocol.ts';
import type { QualityRequest } from '../../src/bridge/quality.ts';

// 3x5 digits, one row per 3-bit number.
const GLYPHS: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7], '3': [7, 1, 7, 1, 7], '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7], '6': [7, 4, 7, 5, 7], '7': [7, 1, 1, 1, 1], '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 7],
  '-': [0, 0, 7, 0, 0],
};

const MAX_W = 960;
const MAX_H = 540;

type Rgb = [number, number, number];

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 3);
  }
  rect(x: number, y: number, rw: number, rh: number, c: Rgb): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + rw));
    const y1 = Math.min(this.h, Math.round(y + rh));
    for (let yy = y0; yy < y1; yy++) {
      let i = (yy * this.w + x0) * 3;
      for (let xx = x0; xx < x1; xx++) {
        this.data[i++] = c[0];
        this.data[i++] = c[1];
        this.data[i++] = c[2];
      }
    }
  }
  number(value: number, x: number, y: number, scale: number, c: Rgb): void {
    let cx = x;
    for (const ch of String(Math.trunc(value))) {
      const g = GLYPHS[ch];
      if (g) {
        for (let row = 0; row < 5; row++) {
          for (let col = 0; col < 3; col++) {
            if ((g[row]! >> (2 - col)) & 1) this.rect(cx + col * scale, y + row * scale, scale, scale, c);
          }
        }
      }
      cx += 4 * scale;
    }
  }
}

export class FakeLink implements ConsoleLink {
  readonly name = 'mock';

  #handlers: LinkHandlers | null = null;
  #quality!: QualityRequest;
  #timer: ReturnType<typeof setInterval> | null = null;
  #frameId = 0;
  #startedAt = 0;
  #pad: VirtualPadState = emptyPadState();
  #seq = 0;
  #padCount = 0;

  get lastPad(): VirtualPadState {
    return this.#pad;
  }
  get lastSeq(): number {
    return this.#seq;
  }
  get padCount(): number {
    return this.#padCount;
  }
  get quality(): QualityRequest {
    return this.#quality;
  }

  async start(handlers: LinkHandlers, quality: QualityRequest): Promise<void> {
    this.#handlers = handlers;
    this.#quality = quality;
    this.#startedAt = Date.now();
    handlers.onStatus({ state: 'streaming', detail: 'fake link (test double)' });
    this.#schedule();
  }

  sendPad(seq: number, state: VirtualPadState): void {
    this.#pad = state;
    this.#seq = seq;
    this.#padCount++;
  }

  setQuality(quality: QualityRequest): void {
    this.#quality = quality;
    this.#schedule();
  }

  requestKeyframe(): void {
    // Every PNG frame is independent.
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#handlers?.onStatus({ state: 'closed' });
    this.#handlers = null;
  }

  #schedule(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = setInterval(() => this.#frame(), 1000 / this.#quality.fps);
    this.#timer.unref?.();
  }

  #frame(): void {
    const q = this.#quality;
    const k = Math.min(1, MAX_W / q.width, MAX_H / q.height);
    const w = Math.max(160, Math.round(q.width * k));
    const h = Math.max(90, Math.round(q.height * k));
    const c = new Canvas(w, h);
    const id = ++this.#frameId;

    // Background and a bar that moves every frame, so consecutive frames differ.
    for (let y = 0; y < h; y++) c.rect(0, y, w, 1, [18 + (y * 14) / h, 22 + (y * 18) / h, 34 + (y * 30) / h]);
    c.rect(0, (id * 3) % h, w, Math.max(1, h / 90), [60, 74, 110]);

    const px = Math.max(1, Math.floor(h / 72));
    const s = h * 0.34;
    const pad = this.#pad;
    const stick = (cx: number, cy: number, sx: number, sy: number): void => {
      c.rect(cx - s / 2, cy - s / 2, s, s, [34, 40, 58]);
      c.rect(cx - 1, cy - s / 2, 2, s, [52, 60, 84]);
      c.rect(cx - s / 2, cy - 1, s, 2, [52, 60, 84]);
      c.rect(cx + (sx * s) / 2 - px * 2, cy + (sy * s) / 2 - px * 2, px * 4, px * 4, [96, 200, 255]);
    };
    stick(w * 0.2, h * 0.62, pad.leftX, pad.leftY);
    stick(w * 0.8, h * 0.62, pad.rightX, pad.rightY);

    // Triggers.
    c.rect(w * 0.08, h * 0.22, w * 0.3, h * 0.04, [40, 46, 66]);
    c.rect(w * 0.08, h * 0.22, (w * 0.3 * pad.l2) / 255, h * 0.04, [255, 180, 80]);
    c.rect(w * 0.62, h * 0.22, w * 0.3, h * 0.04, [40, 46, 66]);
    c.rect(w * 0.62, h * 0.22, (w * 0.3 * pad.r2) / 255, h * 0.04, [255, 180, 80]);

    // Sixteen buttons in a 4 x 4 grid.
    const bs = h * 0.07;
    BUTTON_NAMES.forEach((name, i) => {
      const on = (pad.buttons & BUTTON[name]) !== 0;
      c.rect(w * 0.38 + (i % 4) * bs * 1.3, h * 0.5 + Math.floor(i / 4) * bs * 1.3, bs, bs, on ? [120, 230, 140] : [44, 50, 70]);
    });

    c.number(id, w * 0.03, h * 0.04, px, [230, 230, 240]);
    c.number(this.#seq, w * 0.97 - String(this.#seq).length * 4 * px, h * 0.04, px, [255, 210, 120]);

    this.#handlers?.onVideo({
      header: { codec: CODEC.PNG, key: true, frameId: id, inputSeq: this.#seq, ptsMs: Date.now() - this.#startedAt },
      data: encodePng(w, h, c.data),
    });
  }
}

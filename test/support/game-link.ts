// SPDX-License-Identifier: AGPL-3.0-only
//
// A made-up game behind the bridge, as a console link: the camera turns when the right stick is pushed (see lookworld.ts)
// and the picture goes out as PNG frames. For trying the page's measuring of a game's response in a real browser
// (tools/e2e-look.mjs), where nothing is simulated except the console.

import { CODEC } from '../../src/bridge/protocol.ts';
import type { ConsoleLink, LinkHandlers } from '../../src/bridge/console-link.ts';
import type { QualityRequest } from '../../src/bridge/quality.ts';
import type { VirtualPadState } from '../../src/engine/types.ts';
import { GameModel, rng, World, type GameOptions } from './lookworld.ts';
import { encodePng } from './png.ts';

export class GameLink implements ConsoleLink {
  readonly name = 'mock';
  readonly world: World;
  readonly model: GameModel;
  /** Every right stick value the page sent while this link was up, for looking at what it did. */
  sticks: Array<{ x: number; y: number }> = [];
  /** Anything but the right stick that was not neutral: a measurement must not touch it. */
  strayInput = 0;

  #fps: number;
  #handlers: LinkHandlers | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #t0 = 0;
  #frameId = 0;
  #seq = 0;
  #rand = rng(3);

  constructor(o: GameOptions & { fps?: number; world?: World }) {
    this.world = o.world ?? new World({ w: 320, h: 180, ppd: 4 });
    this.model = new GameModel(o);
    this.#fps = o.fps ?? 30;
  }

  async start(handlers: LinkHandlers, _quality: QualityRequest): Promise<void> {
    this.#handlers = handlers;
    this.#t0 = Date.now();
    handlers.onStatus({ state: 'streaming', detail: 'made-up game (test double)' });
    this.#timer = setInterval(() => this.#frame(), 1000 / this.#fps);
    this.#timer.unref?.();
  }

  sendPad(seq: number, s: VirtualPadState): void {
    this.#seq = seq;
    if (this.sticks.length === 0 || this.sticks.at(-1)!.x !== s.rightX || this.sticks.at(-1)!.y !== s.rightY) this.sticks.push({ x: s.rightX, y: s.rightY });
    if (s.buttons !== 0 || s.l2 !== 0 || s.r2 !== 0 || s.leftX !== 0 || s.leftY !== 0) this.strayInput++;
    this.model.set(s.rightX, s.rightY, Date.now() - this.#t0);
  }

  setQuality(_quality: QualityRequest): void {}

  requestKeyframe(): void {}

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#handlers?.onStatus({ state: 'closed' });
    this.#handlers = null;
  }

  #frame(): void {
    const now = Date.now() - this.#t0;
    this.model.advance(now);
    const g = this.world.render(this.model.yaw, this.model.pitch, now / 1000, 1.5, this.#rand);
    const rgb = new Uint8Array(g.w * g.h * 3);
    for (let i = 0; i < g.w * g.h; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = g.data[i]!;
    this.#handlers?.onVideo({ header: { codec: CODEC.PNG, key: true, frameId: ++this.#frameId, inputSeq: this.#seq, ptsMs: now }, data: encodePng(g.w, g.h, rgb) });
  }
}

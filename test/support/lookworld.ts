// SPDX-License-Identifier: AGPL-3.0-only
//
// A made-up game for testing the look measurement: a world that wraps all the way round (360 degrees), a camera that
// turns according to a stick-to-rate table with a delay and a ramp-up, and what a screen would show of it (with a HUD and
// a character that stay put, and things that move by themselves). Deterministic: the same seed gives the same world.

import { rateAt, type CalPoint } from '../../src/engine/calibration.ts';
import type { Gray, TimedFrame } from '../../src/engine/lookmeasure.ts';
import type { LookIo } from '../../src/engine/lookcalibrate.ts';

/** A small deterministic random number generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WorldOptions {
  seed?: number;
  /** Pixels on the screen per degree of turning. */
  ppd?: number;
  w?: number;
  h?: number;
}

export class World {
  readonly ppd: number;
  readonly w: number;
  readonly h: number;
  /** One full turn, in pixels. */
  readonly period: number;
  /** The world is taller than the screen so that the camera can look up and down. */
  readonly margin = 90;
  #pixels: Float32Array;
  #height: number;

  constructor(o: WorldOptions = {}) {
    this.ppd = o.ppd ?? 3.2;
    this.w = o.w ?? 256;
    this.h = o.h ?? 144;
    this.period = Math.round(360 * this.ppd);
    this.#height = this.h + 2 * this.margin;
    const rand = rng(o.seed ?? 1);
    this.#pixels = new Float32Array(this.period * this.#height);
    // A sky-to-ground gradient, buildings, and fine texture that never repeats.
    for (let y = 0; y < this.#height; y++) for (let x = 0; x < this.period; x++) this.#pixels[y * this.period + x] = 70 + (y / this.#height) * 60;
    for (let i = 0; i < 160; i++) {
      const bx = Math.floor(rand() * this.period);
      const bw = 14 + Math.floor(rand() * 60);
      const by = Math.floor(rand() * this.#height * 0.8);
      const bh = 20 + Math.floor(rand() * 120);
      const v = 30 + rand() * 190;
      for (let y = by; y < Math.min(this.#height, by + bh); y++) for (let x = bx; x < bx + bw; x++) this.#pixels[y * this.period + (x % this.period)] = v + ((x * 7 + y * 13) % 11);
    }
    for (let i = 0; i < this.#pixels.length; i++) this.#pixels[i] = this.#pixels[i]! + (rand() - 0.5) * 28;
  }

  /** What the camera sees at this yaw and pitch (degrees), grey 0..255, with a HUD and a character painted on top. */
  render(yawDeg: number, pitchDeg: number, t = 0, noise = 1.5, rand: () => number = Math.random): Gray {
    const { w, h, period, ppd } = this;
    const out = new Uint8Array(w * h);
    const offX = yawDeg * ppd;
    const offY = this.margin + pitchDeg * ppd;
    for (let y = 0; y < h; y++) {
      const wy = Math.min(this.#height - 2, Math.max(0, offY + y));
      const y0 = Math.floor(wy);
      const fy = wy - y0;
      for (let x = 0; x < w; x++) {
        const wx = (((offX + x) % period) + period) % period;
        const x0 = Math.floor(wx);
        const x1 = (x0 + 1) % period;
        const fx = wx - x0;
        const a = this.#pixels[y0 * period + x0]! * (1 - fx) + this.#pixels[y0 * period + x1]! * fx;
        const b = this.#pixels[(y0 + 1) * period + x0]! * (1 - fx) + this.#pixels[(y0 + 1) * period + x1]! * fx;
        out[y * w + x] = a * (1 - fy) + b * fy;
      }
    }
    const paint = (x0: number, y0: number, rw: number, rh: number, v: (x: number, y: number) => number): void => {
      for (let y = Math.max(0, y0); y < Math.min(h, y0 + rh); y++) for (let x = Math.max(0, x0); x < Math.min(w, x0 + rw); x++) out[y * w + x] = v(x - x0, y - y0);
    };
    paint(w / 2 - 12, h / 2 - 8, 24, 70, (x, y) => 90 + ((x * 5 + y * 3) % 40)); // the character: always in the same place
    paint(6, 6, 40, 14, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 235 : 60); // HUD, top left
    paint(w - 40, h - 34, 32, 28, (x, y) => (Math.hypot(x - 16, y - 14) < 13 ? 200 : 40)); // minimap, bottom right
    // Things that move by themselves, whatever the camera does.
    paint(Math.floor((20 + 31 * t) % (w - 30)), 30, 26, 18, (x, y) => 20 + ((x * 11 + y * 17) % 200));
    paint(Math.floor((w - 40 - 23 * t) % (w - 30) + 30) % (w - 30), 90, 22, 16, (x, y) => 240 - ((x * 13 + y * 7) % 150));
    if (noise > 0) for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, out[i]! + (rand() + rand() + rand() - 1.5) * noise * 2));
    return { w, h, data: out };
  }
}

export interface GameOptions {
  /** Stick (0..1) -> turn rate (degrees per second), as the game would give it once the stick has been held for a while. */
  table: CalPoint[];
  /** How long it takes for a stick to show in the picture, ms. */
  latencyMs?: number;
  /** The camera starts at this share of the table's rate and works up to the whole in `rampMs`. */
  rampStart?: number;
  rampMs?: number;
  /** Vertical rate relative to horizontal. */
  verticalRatio?: number;
  pitchLimit?: number;
}

/** The turn rate `time` ms after the stick was first held, as a share of the table's rate. */
export const rampAt = (rampStart: number, rampMs: number, timeMs: number): number => rampStart + (1 - rampStart) * Math.min(1, Math.max(0, timeMs) / rampMs);

/**
 * The turn rate that a flick of the stick gives on average between `fromMs` and `toMs` after the stick is set, for the
 * game described by `o` (what the measurement should find).
 */
export function flickRate(o: GameOptions, stick: number, fromMs: number, toMs: number): number {
  const latency = o.latencyMs ?? 0;
  const base = rateAt(o.table, Math.abs(stick));
  let sum = 0;
  let n = 0;
  for (let t = fromMs; t < toMs; t += 1) {
    sum += base * rampAt(o.rampStart ?? 1, o.rampMs ?? 1, t - latency);
    n++;
  }
  return sum / n;
}

/**
 * The camera of the made-up game: the stick it is given (seen `latencyMs` later), the turn rate that gives with the
 * ramp-up, and where the camera points. It knows nothing about frames or clocks: give it the time.
 */
export class GameModel {
  yaw = 0;
  pitch = 0;
  #o: Required<GameOptions>;
  /** The stick the game sees, which is the one set `latencyMs` ago. */
  #queue: Array<{ at: number; x: number; y: number }> = [{ at: -1e9, x: 0, y: 0 }];
  #heldSince = -1;
  #at = 0;

  constructor(o: GameOptions) {
    this.#o = { latencyMs: 120, rampStart: 1, rampMs: 1, verticalRatio: 0.6, pitchLimit: 25, ...o } as Required<GameOptions>;
  }

  /** The right stick is set to (x, y) at time `at` ms. */
  set(x: number, y: number, at: number): void {
    this.#queue.push({ at, x, y });
    if (this.#queue.length > 400) this.#queue.splice(0, 200);
  }

  #seen(at: number): { x: number; y: number } {
    const when = at - this.#o.latencyMs;
    let seen = this.#queue[0]!;
    for (const q of this.#queue) if (q.at <= when) seen = q;
    return seen;
  }

  /** Let the game run up to time `to` ms, in steps of at most 5 ms. */
  advance(to: number): void {
    while (this.#at < to) {
      const dtMs = Math.min(5, to - this.#at);
      this.#at += dtMs;
      const s = this.#seen(this.#at);
      if (Math.hypot(s.x, s.y) > 0) {
        if (this.#heldSince < 0) this.#heldSince = this.#at;
      } else this.#heldSince = -1;
      const ramp = this.#heldSince < 0 ? 1 : rampAt(this.#o.rampStart, this.#o.rampMs, this.#at - this.#heldSince);
      const dt = dtMs / 1000;
      this.yaw += Math.sign(s.x) * rateAt(this.#o.table, Math.abs(s.x)) * ramp * dt;
      this.pitch = Math.max(-this.#o.pitchLimit, Math.min(this.#o.pitchLimit, this.pitch + Math.sign(s.y) * rateAt(this.#o.table, Math.abs(s.y)) * this.#o.verticalRatio * ramp * dt));
    }
  }
}

/** The game and the screen, in virtual time (nothing waits for a clock), as the look measurement's `LookIo`. */
export class SimIo implements LookIo {
  readonly world: World;
  readonly model: GameModel;
  now = 0;
  frameMs: number;
  #sx = 0;
  #sy = 0;
  #rand: () => number;
  /** Everything the camera did, for tests that look at it: [time ms, yaw degrees]. */
  trace: Array<[number, number]> = [];
  holds = 0;

  constructor(o: GameOptions & { world?: World; fps?: number; seed?: number }) {
    this.world = o.world ?? new World();
    this.model = new GameModel(o);
    this.frameMs = 1000 / (o.fps ?? 60);
    this.#rand = rng(o.seed ?? 7);
  }

  get yaw(): number {
    return this.model.yaw;
  }

  get pitch(): number {
    return this.model.pitch;
  }

  #set(x: number, y: number): void {
    this.#sx = x;
    this.#sy = y;
    this.model.set(x, y, this.now);
  }

  async #run(ms: number, stop?: (frames: TimedFrame[]) => boolean): Promise<TimedFrame[]> {
    const frames: TimedFrame[] = [];
    const start = this.now;
    while (this.now - start < ms) {
      this.now += this.frameMs;
      this.model.advance(this.now);
      this.trace.push([this.now, this.model.yaw]);
      // A picture shows the world as it is now; the delay is in the stick, not in the picture.
      frames.push({ t: this.now - start, img: this.world.render(this.model.yaw, this.model.pitch, this.now / 1000, 1.5, this.#rand) });
      if (stop?.(frames)) break;
    }
    return frames;
  }

  async hold(x: number, y: number, ms: number, stop?: (frames: TimedFrame[]) => boolean): Promise<TimedFrame[]> {
    this.holds++;
    this.#set(x, y);
    return this.#run(ms, stop);
  }

  async rest(ms: number): Promise<TimedFrame[]> {
    this.#set(0, 0);
    return this.#run(ms);
  }

  get stick(): { x: number; y: number } {
    return { x: this.#sx, y: this.#sy };
  }
}

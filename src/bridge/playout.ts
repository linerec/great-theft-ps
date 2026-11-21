// SPDX-License-Identifier: AGPL-3.0-only
//
// When to show each frame. This project's own work, not a port.
//
// A console makes frames at an even pace. They do not arrive at one: on Wi-Fi a whole frame is now and then 40 to
// 60 ms late (measured on a real PS5 at 1080p60: no loss at all, but a few such frames about every 20 s, and the
// same delays in plain pings to the router). Showing every frame the moment it arrives copies that onto the screen as
// a short freeze followed by a catch-up, which is what makes a stream feel like it stutters.
//
// The answer here is the one audio players have always used: do not show a frame on arrival, show it on the pace it
// was made at, a little later than the earliest it could have been shown. A frame that is late by less than that
// "little later" still goes out exactly on its beat and nobody sees anything. The cost is that delay, added to
// everything, so it is kept as small as what was actually seen requires, and it can be switched off.
//
// How:
//  - The "on time" line says when frame n arrives if nothing holds it up: line(n) = offset + interval * n. It follows
//    the earliest arrivals (a frame cannot arrive earlier than on time): an earlier frame pulls it down at once, and it
//    creeps up slowly otherwise, so two clocks drifting apart do not matter. The interval is learned from the first
//    frames and corrected from where the earliest arrivals lie as the stream goes on.
//  - How late a frame is = its arrival minus the line.
//  - The delay in use covers the latest frame seen in the last minute (plus a small margin, up to a limit). It goes up
//    at once when a later frame turns up and comes down slowly.
//  - A frame is due at line(n) + delay. One that arrives after that is shown at once and counted: that one the viewer
//    did see.
//  - If frames stay far behind the line (the console changed its frame rate, or stopped for a while), the pace is
//    learned again instead of trusted.

export type PlayoutMode = 'smooth' | 'immediate';

export interface PlayoutOptions {
  /** 'smooth' holds frames back to an even pace. 'immediate' shows each one as it arrives (the least delay). */
  mode?: PlayoutMode;
  /** The most delay that may be added, in ms. Default 100. */
  maxDelayMs?: number;
  /** A fixed delay instead of one that follows what is seen. For experiments. */
  fixedDelayMs?: number;
  /** How long a late frame is remembered when the delay is chosen, in ms. Default 60000. */
  memoryMs?: number;
  /** Added on top of the latest frame seen, in ms. Default 3. */
  marginMs?: number;
}

export interface PlayoutDecision {
  /** When to show the frame, on the clock the arrival time was given in. Never before the arrival. */
  dueAt: number;
  /** How much later than on time the frame arrived, in ms. 0 while the pace is being learned. */
  lateMs: number;
  /** The frame came after its slot: it is shown at once, and the viewer sees a hitch. */
  underrun: boolean;
}

/** The pace is taken from the first frames once there are this many of them, over at least this long. */
const LEARN_FRAMES = 30;
const LEARN_MS = 700;
/** How fast the on time line may creep later, in ms per ms. 2 ms per second: more than two clocks drift apart. */
const LINE_CREEP = 0.002;
/** How fast the delay comes down when it is no longer needed, in ms per ms. 4 ms per second: too slow to see. */
const DELAY_FALL = 0.004;
/** The interval is corrected every this many frames, by at most this share of itself. */
const CORRECT_EVERY = 240;
const CORRECT_LIMIT = 0.02;
/** This many frames in a row further behind than any delay could cover: the pace no longer holds, learn it again. */
const LOST_FRAMES = 30;
const LOST_MS = 150;
/** Frame rates a console streams at. An estimate near one of them starts from it. */
const KNOWN_INTERVALS = [1000 / 59.94, 1000 / 29.97];

interface Lowest {
  r: number;
  n: number;
}

export class Playout {
  readonly mode: PlayoutMode;
  #maxDelay: number;
  #fixed: number | undefined;
  #memory: number;
  #margin: number;

  #lastId = -1;
  #n = 0;
  #learn: Array<{ n: number; t: number }> = [];
  #interval = 0;
  /** line(n) = #offset + #interval * (n - #n0) */
  #offset = 0;
  #n0 = 0;
  /** For correcting the interval: the line as it was at the last correction, and the earliest arrival against it in each half of the frames since. */
  #fixedOffset = 0;
  #early: [Lowest, Lowest] = [{ r: Infinity, n: 0 }, { r: Infinity, n: 0 }];
  #lastArrival = 0;
  #delay = 0;
  #lastDue = -Infinity;
  #farBehind = 0;
  /** Late frames of the last minute, the latest one first: a sliding maximum. */
  #late: Array<{ late: number; t: number }> = [];

  constructor(o: PlayoutOptions = {}) {
    this.mode = o.mode ?? 'smooth';
    this.#maxDelay = Math.max(0, o.maxDelayMs ?? 100);
    this.#fixed = o.fixedDelayMs !== undefined ? Math.max(0, Math.min(o.fixedDelayMs, 500)) : undefined;
    this.#memory = o.memoryMs ?? 60000;
    this.#margin = o.marginMs ?? 3;
    if (this.#fixed !== undefined) this.#delay = this.#fixed;
  }

  /** The delay in use, in ms. 0 in 'immediate' mode. */
  get delayMs(): number {
    return this.mode === 'smooth' ? this.#delay : 0;
  }

  /** The time between frames as learned from the stream, in ms. 0 until it is known. */
  get intervalMs(): number {
    return this.#interval;
  }

  /** The latest a frame was in the last minute, in ms: what a delay has to cover. */
  get worstLateMs(): number {
    return this.#late[0]?.late ?? 0;
  }

  /**
   * A frame is ready to be shown. `frameId` is the stream's frame counter (16 bit counters that wrap are fine);
   * `arrivedAt` is when it became ready, in ms on any steady clock.
   */
  schedule(frameId: number, arrivedAt: number): PlayoutDecision {
    const now = arrivedAt;
    const at = (dueAt: number, lateMs: number, underrun: boolean): PlayoutDecision => {
      const due = Math.max(dueAt, now, this.#lastDue);
      this.#lastDue = due;
      return { dueAt: due, lateMs, underrun };
    };

    // Which frame is this, counted without wrapping?
    if (this.#lastId >= 0) {
      const step = ((((frameId - this.#lastId) % 0x10000) + 0x18000) % 0x10000) - 0x8000;
      if (step <= 0) return at(now, 0, false); // a repeat or an older frame: show it, learn nothing from it
      this.#n += step;
    }
    this.#lastId = frameId;
    const n = this.#n;
    const sinceLast = Math.min(1000, now - this.#lastArrival);
    this.#lastArrival = now;

    if (this.#interval === 0) {
      this.#learn.push({ n, t: now });
      if (this.#learn.length >= LEARN_FRAMES && now - this.#learn[0]!.t >= LEARN_MS) this.#start();
      return at(now, 0, false);
    }

    // Where the line says this frame should be, and how the frame moves the line.
    const frames = n - this.#n0;
    const fixed = now - (this.#fixedOffset + this.#interval * frames);
    const half = this.#early[frames < CORRECT_EVERY / 2 ? 0 : 1];
    if (fixed < half.r) {
      half.r = fixed;
      half.n = n;
    }
    let late = now - (this.#offset + this.#interval * frames);
    if (late < 0) {
      this.#offset += late; // earlier than "on time": the line was too late
      late = 0;
    } else {
      const creep = Math.min(late, LINE_CREEP * sinceLast);
      this.#offset += creep;
      late -= creep;
    }
    if (frames >= CORRECT_EVERY) this.#correct(n);

    // Far behind, frame after frame: the pace changed or the stream stood still. Start over.
    this.#farBehind = late > this.#maxDelay + LOST_MS ? this.#farBehind + 1 : 0;
    if (this.#farBehind >= LOST_FRAMES) {
      this.#relearn();
      return at(now, 0, false);
    }

    // Remember how late frames have been.
    while (this.#late.length && this.#late[0]!.t < now - this.#memory) this.#late.shift();
    while (this.#late.length && this.#late[this.#late.length - 1]!.late <= late) this.#late.pop();
    this.#late.push({ late, t: now });

    if (this.mode === 'immediate') return at(now, late, false);

    // The slot this frame had with the delay as it was: arriving after it is what the viewer sees.
    const underrun = late > this.#delay + 0.5;
    const target = this.#fixed ?? Math.min(this.#maxDelay, this.worstLateMs + this.#margin);
    this.#delay = target > this.#delay ? target : Math.max(target, this.#delay - DELAY_FALL * sinceLast);
    return underrun ? at(now, late, true) : at(now - late + this.#delay, late, false);
  }

  /** The first frames are in: take the pace from them and put the line under the earliest. */
  #start(): void {
    // The second half only: a decoder hands its first frames out in a burst.
    const f = this.#learn.slice(Math.floor(this.#learn.length / 2));
    // A rough pace first: the middle one of the steps between frames, which a late frame or a burst does not move.
    const steps: number[] = [];
    for (let i = 1; i < f.length; i++) steps.push((f[i]!.t - f[i - 1]!.t) / (f[i]!.n - f[i - 1]!.n));
    steps.sort((a, b) => a - b);
    let interval = steps[Math.floor(steps.length / 2)]!;
    if (!(interval >= 2)) interval = KNOWN_INTERVALS[0]!;
    // Then a finer one: the earliest arrival in the first part of these frames and the earliest in the last part are
    // both about on time, and they are far apart, so the line through them has the pace.
    const earliest = (part: typeof f): { n: number; t: number } => part.reduce((best, x) => (x.t - interval * x.n < best.t - interval * best.n ? x : best));
    const third = Math.max(1, Math.floor(f.length / 3));
    const a = earliest(f.slice(0, third));
    const b = earliest(f.slice(-third));
    if (b.n > a.n) {
      const finer = (b.t - a.t) / (b.n - a.n);
      if (finer >= 2 && Math.abs(finer - interval) / interval < 0.2) interval = finer;
    }
    // A console streams at one of a few rates: when the estimate is as good as on one, start from exactly that.
    for (const k of KNOWN_INTERVALS) if (Math.abs(interval - k) / k < 0.006) interval = k;
    const last = f[f.length - 1]!;
    this.#interval = interval;
    const line = Math.min(...f.map((x) => x.t - interval * (x.n - last.n)));
    this.#rebase(last.n, line);
    // Start with a delay that covers what these frames already showed, instead of finding it out one frame at a time.
    const worst = Math.max(...f.map((x) => x.t - (line + interval * (x.n - last.n))));
    this.#late = [{ late: worst, t: last.t }];
    if (this.#fixed === undefined) this.#delay = Math.min(this.#maxDelay, worst + this.#margin);
    this.#learn = [];
    this.#farBehind = 0;
  }

  #rebase(n: number, lineHere: number): void {
    this.#n0 = n;
    this.#offset = lineHere;
    this.#fixedOffset = lineHere;
    this.#early = [{ r: Infinity, n: 0 }, { r: Infinity, n: 0 }];
  }

  /**
   * The earliest arrival in the first half of the frames since the last correction, and the earliest in the second:
   * if the interval is right they lie equally far from the line. The difference, per frame, is how wrong it is.
   * Late frames do not disturb this, only early ones count.
   */
  #correct(n: number): void {
    const here = this.#offset + this.#interval * (n - this.#n0);
    const [a, b] = this.#early;
    if (Number.isFinite(a.r) && Number.isFinite(b.r) && b.n > a.n) {
      const limit = this.#interval * CORRECT_LIMIT;
      const change = Math.max(-limit, Math.min(limit, (b.r - a.r) / (b.n - a.n)));
      this.#interval += change;
      // With the interval that far off, frames looked later than they were: that is not a reason to hold the picture back.
      if (Math.abs(change) * CORRECT_EVERY > 3) this.#late = [];
    }
    this.#rebase(n, here);
  }

  #relearn(): void {
    this.#interval = 0;
    this.#learn = [];
    this.#late = [];
    this.#farBehind = 0;
    if (this.#fixed === undefined) this.#delay = 0;
  }
}

export interface DisplaySample {
  /** Frames put on the screen. */
  shown: number;
  /** The longest time between two frames on the screen, in ms. */
  gapMaxMs: number;
  /** Times the screen stood still for more than two and a half frame times: what a viewer notices. */
  hitches: number;
  /** Frames that came after their slot (shown at once). */
  underruns: number;
  /** Frames that were never shown because a newer one was due as well. */
  skipped: number;
  /** The latest a frame arrived, in ms. */
  lateMaxMs: number;
}

const emptySample = (): DisplaySample => ({ shown: 0, gapMaxMs: 0, hitches: 0, underruns: 0, skipped: 0, lateMaxMs: 0 });

/** What the viewer saw: counted where frames are put on the screen, and handed out one window at a time. */
export class DisplayMeter {
  #window = emptySample();
  #lastShownAt = NaN;

  /** A frame went on the screen at `at`. `intervalMs` is the stream's frame time (0 = not known yet). */
  shown(at: number, intervalMs: number): void {
    const w = this.#window;
    w.shown++;
    if (!Number.isNaN(this.#lastShownAt)) {
      const gap = at - this.#lastShownAt;
      if (gap > w.gapMaxMs) w.gapMaxMs = round(gap);
      if (intervalMs > 0 && gap > 2.5 * intervalMs) w.hitches++;
    }
    this.#lastShownAt = at;
  }

  arrived(d: PlayoutDecision): void {
    const w = this.#window;
    if (d.underrun) w.underruns++;
    if (d.lateMs > w.lateMaxMs) w.lateMaxMs = round(d.lateMs);
  }

  skipped(count = 1): void {
    this.#window.skipped += count;
  }

  /** Forget the last frame: the next gap is not measured (a new connection, or the picture was stopped on purpose). */
  pause(): void {
    this.#lastShownAt = NaN;
  }

  /** The window since the last call, which starts a new one. */
  take(): DisplaySample {
    const w = this.#window;
    this.#window = emptySample();
    return w;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// When to start each piece of decoded sound. This project's own. Plain TypeScript with no browser APIs, so it is tested
// on its own (test/audio-schedule.test.ts).
//
// Sound is played by handing the sound card a piece at a time and saying WHEN to start it, in the sound card's own
// clock (the audio context's currentTime, in seconds). Pieces that follow each other seamlessly sound like one stream.
// Two things go wrong. If a piece arrives after the one before it has finished, there is a gap (an underrun): the
// pieces after it are then placed a little ahead of now again, which is the cushion that absorbs the next late piece.
// If many arrive in a burst (a tab that was in the background, a network hold-up that is released) the sound would run
// further and further behind the picture: pieces that are too far ahead are dropped, so the delay stays near its target.
//
// A frame that never came is not silence to the player but time that must pass: skip() moves the schedule on.

export interface SchedulerOptions {
  /** How far ahead of "now" the first piece is placed, and what a restart after a gap goes back to. Seconds. */
  targetDelaySec: number;
  /** Pieces that would start more than this beyond the target are dropped. Seconds. Default 0.06. */
  maxAheadSec?: number;
  /** A piece placed closer to "now" than this counts as late (the card needs a moment to take it). Seconds. Default 0.005. */
  minLeadSec?: number;
}

export class AudioScheduler {
  #target: number;
  #maxAhead: number;
  #minLead: number;
  #next = 0;
  #started = false;
  /** Times the schedule ran dry: a gap in the sound. */
  underruns = 0;
  /** Pieces left out because they came too far ahead of the clock. */
  dropped = 0;

  constructor(o: SchedulerOptions) {
    this.#target = o.targetDelaySec;
    this.#maxAhead = o.maxAheadSec ?? 0.06;
    this.#minLead = o.minLeadSec ?? 0.005;
  }

  get targetDelaySec(): number {
    return this.#target;
  }

  /** The delay the sound will be played at from now on. A lower one is reached by dropping pieces, a higher one at the next gap. */
  setTarget(sec: number): void {
    this.#target = sec;
  }

  /** Forget the schedule: the next piece is placed afresh (after a pause, a hidden tab, a new connection). */
  reset(): void {
    this.#started = false;
    this.#next = 0;
  }

  /** How much sound is scheduled ahead of `now`, seconds (0 when nothing is). */
  bufferedSec(now: number): number {
    return this.#started ? Math.max(0, this.#next - now) : 0;
  }

  /**
   * When a piece of `duration` seconds should start, given the clock's `now`; or null when it is too far ahead and must
   * be dropped.
   */
  place(now: number, duration: number): number | null {
    if (!this.#started || this.#next < now + this.#minLead) {
      if (this.#started) this.underruns++;
      this.#next = now + this.#target;
      this.#started = true;
    } else if (this.#next > now + this.#target + this.#maxAhead) {
      this.dropped++;
      return null;
    }
    const start = this.#next;
    this.#next += duration;
    return start;
  }

  /** A frame that never came: its time passes in silence. Does nothing before the first piece has been placed. */
  skip(duration: number): void {
    if (this.#started) this.#next += duration;
  }
}

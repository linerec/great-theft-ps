// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for a worse network between the bridge and the page, for trying things at a desk. This project's own.
//
// What it imitates is how a connection over TCP looks from the two ends on a mobile network: everything arrives, in
// order, later than it was sent; how much later varies; now and then nothing arrives for a while and then everything
// that was held up comes at once (a lost packet being sent again, a hand-over between cells); and there is a ceiling
// on how many bytes get through per second. It does not imitate loss as such, because TCP does not show loss, only
// its cost in time. (For a transport that does show loss, this needs a second mode.)
//
// The numbers in the profiles below are ASSUMPTIONS to start with, not measurements. They are to be replaced by what
// a real mobile line shows (record it with the page's ping from outside).

export interface LinkProfile {
  /** Added to everything, in ms. One way. */
  delayMs: number;
  /** Up to this much more, different for every message, in ms. */
  jitterMs: number;
  /** How long nothing gets through when the line stalls, in ms. 0: never. */
  stallMs: number;
  /** A stall comes about this often, in ms (the time between them varies). */
  stallEveryMs: number;
  /** The most that gets through, in kbit/s. 0: no limit. */
  kbps: number;
}

export interface LinkSimProfile {
  note: string;
  /** Bridge to page: the picture. */
  down: LinkProfile;
  /** Page to bridge: input. */
  up: LinkProfile;
}

const both = (note: string, p: Omit<LinkProfile, 'kbps'>, downKbps: number, upKbps: number): LinkSimProfile => ({ note, down: { ...p, kbps: downKbps }, up: { ...p, kbps: upKbps } });

export const LINK_PROFILES: Record<string, LinkSimProfile> = {
  'lte-good': both('assumed: a good 4G/5G signal', { delayMs: 25, jitterMs: 10, stallMs: 150, stallEveryMs: 60_000 }, 20_000, 5_000),
  'lte-average': both('assumed: an ordinary 4G signal', { delayMs: 35, jitterMs: 25, stallMs: 250, stallEveryMs: 20_000 }, 8_000, 2_000),
  'lte-poor': both('assumed: a weak signal or a crowded cell', { delayMs: 60, jitterMs: 60, stallMs: 500, stallEveryMs: 6_000 }, 3_000, 1_000),
  moving: both('assumed: on the move, with hand-overs between cells', { delayMs: 45, jitterMs: 30, stallMs: 1500, stallEveryMs: 30_000 }, 6_000, 1_500),
};

/** "lte-average", or the five numbers "delay,jitter,stallMs,stallEveryMs,kbps" for both directions. */
export function parseLinkSim(text: string): LinkSimProfile | null {
  if (Object.hasOwn(LINK_PROFILES, text)) return LINK_PROFILES[text]!;
  const n = text.split(',').map(Number);
  if (n.length !== 5 || n.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const p: LinkProfile = { delayMs: n[0]!, jitterMs: n[1]!, stallMs: n[2]!, stallEveryMs: n[3]!, kbps: n[4]! };
  return { note: 'given on the command line', down: p, up: p };
}

export interface DelayLineOptions {
  now?: () => number;
  /** 0..1, for the jitter and the time between stalls. Replaced by tests. */
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** One direction of the link: what is pushed in comes out later, in the same order. */
export class DelayLine<T> {
  #p: LinkProfile;
  #deliver: (item: T) => void;
  #now: () => number;
  #random: () => number;
  #setTimer: (fn: () => void, ms: number) => unknown;
  #clearTimer: (handle: unknown) => void;
  #queue: Array<{ at: number; item: T; bytes: number }> = [];
  #timer: unknown = null;
  #lastAt = 0;
  /** When the ceiling on bytes per second lets the next message through. */
  #freeAt = 0;
  #nextStallAt = Infinity;
  #closed = false;
  queuedBytes = 0;
  /** Stalls so far: [start, end] in ms, for whoever wants to line them up with what the viewer saw. */
  stalls: Array<[number, number]> = [];

  constructor(profile: LinkProfile, deliver: (item: T) => void, o: DelayLineOptions = {}) {
    this.#p = profile;
    this.#deliver = deliver;
    this.#now = o.now ?? (() => performance.now());
    this.#random = o.random ?? Math.random;
    this.#setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (profile.stallMs > 0 && profile.stallEveryMs > 0) this.#nextStallAt = this.#now() + this.#gap();
  }

  /** The time to the next stall: spread around the mean, never very short. */
  #gap(): number {
    return this.#p.stallEveryMs * (0.3 + 1.4 * this.#random());
  }

  push(item: T, bytes: number): void {
    if (this.#closed) return;
    const p = this.#p;
    let at = this.#now() + p.delayMs + p.jitterMs * this.#random();
    // A stall holds back whatever would have come through during it; it all comes out when the stall ends.
    while (at >= this.#nextStallAt) {
      const end = this.#nextStallAt + p.stallMs;
      if (this.stalls.at(-1)?.[0] !== this.#nextStallAt) this.stalls.push([this.#nextStallAt, end]);
      if (at < end) at = end;
      this.#nextStallAt = end + this.#gap();
    }
    at = Math.max(at, this.#lastAt, this.#freeAt); // in order, and no faster than the line carries
    if (p.kbps > 0) this.#freeAt = at + (bytes * 8) / p.kbps;
    this.#lastAt = at;
    this.#queue.push({ at, item, bytes });
    this.queuedBytes += bytes;
    if (this.#timer === null) this.#arm();
  }

  #arm(): void {
    const head = this.#queue[0];
    if (!head || this.#closed) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      const now = this.#now();
      while (this.#queue.length > 0 && this.#queue[0]!.at <= now + 0.5) {
        const next = this.#queue.shift()!;
        this.queuedBytes -= next.bytes;
        this.#deliver(next.item);
      }
      this.#arm();
    }, Math.max(0, head.at - this.#now()));
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#queue = [];
    this.queuedBytes = 0;
  }
}

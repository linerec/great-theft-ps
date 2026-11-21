// SPDX-License-Identifier: AGPL-3.0-only
//
// When to show each frame: the pace is learned from the stream, late frames are absorbed by a small delay, and what
// the viewer would see is counted. Arrival times here are made up from the pattern measured on a real PS5 over Wi-Fi:
// frames 16.68 ms apart, about a millisecond of jitter, and now and then a whole frame 40 to 55 ms late with the
// following ones arriving right behind it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DisplayMeter, Playout, type PlayoutDecision, type PlayoutOptions } from '../src/bridge/playout.ts';

/** A small repeatable random source, so every run sees the same jitter. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface Arrival {
  id: number;
  t: number;
}

/**
 * Frames made every `interval` ms. Each takes `transit` ms plus a little jitter. A frame listed in `stalls` is held
 * for that many ms, and so is everything behind it until the hold is over (the link stood still, then delivered all).
 */
function arrivals(o: { frames: number; interval: number; jitter?: number; stalls?: Record<number, number>; startId?: number; seed?: number }): Arrival[] {
  const rand = rng(o.seed ?? 1);
  const out: Arrival[] = [];
  let blockedUntil = 0;
  for (let i = 0; i < o.frames; i++) {
    const made = 1000 + i * o.interval;
    let t = made + 5 + rand() * (o.jitter ?? 1);
    const stall = o.stalls?.[i];
    if (stall) blockedUntil = Math.max(blockedUntil, t + stall);
    if (t < blockedUntil) t = blockedUntil + out.filter((a) => a.t >= blockedUntil).length * 0.2;
    out.push({ id: ((o.startId ?? 0) + i) & 0xffff, t });
  }
  return out;
}

interface Played {
  decisions: PlayoutDecision[];
  /** Times frames went on the screen, in order. */
  shownAt: number[];
  /** The longest time between two frames on the screen after the first `skip` frames. */
  worstGap: (skip: number) => number;
  hitches: (skip: number, interval: number) => number;
}

function play(list: Arrival[], opts: PlayoutOptions = {}): Played & { playout: Playout } {
  const playout = new Playout(opts);
  const decisions = list.map((a) => playout.schedule(a.id, a.t));
  const shownAt = decisions.map((d) => d.dueAt);
  const gaps = (skip: number): number[] => shownAt.slice(skip + 1).map((t, i) => t - shownAt[skip + i]!);
  return {
    playout, decisions, shownAt,
    worstGap: (skip) => Math.max(...gaps(skip)),
    hitches: (skip, interval) => gaps(skip).filter((g) => g > 2.5 * interval).length,
  };
}

const T60 = 1000 / 59.94;

describe('playout: when to show each frame', () => {
  it('learns the pace from the stream and shows frames on arrival until it has', () => {
    const list = arrivals({ frames: 300, interval: T60 });
    const p = play(list);
    assert.ok(Math.abs(p.playout.intervalMs - T60) < 0.05, `learned ${p.playout.intervalMs}`);
    for (let i = 0; i < 20; i++) assert.equal(p.decisions[i]!.dueAt, list[i]!.t, 'no delay while learning');
    assert.ok(p.decisions.every((d, i) => d.dueAt >= list[i]!.t), 'a frame is never shown before it arrived');
  });

  it('on a steady stream it adds only a few milliseconds and evens out the jitter', () => {
    const list = arrivals({ frames: 1200, interval: T60, jitter: 2 });
    const p = play(list);
    assert.ok(p.playout.delayMs < 8, `delay in use ${p.playout.delayMs.toFixed(1)} ms`);
    const tail = p.shownAt.slice(600);
    const gaps = tail.slice(1).map((t, i) => t - tail[i]!);
    const spread = Math.max(...gaps) - Math.min(...gaps);
    assert.ok(spread < 0.6, `frames go out ${spread.toFixed(2)} ms apart at most from even, although they arrive up to 2 ms uneven`);
    assert.equal(p.decisions.filter((d) => d.underrun).length, 0);
  });

  it('absorbs the stalls measured over Wi-Fi after the first one: the picture keeps its pace', () => {
    // 60 s. A 50 ms stall twice, 300 ms apart, at 6 s, 26 s and 46 s: the pattern measured on this project's test network.
    const stalls: Record<number, number> = {};
    for (const s of [6, 26, 46]) {
      stalls[Math.round((s * 1000) / T60)] = 50;
      stalls[Math.round((s * 1000 + 300) / T60)] = 50;
    }
    const list = arrivals({ frames: 3600, interval: T60, stalls });

    const plain = play(list, { mode: 'immediate' });
    assert.equal(plain.hitches(60, T60), 6, 'shown on arrival, every stall is a visible hitch');
    assert.ok(plain.worstGap(60) > 60);

    const smooth = play(list, { mode: 'smooth' });
    const firstStall = Math.round(6000 / T60);
    assert.equal(smooth.decisions.filter((d) => d.underrun).length, 1, 'only the very first stall gets through');
    assert.ok(smooth.decisions[firstStall]!.underrun);
    assert.equal(smooth.hitches(firstStall + 5, T60), 0, 'none of the five that follow is seen');
    assert.ok(smooth.worstGap(firstStall + 5) < T60 + 1, `longest time between frames afterwards ${smooth.worstGap(firstStall + 5).toFixed(2)} ms`);
    assert.ok(smooth.playout.delayMs > 45 && smooth.playout.delayMs < 60, `the delay settled at ${smooth.playout.delayMs.toFixed(1)} ms`);
  });

  it('gives the delay back, slowly, when nothing has been late for a minute', () => {
    const list = arrivals({ frames: 7200, interval: T60, stalls: { 300: 50 } }); // two minutes, one stall after 5 s
    const p = play(list);
    const delayAt = (frame: number): number => p.decisions[frame]!.dueAt - (list[frame]!.t - p.decisions[frame]!.lateMs);
    assert.ok(delayAt(1800) > 45, 'still held half a minute later');
    assert.ok(delayAt(7100) < 10, `back down at the end: ${delayAt(7100).toFixed(1)} ms`);
    // It came down without a jump: no two frames closer together than 1 ms less than the pace.
    const gaps = p.shownAt.slice(400).map((t, i, a) => (i ? t - a[i - 1]! : T60));
    assert.ok(Math.min(...gaps) > T60 - 1);
  });

  it('never adds more than the limit, and counts what it could not cover', () => {
    const list = arrivals({ frames: 1200, interval: T60, stalls: { 300: 180, 700: 180 } });
    const p = play(list, { maxDelayMs: 60 });
    assert.ok(p.playout.delayMs <= 60);
    assert.equal(p.decisions.filter((d) => d.underrun).length >= 2, true, 'both stalls are longer than the limit: both are seen, and counted');
  });

  it('keeps to a fixed delay when asked to (for comparing settings)', () => {
    const list = arrivals({ frames: 600, interval: T60, stalls: { 300: 50 } });
    const p = play(list, { fixedDelayMs: 20 });
    assert.equal(p.playout.delayMs, 20);
    assert.ok(p.decisions[300]!.underrun, '50 ms does not fit in 20');
    assert.equal(p.playout.delayMs, 20, 'and it stays at 20');
  });

  it('follows a 30 fps stream, and a frame counter that wraps at 65536', () => {
    const T30 = 1000 / 29.97;
    const list = arrivals({ frames: 900, interval: T30, startId: 65536 - 450, stalls: { 400: 45, 700: 45 } });
    const p = play(list);
    assert.ok(Math.abs(p.playout.intervalMs - T30) < 0.1, `learned ${p.playout.intervalMs}`);
    assert.equal(p.decisions.filter((d) => d.underrun).length, 1, 'the wrap in the middle is not mistaken for anything');
    assert.equal(p.hitches(405, T30), 0);
  });

  it('holds the picture for a frame that was lost instead of rushing the next one', () => {
    const list = arrivals({ frames: 600, interval: T60 }).filter((a) => a.id !== 400 && a.id !== 401);
    const p = play(list);
    const i = list.findIndex((a) => a.id === 402);
    const gap = p.shownAt[i]! - p.shownAt[i - 1]!;
    assert.ok(Math.abs(gap - 3 * T60) < 1.5, `two frames missing: the next one comes three frame times later (${gap.toFixed(1)} ms)`);
  });

  it('corrects a pace that is slightly different from the usual ones', () => {
    const odd = 1000 / 58.9; // within the range that starts from 59.94, but not it
    const list = arrivals({ frames: 3000, interval: odd });
    const p = play(list);
    assert.ok(Math.abs(p.playout.intervalMs - odd) < 0.03, `settled at ${p.playout.intervalMs.toFixed(4)}, the stream runs at ${odd.toFixed(4)}`);
    assert.ok(p.playout.delayMs < 12, `without piling up delay: ${p.playout.delayMs.toFixed(1)} ms`);
  });

  it('learns again when the console changes its frame rate, instead of holding every frame at the limit', () => {
    const first = arrivals({ frames: 600, interval: T60 });
    const lastT = first[first.length - 1]!.t;
    const second = arrivals({ frames: 600, interval: 2 * T60, startId: 600, seed: 7 }).map((a) => ({ id: a.id, t: a.t - 1000 + lastT + 2 * T60 }));
    const p = play([...first, ...second]);
    assert.ok(Math.abs(p.playout.intervalMs - 2 * T60) < 0.2, `now ${p.playout.intervalMs.toFixed(2)} ms between frames`);
    assert.ok(p.playout.delayMs < 10, `delay ${p.playout.delayMs.toFixed(1)} ms`);
    const late = p.decisions.slice(900).filter((d) => d.underrun).length;
    assert.equal(late, 0, 'and the new pace is followed without hitches');
  });

  it('shows repeats and stragglers at once and learns nothing from them', () => {
    const playout = new Playout();
    for (const a of arrivals({ frames: 120, interval: T60 })) playout.schedule(a.id, a.t);
    const before = playout.intervalMs;
    const d = playout.schedule(100, 5000);
    assert.equal(d.underrun, false);
    assert.equal(d.lateMs, 0);
    assert.equal(playout.intervalMs, before);
  });

  it('in immediate mode shows everything on arrival but still says how late frames were', () => {
    const list = arrivals({ frames: 600, interval: T60, stalls: { 300: 50 } });
    const p = play(list, { mode: 'immediate' });
    assert.ok(p.decisions.every((d, i) => d.dueAt === list[i]!.t));
    assert.equal(p.playout.delayMs, 0);
    assert.ok(p.playout.worstLateMs > 40, 'what a delay would have to cover is known either way');
  });
});

describe('display meter: what the viewer saw', () => {
  it('counts frames, the longest standstill and the hitches, one window at a time', () => {
    const m = new DisplayMeter();
    for (const t of [0, 16.7, 33.4, 95, 111.7]) m.shown(t, 16.68);
    m.arrived({ dueAt: 0, lateMs: 48.123, underrun: true });
    m.arrived({ dueAt: 0, lateMs: 2, underrun: false });
    m.skipped(2);
    m.decoded(3.456, 2);
    m.decoded(1, 5);
    m.resync();
    assert.deepEqual(m.take(), { shown: 5, gapMaxMs: 61.6, hitches: 1, underruns: 1, skipped: 2, lateMaxMs: 48.12, decodeMaxMs: 3.46, decodeQueueMax: 5, resyncs: 1 });
    assert.deepEqual(m.take(), { shown: 0, gapMaxMs: 0, hitches: 0, underruns: 0, skipped: 0, lateMaxMs: 0, decodeMaxMs: 0, decodeQueueMax: 0, resyncs: 0 });
    // The gap across two windows still counts, in the window where it ended.
    m.shown(200, 16.68);
    assert.equal(m.take().hitches, 1);
    // After a pause (a new connection) the first gap is not measured.
    m.pause();
    m.shown(5000, 16.68);
    assert.deepEqual([m.take().hitches], [0]);
  });

  it('does not call anything a hitch before the pace is known', () => {
    const m = new DisplayMeter();
    m.shown(0, 0);
    m.shown(500, 0);
    const w = m.take();
    assert.equal(w.hitches, 0);
    assert.equal(w.gapMaxMs, 500);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// The measurements of a stream: what is counted, how the one second windows are closed, what counts as a stutter.
// The clock is replaced, so every number here is exact.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StreamStats } from '../src/console/streamstats.ts';

function clocked(): { stats: StreamStats; at: (ms: number) => void } {
  let now = 1000;
  const stats = new StreamStats(() => now);
  return { stats, at: (ms) => (now = 1000 + ms) };
}
const plain = { keyFrame: false, fecRecovered: false, framesLost: 0 };

describe('stream measurements', () => {
  it('counts frames, bytes, key frames and recoveries, and notes when the first frame came', () => {
    const { stats, at } = clocked();
    at(250);
    stats.frame(8000, { keyFrame: true, fecRecovered: false, framesLost: 0 });
    at(283);
    stats.frame(900, { keyFrame: false, fecRecovered: true, framesLost: 0 });
    at(316);
    stats.frame(700, { keyFrame: false, fecRecovered: false, framesLost: 2 });
    const s = stats.snapshot();
    assert.equal(s.totals.frames, 3);
    assert.equal(s.totals.keyFrames, 1);
    assert.equal(s.totals.bytes, 9600);
    assert.equal(s.totals.fecRecovered, 1);
    assert.equal(s.totals.framesLost, 2);
    assert.equal(s.stages['first-frame'], 250);
    assert.deepEqual(s.events.map((e) => e.kind), ['stage', 'frames-lost']);
    assert.equal(s.events[1]!.detail, '2');
  });

  it('never lets a negative loss count (the reference gives one across the 16 bit wrap) reduce the total', () => {
    const { stats, at } = clocked();
    at(10);
    stats.frame(100, { ...plain, framesLost: 3 });
    at(43);
    stats.frame(100, { ...plain, framesLost: -65530 });
    assert.equal(stats.snapshot().totals.framesLost, 3);
  });

  it('closes one window per second with the mean gap between frames, its jitter and the longest gap', () => {
    const { stats, at } = clocked();
    // Second 0: frames at 100, 130, 170, 200 ms: gaps of 30, 40 and 30 ms.
    for (const t of [100, 130, 170, 200]) {
      at(t);
      stats.frame(1000, plain);
    }
    // Second 1: one frame, 900 ms after the last one.
    at(1100);
    stats.frame(500, plain);
    at(2000);
    const s = stats.snapshot();
    assert.equal(s.samples.length, 2);
    const [first, second] = s.samples;
    assert.equal(first!.t, 0);
    assert.equal(first!.frames, 4);
    assert.equal(first!.bytes, 4000);
    assert.equal(first!.frameGapMeanMs, 33.33);
    assert.equal(first!.frameGapJitterMs, 4.71, 'the standard deviation of 30, 40, 30');
    assert.equal(first!.frameGapMaxMs, 40);
    assert.equal(second!.t, 1);
    assert.equal(second!.frames, 1);
    assert.equal(second!.frameGapMaxMs, 900);
    assert.equal(s.totals.maxFrameGapMs, 900);
  });

  it('keeps windows in which nothing arrived: a silent second is a finding, not a gap in the data', () => {
    const { stats, at } = clocked();
    at(100);
    stats.frame(100, plain);
    at(3500);
    const s = stats.snapshot();
    assert.deepEqual(s.samples.map((w) => [w.t, w.frames]), [[0, 1], [1, 0], [2, 0]]);
  });

  it('counts a gap above the threshold as a stutter and records when', () => {
    const { stats, at } = clocked();
    stats.stutterThresholdMs = 83; // what a 30 fps stream gets
    for (const t of [0, 33, 66, 100, 190, 223]) {
      at(t);
      stats.frame(100, plain);
    }
    const s = stats.snapshot();
    assert.equal(s.totals.stutters, 1, 'only the 90 ms gap: 33 ms is the normal frame time at 30 fps');
    assert.equal(s.stutterThresholdMs, 83);
    const e = s.events.find((x) => x.kind === 'stutter')!;
    assert.equal(e.t, 190);
    assert.equal(e.detail, '90 ms between frames');
  });

  it('records what was received and lost, and the share that was reported to the console', () => {
    const { stats, at } = clocked();
    at(200);
    stats.congestion(95, 5, 5);
    at(400);
    stats.congestion(80, 20, 5); // clamped: 20 were lost, 5 were reported
    at(1000);
    const s = stats.snapshot();
    assert.equal(s.totals.unitsReceived, 175);
    assert.equal(s.totals.unitsLost, 25);
    assert.equal(s.samples[0]!.unitsLost, 25);
    assert.equal(s.samples[0]!.lossReported, 0.05, '10 reported of 200');
    assert.deepEqual(s.events.map((e) => e.detail), ['5 of 100', '20 of 100, reported 5']);
  });

  it('counts corrupt frame reports and key frame requests, with their place in time', () => {
    const { stats, at } = clocked();
    at(120);
    stats.corruptReport(7, 9);
    at(140);
    stats.idrRequest();
    stats.stage('bang');
    const s = stats.snapshot();
    assert.equal(s.totals.corruptReports, 1);
    assert.equal(s.totals.idrRequests, 1);
    assert.deepEqual(s.events, [{ t: 120, kind: 'corrupt-report', detail: '7..9' }, { t: 140, kind: 'idr-request' }, { t: 140, kind: 'stage', detail: 'bang' }]);
    assert.equal(s.stages.bang, 140);
  });

  it('limits the series when asked: the last N windows, or none', () => {
    const { stats, at } = clocked();
    at(5000);
    assert.equal(stats.snapshot().samples.length, 5);
    assert.deepEqual(stats.snapshot(2).samples.map((w) => w.t), [3, 4]);
    assert.deepEqual(stats.snapshot(0).samples, []);
  });

  it('keeps a bounded history however long the stream runs', () => {
    const { stats, at } = clocked();
    at(700_000);
    for (let i = 0; i < 600; i++) stats.idrRequest();
    const s = stats.snapshot();
    assert.equal(s.samples.length, 600);
    assert.equal(s.samples.at(-1)!.t, 699);
    assert.equal(s.events.length, 500);
    assert.equal(s.elapsedMs, 700_000);
  });
});

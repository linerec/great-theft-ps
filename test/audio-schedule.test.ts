// SPDX-License-Identifier: AGPL-3.0-only
//
// When each piece of decoded sound is started (web/audio-schedule.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AudioScheduler } from '../web/audio-schedule.ts';

const FRAME = 0.01; // a 10 ms Opus frame

describe('placing pieces of sound on the sound card clock', () => {
  it('puts the first piece the target delay ahead of now and the next ones right behind it, seamlessly', () => {
    const s = new AudioScheduler({ targetDelaySec: 0.08 });
    assert.equal(s.place(1.0, FRAME), 1.08);
    assert.ok(Math.abs(s.place(1.01, FRAME)! - 1.09) < 1e-9);
    assert.ok(Math.abs(s.place(1.02, FRAME)! - 1.1) < 1e-9);
    assert.equal(s.underruns, 0);
    assert.ok(Math.abs(s.bufferedSec(1.02) - 0.09) < 1e-9);
  });

  it('starts again with the cushion when a piece comes after the schedule ran dry, and counts the gap', () => {
    const s = new AudioScheduler({ targetDelaySec: 0.08 });
    s.place(1.0, FRAME); // runs until 1.09
    const start = s.place(1.5, FRAME)!; // 400 ms of nothing
    assert.equal(start, 1.58);
    assert.equal(s.underruns, 1);
    assert.ok(Math.abs(s.place(1.51, FRAME)! - 1.59) < 1e-9, 'and the next piece follows it');
  });

  it('counts a piece that comes just too late for the card as a gap too', () => {
    const s = new AudioScheduler({ targetDelaySec: 0.08, minLeadSec: 0.005 });
    s.place(1.0, FRAME); // next start is 1.09
    s.place(1.086, FRAME); // 4 ms before the next start: closer than the card needs
    assert.equal(s.underruns, 1);
  });

  it('drops pieces that come too far ahead of the clock, so the sound does not run behind the picture', () => {
    const s = new AudioScheduler({ targetDelaySec: 0.08, maxAheadSec: 0.06 });
    // A burst of 25 frames within one instant: they pile up.
    const starts = Array.from({ length: 25 }, () => s.place(1.0, FRAME));
    const placed = starts.filter((x) => x !== null).length;
    // The first 80 ms is the cushion (silence before the first piece). A piece may start at most target + maxAhead =
    // 140 ms from now, so pieces starting at 80, 90, ... 140 ms fit: seven of them, ending 150 ms ahead.
    assert.equal(placed, 7);
    assert.equal(s.dropped, 25 - placed);
    assert.ok(Math.abs(s.bufferedSec(1.0) - 0.15) < 1e-9);
    // Later, when the clock has caught up, pieces are accepted again.
    assert.notEqual(s.place(1.1, FRAME), null);
  });

  it('lets a lost frame pass in silence', () => {
    const s = new AudioScheduler({ targetDelaySec: 0.08 });
    s.place(1.0, FRAME); // 1.08, next 1.09
    s.skip(FRAME); // a frame that never came: next 1.10
    assert.ok(Math.abs(s.place(1.02, FRAME)! - 1.1) < 1e-9, 'the piece after the gap keeps its place in time');
    assert.equal(s.underruns, 0);
  });

  it('ignores a lost frame before anything has been placed', () => {
    const s = new AudioScheduler({ targetDelaySec: 0.08 });
    s.skip(FRAME);
    assert.equal(s.place(2.0, FRAME), 2.08);
  });

  it('follows a new target: a lower one by dropping what is too far ahead, a higher one at the next gap', () => {
    const s = new AudioScheduler({ targetDelaySec: 0.2, maxAheadSec: 0.03 });
    s.place(1.0, FRAME);
    s.setTarget(0.05);
    // Next start is 1.21; 0.05 + 0.03 = 0.08 ahead is the most now: this one is dropped.
    assert.equal(s.place(1.0, FRAME), null);
    s.setTarget(0.3);
    assert.equal(s.place(5.0, FRAME), 5.3, 'a gap restarts at the higher target');
  });

  it('forgets everything on reset (a pause, a hidden tab, a new connection)', () => {
    const s = new AudioScheduler({ targetDelaySec: 0.08 });
    s.place(1.0, FRAME);
    s.reset();
    assert.equal(s.bufferedSec(1.0), 0);
    assert.equal(s.place(3.0, FRAME), 3.08);
    assert.equal(s.underruns, 0, 'a reset is not a gap');
  });
});

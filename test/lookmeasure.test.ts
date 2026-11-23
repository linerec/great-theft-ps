// SPDX-License-Identifier: AGPL-3.0-only
//
// Measuring camera movement from pictures (src/engine/lookmeasure.ts), against a synthetic world whose movement is known.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rng, World } from './support/lookworld.ts';
import { validateCalibration } from '../src/engine/calibration.ts';
import { buildTable, isotonic, measureRate, onsetMs, RevisitDetector, shiftAlongX, shiftAlongY, similarity, transpose, type TimedFrame } from '../src/engine/lookmeasure.ts';

const world = new World({ seed: 3 });
const view = (yaw: number, pitch = 0, t = 0) => world.render(yaw, pitch, t, 1.5, rng(Math.round(yaw * 1000 + pitch * 77 + 5)));

describe('how far the picture moved between two frames', () => {
  it('finds whole and part pixels, in both directions', () => {
    for (const px of [0, 1, 1.7, 5.5, 11.2, -3.2, -9.8, 20.4, -24]) {
      const a = view(10);
      const b = view(10 + px / world.ppd);
      const e = shiftAlongX(a, b);
      // The world moves left when the camera turns right: a camera turn of `px` pixels shifts the picture by -px.
      assert.ok(Math.abs(e.shift + px) < 0.3, `moved ${px} px, found ${-e.shift}`);
      assert.ok(e.agree >= 8, `many blocks agree (${e.agree})`);
    }
  });

  it('does not claim to see a part of a pixel that it cannot (that is why measureRate waits until a picture has moved a few pixels)', () => {
    const e = shiftAlongX(view(10), view(10 + 0.3 / world.ppd));
    assert.ok(Math.abs(e.shift) < 0.5, `found ${e.shift}`);
  });

  it('is not fooled by what stays put (the character, the HUD) or moves by itself, as the background is the larger part', () => {
    const e = shiftAlongX(view(0, 0, 0), view(4 / world.ppd, 0, 0.2));
    assert.ok(Math.abs(e.shift + 4) < 0.25, `found ${e.shift}`);
    assert.ok(e.textured >= 20);
  });

  it('measures up and down too', () => {
    for (const px of [1.5, 4, -6.5]) {
      const e = shiftAlongY(view(30, 0), view(30, px / world.ppd));
      assert.ok(Math.abs(e.shift + px) < 0.3, `moved ${px} px, found ${-e.shift}`);
    }
  });

  it('says it cannot tell when there is nothing in the picture to follow', () => {
    const flat = { w: 256, h: 144, data: new Uint8Array(256 * 144).fill(100) };
    assert.ok(Number.isNaN(shiftAlongX(flat, flat).shift));
    assert.equal(shiftAlongX(flat, flat).textured, 0);
  });

  it('says it cannot tell when the picture moved further than it looks', () => {
    const e = shiftAlongX(view(0), view(60 / world.ppd));
    assert.ok(!Number.isFinite(e.shift) || Math.abs(e.shift + 60) > 5, 'no confident wrong answer');
  });

  it('refuses two pictures of different sizes', () => {
    assert.throws(() => shiftAlongX({ w: 8, h: 8, data: new Uint8Array(64) }, { w: 9, h: 8, data: new Uint8Array(72) }), /differ in size/);
  });

  it('turns a picture on its side', () => {
    const t = transpose({ w: 3, h: 2, data: [1, 2, 3, 4, 5, 6] });
    assert.deepEqual([t.w, t.h, [...(t.data as Uint8Array)]], [2, 3, [1, 4, 2, 5, 3, 6]]);
  });
});

/** Frames of a camera turning at a steady `degPerSec`, at `fps`, with noise. */
function turning(degPerSec: number, seconds: number, fps = 60, axis: 'x' | 'y' = 'x'): TimedFrame[] {
  const frames: TimedFrame[] = [];
  for (let i = 0; i <= seconds * fps; i++) {
    const t = i / fps;
    frames.push({ t: t * 1000, img: axis === 'x' ? world.render(degPerSec * t, 0, t, 1.5, rng(i + 11)) : world.render(0, degPerSec * t, t, 1.5, rng(i + 11)) });
  }
  return frames;
}

describe('how fast the picture moves over a stretch of frames', () => {
  for (const rate of [3, 8, 25, 80, 160, 300]) {
    it(`finds ${rate} degrees a second to within a few percent, from slow to fast`, () => {
      const m = measureRate(turning(rate, 1), 0, 1000, 'x')!;
      assert.ok(m, 'measured');
      const got = -m.pxPerSec / world.ppd;
      assert.ok(Math.abs(got - rate) / rate < 0.06, `${rate} deg/s measured as ${got.toFixed(2)} (lag ${m.lag})`);
      assert.ok(m.support > 0.8);
    });
  }

  it('finds a turn to the left as negative of one to the right', () => {
    const r = measureRate(turning(40, 1), 0, 1000, 'x')!;
    const l = measureRate(turning(-40, 1), 0, 1000, 'x')!;
    assert.ok(r.pxPerSec < 0 && l.pxPerSec > 0);
    assert.ok(Math.abs(r.pxPerSec + l.pxPerSec) / Math.abs(r.pxPerSec) < 0.05);
  });

  it('finds up and down', () => {
    const m = measureRate(turning(30, 0.6, 60, 'y'), 0, 600, 'y')!;
    assert.ok(Math.abs(-m.pxPerSec / world.ppd - 30) < 2.5, `got ${(-m.pxPerSec / world.ppd).toFixed(1)}`);
  });

  it('finds nothing moving when nothing moves', () => {
    const m = measureRate(turning(0, 1), 0, 1000, 'x')!;
    assert.ok(Math.abs(m.pxPerSec) < 1.5, `moved ${m.pxPerSec.toFixed(2)} px/s`);
  });

  it('looks again from further away when the picture moves too far between two frames to follow', () => {
    const m = measureRate(turning(300, 1, 30), 0, 1000, 'x')!; // 32 pixels a frame
    assert.ok(m, 'measured');
    assert.equal(m.factor, 2);
    assert.ok(Math.abs(-m.pxPerSec / world.ppd - 300) / 300 < 0.08, `got ${(-m.pxPerSec / world.ppd).toFixed(1)}`);
  });

  it('works on frames that come at 30 a second as well', () => {
    const m = measureRate(turning(120, 1, 30), 0, 1000, 'x')!;
    assert.ok(Math.abs(-m.pxPerSec / world.ppd - 120) < 8);
  });

  it('uses only the frames in the stretch it was asked about', () => {
    const frames = [...turning(0, 0.5), ...turning(100, 0.5).map((f) => ({ ...f, t: f.t + 500 }))];
    assert.ok(Math.abs(measureRate(frames, 0, 450, 'x')!.pxPerSec) < 3);
  });

  it('gives null for too few frames or a picture it cannot follow', () => {
    assert.equal(measureRate(turning(50, 0.03), 0, 1000, 'x'), null, 'two frames');
    const flat = Array.from({ length: 20 }, (_, i) => ({ t: i * 16, img: { w: 256, h: 144, data: new Uint8Array(256 * 144).fill(90) } }));
    assert.equal(measureRate(flat, 0, 1000, 'x'), null);
  });

  it('keeps time by the frames\' own clock, so frames that come unevenly are no trouble', () => {
    const rand = rng(5);
    const frames: TimedFrame[] = [];
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += 10 + rand() * 14;
      frames.push({ t, img: world.render(60 * (t / 1000), 0, t / 1000, 1.5, rng(i)) });
    }
    const m = measureRate(frames, 0, 1e9, 'x')!;
    assert.ok(Math.abs(-m.pxPerSec / world.ppd - 60) < 4);
  });
});

describe('when the picture first moves', () => {
  it('finds the frame at which it starts', () => {
    const frames = [...turning(0, 0.3), ...turning(150, 0.5).map((f) => ({ ...f, t: f.t + 300, img: world.render(150 * (f.t / 1000), 0, f.t / 1000, 1.5, rng(Math.round(f.t))) }))];
    const t = onsetMs(frames, 'x')!;
    assert.ok(t >= 280 && t <= 345, `found ${t}`);
  });
  it('gives null when it never does', () => assert.equal(onsetMs(turning(0, 0.5), 'x'), null));
});

describe('one full turn', () => {
  it('is similar to itself, and not to a quarter turn away', () => {
    const a = view(0);
    assert.ok(similarity(a, view(0.0)).share > 0.95);
    assert.ok(similarity(a, view(90)).share < 0.5);
    assert.ok(similarity(a, view(180)).share < 0.5);
  });

  it('finds the picture again when it is a few pixels from the exact place, and says by how many', () => {
    for (const px of [-14, -3, 5, 11]) {
      const got = similarity(view(0), view(px / world.ppd), { maxShift: 16 });
      assert.ok(got.share > 0.55, `shifted ${px}: ${got.share}`);
      assert.ok(Math.abs(got.shift + px) <= 1, `moved ${px}, found ${-got.shift}`);
    }
  });

  it('is similar again after 360 degrees, whatever the HUD and the passers-by do', () => {
    assert.ok(similarity(view(0, 0, 0), view(360, 0, 5)).share > 0.7);
  });

  it('notices the camera coming all the way round, and at about the right time', () => {
    const rate = 200; // degrees a second: one turn takes 1.8 s
    const ref = view(0);
    const d = new RevisitDetector(ref);
    let done: number | null = null;
    for (let i = 1; i < 300 && done === null; i++) {
      const t = i / 60;
      if (d.push({ t: t * 1000, img: world.render(rate * t, 0, t, 1.5, rng(i)) })) done = i;
    }
    assert.notEqual(done, null, 'found');
    assert.ok(Math.abs(d.result!.t / 1000 - 1.8) < 0.05, `at ${(d.result!.t / 1000).toFixed(3)} s`);
    assert.ok(d.result!.similarity > 0.55);
  });

  it('does not call it a turn while the camera is still near the start, or if it never comes back', () => {
    const d = new RevisitDetector(view(0));
    for (let i = 1; i < 200; i++) assert.equal(d.push({ t: (i / 60) * 1000, img: world.render(40 * (i / 60), 0, i / 60, 1.5, rng(i)) }), false, 'a turn of 40 deg/s does not come round in 3 s');
    assert.equal(d.result, null);
    const still = new RevisitDetector(view(0));
    for (let i = 1; i < 60; i++) assert.equal(still.push({ t: i * 16, img: view(0) }), false);
  });
});

describe('the table from measured levels', () => {
  const dzRates = (dz: number, full: number, curve = 1) => (s: number) => (s <= dz ? 0 : full * Math.pow((s - dz) / (1 - dz), curve));
  const levels = (f: (s: number) => number, sticks = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1], noise = 0, seed = 1) => {
    const r = rng(seed);
    return sticks.map((stick) => ({ stick, rate: Math.max(0, f(stick) + (r() - 0.5) * 2 * noise) }));
  };

  it('finds a deadzone and a straight rise', () => {
    const b = buildTable(levels(dzRates(0.22, 180)));
    assert.ok(Math.abs(b.innerDeadzone - 0.22) < 0.03, `deadzone ${b.innerDeadzone}`);
    assert.ok(Math.abs(b.fullStickRate - 180) < 1);
    assert.deepEqual(validateCalibration(b.table, 't'), []);
    assert.equal(b.table[0]!.join(), '0,0');
    assert.equal(b.table.at(-1)![0], 1);
  });

  it('finds a curved response', () => {
    const b = buildTable(levels(dzRates(0.1, 300, 2)));
    const mid = b.table.find((p) => p[0] >= 0.55)!;
    assert.ok(Math.abs(mid[1] - 300 * Math.pow((mid[0] - 0.1) / 0.9, 2)) < 12);
  });

  it('copes with a game that has no deadzone', () => {
    const b = buildTable(levels((s) => 120 * s));
    assert.ok(b.innerDeadzone < 0.03);
    assert.deepEqual(validateCalibration(b.table, 't'), []);
  });

  it('turns noisy measurements into a table that never goes down and that is valid', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const b = buildTable(levels(dzRates(0.2, 200), undefined, 3, seed));
      assert.deepEqual(validateCalibration(b.table, 't'), [], `seed ${seed}`);
      assert.ok(Math.abs(b.innerDeadzone - 0.2) < 0.06, `seed ${seed}: deadzone ${b.innerDeadzone}`);
    }
  });

  it('extends to full deflection when that was not measured', () => {
    const b = buildTable(levels(dzRates(0.1, 100), [0.2, 0.4, 0.6, 0.8]));
    assert.equal(b.table.at(-1)![0], 1);
    assert.ok(b.fullStickRate >= 100 * 0.75 / 0.9 - 1);
  });

  it('works when a game jumps straight to speed past its deadzone', () => {
    const b = buildTable(levels((s) => (s < 0.3 ? 0 : 60 + 100 * s)));
    assert.deepEqual(validateCalibration(b.table, 't'), []);
    assert.ok(b.innerDeadzone >= 0.25 && b.innerDeadzone <= 0.3, `deadzone ${b.innerDeadzone}`);
  });

  it('refuses when there is too little, or the camera did not turn', () => {
    assert.throws(() => buildTable([{ stick: 0.5, rate: 10 }]), /too few/);
    assert.throws(() => buildTable(levels(() => 0.2)), /did not turn/);
    assert.throws(() => buildTable([{ stick: 0.2, rate: NaN }, { stick: 0.4, rate: NaN }, { stick: 0.6, rate: NaN }]), /too few/);
  });

  it('makes values non-decreasing with the least change', () => {
    assert.deepEqual(isotonic([1, 2, 3]), [1, 2, 3]);
    assert.deepEqual(isotonic([3, 1]), [2, 2]);
    assert.deepEqual(isotonic([1, 5, 2, 8]), [1, 3.5, 3.5, 8]);
    assert.deepEqual(isotonic([]), []);
  });
});

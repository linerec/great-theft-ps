// SPDX-License-Identifier: AGPL-3.0-only
//
// Smoothing only where it helps. A mouse makes whole counts, so a slow hand reaches the stick as ones and zeros and the
// game's camera jumps and stands still; that wants smoothing. A quick turn has no such problem and only gets the delay.
// Casiez et al. (CHI 2012, the 1 euro filter) and JoyShockMapper's tiered smoothing both take the cutoff up with speed.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LookFilter } from '../src/engine/mouse.ts';
import { defaultProfile, validateProfile, type MouseConfig } from '../src/engine/profile.ts';

const DT = 0.004;
const DEG = 0.05;
const mouse = (over: Partial<MouseConfig> = {}): MouseConfig => ({ ...defaultProfile().mouse, ...over });

/** The rate (deg/s) the filter answers with at each tick for a hand at a steady `degPerSec`, whole counts only. */
function rates(cfg: MouseConfig, degPerSec: number, ticks: number, stopAfter = ticks): number[] {
  const f = new LookFilter();
  let rest = 0;
  const out: number[] = [];
  for (let i = 0; i < ticks; i++) {
    let counts = 0;
    if (i < stopAfter) {
      rest += (degPerSec / DEG) * DT;
      counts = Math.trunc(rest);
      rest -= counts;
    }
    out.push(f.step(cfg, counts, 0, DT).rateX);
  }
  return out;
}
const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
const spread = (a: number[]): number => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));

describe('smoothing that fades with speed', () => {
  it('is the same smoothing at every speed when the fade is 0 (what profiles have always done)', () => {
    const cfg = mouse({ smoothingMs: 12, smoothingFadeRate: 0 });
    const a = rates(cfg, 120, 50);
    const legacy = rates({ ...cfg, smoothingFadeRate: undefined as unknown as number }, 120, 50);
    assert.deepEqual(a, legacy, 'a profile without the setting behaves like 0');
    assert.ok(a[0]! < 120 * 0.7, `the first tick is held back by the filter: ${a[0]}`);
  });

  it('starts a quick turn at once: no filter in the way above the fade rate', () => {
    const fixed = rates(mouse({ smoothingMs: 12, smoothingFadeRate: 0 }), 120, 20);
    const tiered = rates(mouse({ smoothingMs: 12, smoothingFadeRate: 40 }), 120, 20);
    assert.ok(tiered[5]! > fixed[5]!, `tiered ${tiered[5]} against fixed ${fixed[5]} five ticks in`);
    assert.ok(tiered[5]! > 100, 'it is at the hand\'s speed within a few ticks');
  });

  it('stops a quick turn at once: nothing trails behind the hand', () => {
    const fixed = rates(mouse({ smoothingMs: 12, smoothingFadeRate: 0, carryMs: 0 }), 120, 60, 40);
    const tiered = rates(mouse({ smoothingMs: 12, smoothingFadeRate: 40, carryMs: 0 }), 120, 60, 40);
    assert.ok(fixed[41]! > 1, `the fixed filter is still turning a tick after the hand stopped: ${fixed[41]}`);
    assert.equal(tiered[41], 0);
  });

  it('keeps smoothing a slow, precise movement, where one count more or less is most of the signal', () => {
    // 3 deg/s is 0.24 counts per tick: without smoothing the camera is asked for 12.5 deg/s for one tick in four.
    const none = rates(mouse({ smoothingMs: 0 }), 3, 250).slice(100);
    const tiered = rates(mouse({ smoothingMs: 12, smoothingFadeRate: 40 }), 3, 250).slice(100);
    const fixed = rates(mouse({ smoothingMs: 12, smoothingFadeRate: 0 }), 3, 250).slice(100);
    assert.ok(spread(tiered) < spread(none) * 0.5, `spread ${spread(tiered).toFixed(2)} against ${spread(none).toFixed(2)} without smoothing`);
    assert.ok(Math.abs(spread(tiered) - spread(fixed)) < 0.5, 'as smooth as the fixed filter down there');
    assert.ok(Math.abs(mean(tiered) - 3) < 0.5, `and the same distance: ${mean(tiered).toFixed(2)} deg/s`);
  });

  it('fades out between half the rate and the rate: the middle gets some smoothing', () => {
    const at = (speed: number): number => rates(mouse({ smoothingMs: 12, smoothingFadeRate: 100 }), speed, 12)[1]! / speed;
    assert.ok(at(20) < at(75) && at(75) < at(120), `${at(20).toFixed(2)} < ${at(75).toFixed(2)} < ${at(120).toFixed(2)}`);
  });
});

describe('the setting in a profile', () => {
  const profileWith = (edit: (m: Record<string, unknown>) => void): unknown => {
    const p = JSON.parse(JSON.stringify(defaultProfile())) as { mouse: Record<string, unknown> };
    edit(p.mouse);
    return p;
  };

  it('is 0 unless said, and is kept when said', () => {
    assert.equal(defaultProfile().mouse.smoothingFadeRate, 0);
    const given = validateProfile(profileWith((m) => (m.smoothingFadeRate = 40)));
    assert.ok(given.ok);
    if (given.ok) assert.equal(given.profile.mouse.smoothingFadeRate, 40);
    const missing = validateProfile(profileWith((m) => delete m.smoothingFadeRate));
    assert.ok(missing.ok, 'a profile saved before the setting existed still loads');
    if (missing.ok) assert.equal(missing.profile.mouse.smoothingFadeRate, 0);
  });

  it('is refused when it is not a number in range', () => {
    assert.equal(validateProfile(profileWith((m) => (m.smoothingFadeRate = -5))).ok, false);
    assert.equal(validateProfile(profileWith((m) => (m.smoothingFadeRate = 'fast'))).ok, false);
  });
});

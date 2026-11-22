// SPDX-License-Identifier: AGPL-3.0-only
//
// A mouse says how far to turn, a stick only how fast. When the hand is faster than the camera may turn, the turning
// that did not fit is carried over and done afterwards, instead of being lost. Reported from a real game: a long quick
// swipe turned the view a little and then it stood still.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MappingEngine } from '../src/engine/engine.ts';
import { LookFilter } from '../src/engine/mouse.ts';
import { defaultProfile, validateProfile, type MouseConfig } from '../src/engine/profile.ts';

const DT = 0.004;
const mouse = (over: Partial<MouseConfig> = {}): MouseConfig => ({ ...defaultProfile().mouse, smoothingMs: 0, ...over });

/** Feed `counts` evenly over `seconds`, then let it run on, and return the angle turned and when the turning ended. */
function swipe(cfg: MouseConfig, counts: number, seconds: number, limit = Infinity): { angle: number; turningMs: number; peak: number } {
  const f = new LookFilter();
  const ticks = Math.round(seconds / DT);
  let angle = 0;
  let last = 0;
  let peak = 0;
  for (let i = 0; i < ticks + 750; i++) {
    const s = f.step(cfg, i < ticks ? counts / ticks : 0, 0, DT, limit);
    angle += s.rateX * DT;
    peak = Math.max(peak, Math.abs(s.rateX));
    if (s.rateX !== 0) last = (i + 1) * 4;
  }
  return { angle, turningMs: last, peak };
}

describe('mouse look: carrying over what does not fit under the speed limit', () => {
  it('a movement slower than the limit is unchanged: turned as it comes, nothing owed', () => {
    const r = swipe(mouse(), 2000, 1); // 100 deg at 100 deg/s
    assert.ok(Math.abs(r.angle - 100) < 0.01, `turned ${r.angle}`);
    assert.equal(r.turningMs, 1000, 'it stops when the hand stops');
  });

  it('a quick swipe is turned in full when it fits within the carry time', () => {
    // 150 deg in 0.2 s is 750 deg/s; the limit is 360. 72 deg fit, 78 are owed and paid within the next 0.22 s.
    const r = swipe(mouse({ carryMs: 300 }), 3000, 0.2);
    assert.ok(Math.abs(r.angle - 150) < 0.01, `turned ${r.angle}`);
    assert.ok(r.peak <= 360 + 1e-6, 'never faster than the limit');
    assert.ok(r.turningMs > 400 && r.turningMs < 440, `the camera goes on for a moment after the hand stopped: until ${r.turningMs} ms`);
  });

  it('without carry-over the same swipe loses more than half, which is what was reported', () => {
    const r = swipe(mouse({ carryMs: 0 }), 3000, 0.2);
    assert.ok(Math.abs(r.angle - 72) < 0.01, `turned ${r.angle} of 150`);
    assert.equal(r.turningMs, 200);
  });

  it('owes no more than the carry time can pay: a very long swipe still loses the rest, and does not spin on', () => {
    // 315 deg in 0.3 s. 108 deg fit, at most 0.3 s x 360 = 108 deg are carried: 216 in all.
    const r = swipe(mouse({ carryMs: 300 }), 6300, 0.3);
    assert.ok(Math.abs(r.angle - 216) < 0.5, `turned ${r.angle}`);
    assert.ok(r.turningMs <= 604, `turning ended at ${r.turningMs} ms`);
  });

  it('turning the hand back cancels what was owed instead of first paying it', () => {
    const f = new LookFilter();
    const cfg = mouse({ carryMs: 300 });
    let angle = 0;
    for (let i = 0; i < 25; i++) angle += f.step(cfg, 96, 0, DT).rateX * DT; // 120 deg to the right in 0.1 s: 36 turned, 84 owed
    assert.ok(Math.abs(f.owed - 84) < 0.01, `owed ${f.owed}`);
    for (let i = 0; i < 25; i++) angle += f.step(cfg, -96, 0, DT).rateX * DT; // and straight back
    for (let i = 0; i < 300; i++) angle += f.step(cfg, 0, 0, DT).rateX * DT;
    assert.ok(Math.abs(angle) < 1, `ends where it began: ${angle}`);
    assert.ok(f.owed < 1e-6);
  });

  it('works on the diagonal and keeps the direction', () => {
    const f = new LookFilter();
    const cfg = mouse({ carryMs: 300 });
    let x = 0;
    let y = 0;
    for (let i = 0; i < 300; i++) {
      const s = f.step(cfg, i < 25 ? 80 : 0, i < 25 ? 40 : 0, DT);
      x += s.rateX * DT;
      y += s.rateY * DT;
      assert.ok(Math.hypot(s.rateX, s.rateY) <= 360 + 1e-6);
    }
    assert.ok(Math.abs(x - 100) < 0.01 && Math.abs(y - 50) < 0.01, `turned ${x}, ${y}`);
  });

  it('takes the game\'s own ceiling into account: no faster than the game turns at full stick', () => {
    // The profile says this game turns 150 deg/s at full stick. 50 deg asked in 0.1 s (500 deg/s).
    const p = defaultProfile();
    p.mouse.smoothingMs = 0;
    p.inGame.maxTurnRateAtFullStick = 150;
    p.inGame.innerDeadzone = 0;
    const checked = validateProfile(p);
    assert.ok(checked.ok);
    const e = new MappingEngine(checked.ok ? checked.profile : p);
    let cameraAngle = 0; // what the game does with the stick: 150 deg/s at full
    let fullStickMs = 0;
    for (let i = 0; i < 400; i++) {
      if (i < 25) e.mouseMove(40, 0);
      const s = e.tick(DT);
      cameraAngle += s.rightX * 150 * DT;
      if (s.rightX > 0.999) fullStickMs += 4;
    }
    assert.ok(Math.abs(cameraAngle - 50) < 0.5, `the camera turned ${cameraAngle} of the 50 asked`);
    assert.ok(fullStickMs > 300, `the stick stayed at full for ${fullStickMs} ms, well after the 100 ms the hand moved`);
  });

  it('is a setting of the profile, checked like the others, and older profiles get the default', () => {
    const old = JSON.parse(JSON.stringify(defaultProfile()));
    delete old.mouse.carryMs;
    const read = validateProfile(old);
    assert.ok(read.ok && read.profile.mouse.carryMs === 300);
    old.mouse.carryMs = 5000;
    assert.equal(validateProfile(old).ok, false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defaultProfile } from '../src/engine/profile.ts';
import { FEEL_PRESETS, presetOf, RawMouseGate, SENSITIVITY_MAX, SENSITIVITY_MIN, stepSensitivity } from '../web/mouse-feel.ts';

describe('the starting points for the mouse feel', () => {
  it('include what the profile has always had, so that it can be gone back to', () => {
    const m = defaultProfile().mouse;
    assert.equal(presetOf(m), 'smooth');
  });

  it('are different from each other, and each is recognised by its own values', () => {
    assert.equal(new Set(FEEL_PRESETS.map((p) => `${p.set.smoothingMs}/${p.set.carryMs}/${p.set.curve}`)).size, FEEL_PRESETS.length);
    for (const p of FEEL_PRESETS) assert.equal(presetOf(p.set), p.id);
  });

  it('say "changed by hand" for anything else', () => {
    assert.equal(presetOf({ smoothingMs: 7, carryMs: 0, curve: 1 }), null);
  });

  it('only ever set values the profile accepts', () => {
    for (const p of FEEL_PRESETS) {
      assert.ok(p.set.smoothingMs >= 0 && p.set.smoothingMs <= 200);
      assert.ok(p.set.carryMs >= 0 && p.set.carryMs <= 2000);
      assert.ok(p.set.curve >= 0.5 && p.set.curve <= 3);
    }
  });
});

describe('stepSensitivity', () => {
  it('goes up and down by the same ratio, and a step back lands where it began', () => {
    const up = stepSensitivity(0.05, 1);
    assert.equal(up, 0.053);
    assert.equal(stepSensitivity(up, -1), 0.05);
  });

  it('is as large, in proportion, for a small value as for a large one', () => {
    assert.ok(Math.abs(stepSensitivity(0.02, 1) / 0.02 - 1.06) < 0.03);
    assert.ok(Math.abs(stepSensitivity(0.2, 1) / 0.2 - 1.06) < 0.01);
  });

  it('stops at the ends of the slider', () => {
    assert.equal(stepSensitivity(SENSITIVITY_MAX, 1), SENSITIVITY_MAX);
    assert.equal(stepSensitivity(SENSITIVITY_MIN, -1), SENSITIVITY_MIN);
  });

  it('is never stuck: even at the smallest values a press changes the number', () => {
    assert.ok(stepSensitivity(0.01, 1) > 0.01);
    assert.ok(stepSensitivity(0.011, -1) < 0.011);
  });
});

describe('RawMouseGate: a movement is counted once', () => {
  it('counts ordinary moves while no raw updates come', () => {
    const g = new RawMouseGate(100);
    assert.equal(g.ordinary(0), true);
    assert.equal(g.ordinary(5000), true);
  });

  it('leaves the ordinary move out while raw updates are arriving, and takes it up again when they stop', () => {
    const g = new RawMouseGate(100);
    g.raw(1000);
    assert.equal(g.ordinary(1016), false, 'the same movement, a frame later');
    g.raw(1030);
    assert.equal(g.ordinary(1040), false);
    assert.equal(g.ordinary(1129), false);
    assert.equal(g.ordinary(1130), true, 'no raw update for the quiet time');
  });

  it('forgets when reset', () => {
    const g = new RawMouseGate(100);
    g.raw(10);
    g.reset();
    assert.equal(g.ordinary(11), true);
  });
});

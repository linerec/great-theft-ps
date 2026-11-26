// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUTTON, emptyPadState } from '../src/engine/types.ts';
import { setLang } from '../src/i18n/index.ts';
import { GamepadInput, mergeGamepad, padName, samplePad, stick, type GamepadLike } from '../web/gamepad.ts';

/** A DualSense as a browser shows it: 18 buttons (17 is the touchpad), 4 axes, all at rest. */
function dualsense(o: { down?: number[]; l2?: number; r2?: number; axes?: [number, number, number, number]; mapping?: string; id?: string } = {}): GamepadLike {
  const buttons = Array.from({ length: 18 }, (_, i) => ({ pressed: (o.down ?? []).includes(i), value: (o.down ?? []).includes(i) ? 1 : 0 }));
  if (o.l2 !== undefined) buttons[6] = { pressed: o.l2 > 0.5, value: o.l2 };
  if (o.r2 !== undefined) buttons[7] = { pressed: o.r2 > 0.5, value: o.r2 };
  return { id: o.id ?? 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', mapping: o.mapping ?? 'standard', buttons, axes: o.axes ?? [0, 0, 0, 0] };
}

describe('a controller as the console\'s pad', () => {
  it('maps every button of the standard layout to the console button in the same place', () => {
    const expected: Array<[number, number]> = [
      [0, BUTTON.cross], [1, BUTTON.moon], [2, BUTTON.box], [3, BUTTON.pyramid], [4, BUTTON.l1], [5, BUTTON.r1],
      [8, BUTTON.share], [9, BUTTON.options], [10, BUTTON.l3], [11, BUTTON.r3],
      [12, BUTTON.dpad_up], [13, BUTTON.dpad_down], [14, BUTTON.dpad_left], [15, BUTTON.dpad_right], [16, BUTTON.ps], [17, BUTTON.touchpad],
    ];
    for (const [index, bit] of expected) assert.equal(samplePad(dualsense({ down: [index] }))!.buttons, bit, `button ${index}`);
    assert.equal(samplePad(dualsense({ down: [0, 1, 4] }))!.buttons, BUTTON.cross | BUTTON.moon | BUTTON.l1, 'several at once');
    assert.equal(samplePad(dualsense())!.active, false);
  });

  it('keeps the triggers analog (0 to 255) and ignores a resting trigger that reads a little above zero', () => {
    const s = samplePad(dualsense({ l2: 0.5, r2: 1 }))!;
    assert.equal(s.l2, 128);
    assert.equal(s.r2, 255);
    assert.equal(s.buttons, 0, 'the triggers are not buttons of the pad state');
    assert.equal(samplePad(dualsense({ l2: 0.01 }))!.l2, 0);
    assert.equal(samplePad(dualsense({ l2: 0.01 }))!.active, false);
    // A pad that only says "pressed" (no analog value) is a full press.
    const digital = dualsense();
    (digital.buttons as Array<{ pressed: boolean; value: number }>)[7] = { pressed: true, value: 0 };
    assert.equal(samplePad(digital)!.r2, 255);
  });

  it('has a round dead zone whose edge does not jump, and reaches full travel at the end', () => {
    assert.deepEqual(stick(0.05, 0.05, 0.1), { x: 0, y: 0 });
    const justOut = stick(0.1001, 0, 0.1);
    assert.ok(justOut.x > 0 && justOut.x < 0.001, `no jump at the edge: ${justOut.x}`);
    const half = stick(0.55, 0, 0.1);
    assert.ok(Math.abs(half.x - 0.5) < 1e-9, 'half of the travel past the zone is half');
    const full = stick(1, 0, 0.1);
    assert.equal(full.x, 1);
    const diagonal = stick(0.8, 0.8, 0.1);
    assert.ok(Math.hypot(diagonal.x, diagonal.y) <= 1 + 1e-9, 'a corner never goes past 1');
    assert.ok(Math.abs(diagonal.x - diagonal.y) < 1e-12, 'the direction is kept');
    assert.ok(Math.abs(stick(-0.6, 0, 0.1).x + 0.5 / 0.9) < 1e-12, 'the other direction is the mirror image');
  });

  it('reads the sticks (down is positive, as in the pad state) and survives odd values', () => {
    const s = samplePad(dualsense({ axes: [-1, 0.5, 0.3, 1] }), 0.1)!;
    // (-1, 0.5) lies outside the circle a stick can really reach: it is brought back to the rim, in the same direction.
    assert.ok(Math.abs(s.leftX + 0.8944) < 1e-3 && Math.abs(s.leftY - 0.4472) < 1e-3, `${s.leftX}, ${s.leftY}`);
    assert.ok(s.rightY > 0.9 && s.rightX > 0.25, `${s.rightX}, ${s.rightY}`); // (0.3, 1): pushed down and a little right
    assert.equal(s.active, true);
    const bad = samplePad(dualsense({ axes: [NaN, Infinity, undefined as never, 0] }))!;
    assert.equal(bad.leftX, 0);
    assert.equal(bad.leftY, 0);
    assert.equal(bad.rightX, 0);
  });

  it('only understands the standard layout', () => {
    assert.equal(samplePad({ id: 'odd', mapping: '', buttons: Array.from({ length: 10 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0, 0, 0] }), null);
    assert.ok(samplePad(dualsense({ mapping: '' })), 'a pad with all the buttons is taken even if the browser did not say "standard"');
  });

  it('names a DualSense and a DualShock, and shortens the rest', () => {
    assert.equal(padName('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'DualSense');
    assert.equal(padName('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), 'DualShock 4');
    assert.equal(padName('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'Xbox 360 Controller');
    assert.equal(padName('(only noise)'), 'Controller');
  });

  it('names a controller with no name in the language of the page at the moment it is asked', () => {
    setLang('ko');
    try {
      assert.equal(padName('(only noise)'), '컨트롤러');
    } finally {
      setLang('en');
    }
    assert.equal(padName('(only noise)'), 'Controller');
  });
});

describe('joining the keyboard and mouse', () => {
  it('adds buttons, takes the stronger trigger, and lets a pushed stick take over', () => {
    const s = emptyPadState();
    s.buttons = BUTTON.cross;
    s.l2 = 200;
    s.leftX = 1; // from the keys
    s.rightX = 0.4; // from the mouse
    const pad = samplePad(dualsense({ down: [1], l2: 0.5, r2: 0.9, axes: [0, 0, -0.9, 0] }))!;
    mergeGamepad(s, pad);
    assert.equal(s.buttons, BUTTON.cross | BUTTON.moon);
    assert.equal(s.l2, 200, 'the keyboard\'s trigger was stronger');
    assert.equal(s.r2, Math.round(0.9 * 255));
    assert.equal(s.leftX, 1, 'the left stick was not touched, so the keys keep it');
    assert.ok(s.rightX < -0.8, 'the right stick was pushed: it replaces the mouse');
  });

  it('does nothing for a controller lying still, so that the mouse keeps the look', () => {
    const s = emptyPadState();
    s.rightX = 0.7;
    s.buttons = BUTTON.box;
    mergeGamepad(s, samplePad(dualsense()));
    mergeGamepad(s, null);
    assert.equal(s.rightX, 0.7);
    assert.equal(s.buttons, BUTTON.box);
  });
});

describe('finding the controller', () => {
  it('reports it when it shows up or goes away, and reads the first one it understands', () => {
    let list: Array<GamepadLike | null> = [];
    const input = new GamepadInput(() => list);
    const seen: Array<string | null> = [];
    input.onChange = (n) => seen.push(n);
    assert.equal(input.poll(), null);
    list = [null, dualsense({ down: [0] })];
    assert.equal(input.poll()!.buttons, BUTTON.cross);
    input.poll();
    list = [{ ...dualsense(), connected: false }];
    assert.equal(input.poll(), null, 'a pad that says it is gone is gone');
    assert.deepEqual(seen, ['DualSense', null], 'told once for each change, not every frame');
  });
});

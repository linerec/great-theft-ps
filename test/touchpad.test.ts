// SPDX-License-Identifier: AGPL-3.0-only
//
// A pad on a touch screen: buttons under fingers, a stick that starts where the thumb lands, the camera by dragging.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TouchPad } from '../src/engine/touchpad.ts';
import { BUTTON } from '../src/engine/types.ts';

const W = 800;
const pad = (): TouchPad => new TouchPad({ stickRadius: 60 });
const near = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

describe('touch pad: buttons', () => {
  it('a finger on a button presses it until it is lifted, and several fingers press several buttons', () => {
    const p = pad();
    p.down(1, 700, 300, W, 'cross');
    p.down(2, 60, 40, W, 'l2');
    p.down(3, 740, 40, W, 'r1');
    assert.equal(p.output.buttons, BUTTON.cross | BUTTON.r1);
    assert.equal(p.output.l2, 255);
    assert.equal(p.output.r2, 0);
    assert.deepEqual(p.pressed.sort(), ['cross', 'l2', 'r1']);
    p.up(1);
    assert.equal(p.output.buttons, BUTTON.r1);
    p.up(2);
    p.up(3);
    assert.equal(p.active, false);
    assert.deepEqual(p.output, { buttons: 0, l2: 0, r2: 0, stickActive: false, leftX: 0, leftY: 0 });
  });

  it('a thumb rolls from one face button to the next, and from one d-pad direction to the next', () => {
    const p = pad();
    p.down(1, 700, 300, W, 'cross');
    p.move(1, 730, 270, 'moon');
    assert.equal(p.output.buttons, BUTTON.moon, 'the press moved; the first button is let go');
    p.down(2, 100, 120, W, 'dpad_up');
    p.move(2, 130, 150, 'dpad_right');
    assert.equal(p.output.buttons, BUTTON.moon | BUTTON.dpad_right);
  });

  it('a press does not wander to a button of another kind, and stays when the finger slides off', () => {
    const p = pad();
    p.down(1, 700, 300, W, 'cross');
    p.move(1, 740, 60, 'r1');
    assert.equal(p.output.buttons, BUTTON.cross);
    p.move(1, 600, 200, null);
    assert.equal(p.output.buttons, BUTTON.cross, 'still held on empty space, like a thumb that slipped');
    const q = pad();
    q.down(1, 60, 40, W, 'l1');
    q.move(1, 60, 80, 'l2');
    assert.equal(q.output.buttons, BUTTON.l1);
    assert.equal(q.output.l2, 0);
  });
});

describe('touch pad: the left stick', () => {
  it('starts where the thumb lands and reads how far it is dragged from there', () => {
    const p = pad();
    p.down(1, 150, 250, W, null);
    assert.equal(p.output.stickActive, true);
    assert.deepEqual([p.output.leftX, p.output.leftY], [0, 0]);
    p.move(1, 150, 190, null); // the full reach upwards
    near(p.output.leftX, 0);
    near(p.output.leftY, -1);
    p.move(1, 180, 250, null); // half the reach to the right
    near(p.output.leftX, (0.5 - 0.1) / 0.9);
    near(p.output.leftY, 0);
    p.up(1);
    assert.equal(p.output.stickActive, false);
  });

  it('ignores a resting thumb, and starts from zero just past that', () => {
    const p = pad();
    p.down(1, 150, 250, W, null);
    p.move(1, 154, 252, null);
    assert.deepEqual([p.output.leftX, p.output.leftY], [0, 0]);
    p.move(1, 157, 250, null); // 7 px of 60: just past the 10 percent
    assert.ok(p.output.leftX > 0 && p.output.leftX < 0.05, String(p.output.leftX));
  });

  it('never reads more than full, and its centre follows a thumb dragged past the reach', () => {
    const p = pad();
    p.down(1, 150, 250, W, null);
    p.move(1, 350, 250, null); // 200 px to the right, reach is 60
    near(p.output.leftX, 1);
    assert.deepEqual(p.stick, { cx: 290, cy: 250, x: 350, y: 250 }, 'the centre came along');
    p.move(1, 290, 250, null); // back by one reach: centred at once, not after 140 px of dead travel
    near(p.output.leftX, 0);
  });

  it('is one stick: a second finger on the left side moves the camera instead', () => {
    const p = pad();
    p.down(1, 150, 250, W, null);
    p.down(2, 200, 100, W, null);
    p.move(2, 220, 100, null);
    assert.deepEqual(p.takeLook(), { dx: 80, dy: 0 });
    near(p.output.leftX, 0);
  });
});

describe('touch pad: the camera', () => {
  it('turns by the distance dragged on the right side, handed on as mouse movement', () => {
    const p = pad();
    p.down(1, 600, 200, W, null);
    assert.equal(p.output.stickActive, false);
    p.move(1, 610, 195, null);
    p.move(1, 625, 195, null);
    assert.deepEqual(p.takeLook(), { dx: 100, dy: -20 }, '25 px right and 5 px up, times four');
    assert.deepEqual(p.takeLook(), { dx: 0, dy: 0 }, 'taken once');
  });

  it('works while the stick and buttons are in use', () => {
    const p = pad();
    p.down(1, 150, 250, W, null);
    p.move(1, 150, 190, null);
    p.down(2, 600, 200, W, null);
    p.down(3, 740, 40, W, 'r2');
    p.move(2, 590, 200, null);
    assert.deepEqual(p.takeLook(), { dx: -40, dy: 0 });
    near(p.output.leftY, -1);
    assert.equal(p.output.r2, 255);
  });

  it('follows the scale it is given', () => {
    const p = new TouchPad({ stickRadius: 60, lookScale: 2, stickZone: 0.3 });
    p.down(1, 300, 200, W, null); // right of the 30 percent: camera
    p.move(1, 310, 200, null);
    assert.deepEqual(p.takeLook(), { dx: 20, dy: 0 });
  });

  it('lets go of everything at once', () => {
    const p = pad();
    p.down(1, 150, 250, W, null);
    p.down(2, 700, 300, W, 'cross');
    p.down(3, 600, 100, W, null);
    p.move(3, 640, 100, null);
    p.releaseAll();
    assert.equal(p.active, false);
    assert.deepEqual(p.takeLook(), { dx: 0, dy: 0 });
    assert.equal(p.output.buttons, 0);
    p.move(1, 0, 0, null); // a late event for a finger that is gone does nothing
    assert.equal(p.active, false);
  });
});

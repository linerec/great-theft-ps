// SPDX-License-Identifier: AGPL-3.0-only
//
// The controller state (src/console/controller.ts, from chiaki-ng lib/src/controller.c and
// lib/include/chiaki/controller.h, commit 43728af) and the conversion from this project's pad state.
//
// STATUS: the reference has no test for controller.c, so every expectation here was worked out from the C source by
// the same reading that produced the port. It shows that the port does what that reading says, nothing more. Never run
// against a real console.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACCEL_MAX, ACCEL_MIN, cloneControllerState, CONTROLLER_ANALOG_BUTTON, CONTROLLER_BUTTON, CONTROLLER_BUTTONS_COUNT, CONTROLLER_TOUCHES_MAX,
  controllerMotionEquals, controllerStateEquals, controllerStateFromPad, controllerStateOr, controllerStateSetIdle, controllerStateSetTouchPos,
  controllerStateStartTouch, controllerStateStopTouch, createIdleControllerState, GYRO_MAX, GYRO_MIN,
} from '../src/console/controller.ts';
import { BUTTON, emptyPadState, GYRO_LIMIT_RAD_S } from '../src/engine/types.ts';

describe('controller: constants of controller.h', () => {
  it('button bits', () => {
    assert.deepEqual(CONTROLLER_BUTTON, {
      cross: 0x0001, moon: 0x0002, box: 0x0004, pyramid: 0x0008,
      dpad_left: 0x0010, dpad_right: 0x0020, dpad_up: 0x0040, dpad_down: 0x0080,
      l1: 0x0100, r1: 0x0200, l3: 0x0400, r3: 0x0800,
      options: 0x1000, share: 0x2000, touchpad: 0x4000, ps: 0x8000,
    });
    assert.equal(CONTROLLER_BUTTONS_COUNT, 16);
    assert.equal(Object.keys(CONTROLLER_BUTTON).length, CONTROLLER_BUTTONS_COUNT);
    assert.deepEqual(CONTROLLER_ANALOG_BUTTON, { l2: 0x10000, r2: 0x20000 });
    assert.equal(CONTROLLER_TOUCHES_MAX, 2);
  });

  it("the engine's BUTTON has the same names and bits, so its mask can be forwarded as it is", () => {
    assert.deepEqual({ ...BUTTON }, { ...CONTROLLER_BUTTON });
  });

  it('the analog ids do not overlap with the buttons', () => {
    const all = Object.values(CONTROLLER_BUTTON).reduce((m, b) => m | b, 0);
    assert.equal(all, 0xffff);
    assert.equal(all & (CONTROLLER_ANALOG_BUTTON.l2 | CONTROLLER_ANALOG_BUTTON.r2), 0);
  });
});

describe('controller: set_idle', () => {
  const idle = {
    buttons: 0, l2State: 0, r2State: 0, leftX: 0, leftY: 0, rightX: 0, rightY: 0,
    touchIdNext: 0,
    touches: [{ x: 0, y: 0, id: -1 }, { x: 0, y: 0, id: -1 }],
    gyroX: 0, gyroY: 0, gyroZ: 0,
    accelX: 0, accelY: 1, accelZ: 0,
    orientX: 0, orientY: 0, orientZ: 0, orientW: 1,
  };

  it('a new state is idle: nothing pressed, no touch, 1 g on Y, identity orientation', () => {
    assert.deepEqual(createIdleControllerState(), idle);
  });

  it('resets every field of a used state', () => {
    const state = createIdleControllerState();
    state.buttons = 0xffff;
    state.l2State = 0xff;
    state.r2State = 1;
    state.leftX = -32768;
    state.leftY = 32767;
    state.rightX = 5;
    state.rightY = -5;
    controllerStateStartTouch(state, 10, 20);
    controllerStateStartTouch(state, 30, 40);
    state.gyroX = 1;
    state.gyroY = 2;
    state.gyroZ = 3;
    state.accelX = 4;
    state.accelY = 5;
    state.accelZ = 6;
    state.orientX = 0.5;
    state.orientY = 0.5;
    state.orientZ = 0.5;
    state.orientW = 0.5;
    controllerStateSetIdle(state);
    assert.deepEqual(state, idle);
  });

  it('a clone is equal and shares nothing', () => {
    const state = createIdleControllerState();
    controllerStateStartTouch(state, 10, 20);
    const copy = cloneControllerState(state);
    assert.deepEqual(copy, state);
    copy.touches[0]!.x = 99;
    copy.buttons = 1;
    assert.equal(state.touches[0]!.x, 10);
    assert.equal(state.buttons, 0);
  });
});

describe('controller: touches', () => {
  it('start_touch takes the first free slot and hands out ids in order', () => {
    const state = createIdleControllerState();
    assert.equal(controllerStateStartTouch(state, 100, 200), 0);
    assert.equal(controllerStateStartTouch(state, 300, 400), 1);
    assert.deepEqual(state.touches, [{ x: 100, y: 200, id: 0 }, { x: 300, y: 400, id: 1 }]);
    assert.equal(state.touchIdNext, 2);
  });

  it('start_touch returns -1 when both slots are taken, and does not use up an id', () => {
    const state = createIdleControllerState();
    controllerStateStartTouch(state, 1, 1);
    controllerStateStartTouch(state, 2, 2);
    assert.equal(controllerStateStartTouch(state, 3, 3), -1);
    assert.equal(state.touchIdNext, 2);
    assert.deepEqual(state.touches, [{ x: 1, y: 1, id: 0 }, { x: 2, y: 2, id: 1 }]);
  });

  it('stop_touch frees the slot; the next touch reuses it with a new id', () => {
    const state = createIdleControllerState();
    controllerStateStartTouch(state, 1, 1);
    controllerStateStartTouch(state, 2, 2);
    controllerStateStopTouch(state, 0);
    assert.equal(state.touches[0]!.id, -1);
    assert.equal(state.touches[1]!.id, 1);
    assert.equal(controllerStateStartTouch(state, 5, 6), 2);
    assert.deepEqual(state.touches[0], { x: 5, y: 6, id: 2 });
  });

  it('stop_touch with an unknown id changes nothing, and 0xff never matches a free slot', () => {
    const state = createIdleControllerState();
    controllerStateStartTouch(state, 1, 1);
    const before = cloneControllerState(state);
    controllerStateStopTouch(state, 7);
    controllerStateStopTouch(state, 0xff);
    controllerStateStopTouch(state, -1);
    assert.deepEqual(state, before);
  });

  it('ids wrap from 127 to 0', () => {
    const state = createIdleControllerState();
    for (let i = 0; i < 127; i++) {
      assert.equal(controllerStateStartTouch(state, 0, 0), i);
      controllerStateStopTouch(state, i);
    }
    assert.equal(controllerStateStartTouch(state, 0, 0), 127);
    assert.equal(state.touchIdNext, 0);
    controllerStateStopTouch(state, 127);
    assert.equal(controllerStateStartTouch(state, 0, 0), 0);
  });

  it('set_touch_pos moves the touch with that id and only that one', () => {
    const state = createIdleControllerState();
    controllerStateStartTouch(state, 1, 1);
    controllerStateStartTouch(state, 2, 2);
    controllerStateSetTouchPos(state, 1, 1919, 1079);
    assert.deepEqual(state.touches, [{ x: 1, y: 1, id: 0 }, { x: 1919, y: 1079, id: 1 }]);
    controllerStateSetTouchPos(state, 9, 5, 5);
    assert.deepEqual(state.touches, [{ x: 1, y: 1, id: 0 }, { x: 1919, y: 1079, id: 1 }]);
  });

  it('set_touch_pos masks the id with 0x7f (stop_touch does not)', () => {
    const state = createIdleControllerState();
    controllerStateStartTouch(state, 1, 1);
    controllerStateSetTouchPos(state, 0x80, 7, 8);
    assert.deepEqual(state.touches[0], { x: 7, y: 8, id: 0 });
    controllerStateStopTouch(state, 0x80);
    assert.equal(state.touches[0]!.id, 0, 'still down');
  });

  it('coordinates are 16 bit unsigned, fractions are cut off', () => {
    const state = createIdleControllerState();
    controllerStateStartTouch(state, 100.9, 0x12345);
    assert.deepEqual(state.touches[0], { x: 100, y: 0x2345, id: 0 });
  });
});

describe('controller: state_equals', () => {
  it('idle equals idle, and a state equals its clone', () => {
    assert.ok(controllerStateEquals(createIdleControllerState(), createIdleControllerState()));
    const state = createIdleControllerState();
    state.buttons = CONTROLLER_BUTTON.cross;
    state.leftX = 100;
    controllerStateStartTouch(state, 5, 6);
    assert.ok(controllerStateEquals(state, cloneControllerState(state)));
  });

  it('every integer field counts', () => {
    for (const field of ['buttons', 'l2State', 'r2State', 'leftX', 'leftY', 'rightX', 'rightY'] as const) {
      const a = createIdleControllerState();
      const b = createIdleControllerState();
      b[field] = 1;
      assert.ok(!controllerStateEquals(a, b), field);
      assert.ok(!controllerStateEquals(b, a), field);
    }
  });

  it('every motion field counts', () => {
    for (const field of ['gyroX', 'gyroY', 'gyroZ', 'accelX', 'accelY', 'accelZ', 'orientX', 'orientY', 'orientZ', 'orientW'] as const) {
      const a = createIdleControllerState();
      const b = createIdleControllerState();
      b[field] += 0.001;
      assert.ok(!controllerStateEquals(a, b), field);
      assert.ok(!controllerStateEquals(b, a), field);
      assert.ok(!controllerMotionEquals(a, b), field);
    }
  });

  it('motion is compared with a tolerance of 0.0000001 in single precision', () => {
    const a = createIdleControllerState();
    const b = createIdleControllerState();
    b.gyroX = 0.00000005;
    assert.ok(controllerStateEquals(a, b));
    b.gyroX = 0.0000002;
    assert.ok(!controllerStateEquals(a, b));
    b.gyroX = -0.0000002;
    assert.ok(!controllerStateEquals(a, b));
    // two doubles that are the same float are equal
    b.gyroX = 0;
    a.accelY = 1;
    b.accelY = 1 + 1e-12;
    assert.ok(controllerStateEquals(a, b));
  });

  it('touches: the id counts, the position only while the finger is down', () => {
    const a = createIdleControllerState();
    const b = createIdleControllerState();
    b.touches[1]!.x = 500; // up on both sides: the position is ignored
    assert.ok(controllerStateEquals(a, b));

    controllerStateStartTouch(a, 10, 20);
    assert.ok(!controllerStateEquals(a, b), 'down on one side only');
    controllerStateStartTouch(b, 10, 20);
    assert.ok(controllerStateEquals(a, b));
    controllerStateSetTouchPos(b, 0, 10, 21);
    assert.ok(!controllerStateEquals(a, b), 'moved');
  });

  it('touch_id_next is not compared', () => {
    const a = createIdleControllerState();
    const b = createIdleControllerState();
    b.touchIdNext = 5;
    assert.ok(controllerStateEquals(a, b));
  });
});

describe('controller: state_or', () => {
  it('buttons are combined, triggers take the larger value', () => {
    const a = createIdleControllerState();
    const b = createIdleControllerState();
    a.buttons = CONTROLLER_BUTTON.cross | CONTROLLER_BUTTON.l1;
    b.buttons = CONTROLLER_BUTTON.cross | CONTROLLER_BUTTON.ps;
    a.l2State = 10;
    b.l2State = 200;
    a.r2State = 255;
    b.r2State = 0;
    const out = createIdleControllerState();
    controllerStateOr(out, a, b);
    assert.equal(out.buttons, CONTROLLER_BUTTON.cross | CONTROLLER_BUTTON.l1 | CONTROLLER_BUTTON.ps);
    assert.equal(out.l2State, 200);
    assert.equal(out.r2State, 255);
  });

  it('sticks take the value with the larger magnitude, the second on a tie', () => {
    const a = createIdleControllerState();
    const b = createIdleControllerState();
    a.leftX = -30000;
    b.leftX = 100;
    a.leftY = 5;
    b.leftY = -6;
    a.rightX = 7;
    b.rightX = -7; // tie: MAX_ABS takes b
    a.rightY = -32768;
    b.rightY = 32767;
    const out = createIdleControllerState();
    controllerStateOr(out, a, b);
    assert.deepEqual([out.leftX, out.leftY, out.rightX, out.rightY], [-30000, -6, -7, -32768]);
  });

  it('touches: per slot the first state wins, then the second, otherwise the slot is cleared', () => {
    const a = createIdleControllerState();
    const b = createIdleControllerState();
    a.touches[0] = { x: 1, y: 2, id: 3 };
    b.touches[0] = { x: 4, y: 5, id: 6 };
    b.touches[1] = { x: 7, y: 8, id: 9 };
    const out = createIdleControllerState();
    out.touchIdNext = 44;
    controllerStateOr(out, a, b);
    assert.deepEqual(out.touches, [{ x: 1, y: 2, id: 3 }, { x: 7, y: 8, id: 9 }]);
    assert.equal(out.touchIdNext, 0);

    const stale = createIdleControllerState();
    stale.touches[0] = { x: 50, y: 60, id: 1 };
    controllerStateOr(stale, createIdleControllerState(), createIdleControllerState());
    assert.deepEqual(stale.touches, [{ x: 0, y: 0, id: -1 }, { x: 0, y: 0, id: -1 }]);
  });

  it('motion comes whole from the first state when it reports any, otherwise from the second', () => {
    const a = createIdleControllerState();
    const b = createIdleControllerState();
    b.gyroX = 1;
    b.accelZ = 0.5;
    b.orientX = 1;
    b.orientW = 0;
    const out = createIdleControllerState();
    controllerStateOr(out, a, b);
    assert.deepEqual([out.gyroX, out.accelZ, out.orientX, out.orientW], [1, 0.5, 1, 0], 'a is at rest: b');

    a.gyroY = -0.25; // a now reports motion: everything from a, nothing mixed in from b
    controllerStateOr(out, a, b);
    assert.deepEqual(
      [out.gyroX, out.gyroY, out.gyroZ, out.accelX, out.accelY, out.accelZ, out.orientX, out.orientY, out.orientZ, out.orientW],
      [0, -0.25, 0, 0, 1, 0, 0, 0, 0, 1],
    );

    // only gyro and accelerometer are looked at: an orientation alone does not make a the source
    const c = createIdleControllerState();
    c.orientX = 1;
    c.orientW = 0;
    controllerStateOr(out, c, b);
    assert.deepEqual([out.gyroX, out.orientX, out.orientW], [1, 1, 0], 'b, whose orientation happens to be the same');
    const d = createIdleControllerState();
    controllerStateOr(out, c, d);
    assert.deepEqual([out.orientX, out.orientW], [0, 1], "d's orientation, not c's");
  });

  it('the result may be written into either input', () => {
    const make = (): [ReturnType<typeof createIdleControllerState>, ReturnType<typeof createIdleControllerState>] => {
      const a = createIdleControllerState();
      const b = createIdleControllerState();
      a.buttons = 1;
      a.leftX = -9;
      a.touches[1] = { x: 1, y: 2, id: 3 };
      a.gyroZ = 2;
      b.buttons = 2;
      b.leftX = 8;
      b.l2State = 9;
      b.touches[0] = { x: 4, y: 5, id: 6 };
      b.touches[1] = { x: 7, y: 7, id: 7 };
      b.accelX = 3;
      return [a, b];
    };
    const [a0, b0] = make();
    const expected = createIdleControllerState();
    controllerStateOr(expected, a0, b0);
    assert.equal(expected.buttons, 3);
    assert.deepEqual(expected.touches, [{ x: 4, y: 5, id: 6 }, { x: 1, y: 2, id: 3 }]);

    const [a1, b1] = make();
    controllerStateOr(a1, a1, b1);
    assert.deepEqual(a1, expected);
    const [a2, b2] = make();
    controllerStateOr(b2, a2, b2);
    assert.deepEqual(b2, expected);
  });
});

describe('controller: from a VirtualPadState', () => {
  it('an empty pad state is the idle state', () => {
    assert.deepEqual(controllerStateFromPad(emptyPadState()), createIdleControllerState());
    assert.ok(controllerStateEquals(controllerStateFromPad(emptyPadState()), createIdleControllerState()));
  });

  it('buttons are forwarded as they are, limited to the sixteen buttons', () => {
    const pad = emptyPadState();
    for (const [name, bit] of Object.entries(BUTTON)) {
      pad.buttons = bit;
      assert.equal(controllerStateFromPad(pad).buttons, CONTROLLER_BUTTON[name as keyof typeof CONTROLLER_BUTTON], name);
    }
    pad.buttons = 0xffff;
    assert.equal(controllerStateFromPad(pad).buttons, 0xffff);
    pad.buttons = 0xffff | CONTROLLER_ANALOG_BUTTON.l2 | CONTROLLER_ANALOG_BUTTON.r2 | (1 << 30);
    assert.equal(controllerStateFromPad(pad).buttons, 0xffff, 'the analog ids are not buttons of the state');
  });

  it('triggers: 0..255, rounded, saturating', () => {
    const cases: Array<[number, number]> = [[0, 0], [1, 1], [127.4, 127], [127.5, 128], [255, 255], [256, 255], [1e9, 255], [-1, 0], [-0.4, 0], [Number.NaN, 0]];
    for (const [input, expected] of cases) {
      const pad = emptyPadState();
      pad.l2 = input;
      pad.r2 = input;
      const state = controllerStateFromPad(pad);
      assert.equal(state.l2State, expected, `l2 ${input}`);
      assert.equal(state.r2State, expected, `r2 ${input}`);
      assert.ok(Object.is(state.l2State, expected), 'no negative zero');
    }
  });

  it('sticks: -1..1 to -32767..32767, rounded the same way on both sides, saturating, no sign change', () => {
    const cases: Array<[number, number]> = [
      [0, 0], [1, 32767], [-1, -32767], [0.5, 16384], [-0.5, -16384], [0.25, 8192], [-0.25, -8192], [1 / 32767, 1], [-1 / 32767, -1],
      [1.0001, 32767], [2, 32767], [-1.0001, -32767], [-50, -32767], [Number.POSITIVE_INFINITY, 0], [Number.NaN, 0], [-0.00001, 0],
    ];
    for (const [input, expected] of cases) {
      for (const axis of ['leftX', 'leftY', 'rightX', 'rightY'] as const) {
        const pad = emptyPadState();
        pad[axis] = input;
        const state = controllerStateFromPad(pad);
        assert.ok(Object.is(state[axis], expected), `${axis} ${input}: got ${state[axis]}, expected ${expected}`);
        for (const other of ['leftX', 'leftY', 'rightX', 'rightY'] as const) {
          if (other !== axis) assert.equal(state[other], 0, `${other} untouched`);
        }
      }
    }
  });

  it('+Y stays down: "stick up" is negative, as in the reference keyboard mapping (-0x7fff)', () => {
    const pad = emptyPadState();
    pad.leftY = -1;
    pad.rightY = 1;
    const state = controllerStateFromPad(pad);
    assert.equal(state.leftY, -0x7fff);
    assert.equal(state.rightY, 0x7fff);
  });

  it('gyro and accelerometer pass through unchanged inside the range of the wire format', () => {
    const pad = emptyPadState();
    pad.gyro = { x: 0.125, y: -29.5, z: 30 };
    pad.accel = { x: -5, y: 0.98, z: 4.75 };
    const state = controllerStateFromPad(pad);
    assert.deepEqual([state.gyroX, state.gyroY, state.gyroZ], [0.125, -29.5, 30]);
    assert.deepEqual([state.accelX, state.accelY, state.accelZ], [-5, 0.98, 4.75]);
  });

  it('gyro is limited to +-30 and the accelerometer to +-5 (GYRO_MIN/MAX, ACCEL_MIN/MAX of feedback.c)', () => {
    assert.deepEqual([GYRO_MIN, GYRO_MAX, ACCEL_MIN, ACCEL_MAX], [-30, 30, -5, 5]);
    assert.equal(GYRO_LIMIT_RAD_S, GYRO_MAX, 'the limit the engine documents is the one used here');
    const pad = emptyPadState();
    pad.gyro = { x: 30.001, y: -1000, z: Number.POSITIVE_INFINITY };
    pad.accel = { x: 5.5, y: -5.5, z: Number.NaN };
    const state = controllerStateFromPad(pad);
    assert.deepEqual([state.gyroX, state.gyroY, state.gyroZ], [30, -30, 0]);
    assert.deepEqual([state.accelX, state.accelY, state.accelZ], [5, -5, 0]);
    pad.accel = { x: 0, y: Number.NaN, z: 0 };
    assert.equal(controllerStateFromPad(pad).accelY, 1, 'the rest value of Y is 1 g');
  });

  it('the orientation passes through; one without a length becomes the rest orientation', () => {
    const pad = emptyPadState();
    pad.orient = { x: 0.5, y: -0.5, z: 0.5, w: -0.5 };
    let state = controllerStateFromPad(pad);
    assert.deepEqual([state.orientX, state.orientY, state.orientZ, state.orientW], [0.5, -0.5, 0.5, -0.5]);
    for (const bad of [{ x: 0, y: 0, z: 0, w: 0 }, { x: Number.NaN, y: 0, z: 0, w: 1 }, { x: 0, y: Number.POSITIVE_INFINITY, z: 0, w: 1 }]) {
      pad.orient = bad;
      state = controllerStateFromPad(pad);
      assert.deepEqual([state.orientX, state.orientY, state.orientZ, state.orientW], [0, 0, 0, 1]);
    }
  });

  it('writes into a given state and leaves its touches alone', () => {
    const state = createIdleControllerState();
    const id = controllerStateStartTouch(state, 100, 200);
    const pad = emptyPadState();
    pad.buttons = BUTTON.touchpad | BUTTON.cross;
    pad.leftX = 1;
    const result = controllerStateFromPad(pad, state);
    assert.equal(result, state, 'the same object');
    assert.equal(state.buttons, CONTROLLER_BUTTON.touchpad | CONTROLLER_BUTTON.cross);
    assert.equal(state.leftX, 32767);
    assert.deepEqual(state.touches[0], { x: 100, y: 200, id });
    assert.equal(state.touchIdNext, 1);

    // and every pad field is overwritten, so a released button does not stick
    controllerStateFromPad(emptyPadState(), state);
    assert.equal(state.buttons, 0);
    assert.equal(state.leftX, 0);
    assert.deepEqual(state.touches[0], { x: 100, y: 200, id });
  });

  it('does not keep a reference to the pad state', () => {
    const pad = emptyPadState();
    const state = controllerStateFromPad(pad);
    pad.gyro.x = 5;
    pad.buttons = 1;
    assert.equal(state.gyroX, 0);
    assert.equal(state.buttons, 0);
  });
});

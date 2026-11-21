// SPDX-License-Identifier: AGPL-3.0-only
//
// Feedback state and feedback history (src/console/feedback.ts, from chiaki-ng lib/src/feedback.c and
// lib/include/chiaki/feedback.h, commit 43728af).
//
// The first group is every test of the reference's own test/feedback.c, with the same states and the same assertions.
// The reference has no vector for the feedback state and none that spells out whole events, so the other groups hold
// values worked out by hand from the C source: they show that the port does what that reading says, nothing more.
//
// STATUS: checked against the reference's four history vectors. Never run against a real console.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTROLLER_ANALOG_BUTTON, CONTROLLER_BUTTON, controllerStateSetTouchPos, controllerStateStartTouch, controllerStateStopTouch,
  createIdleControllerState, type ControllerState,
} from '../src/console/controller.ts';
import {
  compressQuat, FEEDBACK_STATE_BUF_SIZE_MAX, FEEDBACK_STATE_BUF_SIZE_V12, FEEDBACK_STATE_BUF_SIZE_V9, FeedbackHistoryBuffer,
  feedbackHistoryEventSetButton, feedbackHistoryEventSetTouchpad, feedbackStateFormatV12, feedbackStateFormatV9, HISTORY_EVENT_SIZE_MAX,
  type FeedbackState,
} from '../src/console/feedback.ts';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const bytes = (b: Uint8Array | null): Buffer => {
  assert.ok(b !== null);
  return Buffer.from(b);
};

describe('feedback history: chiaki-ng test vectors (test/feedback.c)', () => {
  const PACKETS_MAX = 8;

  /** record() and format_packet() of the reference test: one formatted packet (events newest first) per pushed event. */
  function record(prev: ControllerState, now: ControllerState): Uint8Array[] {
    const history = new FeedbackHistoryBuffer(0x10);
    const packets: Uint8Array[] = [];
    history.recordState(prev, now, () => {
      assert.ok(packets.length < PACKETS_MAX);
      const packet = history.format(0x40);
      assert.ok(packet !== null);
      packets.push(packet);
    });
    return packets;
  }

  it('touchpad_click_release_before_touch_up', () => {
    // a tap releases click and finger in the same state change; a console seeing the
    // finger lift while the click is still down keeps the finger down
    const prev = createIdleControllerState();
    controllerStateStartTouch(prev, 100, 200);
    prev.buttons |= CONTROLLER_BUTTON.touchpad;
    const now = createIdleControllerState();

    const packets = record(prev, now);
    assert.equal(packets.length, 2);
    assert.equal(packets[0]!.length, 2);
    assert.equal(packets[0]![0], 0x80); // click up
    assert.equal(packets[0]![1], 0x91);
    assert.equal(packets[1]!.length, 5 + 2);
    assert.equal(packets[1]![0], 0xc0); // then touch up
  });

  it('touchpad_touch_down_before_click_press', () => {
    const prev = createIdleControllerState();
    const now = createIdleControllerState();
    controllerStateStartTouch(now, 100, 200);
    now.buttons |= CONTROLLER_BUTTON.touchpad;

    const packets = record(prev, now);
    assert.equal(packets.length, 2);
    assert.equal(packets[0]!.length, 5);
    assert.equal(packets[0]![0], 0xd0); // touch down
    assert.equal(packets[1]!.length, 2 + 5);
    assert.equal(packets[1]![0], 0x80); // then click press
    assert.equal(packets[1]![1], 0xb1);
  });

  it('simultaneous_l2_r2_one_packet_each', () => {
    // the console applies only the newest event of a packet, so L2 sharing a packet with R2 got lost
    const prev = createIdleControllerState();
    const now = createIdleControllerState();
    now.l2State = 0xff;
    now.r2State = 0xff;

    const packets = record(prev, now);
    assert.equal(packets.length, 2);
    assert.equal(packets[0]!.length, 3);
    assert.equal(packets[0]![1], 0x86); // L2
    assert.equal(packets[1]!.length, 3 + 3);
    assert.equal(packets[1]![1], 0x87); // then R2
  });

  it('no_change_no_packet', () => {
    const state = createIdleControllerState();
    const packets = record(state, state);
    assert.equal(packets.length, 0);
  });
});

describe('feedback history: events (worked out from feedback.c)', () => {
  it('buttons with a state byte', () => {
    const table: Array<[number, number]> = [
      [CONTROLLER_BUTTON.cross, 0x88], [CONTROLLER_BUTTON.moon, 0x89], [CONTROLLER_BUTTON.box, 0x8a], [CONTROLLER_BUTTON.pyramid, 0x8b],
      [CONTROLLER_BUTTON.dpad_left, 0x82], [CONTROLLER_BUTTON.dpad_right, 0x83], [CONTROLLER_BUTTON.dpad_up, 0x80], [CONTROLLER_BUTTON.dpad_down, 0x81],
      [CONTROLLER_BUTTON.l1, 0x84], [CONTROLLER_BUTTON.r1, 0x85],
      [CONTROLLER_ANALOG_BUTTON.l2, 0x86], [CONTROLLER_ANALOG_BUTTON.r2, 0x87],
    ];
    for (const [button, code] of table) {
      assert.deepEqual(bytes(feedbackHistoryEventSetButton(button, 0xff)), Buffer.from([0x80, code, 0xff]), `press 0x${button.toString(16)}`);
      assert.deepEqual(bytes(feedbackHistoryEventSetButton(button, 0)), Buffer.from([0x80, code, 0x00]), `release 0x${button.toString(16)}`);
    }
    assert.deepEqual(bytes(feedbackHistoryEventSetButton(CONTROLLER_ANALOG_BUTTON.l2, 0x7f)), hex('80 86 7f'));
    assert.deepEqual(bytes(feedbackHistoryEventSetButton(CONTROLLER_ANALOG_BUTTON.r2, 1)), hex('80 87 01'));
  });

  it('buttons whose code says pressed or released (two bytes)', () => {
    const table: Array<[number, number, number]> = [
      [CONTROLLER_BUTTON.l3, 0xaf, 0x8f], [CONTROLLER_BUTTON.r3, 0xb0, 0x90], [CONTROLLER_BUTTON.options, 0xac, 0x8c],
      [CONTROLLER_BUTTON.share, 0xad, 0x8d], [CONTROLLER_BUTTON.touchpad, 0xb1, 0x91], [CONTROLLER_BUTTON.ps, 0xae, 0x8e],
    ];
    for (const [button, pressed, released] of table) {
      assert.deepEqual(bytes(feedbackHistoryEventSetButton(button, 0xff)), Buffer.from([0x80, pressed]), `press 0x${button.toString(16)}`);
      assert.deepEqual(bytes(feedbackHistoryEventSetButton(button, 1)), Buffer.from([0x80, pressed]), 'any state but 0 is pressed');
      assert.deepEqual(bytes(feedbackHistoryEventSetButton(button, 0)), Buffer.from([0x80, released]), `release 0x${button.toString(16)}`);
    }
  });

  it('every button and both triggers have an event, and no two share a code', () => {
    const buttons = [...Object.values(CONTROLLER_BUTTON), ...Object.values(CONTROLLER_ANALOG_BUTTON)];
    assert.equal(buttons.length, 18);
    const seen = new Set<string>();
    for (const button of buttons) {
      for (const state of [0, 0xff]) {
        const event = feedbackHistoryEventSetButton(button, state);
        assert.ok(event !== null);
        assert.ok(event.length === 2 || event.length === 3);
        assert.ok(event.length <= HISTORY_EVENT_SIZE_MAX);
        seen.add(Buffer.from(event).toString('hex'));
      }
    }
    assert.equal(seen.size, 36);
  });

  it('anything that is not exactly one known button gives no event', () => {
    for (const bad of [0, CONTROLLER_BUTTON.cross | CONTROLLER_BUTTON.moon, 1 << 18, 1 << 31, -1, 0xffff]) {
      assert.equal(feedbackHistoryEventSetButton(bad, 0xff), null, `0x${(bad >>> 0).toString(16)}`);
    }
  });

  it('touchpad: 12 bits of x and 12 bits of y behind the id', () => {
    assert.equal(HISTORY_EVENT_SIZE_MAX, 5);
    assert.deepEqual(bytes(feedbackHistoryEventSetTouchpad(true, 5, 0x123, 0x456)), hex('d0 05 12 34 56'));
    assert.deepEqual(bytes(feedbackHistoryEventSetTouchpad(false, 5, 0x123, 0x456)), hex('c0 05 12 34 56'));
    assert.deepEqual(bytes(feedbackHistoryEventSetTouchpad(true, 0, 0, 0)), hex('d0 00 00 00 00'));
    assert.deepEqual(bytes(feedbackHistoryEventSetTouchpad(true, 0, 100, 200)), hex('d0 00 06 40 c8'));
    assert.deepEqual(bytes(feedbackHistoryEventSetTouchpad(true, 127, 1919, 1079)), hex('d0 7f 77 f4 37'), 'the PS5 corner');
    assert.deepEqual(bytes(feedbackHistoryEventSetTouchpad(true, 1, 1920, 942)), hex('d0 01 78 03 ae'), 'the PS4 corner');
    assert.deepEqual(bytes(feedbackHistoryEventSetTouchpad(true, 0x85, 1, 1)), hex('d0 05 00 10 01'), 'the id is masked with 0x7f');
  });
});

describe('feedback history: the ring buffer', () => {
  const ev = (n: number): Uint8Array => Uint8Array.of(0x80, 0x88, n);

  it('formats newest first', () => {
    const buf = new FeedbackHistoryBuffer(4);
    assert.deepEqual(bytes(buf.format()), Buffer.alloc(0));
    buf.push(ev(1));
    buf.push(ev(2));
    buf.push(Uint8Array.of(0x80, 0xb1));
    assert.equal(buf.len, 3);
    assert.deepEqual(bytes(buf.format()), hex('80b1 808802 808801'));
  });

  it('drops the oldest when full', () => {
    const buf = new FeedbackHistoryBuffer(4);
    for (let i = 1; i <= 6; i++) buf.push(ev(i));
    assert.equal(buf.len, 4);
    assert.deepEqual(bytes(buf.format()), hex('808806 808805 808804 808803'));
    for (let i = 7; i <= 15; i++) buf.push(ev(i));
    assert.deepEqual(bytes(buf.format()), hex('80880f 80880e 80880d 80880c'));
  });

  it('lowering len limits what is written, and the next push adds to that', () => {
    const buf = new FeedbackHistoryBuffer(0x10);
    for (let i = 1; i <= 5; i++) buf.push(ev(i));
    buf.len = 2;
    assert.deepEqual(bytes(buf.format()), hex('808805 808804'));
    buf.push(ev(6));
    assert.deepEqual(bytes(buf.format()), hex('808806 808805 808804'));
  });

  it('refuses to format into too little room (CHIAKI_ERR_BUF_TOO_SMALL)', () => {
    const buf = new FeedbackHistoryBuffer(4);
    buf.push(ev(1));
    buf.push(ev(2));
    assert.equal(buf.format(5), null);
    assert.deepEqual(bytes(buf.format(6)), hex('808802 808801'));
  });

  it('keeps its own copy of an event', () => {
    const buf = new FeedbackHistoryBuffer(4);
    const event = ev(1);
    buf.push(event);
    event[2] = 0x99;
    assert.deepEqual(bytes(buf.format()), hex('808801'));
  });

  it('needs a positive size', () => {
    assert.throws(() => new FeedbackHistoryBuffer(0), RangeError);
    assert.throws(() => new FeedbackHistoryBuffer(1.5), RangeError);
  });
});

describe('feedback history: turning a state change into events (worked out from feedback.c)', () => {
  /** Every event of the change, oldest first, each as hex. */
  function events(prev: ControllerState, now: ControllerState): string[] {
    const history = new FeedbackHistoryBuffer(0x10);
    const out: string[] = [];
    let previousLength = 0;
    const recorded = history.recordState(prev, now, () => {
      const all = bytes(history.format());
      out.push(all.subarray(0, all.length - previousLength).toString('hex'));
      previousLength = all.length;
    });
    assert.equal(recorded, out.length > 0);
    return out;
  }

  it('releases, then touches, then presses in bit order, then L2, then R2', () => {
    const prev = createIdleControllerState();
    prev.buttons = CONTROLLER_BUTTON.cross | CONTROLLER_BUTTON.r1 | CONTROLLER_BUTTON.ps;
    prev.l2State = 0x40;
    controllerStateStartTouch(prev, 0x123, 0x456); // slot 0, id 0
    const now = createIdleControllerState();
    now.buttons = CONTROLLER_BUTTON.r1 | CONTROLLER_BUTTON.moon | CONTROLLER_BUTTON.options | CONTROLLER_BUTTON.dpad_up;
    now.l2State = 0x41;
    now.r2State = 0xff;
    now.touches[1] = { x: 1, y: 2, id: 9 };

    assert.deepEqual(events(prev, now), [
      '808800', // cross up (bit 0)
      '808e', // ps up (bit 15)
      'c000123456', // touch 0 up, at its last position
      'd009001002', // touch 9 down
      '8089ff', // moon down (bit 1)
      '8080ff', // dpad up down (bit 6)
      '80ac', // options down (bit 12)
      '808641', // L2
      '8087ff', // R2
    ]);
  });

  it('a held button and an unchanged trigger give nothing', () => {
    const prev = createIdleControllerState();
    prev.buttons = CONTROLLER_BUTTON.box;
    prev.r2State = 7;
    const now = createIdleControllerState();
    now.buttons = CONTROLLER_BUTTON.box;
    now.r2State = 7;
    now.leftX = 500; // sticks and motion are not history events
    now.gyroX = 1;
    assert.deepEqual(events(prev, now), []);
  });

  it('a moving finger gives a touch down event with the new position', () => {
    const prev = createIdleControllerState();
    const id = controllerStateStartTouch(prev, 10, 20);
    const now = createIdleControllerState();
    controllerStateStartTouch(now, 10, 20);
    assert.deepEqual(events(prev, now), [], 'not moved');
    controllerStateSetTouchPos(now, id, 11, 20);
    assert.deepEqual(events(prev, now), ['d00000b014']);
    controllerStateStopTouch(now, id);
    assert.deepEqual(events(prev, now), ['c00000a014'], 'the lift reports the last known position');
  });

  it('as in the reference: a slot whose finger was replaced within one change only reports the old one lifting', () => {
    const prev = createIdleControllerState();
    prev.touches[0] = { x: 1, y: 1, id: 3 };
    const now = createIdleControllerState();
    now.touches[0] = { x: 2, y: 2, id: 4 };
    assert.deepEqual(events(prev, now), ['c003001001']);
  });

  it('only the sixteen buttons are looked at', () => {
    const prev = createIdleControllerState();
    const now = createIdleControllerState();
    now.buttons = CONTROLLER_ANALOG_BUTTON.l2 | CONTROLLER_ANALOG_BUTTON.r2 | (1 << 20);
    assert.deepEqual(events(prev, now), []);
  });
});

describe('feedback state (no reference vector: worked out from feedback.c)', () => {
  const idle = (): FeedbackState => ({
    gyroX: 0, gyroY: 0, gyroZ: 0, accelX: 0, accelY: 1, accelZ: 0, orientX: 0, orientY: 0, orientZ: 0, orientW: 1,
    leftX: 0, leftY: 0, rightX: 0, rightY: 0,
  });
  const u16le = (b: Uint8Array, off: number): number => b[off]! | (b[off + 1]! << 8);

  it('sizes', () => {
    assert.equal(FEEDBACK_STATE_BUF_SIZE_V9, 0x19);
    assert.equal(FEEDBACK_STATE_BUF_SIZE_V12, 0x1c);
    assert.equal(FEEDBACK_STATE_BUF_SIZE_MAX, 0x1c);
    assert.equal(feedbackStateFormatV9(idle()).length, 0x19);
    assert.equal(feedbackStateFormatV12(idle()).length, 0x1c);
  });

  it('the idle state, PS4 layout (v9)', () => {
    // 0xa0 | gyro 0 -> 0x7fff x3 | accel (0, 1, 0) -> 0x7fff 0x9999 0x7fff | identity quaternion | sticks 0
    assert.deepEqual(bytes(feedbackStateFormatV9(idle())), hex('a0 ff7f ff7f ff7f ff7f 9999 ff7f fef7ef1f 0000 0000 0000 0000'));
  });

  it('the PS5 layout (v12) is the PS4 one followed by 00 00 01', () => {
    assert.deepEqual(bytes(feedbackStateFormatV12(idle())), hex('a0 ff7f ff7f ff7f ff7f 9999 ff7f fef7ef1f 0000 0000 0000 0000 000001'));
    const state = idle();
    state.gyroX = 3;
    state.accelZ = -2;
    state.orientX = 0.5;
    state.orientY = 0.5;
    state.orientZ = 0.5;
    state.orientW = 0.5;
    state.leftX = 1234;
    state.rightY = -4321;
    const v9 = bytes(feedbackStateFormatV9(state));
    const v12 = bytes(feedbackStateFormatV12(state));
    assert.deepEqual(v12.subarray(0, 0x19), v9);
    assert.deepEqual(v12.subarray(0x19), hex('000001'));
  });

  it('sticks are 16 bit big endian, two\'s complement', () => {
    const state = idle();
    state.leftX = 0x1234;
    state.leftY = -2;
    state.rightX = 32767;
    state.rightY = -32768;
    assert.deepEqual(bytes(feedbackStateFormatV9(state)).subarray(0x11), hex('1234 fffe 7fff 8000'));
  });

  it('gyro: -30..30 onto 0..0xffff, little endian, in the order x, y, z', () => {
    const state = idle();
    state.gyroX = -30;
    state.gyroY = 30;
    state.gyroZ = 15;
    const buf = feedbackStateFormatV9(state);
    assert.equal(u16le(buf, 0x1), 0x0000);
    assert.equal(u16le(buf, 0x3), 0xffff);
    assert.equal(u16le(buf, 0x5), 0xbfff); // 65535 * 45 / 60 = 49151.25, cut off
    state.gyroX = -15;
    assert.equal(u16le(feedbackStateFormatV9(state), 0x1), 0x3fff); // 65535 * 15 / 60 = 16383.75, cut off
  });

  it('accelerometer: -5..5 onto 0..0xffff, little endian, in the order x, y, z', () => {
    const state = idle();
    state.accelX = -5;
    state.accelY = 5;
    state.accelZ = 2.5;
    const buf = feedbackStateFormatV9(state);
    assert.equal(u16le(buf, 0x7), 0x0000);
    assert.equal(u16le(buf, 0x9), 0xffff);
    assert.equal(u16le(buf, 0xb), 0xbfff); // 65535 * 7.5 / 10 = 49151.25
    state.accelZ = -1;
    assert.equal(u16le(feedbackStateFormatV9(state), 0xb), 0x6666); // 65535 * 4 / 10 = 26214
  });

  it('values outside the range saturate (the reference leaves this undefined)', () => {
    const state = idle();
    state.gyroX = 30.5;
    state.gyroY = -1e6;
    state.gyroZ = Number.NaN;
    state.accelX = 1e30;
    state.accelY = -5.0001;
    state.accelZ = Number.NEGATIVE_INFINITY;
    const buf = feedbackStateFormatV9(state);
    assert.deepEqual([u16le(buf, 0x1), u16le(buf, 0x3), u16le(buf, 0x5)], [0xffff, 0, 0]);
    assert.deepEqual([u16le(buf, 0x7), u16le(buf, 0x9), u16le(buf, 0xb)], [0xffff, 0, 0]);
  });

  it('the orientation sits at 0x0d, little endian', () => {
    const state = idle();
    state.orientX = 0.5;
    state.orientY = 0.5;
    state.orientZ = 0.5;
    state.orientW = 0.5;
    assert.deepEqual(bytes(feedbackStateFormatV9(state)).subarray(0xd, 0x11), hex('a04d9b36')); // 0x369b4da0
  });
});

describe('feedback state: quaternion compression (worked out from compress_quat in feedback.c)', () => {
  it('the left out component: index in bits 1..2, sign in bit 0; a zero is 0xff', () => {
    assert.equal(compressQuat(0, 0, 0, 1), 0x1feff7fe); // w left out: 3 << 1
    assert.equal(compressQuat(0, 0, 0, -1), 0x1feff7ff); // and negative
    assert.equal(compressQuat(1, 0, 0, 0), 0x1feff7f8); // x left out
    assert.equal(compressQuat(0, -1, 0, 0), 0x1feff7fb); // y left out, negative
    assert.equal(compressQuat(0, 0, 1, 0), 0x1feff7fc); // z left out
  });

  it('on a tie the first of the largest is left out', () => {
    // (v + sqrt(1/2)) * 511 / (2 * sqrt(1/2)) for 0.5 is 436.17, cut off to 436 = 0x1b4, three times
    assert.equal(compressQuat(0.5, 0.5, 0.5, 0.5), 0x369b4da0);
    assert.equal(compressQuat(-0.5, 0.5, 0.5, 0.5), 0x369b4da1);
  });

  it('the three kept components are in the order x, y, z, w with the left out one skipped', () => {
    // -0.5 gives (0.7071 - 0.5) * 361.33 = 74.8 -> 74 = 0x4a; 0.5 gives 0x1b4; 0.1 gives 291.6 -> 291 = 0x123
    const w = Math.sqrt(1 - 0.25 - 0.25 - 0.01);
    assert.equal(compressQuat(-0.5, 0.5, 0.1, w), ((3 << 1) | (0x4a << 3) | (0x1b4 << 12) | (0x123 << 21)) >>> 0);
    assert.equal(compressQuat(w, -0.5, 0.5, 0.1), ((0 << 1) | (0x4a << 3) | (0x1b4 << 12) | (0x123 << 21)) >>> 0);
    assert.equal(compressQuat(-0.5, w, 0.5, 0.1), ((1 << 1) | (0x4a << 3) | (0x1b4 << 12) | (0x123 << 21)) >>> 0);
    assert.equal(compressQuat(-0.5, 0.5, w, 0.1), ((2 << 1) | (0x4a << 3) | (0x1b4 << 12) | (0x123 << 21)) >>> 0);
  });

  it('kept components are limited to +-sqrt(1/2), which is 0 and 0x1ff', () => {
    // not unit quaternions: the only way a kept component can be outside the limit
    assert.equal(compressQuat(0.8, 0.9, 0, 0), ((1 << 1) | (0x1ff << 3) | (0xff << 12) | (0xff << 21)) >>> 0);
    assert.equal(compressQuat(-0.8, 0.9, 0, 0), ((1 << 1) | (0x000 << 3) | (0xff << 12) | (0xff << 21)) >>> 0);
    assert.equal(compressQuat(Math.SQRT1_2, 0, 0, Math.SQRT1_2) >>> 3 & 0x1ff, 0xff, 'x left out on the tie, y is zero');
    assert.equal(compressQuat(Math.SQRT1_2, 0, 0, Math.SQRT1_2) >>> 21, 0x1ff, 'w at the limit');
    assert.equal(compressQuat(Math.SQRT1_2, 0, 0, -Math.SQRT1_2) >>> 21, 0x000, 'w at the negative limit');
  });

  it('never uses more than 30 bits, and a kept component that is not a number is written as 0', () => {
    assert.equal(compressQuat(1, 1, 1, 1) >>> 30, 0);
    // w is the largest, y is kept: undefined in C, 0 here
    assert.equal(compressQuat(0, Number.NaN, 0, 1), ((3 << 1) | (0xff << 3) | (0 << 12) | (0xff << 21)) >>> 0);
    // as in C, nothing compares larger than a NaN in front, so x stays the left out one and w is limited to 0x1ff
    assert.equal(compressQuat(Number.NaN, 0, 0, 1), ((0 << 1) | (0xff << 3) | (0xff << 12) | (0x1ff << 21)) >>> 0);
  });

  it('can be undone: a decoder written from the same layout gets the quaternion back within the 9 bit step', () => {
    const decode = (r: number): number[] => {
      const largest = (r >>> 1) & 3;
      const q = [0, 0, 0, 0];
      let sum = 0;
      for (let i = 0; i < 3; i++) {
        const v = ((r >>> (3 + i * 9)) & 0x1ff) * (2 * Math.SQRT1_2) / 0x1ff - Math.SQRT1_2;
        q[i < largest ? i : i + 1] = v;
        sum += v * v;
      }
      q[largest] = Math.sqrt(Math.max(0, 1 - sum)) * (r & 1 ? -1 : 1);
      return q;
    };
    let seed = 12345;
    const random = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff * 2 - 1;
    };
    const step = (2 * Math.SQRT1_2) / 0x1ff;
    for (let n = 0; n < 2000; n++) {
      const raw = [random(), random(), random(), random()];
      const norm = Math.hypot(...raw);
      if (norm < 0.1) continue;
      const q = raw.map((v) => v / norm);
      const back = decode(compressQuat(q[0]!, q[1]!, q[2]!, q[3]!));
      const largest = q.reduce((best, v, i) => (Math.abs(v) > Math.abs(q[best]!) ? i : best), 0);
      for (let i = 0; i < 4; i++) {
        // the kept ones are cut off to a step; the left out one inherits their error
        const tolerance = i === largest ? 4 * step : step * 1.001;
        assert.ok(Math.abs(back[i]! - q[i]!) <= tolerance, `component ${i} of ${q.join(',')}: ${back[i]}`);
      }
    }
  });
});

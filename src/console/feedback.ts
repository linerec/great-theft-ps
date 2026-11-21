// SPDX-License-Identifier: AGPL-3.0-only
//
// What the client reports to the console about its controller: the "feedback state" (sticks and motion, sent as a whole)
// and the "feedback history" (button, trigger and touch events, sent as a list of the most recent ones).
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/feedback.c and
// lib/include/chiaki/feedback.h (commit 43728af). The layouts, the event codes, the quaternion compression and the
// order in which a state change is turned into events are transcribed from there. See NOTICE.md.
//
// The feedback state, as formatted here (the 12 byte packet header in front of it belongs to the transport):
//
//   0x00        0xa0
//   0x01..0x06  gyro x, y, z       uint16 little endian: 0xffff * (value - GYRO_MIN) / (GYRO_MAX - GYRO_MIN)
//   0x07..0x0c  accel x, y, z      uint16 little endian: 0xffff * (value - ACCEL_MIN) / (ACCEL_MAX - ACCEL_MIN)
//   0x0d..0x10  orientation        32 bits little endian, see compressQuat()
//   0x11..0x18  left x, left y, right x, right y   int16 BIG endian
//   -- "v12" only (PS5) --
//   0x19..0x1b  0x00 0x00 0x01
//
// "v9" (0x19 bytes) is what the reference sends when the Takion protocol version is 9 or lower, which is a PS4;
// "v12" (0x1c bytes) otherwise, which is a PS5. The PS5 layout is the PS4 one plus the three constant bytes; nothing
// else differs. Buttons and triggers are NOT part of the state, they travel as history events only.
//
// Differences from the reference, all in places where the C code has no defined behaviour:
// - A gyro or accelerometer value outside its range makes the C code cast an out of range float to uint16_t, which is
//   undefined (it wraps on some machines and saturates on others). Here it saturates at 0 and 0xffff.
// - A quaternion component that is not a number is written as 0 instead of being undefined.
// - An event for an unknown button is `null` instead of CHIAKI_ERR_INVALID_DATA with a half filled event.
//
// STATUS: the history events and their order are checked against all four vectors of the reference's own test
// (test/feedback.c, ported in test/feedback.test.ts). The reference has NO vector for the feedback state: its layout is
// checked only against values worked out by hand from the C source. It has NOT been run against a real console.

import {
  ACCEL_MAX, ACCEL_MIN, CONTROLLER_ANALOG_BUTTON, CONTROLLER_BUTTON, CONTROLLER_BUTTONS_COUNT, CONTROLLER_TOUCHES_MAX, GYRO_MAX, GYRO_MIN,
  type ControllerState,
} from './controller.ts';

/** ChiakiFeedbackState: the part of the controller state that the feedback state carries. */
export interface FeedbackState {
  /** rad/s as the reference GUI fills it; representable range GYRO_MIN..GYRO_MAX. */
  gyroX: number;
  gyroY: number;
  gyroZ: number;
  /** g as the reference GUI fills it; representable range ACCEL_MIN..ACCEL_MAX. */
  accelX: number;
  accelY: number;
  accelZ: number;
  /** Unit quaternion. */
  orientX: number;
  orientY: number;
  orientZ: number;
  orientW: number;
  /** int16_t. */
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
}

export const FEEDBACK_STATE_BUF_SIZE_MAX = 0x1c;
export const FEEDBACK_STATE_BUF_SIZE_V9 = 0x19;
export const FEEDBACK_STATE_BUF_SIZE_V12 = 0x1c;

const f32 = Math.fround;

/**
 * `(uint16_t)(0xffff * ((float)value - MIN) / (MAX - MIN))` in single precision, truncated towards zero as the C cast
 * does. Outside the range the C cast is undefined; here it saturates.
 */
function quantize(value: number, min: number, max: number): number {
  const scaled = f32(f32(0xffff * f32(f32(value) - min)) / (max - min));
  if (!(scaled > 0)) return 0; // negative, or not a number
  if (scaled >= 0xffff) return 0xffff;
  return Math.trunc(scaled);
}

/**
 * compress_quat() of feedback.c ("very similar idea as https://github.com/jpreiss/quatcompress"): the largest of the
 * four components is left out, since a unit quaternion lets the receiver work it out again.
 *
 *   bit 0       1 when the left out component is negative
 *   bits 1..2   index of the left out component (0 = x, 1 = y, 2 = z, 3 = w)
 *   bits 3..29  the other three in order, 9 bits each: (v + sqrt(1/2)) * 0x1ff / (2 * sqrt(1/2)), with v limited to
 *               +-sqrt(1/2) first
 */
export function compressQuat(x: number, y: number, z: number, w: number): number {
  const q = [f32(x), f32(y), f32(z), f32(w)];
  let largest = 0;
  for (let i = 1; i < 4; i++) {
    if (Math.abs(q[i]!) > Math.abs(q[largest]!)) largest = i;
  }
  let r = (q[largest]! < 0 ? 1 : 0) | (largest << 1);
  for (let i = 0; i < 3; i++) {
    let v = q[i < largest ? i : i + 1]!;
    if (v < -Math.SQRT1_2) v = f32(-Math.SQRT1_2);
    if (v > Math.SQRT1_2) v = f32(Math.SQRT1_2);
    v = f32(v + Math.SQRT1_2);
    v = f32(v * (0x1ff / (2 * Math.SQRT1_2)));
    const bits = v > 0 ? Math.trunc(v) & 0x1ff : 0;
    r |= bits << (3 + i * 9);
  }
  return r >>> 0;
}

function formatState(buf: Uint8Array, state: FeedbackState): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf[0x0] = 0xa0;
  view.setUint16(0x1, quantize(state.gyroX, GYRO_MIN, GYRO_MAX), true);
  view.setUint16(0x3, quantize(state.gyroY, GYRO_MIN, GYRO_MAX), true);
  view.setUint16(0x5, quantize(state.gyroZ, GYRO_MIN, GYRO_MAX), true);
  view.setUint16(0x7, quantize(state.accelX, ACCEL_MIN, ACCEL_MAX), true);
  view.setUint16(0x9, quantize(state.accelY, ACCEL_MIN, ACCEL_MAX), true);
  view.setUint16(0xb, quantize(state.accelZ, ACCEL_MIN, ACCEL_MAX), true);
  view.setUint32(0xd, compressQuat(state.orientX, state.orientY, state.orientZ, state.orientW), true);
  view.setInt16(0x11, state.leftX, false); // htons((uint16_t)left_x)
  view.setInt16(0x13, state.leftY, false);
  view.setInt16(0x15, state.rightX, false);
  view.setInt16(0x17, state.rightY, false);
}

/** chiaki_feedback_state_format_v9(): the PS4 layout, FEEDBACK_STATE_BUF_SIZE_V9 bytes. */
export function feedbackStateFormatV9(state: FeedbackState): Uint8Array {
  const buf = new Uint8Array(FEEDBACK_STATE_BUF_SIZE_V9);
  formatState(buf, state);
  return buf;
}

/** chiaki_feedback_state_format_v12(): the PS5 layout, FEEDBACK_STATE_BUF_SIZE_V12 bytes. */
export function feedbackStateFormatV12(state: FeedbackState): Uint8Array {
  const buf = new Uint8Array(FEEDBACK_STATE_BUF_SIZE_V12);
  formatState(buf, state);
  buf[0x19] = 0x0;
  buf[0x1a] = 0x0;
  buf[0x1b] = 0x1;
  return buf;
}

export const HISTORY_EVENT_SIZE_MAX = 0x5;

/**
 * ChiakiFeedbackHistoryEvent: the bytes of one event, 2, 3 or 5 of them (the C struct is a 5 byte buffer and a length;
 * here the array has exactly the length).
 */
export type FeedbackHistoryEvent = Uint8Array;

/**
 * chiaki_feedback_history_event_set_button().
 * @param button one bit of CONTROLLER_BUTTON, or one of CONTROLLER_ANALOG_BUTTON
 * @param state 0x00 for not pressed, 0xff for pressed, values in between for the analog triggers
 * @returns the event, or null for anything that is not exactly one known button (CHIAKI_ERR_INVALID_DATA)
 */
export function feedbackHistoryEventSetButton(button: number, state: number): FeedbackHistoryEvent | null {
  state &= 0xff;
  // some buttons use a third byte for the state, some don't
  let code: number;
  switch (button) {
    case CONTROLLER_BUTTON.cross:
      code = 0x88;
      break;
    case CONTROLLER_BUTTON.moon:
      code = 0x89;
      break;
    case CONTROLLER_BUTTON.box:
      code = 0x8a;
      break;
    case CONTROLLER_BUTTON.pyramid:
      code = 0x8b;
      break;
    case CONTROLLER_BUTTON.dpad_left:
      code = 0x82;
      break;
    case CONTROLLER_BUTTON.dpad_right:
      code = 0x83;
      break;
    case CONTROLLER_BUTTON.dpad_up:
      code = 0x80;
      break;
    case CONTROLLER_BUTTON.dpad_down:
      code = 0x81;
      break;
    case CONTROLLER_BUTTON.l1:
      code = 0x84;
      break;
    case CONTROLLER_BUTTON.r1:
      code = 0x85;
      break;
    case CONTROLLER_ANALOG_BUTTON.l2:
      code = 0x86;
      break;
    case CONTROLLER_ANALOG_BUTTON.r2:
      code = 0x87;
      break;
    case CONTROLLER_BUTTON.l3:
      return Uint8Array.of(0x80, state ? 0xaf : 0x8f);
    case CONTROLLER_BUTTON.r3:
      return Uint8Array.of(0x80, state ? 0xb0 : 0x90);
    case CONTROLLER_BUTTON.options:
      return Uint8Array.of(0x80, state ? 0xac : 0x8c);
    case CONTROLLER_BUTTON.share:
      return Uint8Array.of(0x80, state ? 0xad : 0x8d);
    case CONTROLLER_BUTTON.touchpad:
      return Uint8Array.of(0x80, state ? 0xb1 : 0x91);
    case CONTROLLER_BUTTON.ps:
      return Uint8Array.of(0x80, state ? 0xae : 0x8e);
    default:
      return null;
  }
  return Uint8Array.of(0x80, code, state);
}

/**
 * chiaki_feedback_history_event_set_touchpad().
 * @param pointerId identifier of the touch, 0 to 127
 * @param x 12 bits. The reference documents 0 to 1920 (its GUI: 1920 for a PS4, 1919 for a PS5)
 * @param y 12 bits. The reference documents 0 to 942 (its GUI: 942 for a PS4, 1079 for a PS5)
 */
export function feedbackHistoryEventSetTouchpad(down: boolean, pointerId: number, x: number, y: number): FeedbackHistoryEvent {
  x &= 0xffff; // uint16_t parameters
  y &= 0xffff;
  return Uint8Array.of(
    down ? 0xd0 : 0xc0,
    pointerId & 0x7f,
    (x >> 4) & 0xff,
    (((x & 0xf) << 4) & 0xff) | ((y >> 8) & 0xff),
    y & 0xff,
  );
}

/** ChiakiFeedbackHistoryBuffer: a ring of the most recent events, newest first. */
export class FeedbackHistoryBuffer {
  events: Array<FeedbackHistoryEvent | undefined>;
  size: number;
  begin: number;
  /** How many events format() writes. The sender lowers it after each packet to limit what is repeated. */
  len: number;

  /** chiaki_feedback_history_buffer_init(). */
  constructor(size: number) {
    if (!Number.isInteger(size) || size <= 0) throw new RangeError('the history buffer needs a positive size');
    this.events = new Array<FeedbackHistoryEvent | undefined>(size);
    this.size = size;
    this.begin = 0;
    this.len = 0;
  }

  /** chiaki_feedback_history_buffer_push(): put an event at the front, dropping the oldest when full. */
  push(event: FeedbackHistoryEvent): void {
    this.begin = (this.begin + this.size - 1) % this.size;
    this.len++;
    if (this.len >= this.size) this.len = this.size;
    this.events[this.begin] = Uint8Array.from(event);
  }

  /**
   * chiaki_feedback_history_buffer_format(): the events one after the other, newest first.
   * @returns the bytes, or null when they do not fit into `maxSize` (CHIAKI_ERR_BUF_TOO_SMALL)
   */
  format(maxSize: number = Number.POSITIVE_INFINITY): Uint8Array | null {
    const parts: FeedbackHistoryEvent[] = [];
    let written = 0;
    for (let i = 0; i < this.len; i++) {
      const event = this.events[(this.begin + i) % this.size]!;
      if (written + event.length > maxSize) return null;
      parts.push(event);
      written += event.length;
    }
    const out = new Uint8Array(written);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  /**
   * chiaki_feedback_history_buffer_record_state(): push the events for the change from `prev` to `now`, in the order a
   * real controller produces them: button releases, then touch changes, then button presses, then the triggers.
   * `eventPushed` is called after each push: the console applies only one new event per history packet, so every event
   * needs a packet of its own.
   * @returns true if any event was pushed
   */
  recordState(prev: ControllerState, now: ControllerState, eventPushed?: () => void): boolean {
    let recorded = false;
    const push = (event: FeedbackHistoryEvent): void => {
      this.push(event);
      recorded = true;
      if (eventPushed) eventPushed();
    };

    const buttons = (pressed: boolean): void => {
      for (let i = 0; i < CONTROLLER_BUTTONS_COUNT; i++) {
        const buttonId = 1 << i;
        const was = (prev.buttons & buttonId) !== 0;
        const is = (now.buttons & buttonId) !== 0;
        if (was === is || is !== pressed) continue;
        const event = feedbackHistoryEventSetButton(buttonId, is ? 0xff : 0);
        if (event === null) continue; // cannot happen for the sixteen buttons; the reference logs and goes on
        push(event);
      }
    };

    const analog = (button: number, statePrev: number, stateNow: number): void => {
      if (statePrev === stateNow) return;
      const event = feedbackHistoryEventSetButton(button, stateNow);
      if (event === null) return;
      push(event);
    };

    // Releases go before touch changes: when a touchpad click and its finger are released
    // in one state change, the finger must not lift while the click is still held.
    buttons(false);

    for (let i = 0; i < CONTROLLER_TOUCHES_MAX; i++) {
      const tp = prev.touches[i]!;
      const tn = now.touches[i]!;
      if (tp.id !== tn.id && tp.id >= 0) {
        push(feedbackHistoryEventSetTouchpad(false, tp.id, tp.x, tp.y));
      } else if (tn.id >= 0 && (tp.id !== tn.id || tp.x !== tn.x || tp.y !== tn.y)) {
        push(feedbackHistoryEventSetTouchpad(true, tn.id, tn.x, tn.y));
      }
    }

    buttons(true);
    analog(CONTROLLER_ANALOG_BUTTON.l2, prev.l2State, now.l2State);
    analog(CONTROLLER_ANALOG_BUTTON.r2, prev.r2State, now.r2State);
    return recorded;
  }
}

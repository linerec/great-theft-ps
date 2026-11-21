// SPDX-License-Identifier: AGPL-3.0-only
//
// The controller state a Remote Play session reports to the console, and the conversion from this project's pad state.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/controller.c and
// lib/include/chiaki/controller.h (commit 43728af). The button bits, the touch id handling, the comparison and the
// union of two states are transcribed from there. See NOTICE.md.
//
// Not in the reference: controllerStateFromPad() (the reference fills the state from SDL events in its GUI, there is no
// float to integer conversion in the library), createIdleControllerState() and cloneControllerState() (C does both with
// a struct on the stack and an assignment). GYRO_* and ACCEL_* are the #defines of lib/src/feedback.c; they live here
// so that the pad conversion and feedback.ts share one definition without importing each other.
//
// STATUS: checked against tests written from the same reading of the C source (test/controller.test.ts), and through
// the reference's own feedback vectors, which build their states with these functions (test/feedback.test.ts). The
// reference has no test of its own for controller.c. It has NOT been run against a real console.

import type { VirtualPadState } from '../engine/types.ts';

/** ChiakiControllerButton. The same bit order as BUTTON in src/engine/types.ts (a test checks that). */
export const CONTROLLER_BUTTON = {
  cross: 1 << 0,
  moon: 1 << 1,
  box: 1 << 2,
  pyramid: 1 << 3,
  dpad_left: 1 << 4,
  dpad_right: 1 << 5,
  dpad_up: 1 << 6,
  dpad_down: 1 << 7,
  l1: 1 << 8,
  r1: 1 << 9,
  l3: 1 << 10,
  r3: 1 << 11,
  options: 1 << 12,
  share: 1 << 13,
  touchpad: 1 << 14,
  ps: 1 << 15,
} as const;

export const CONTROLLER_BUTTONS_COUNT = 16;

/**
 * ChiakiControllerAnalogButton. These are identifiers for history events only: they are never set in
 * ControllerState.buttons (the triggers travel as l2State / r2State) and must not overlap with CONTROLLER_BUTTON.
 */
export const CONTROLLER_ANALOG_BUTTON = {
  l2: 1 << 16,
  r2: 1 << 17,
} as const;

export const CONTROLLER_TOUCHES_MAX = 2;

/** Touch ids run from 0 to 127 and then start again (TOUCH_ID_MASK). */
const TOUCH_ID_MASK = 0x7f;

/** The range the feedback state can carry: GYRO_MIN / GYRO_MAX of lib/src/feedback.c (rad/s, see feedback.ts). */
export const GYRO_MIN = -30;
export const GYRO_MAX = 30;
/** ACCEL_MIN / ACCEL_MAX of lib/src/feedback.c (in g). */
export const ACCEL_MIN = -5;
export const ACCEL_MAX = 5;

/** ChiakiControllerTouch. */
export interface ControllerTouch {
  /** uint16_t. The reference GUI uses 0..1920 by 0..942 for a PS4 and 0..1919 by 0..1079 for a PS5. */
  x: number;
  y: number;
  /** int8_t: 0..127 while the finger is down, -1 when it is up. */
  id: number;
}

/** ChiakiControllerState. All fields are plain numbers; the comments give the C type they stand for. */
export interface ControllerState {
  /** uint32_t bitmask of CONTROLLER_BUTTON. */
  buttons: number;
  /** uint8_t, 0..255. */
  l2State: number;
  r2State: number;
  /** int16_t. +X is right, +Y is DOWN (the reference maps "stick up" to -0x7fff). */
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  /** uint8_t: the id the next touch gets. */
  touchIdNext: number;
  /** Always CONTROLLER_TOUCHES_MAX entries. */
  touches: ControllerTouch[];
  /** float. The reference GUI stores SDL's gyroscope reading unchanged: rad/s. */
  gyroX: number;
  gyroY: number;
  gyroZ: number;
  /** float. The reference GUI stores SDL's accelerometer reading divided by standard gravity: g. At rest (0, 1, 0). */
  accelX: number;
  accelY: number;
  accelZ: number;
  /** float. Orientation as a quaternion; at rest (0, 0, 0, 1). */
  orientX: number;
  orientY: number;
  orientZ: number;
  orientW: number;
}

/** chiaki_controller_state_set_idle(). */
export function controllerStateSetIdle(state: ControllerState): void {
  state.buttons = 0;
  state.l2State = 0;
  state.r2State = 0;
  state.leftX = 0;
  state.leftY = 0;
  state.rightX = 0;
  state.rightY = 0;
  state.touchIdNext = 0;
  if (!Array.isArray(state.touches) || state.touches.length !== CONTROLLER_TOUCHES_MAX) {
    state.touches = [];
    for (let i = 0; i < CONTROLLER_TOUCHES_MAX; i++) state.touches.push({ x: 0, y: 0, id: -1 });
  }
  for (const touch of state.touches) {
    touch.id = -1;
    touch.x = 0;
    touch.y = 0;
  }
  state.gyroX = 0;
  state.gyroY = 0;
  state.gyroZ = 0;
  state.accelX = 0;
  state.accelY = 1;
  state.accelZ = 0;
  state.orientX = 0;
  state.orientY = 0;
  state.orientZ = 0;
  state.orientW = 1;
}

/** A new state with nothing pressed (a ChiakiControllerState on the stack followed by set_idle). */
export function createIdleControllerState(): ControllerState {
  const state = {} as ControllerState;
  controllerStateSetIdle(state);
  return state;
}

/** A deep copy (the C code assigns the struct, which copies the touches with it). */
export function cloneControllerState(state: ControllerState): ControllerState {
  return { ...state, touches: state.touches.map((t) => ({ x: t.x, y: t.y, id: t.id })) };
}

/**
 * chiaki_controller_state_start_touch().
 * @returns the id of the new touch (0..127), or -1 when both slots are taken.
 */
export function controllerStateStartTouch(state: ControllerState, x: number, y: number): number {
  for (let i = 0; i < CONTROLLER_TOUCHES_MAX; i++) {
    const touch = state.touches[i]!;
    if (touch.id < 0) {
      touch.id = state.touchIdNext;
      state.touchIdNext = (state.touchIdNext + 1) & TOUCH_ID_MASK;
      touch.x = x & 0xffff; // uint16_t parameters
      touch.y = y & 0xffff;
      return touch.id;
    }
  }
  return -1;
}

/** chiaki_controller_state_stop_touch(). Unlike set_touch_pos the reference does not mask the id here. */
export function controllerStateStopTouch(state: ControllerState, id: number): void {
  id &= 0xff; // uint8_t parameter: it can never equal the -1 of a free slot
  for (let i = 0; i < CONTROLLER_TOUCHES_MAX; i++) {
    const touch = state.touches[i]!;
    if (touch.id === id) {
      touch.id = -1;
      break;
    }
  }
}

/** chiaki_controller_state_set_touch_pos(). */
export function controllerStateSetTouchPos(state: ControllerState, id: number, x: number, y: number): void {
  id &= TOUCH_ID_MASK;
  for (let i = 0; i < CONTROLLER_TOUCHES_MAX; i++) {
    const touch = state.touches[i]!;
    if (touch.id === id) {
      touch.x = x & 0xffff;
      touch.y = y & 0xffff;
      break;
    }
  }
}

const f32 = Math.fround;
/** The tolerance of the reference's CHECKF / SETCHOOSER macros, as the single precision constant 0.0000001f. */
const FLOAT_TOLERANCE = f32(0.0000001);

/** `a < b - 0.0000001f || a > b + 0.0000001f`, evaluated in single precision as the C code does. */
function floatDiffers(a: number, b: number): boolean {
  const fa = f32(a);
  const fb = f32(b);
  return fa < f32(fb - FLOAT_TOLERANCE) || fa > f32(fb + FLOAT_TOLERANCE);
}

/**
 * The CHECKF block shared by chiaki_controller_state_equals() and feedbacksender.c's
 * controller_state_equals_for_feedback_state(): gyro, accelerometer and orientation equal within the tolerance.
 */
export function controllerMotionEquals(a: ControllerState, b: ControllerState): boolean {
  return !(
    floatDiffers(a.gyroX, b.gyroX) || floatDiffers(a.gyroY, b.gyroY) || floatDiffers(a.gyroZ, b.gyroZ)
    || floatDiffers(a.accelX, b.accelX) || floatDiffers(a.accelY, b.accelY) || floatDiffers(a.accelZ, b.accelZ)
    || floatDiffers(a.orientX, b.orientX) || floatDiffers(a.orientY, b.orientY) || floatDiffers(a.orientZ, b.orientZ)
    || floatDiffers(a.orientW, b.orientW)
  );
}

/** chiaki_controller_state_equals(). touchIdNext is not compared, and neither is the position of a lifted touch. */
export function controllerStateEquals(a: ControllerState, b: ControllerState): boolean {
  if (!(a.buttons === b.buttons
    && a.l2State === b.l2State
    && a.r2State === b.r2State
    && a.leftX === b.leftX
    && a.leftY === b.leftY
    && a.rightX === b.rightX
    && a.rightY === b.rightY)) return false;

  for (let i = 0; i < CONTROLLER_TOUCHES_MAX; i++) {
    const ta = a.touches[i]!;
    const tb = b.touches[i]!;
    if (ta.id !== tb.id) return false;
    if (ta.id >= 0 && (ta.x !== tb.x || ta.y !== tb.y)) return false;
  }

  return controllerMotionEquals(a, b);
}

/** MAX_ABS of controller.c: the first value when its magnitude is strictly larger, otherwise the second. */
const maxAbs = (a: number, b: number): number => (Math.abs(a) > Math.abs(b) ? a : b);

/**
 * chiaki_controller_state_or(): the union of two states. `out` may be `a` or `b`.
 * Motion is not mixed: when `a` reports any gyro or accelerometer value away from rest, all of its motion fields are
 * taken, otherwise all of `b`'s.
 */
export function controllerStateOr(out: ControllerState, a: ControllerState, b: ControllerState): void {
  out.buttons = (a.buttons | b.buttons) >>> 0;
  out.l2State = Math.max(a.l2State, b.l2State);
  out.r2State = Math.max(a.r2State, b.r2State);
  out.leftX = maxAbs(a.leftX, b.leftX);
  out.leftY = maxAbs(a.leftY, b.leftY);
  out.rightX = maxAbs(a.rightX, b.rightX);
  out.rightY = maxAbs(a.rightY, b.rightY);

  out.touchIdNext = 0;
  for (let i = 0; i < CONTROLLER_TOUCHES_MAX; i++) {
    const touch = a.touches[i]!.id >= 0 ? a.touches[i]! : (b.touches[i]!.id >= 0 ? b.touches[i]! : null);
    const target = out.touches[i]!;
    if (touch === null) {
      target.id = -1;
      target.x = 0;
      target.y = 0;
      continue;
    }
    if (touch !== target) {
      target.x = touch.x;
      target.y = touch.y;
      target.id = touch.id;
    }
  }

  const chooser = floatDiffers(a.gyroX, 0) || floatDiffers(a.gyroY, 0) || floatDiffers(a.gyroZ, 0)
    || floatDiffers(a.accelX, 0) || floatDiffers(a.accelY, 1) || floatDiffers(a.accelZ, 0);
  const src = chooser ? a : b;
  out.gyroX = src.gyroX;
  out.gyroY = src.gyroY;
  out.gyroZ = src.gyroZ;
  out.accelX = src.accelX;
  out.accelY = src.accelY;
  out.accelZ = src.accelZ;
  out.orientX = src.orientX;
  out.orientY = src.orientY;
  out.orientZ = src.orientZ;
  out.orientW = src.orientW;
}

/** All sixteen digital buttons. Anything above (the analog ids, stray bits) is not a button of the state. */
const BUTTONS_MASK = (1 << CONTROLLER_BUTTONS_COUNT) - 1;
/** Full deflection. The reference's keyboard mapping uses the same symmetric value (+-0x7fff). */
const STICK_MAX = 0x7fff;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** -1..1 to int16_t, saturating, rounded the same way on both sides of the centre. `| 0` also turns -0 into 0. */
const stickToInt16 = (v: number): number => {
  const c = clamp(finiteOr(v, 0), -1, 1);
  const magnitude = Math.round(Math.abs(c) * STICK_MAX);
  return (c < 0 ? -magnitude : magnitude) | 0;
};
const triggerToUint8 = (v: number): number => Math.round(clamp(finiteOr(v, 0), 0, 0xff)) | 0;

/**
 * Convert this project's pad state (src/engine/types.ts) to the state the console protocol uses. Not in the reference.
 *
 * - buttons: the mask is taken as it is (same bit order), limited to the sixteen buttons.
 * - triggers: 0..255, rounded and saturated.
 * - sticks: -1..1 to -32767..32767, rounded and saturated. No sign change: +Y is down on both sides.
 * - gyro (rad/s) and accelerometer (g): unchanged, limited to the range the feedback state can carry (+-30 and +-5).
 *   The reference does not limit them: its 16 bit cast is undefined for values outside the range.
 * - orientation: unchanged. A quaternion that is not finite or has no length becomes the rest orientation (0, 0, 0, 1).
 * - anything that is not a finite number becomes the rest value.
 *
 * VirtualPadState has no touch points, so the touches and touchIdNext of `out` are left alone: pass the same state
 * every time and manage its touches with the touch functions above, or pass nothing to get a state without touches.
 */
export function controllerStateFromPad(pad: VirtualPadState, out: ControllerState = createIdleControllerState()): ControllerState {
  out.buttons = pad.buttons & BUTTONS_MASK;
  out.l2State = triggerToUint8(pad.l2);
  out.r2State = triggerToUint8(pad.r2);
  out.leftX = stickToInt16(pad.leftX);
  out.leftY = stickToInt16(pad.leftY);
  out.rightX = stickToInt16(pad.rightX);
  out.rightY = stickToInt16(pad.rightY);

  out.gyroX = clamp(finiteOr(pad.gyro.x, 0), GYRO_MIN, GYRO_MAX);
  out.gyroY = clamp(finiteOr(pad.gyro.y, 0), GYRO_MIN, GYRO_MAX);
  out.gyroZ = clamp(finiteOr(pad.gyro.z, 0), GYRO_MIN, GYRO_MAX);
  out.accelX = clamp(finiteOr(pad.accel.x, 0), ACCEL_MIN, ACCEL_MAX);
  out.accelY = clamp(finiteOr(pad.accel.y, 1), ACCEL_MIN, ACCEL_MAX);
  out.accelZ = clamp(finiteOr(pad.accel.z, 0), ACCEL_MIN, ACCEL_MAX);

  const { x, y, z, w } = pad.orient;
  const norm = x * x + y * y + z * z + w * w;
  if (Number.isFinite(norm) && norm > 0) {
    out.orientX = x;
    out.orientY = y;
    out.orientZ = z;
    out.orientW = w;
  } else {
    out.orientX = 0;
    out.orientY = 0;
    out.orientZ = 0;
    out.orientW = 1;
  }
  return out;
}

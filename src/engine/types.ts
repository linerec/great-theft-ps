// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared types for the mapping engine. Everything here is plain data so the same
// engine runs unchanged in a browser, in Node and in a desktop shell.

/**
 * Button bit positions. They intentionally match the order used by the
 * console-facing library (ChiakiControllerButton, lib/include/chiaki/controller.h)
 * so the bridge can forward the mask as-is. Verify again in milestone M2.
 */
export const BUTTON = {
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

export type ButtonName = keyof typeof BUTTON;
export const BUTTON_NAMES = Object.keys(BUTTON) as ButtonName[];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Virtual DualSense state produced by the engine, one per tick.
 *
 * Stick axes are -1..1 with +Y pointing DOWN (SDL convention; verify in M2).
 * Triggers are 0..255. Gyro is rad/s, accel is in g, orient is a unit quaternion.
 */
export interface VirtualPadState {
  buttons: number;
  l2: number;
  r2: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  gyro: Vec3;
  accel: Vec3;
  orient: Quat;
}

/**
 * The console-facing library clamps gyro to +-30 before 16-bit quantisation
 * (lib/src/feedback.c, GYRO_MIN/GYRO_MAX). Values beyond that are lost.
 */
export const GYRO_LIMIT_RAD_S = 30;

export function emptyPadState(): VirtualPadState {
  return {
    buttons: 0,
    l2: 0,
    r2: 0,
    leftX: 0,
    leftY: 0,
    rightX: 0,
    rightY: 0,
    gyro: { x: 0, y: 0, z: 0 },
    accel: { x: 0, y: 1, z: 0 },
    orient: { x: 0, y: 0, z: 0, w: 1 },
  };
}

/** What the mouse-look stage reports each tick, for the tester UI and tests. */
export interface LookDiagnostics {
  /** Turn rate after curve and caps, in degrees per second (+X right, +Y down). */
  rateX: number;
  rateY: number;
  /** True when a cap (max turn rate, max deflection, stick saturation, gyro limit) limited the output. */
  capped: boolean;
}

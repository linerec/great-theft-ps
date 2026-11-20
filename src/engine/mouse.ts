// SPDX-License-Identifier: AGPL-3.0-only
//
// Mouse look. Three stages, each small and testable on its own:
//   1. LookFilter   mouse counts -> desired camera turn rate (deg/s), with smoothing,
//                   response curve and a hard speed limit.
//   2. rateToStick  turn rate -> stick deflection through the INVERSE of the per-game
//                   calibration table, so the same mouse movement turns the camera by the
//                   same angle in every game. Optional deflection cap.
//   2'. VirtualGyro turn rate -> virtual gyro (rad/s) plus a consistent orientation and
//                   gravity vector, for games with gyro aiming. No stick ceiling.

import { stickFor, type CalPoint } from './calibration.ts';
import type { MouseConfig } from './profile.ts';
import { GYRO_LIMIT_RAD_S, type Quat, type Vec3 } from './types.ts';

/** Below this turn rate (deg/s) the smoothed rate snaps to zero so the stick returns to centre. */
const RATE_EPSILON = 0.05;

export interface LookStep {
  /** Turn rate after smoothing, curve and speed limit, deg/s (+X right, +Y down). */
  rateX: number;
  rateY: number;
  /** True when the speed limit clipped the requested rate. */
  capped: boolean;
}

export class LookFilter {
  #sx = 0;
  #sy = 0;

  reset(): void {
    this.#sx = 0;
    this.#sy = 0;
  }

  /** `dx`/`dy` are mouse counts accumulated over `dt` seconds. Call every tick, also with zeros, so smoothing decays. */
  step(cfg: MouseConfig, dx: number, dy: number, dt: number): LookStep {
    const perSecond = cfg.degPerCount / dt;
    const wantX = dx * perSecond;
    const wantY = (cfg.invertY ? -dy : dy) * perSecond * cfg.verticalScale;

    const alpha = cfg.smoothingMs <= 0 ? 1 : 1 - Math.exp(-(dt * 1000) / cfg.smoothingMs);
    this.#sx += (wantX - this.#sx) * alpha;
    this.#sy += (wantY - this.#sy) * alpha;

    let magnitude = Math.hypot(this.#sx, this.#sy);
    if (magnitude < RATE_EPSILON) {
      this.#sx = 0;
      this.#sy = 0;
      magnitude = 0;
    }
    if (magnitude === 0) return { rateX: 0, rateY: 0, capped: false };

    const shaped = cfg.maxTurnRate * Math.pow(magnitude / cfg.maxTurnRate, cfg.curve);
    const limited = Math.min(shaped, cfg.maxTurnRate);
    const scale = limited / magnitude;
    return { rateX: this.#sx * scale, rateY: this.#sy * scale, capped: shaped > cfg.maxTurnRate };
  }
}

/** What the engine knows about how the game turns stick into camera rotation. */
export interface StickModel {
  /** radial: the deadzone and curve act on the stick vector's length. axial: per axis. */
  shape: 'radial' | 'axial';
  /** Vertical turn rate relative to horizontal at the same stick value. */
  verticalRatio: number;
  /** Stick -> horizontal turn rate. For radial games this is the only table that is used. */
  horizontal: CalPoint[];
  /** Stick -> vertical turn rate. Axial games only. */
  vertical: CalPoint[];
}

export interface StickResult {
  x: number;
  y: number;
  capped: boolean;
}

/** Convert a desired turn rate into stick deflection using the inverse calibration. */
export function rateToStick(rateX: number, rateY: number, cfg: MouseConfig, model: StickModel): StickResult {
  let x: number;
  let y: number;
  let capped: boolean;

  if (model.shape === 'radial') {
    // The game turns the stick VECTOR into a camera rate: direction from the vector, speed from its
    // length. So invert once on the length of the desired rate (vertical normalised to horizontal),
    // then keep the direction. Inverting each axis separately would overshoot on diagonals.
    const ux = rateX;
    const uy = rateY / model.verticalRatio;
    const r = Math.hypot(ux, uy);
    if (r === 0) return { x: 0, y: 0, capped: false };
    const { stick, saturated } = stickFor(model.horizontal, r);
    x = (stick * ux) / r;
    y = (stick * uy) / r;
    capped = saturated;
  } else {
    const ax = stickFor(model.horizontal, Math.abs(rateX));
    const ay = stickFor(model.vertical, Math.abs(rateY));
    x = Math.sign(rateX) * ax.stick;
    y = Math.sign(rateY) * ay.stick;
    capped = ax.saturated || ay.saturated;
  }

  const limit = Math.min(1, cfg.maxDeflection);
  const magnitude = Math.hypot(x, y);
  if (magnitude > limit) {
    x *= limit / magnitude;
    y *= limit / magnitude;
    capped = true;
  }
  return { x, y, capped };
}

export interface GyroResult {
  gyro: Vec3;
  accel: Vec3;
  orient: Quat;
  capped: boolean;
}

function multiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function normalize(q: Quat): Quat {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

/** Rotate `v` by the inverse of unit quaternion `q` (world vector into the sensor frame). */
function rotateByInverse(q: Quat, v: Vec3): Vec3 {
  const ux = -q.x;
  const uy = -q.y;
  const uz = -q.z;
  // v + 2w(u x v) + 2 u x (u x v)
  const cx = uy * v.z - uz * v.y;
  const cy = uz * v.x - ux * v.z;
  const cz = ux * v.y - uy * v.x;
  const dx = uy * cz - uz * cy;
  const dy = uz * cx - ux * cz;
  const dz = ux * cy - uy * cx;
  return { x: v.x + 2 * (q.w * cx + dx), y: v.y + 2 * (q.w * cy + dy), z: v.z + 2 * (q.w * cz + dz) };
}

export class VirtualGyro {
  #q: Quat = { x: 0, y: 0, z: 0, w: 1 };

  reset(): void {
    this.#q = { x: 0, y: 0, z: 0, w: 1 };
  }

  /**
   * `rateX`/`rateY` are the filtered camera turn rates in deg/s. `accelRest` is the gravity vector (in g)
   * the controller reports while held still; it is rotated along with the virtual orientation.
   * The exact gyro axes, signs and rest vector must be verified against a real console (M2).
   */
  step(cfg: MouseConfig, rateX: number, rateY: number, dt: number, accelRest: Vec3): GyroResult {
    const g = cfg.gyro;
    const toRad = (Math.PI / 180) * g.gain;
    const limit = Math.min(g.maxRadPerSec, GYRO_LIMIT_RAD_S);
    let capped = false;

    let yaw = rateX * toRad * g.yawSign;
    let pitch = rateY * toRad * g.pitchSign;
    if (Math.abs(yaw) > limit) {
      yaw = Math.sign(yaw) * limit;
      capped = true;
    }
    if (Math.abs(pitch) > limit) {
      pitch = Math.sign(pitch) * limit;
      capped = true;
    }

    const gyro: Vec3 = { x: 0, y: 0, z: 0 };
    gyro[g.yawAxis] = yaw;
    gyro[g.pitchAxis] = pitch;

    const speed = Math.hypot(gyro.x, gyro.y, gyro.z);
    if (speed > 0) {
      const half = (speed * dt) / 2;
      const s = Math.sin(half) / speed;
      this.#q = normalize(multiply(this.#q, { x: gyro.x * s, y: gyro.y * s, z: gyro.z * s, w: Math.cos(half) }));
    }
    return { gyro, accel: rotateByInverse(this.#q, accelRest), orient: { ...this.#q }, capped };
  }
}

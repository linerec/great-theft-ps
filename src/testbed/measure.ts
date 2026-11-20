// SPDX-License-Identifier: AGPL-3.0-only
//
// Black-box calibration. Given only the ability to feed pad input to a game and
// watch the camera turn, measure what the game does with the stick:
// stick deflection -> turn rate. This is the same procedure a person would follow
// with a real game (hold the stick, time a turn), automated against the test beds.

import type { CalPoint } from '../engine/calibration.ts';
import type { Profile } from '../engine/profile.ts';
import { emptyPadState } from '../engine/types.ts';
import { FpsGame, type GameSettings } from './fps.ts';

/** The only things calibration needs from a game: feed it pad input, read the camera angles. */
export interface LookGame {
  update(pad: ReturnType<typeof emptyPadState>, dt: number): void;
  /** Total horizontal camera turn since the game was created, unwrapped, degrees (positive = right). */
  readonly yawTotal: number;
  /** Vertical camera angle, degrees (positive = up). */
  readonly pitch: number;
}

/** Creates a fresh game in its starting state. */
export type GameFactory = () => LookGame;

const DT = 0.004;
const SAMPLE_SECONDS = 0.1; // short enough that vertical measurements stay inside the pitch limit
const STEPS = 24;

/** Turn rates (deg/s) the game produces for a held stick. `down` is positive when looking down. */
export function measureLook(make: GameFactory, stickX: number, stickY: number, l2 = 0): { yaw: number; down: number } {
  const game = make();
  const pad = emptyPadState();
  pad.rightX = stickX;
  pad.rightY = stickY;
  pad.l2 = l2;
  const y0 = game.yawTotal;
  const p0 = game.pitch;
  const ticks = Math.round(SAMPLE_SECONDS / DT);
  for (let i = 0; i < ticks; i++) game.update(pad, DT);
  return { yaw: (game.yawTotal - y0) / SAMPLE_SECONDS, down: -(game.pitch - p0) / SAMPLE_SECONDS };
}

export interface MeasuredCalibration {
  /** Stick -> horizontal turn rate table, in the format the mapping profile stores. */
  horizontal: CalPoint[];
  /** Vertical turn rate relative to horizontal. */
  verticalRateRatio: number;
  deadzoneShape: 'radial' | 'axial';
  /** Turn rate at full horizontal stick. */
  fullStickRate: number;
  /** Look speed with the left trigger held (aiming) relative to normal. */
  aimLookScale: number;
}

/** Store a measurement in a mapping profile. */
export function applyMeasuredCalibration(profile: Profile, m: MeasuredCalibration): void {
  profile.calibration.horizontal = m.horizontal;
  profile.calibration.vertical = null;
  profile.inGame.verticalRateRatio = m.verticalRateRatio;
  profile.inGame.deadzoneShape = m.deadzoneShape;
  profile.inGame.maxTurnRateAtFullStick = Math.round(m.fullStickRate);
  const aim = profile.layers.find((l) => l.name === 'aim');
  if (aim) aim.lookScale = Math.min(4, Math.max(0.1, Math.round(m.aimLookScale * 1000) / 1000));
}

export function measureCalibration(game: GameSettings | GameFactory): MeasuredCalibration {
  const make: GameFactory = typeof game === 'function' ? game : () => new FpsGame({ ...game });
  const horizontalRate = (s: number): number => measureLook(make, s, 0).yaw;

  // Coarse sweep, forced monotonic so measurement noise can never produce an invalid table.
  const rates: number[] = [];
  for (let i = 0; i <= STEPS; i++) rates.push(Math.max(i === 0 ? 0 : rates[i - 1]!, horizontalRate(i / STEPS)));

  // Find the edge of the deadzone precisely: the smallest stick value that turns the camera.
  const eps = 1e-6;
  const firstMoving = rates.findIndex((r) => r > eps);
  const points: CalPoint[] = [[0, 0]];
  if (firstMoving > 0) {
    let lo = (firstMoving - 1) / STEPS;
    let hi = firstMoving / STEPS;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (horizontalRate(mid) > eps) hi = mid;
      else lo = mid;
    }
    if (hi > 1e-4) points.push([hi, 0]);
  }
  for (let i = 1; i <= STEPS; i++) {
    const stick = i / STEPS;
    const last = points[points.length - 1]!;
    if (rates[i]! > eps && stick > last[0]) points.push([stick, rates[i]!]);
  }
  if (points[points.length - 1]![0] !== 1) points.push([1, rates[STEPS]!]);

  const fullStickRate = rates[STEPS]!;
  const verticalRateRatio = fullStickRate > 0 ? measureLook(make, 0, 1).down / fullStickRate : 1;

  // Shape: does the game apply its deadzone to the stick vector (radial) or per axis?
  // Compare a diagonal push with what each hypothesis predicts from the horizontal table.
  const probe = 0.5;
  const measured = measureLook(make, probe, probe).yaw;
  const rateAt = (s: number): number => {
    for (let i = 0; i < points.length - 1; i++) {
      const [s0, r0] = points[i]!;
      const [s1, r1] = points[i + 1]!;
      if (s <= s1) return r0 + ((s - s0) / (s1 - s0)) * (r1 - r0);
    }
    return points[points.length - 1]![1];
  };
  const axialGuess = rateAt(probe);
  const radialGuess = rateAt(Math.hypot(probe, probe)) * Math.SQRT1_2;
  const deadzoneShape = Math.abs(measured - axialGuess) < Math.abs(measured - radialGuess) * 0.5 ? 'axial' : 'radial';

  // Aiming: same stick, left trigger held. The ratio is what the mapping needs for its aim layer.
  const normal = measureLook(make, 0.6, 0).yaw;
  const aiming = measureLook(make, 0.6, 0, 255).yaw;
  const aimLookScale = normal > 0 ? aiming / normal : 1;

  return { horizontal: points, verticalRateRatio, deadzoneShape, fullStickRate, aimLookScale };
}

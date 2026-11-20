// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-game stick calibration: a monotonic table from raw stick deflection (0..1)
// to the turn rate the game actually produces (degrees per second). The engine
// uses the inverse of this table, so "mouse moved N counts" can become a stick
// value that turns the camera by the same angle in every game.

/** [stick deflection 0..1, turn rate in deg/s] */
export type CalPoint = [number, number];

export function validateCalibration(points: unknown, path: string): string[] {
  const errors: string[] = [];
  if (!Array.isArray(points)) return [`${path}: must be an array of [stick, turnRate] points`];
  if (points.length < 2 || points.length > 32) errors.push(`${path}: needs 2 to 32 points`);

  let prevStick = -Infinity;
  let prevRate = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p: unknown = points[i];
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      errors.push(`${path}[${i}]: must be two finite numbers [stick, turnRate]`);
      continue;
    }
    const stick = p[0] as number;
    const rate = p[1] as number;
    if (stick < 0 || stick > 1) errors.push(`${path}[${i}]: stick must be within 0..1`);
    if (rate < 0 || rate > 10000) errors.push(`${path}[${i}]: turnRate must be within 0..10000 deg/s`);
    if (i === 0 && (stick !== 0 || rate !== 0)) errors.push(`${path}[0]: the first point must be [0, 0]`);
    if (stick <= prevStick) errors.push(`${path}[${i}]: stick values must strictly increase`);
    if (rate < prevRate) errors.push(`${path}[${i}]: turn rates must not decrease`);
    prevStick = stick;
    prevRate = rate;
  }
  const last: unknown = points[points.length - 1];
  if (Array.isArray(last) && last[0] !== 1) errors.push(`${path}: the last point must have stick = 1`);
  return errors;
}

/**
 * Linear model used until the user measures a real table: nothing happens
 * inside the game's inner deadzone, then the turn rate rises linearly to the
 * rate at full deflection.
 */
export function linearModel(innerDeadzone: number, maxRateAtFullStick: number): CalPoint[] {
  if (innerDeadzone <= 0) return [[0, 0], [1, maxRateAtFullStick]];
  return [[0, 0], [innerDeadzone, 0], [1, maxRateAtFullStick]];
}

/**
 * Table for a game that publishes its deadzone, full-stick rate and response curve
 * (rate = max * ((stick - deadzone) / (1 - deadzone)) ^ curve). curve = 1 is linear.
 */
export function modelTable(innerDeadzone: number, maxRateAtFullStick: number, curve: number): CalPoint[] {
  if (curve === 1) return linearModel(innerDeadzone, maxRateAtFullStick);
  const points: CalPoint[] = [[0, 0]];
  if (innerDeadzone > 0) points.push([innerDeadzone, 0]);
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    const stick = i === steps ? 1 : innerDeadzone + ((1 - innerDeadzone) * i) / steps;
    points.push([stick, maxRateAtFullStick * Math.pow(i / steps, curve)]);
  }
  return points;
}

/** Turn rate (deg/s) the game produces at a given raw stick deflection. */
export function rateAt(points: CalPoint[], stick: number): number {
  const s = Math.min(1, Math.max(0, stick));
  for (let i = 0; i < points.length - 1; i++) {
    const [s0, r0] = points[i]!;
    const [s1, r1] = points[i + 1]!;
    if (s <= s1) return s1 === s0 ? r1 : r0 + ((s - s0) / (s1 - s0)) * (r1 - r0);
  }
  return points[points.length - 1]![1];
}

/**
 * Smallest stick deflection that produces at least `rate` deg/s.
 * A flat start (the inner deadzone) is jumped over, so the first non-zero
 * output already clears the deadzone. `saturated` is true when the table
 * cannot reach the requested rate at all.
 */
export function stickFor(points: CalPoint[], rate: number): { stick: number; saturated: boolean } {
  if (!(rate > 0)) return { stick: 0, saturated: false };
  for (let i = 0; i < points.length - 1; i++) {
    const [s0, r0] = points[i]!;
    const [s1, r1] = points[i + 1]!;
    if (r1 > r0 && rate <= r1 && rate > r0) {
      return { stick: s0 + ((rate - r0) / (r1 - r0)) * (s1 - s0), saturated: false };
    }
  }
  return { stick: points[points.length - 1]![0], saturated: true };
}

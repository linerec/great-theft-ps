// SPDX-License-Identifier: AGPL-3.0-only
//
// How the mouse feels, in terms a person can try one after another while playing: a few starting points, a step for the
// sensitivity that can be pressed during the game, and the rule that keeps a mouse movement from being counted twice.
// The translation itself (counts to stick) is in src/engine/mouse.ts; this file only picks values for it.

/** The mouse settings of the profile that these controls change. */
export interface Feel {
  /** Degrees of camera rotation per mouse count. */
  degPerCount: number;
  /** Time constant of the low-pass filter, ms. */
  smoothingMs: number;
  /** How long the camera may go on turning after the hand stopped, to pay what the speed limit held back, ms. */
  carryMs: number;
  /** 1 = linear. */
  curve: number;
}

export interface FeelPreset {
  id: 'sharp' | 'balanced' | 'smooth';
  name: string;
  hint: string;
  /** The values it sets (the sensitivity stays what the person chose). */
  set: Pick<Feel, 'smoothingMs' | 'carryMs' | 'curve'>;
}

/**
 * Starting points to compare, not measured optima. They differ in the low-pass filter only, because that is what sets the
 * delay and the wobble (tools/research/feel-sim.mjs, in the engine alone: filter 0 ms starts at once and stops at once but
 * the stick wobbles about 9 % at a slow pan; 5 ms starts in 8 ms, slides 36 ms after the hand stops, 4 % wobble; 12 ms,
 * the profile's old value, starts in 24 ms, slides 92 ms, 2 % wobble). The carry-over stays at 300 ms in all three: it
 * only acts on a swipe faster than the game can turn, where less of it turns the camera a fraction of the way.
 */
export const FEEL_PRESETS: readonly FeelPreset[] = [
  { id: 'sharp', name: '또렷하게', hint: '가장 빠르게 반응합니다. 아주 천천히 움직일 때 시점이 조금 떨릴 수 있습니다.', set: { smoothingMs: 0, carryMs: 300, curve: 1 } },
  { id: 'balanced', name: '균형', hint: '반응이 빠르고 떨림은 적은 중간입니다.', set: { smoothingMs: 5, carryMs: 300, curve: 1 } },
  { id: 'smooth', name: '부드럽게', hint: '기본값. 떨림이 가장 적지만, 손을 멈춘 뒤에도 0.1초쯤 더 돕니다.', set: { smoothingMs: 12, carryMs: 300, curve: 1 } },
];

/** The preset these values are, or null when they have been changed by hand. */
export function presetOf(f: Pick<Feel, 'smoothingMs' | 'carryMs' | 'curve'>): FeelPreset['id'] | null {
  const hit = FEEL_PRESETS.find((p) => p.set.smoothingMs === f.smoothingMs && p.set.carryMs === f.carryMs && p.set.curve === f.curve);
  return hit ? hit.id : null;
}

export const SENSITIVITY_MIN = 0.005;
export const SENSITIVITY_MAX = 0.3;

/**
 * One step of the sensitivity: 6 % up or down, which is small enough to find a setting and large enough to feel after
 * one press. It is a ratio, so the same step is as noticeable at 0.02 as at 0.2. Held within the range of the slider.
 */
export function stepSensitivity(current: number, direction: 1 | -1): number {
  const next = current * (direction === 1 ? 1.06 : 1 / 1.06);
  const clamped = Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, next));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * A mouse movement reaches the page twice: at once as a raw update, and about a frame later, summed, as an ordinary
 * move. The raw one is first by up to a frame, so it is used whenever the browser sends it; the ordinary one only
 * counts when no raw update came lately (a browser without them, or a page that is not allowed them).
 */
export class RawMouseGate {
  #rawAt = -Infinity;
  readonly quietMs: number;

  constructor(quietMs = 120) {
    this.quietMs = quietMs;
  }

  /** A raw update arrived. */
  raw(now: number): void {
    this.#rawAt = now;
  }

  /** Should an ordinary move at `now` be counted? */
  ordinary(now: number): boolean {
    return now - this.#rawAt >= this.quietMs;
  }

  /** Forget what was seen (the mouse was let go and taken again). */
  reset(): void {
    this.#rawAt = -Infinity;
  }
}

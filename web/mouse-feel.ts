// SPDX-License-Identifier: AGPL-3.0-only
//
// How the mouse feels, in terms a person can try one after another while playing: a few starting points, a step for the
// sensitivity that can be pressed during the game, and the rule that keeps a mouse movement from being counted twice.
// The translation itself (counts to stick) is in src/engine/mouse.ts; this file only picks values for it.

import type { Feel } from '../src/engine/feel-study.ts';
import { N_ } from '../src/i18n/index.ts';

/** The mouse settings of the profile that these controls change (defined with the study of the feel, which records them). */
export type { Feel };

export interface FeelPreset {
  id: 'sharp' | 'balanced' | 'smooth';
  /** A sentence to be shown through t() (the table is kept, the language can change). */
  name: string;
  hint: string;
  /** The values it sets (the sensitivity stays what the person chose). */
  set: Pick<Feel, 'smoothingMs' | 'smoothingFadeRate' | 'carryMs' | 'curve'>;
}

/**
 * Starting points to compare, not measured optima. They differ in the low-pass filter only, because that is what sets the
 * delay and the evenness (tools/research/feel-sim.mjs, in the engine alone, against a game that is what the profile says):
 *  - "sharp", no filter: no delay at all, but a slow pan reaches the game as ones and zeros (the angle per frame spreads
 *    18 % at 3 deg/s);
 *  - "smooth", 12 ms at every speed, the profile's old value: the slow pan is even (7 %), but a turn starts 24 ms late and
 *    runs 92 ms on after the hand stops;
 *  - "balanced", 12 ms that fades out between 20 and 40 deg/s: as even as "smooth" at the slow pan (7 %) and no delay and
 *    no run-on for a real turn.
 * The carry-over stays at 300 ms in all three: it only acts on a swipe faster than the game can turn.
 */
export const FEEL_PRESETS: readonly FeelPreset[] = [
  { id: 'sharp', name: N_('Crisp'), hint: N_('No delay at all. The view may tremble a little when you move very slowly.'), set: { smoothingMs: 0, smoothingFadeRate: 0, carryMs: 300, curve: 1 } },
  { id: 'balanced', name: N_('Balanced'), hint: N_('Smooth when you move slowly, no delay when you turn. Try this one first.'), set: { smoothingMs: 12, smoothingFadeRate: 40, carryMs: 300, curve: 1 } },
  { id: 'smooth', name: N_('Smooth'), hint: N_('The old default. Always smooth, but it starts a little late when you begin to turn and runs on for about 0.1 s after your hand stops.'), set: { smoothingMs: 12, smoothingFadeRate: 0, carryMs: 300, curve: 1 } },
];

/** The preset these values are, or null when they have been changed by hand. */
export function presetOf(f: Pick<Feel, 'smoothingMs' | 'smoothingFadeRate' | 'carryMs' | 'curve'>): FeelPreset['id'] | null {
  const hit = FEEL_PRESETS.find((p) => p.set.smoothingMs === f.smoothingMs && p.set.smoothingFadeRate === f.smoothingFadeRate && p.set.carryMs === f.carryMs && p.set.curve === f.curve);
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

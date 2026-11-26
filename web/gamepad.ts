// SPDX-License-Identifier: AGPL-3.0-only
//
// A real controller (a DualSense, a DualShock 4, or any pad the browser calls "standard") used as the console's pad.
// This project's own.
//
// The browser's Gamepad API gives every controller the same layout when it can ("standard"): the buttons by number and
// the sticks as four axes. A DualSense is laid out like this (Chrome, Edge and Safari all do it): 0 cross, 1 circle,
// 2 square, 3 triangle, 4 L1, 5 R1, 6 L2 and 7 R2 (both analog), 8 create, 9 options, 10 L3, 11 R3, 12 to 15 the
// d-pad (up, down, left, right), 16 the PS button, 17 the touchpad click. Axes 0 and 1 are the left stick, 2 and 3 the
// right one; down is positive, as in this project's pad state.
//
// The controller joins what the keyboard and mouse already do (see mergeGamepad): its buttons are added, a trigger is
// the stronger of the two, and a stick that is being pushed takes over from the mouse and the keys. A page may only see a
// controller after a button has been pressed on it once; that is a browser rule, not a choice here.

import { BUTTON, type VirtualPadState } from '../src/engine/types.ts';
import { t } from '../src/i18n/index.ts';

/** What a controller says right now, in the pad state's own terms. */
export interface PadSample {
  buttons: number;
  /** 0..255 */
  l2: number;
  r2: number;
  /** -1..1, down positive; already past the dead zone. */
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  /** Is anything pressed or pushed? (A controller lying still does not take the sticks from the mouse.) */
  active: boolean;
}

/** The parts of a Gamepad this needs, so that it can be tested without a browser. */
export interface GamepadLike {
  id: string;
  mapping: string;
  connected?: boolean;
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
  axes: ReadonlyArray<number>;
}

/** Standard-layout button number -> console button. 6 and 7 are the triggers, handled apart. */
const BUTTON_OF: ReadonlyArray<readonly [number, number]> = [
  [0, BUTTON.cross], [1, BUTTON.moon], [2, BUTTON.box], [3, BUTTON.pyramid],
  [4, BUTTON.l1], [5, BUTTON.r1],
  [8, BUTTON.share], [9, BUTTON.options], [10, BUTTON.l3], [11, BUTTON.r3],
  [12, BUTTON.dpad_up], [13, BUTTON.dpad_down], [14, BUTTON.dpad_left], [15, BUTTON.dpad_right],
  [16, BUTTON.ps], [17, BUTTON.touchpad],
];

/** A stick's dead zone is round, and what is left of the travel is stretched to the whole range, so there is no jump at its edge. */
export function stick(x: number, y: number, deadzone: number): { x: number; y: number } {
  const m = Math.hypot(x, y);
  if (!(m > deadzone)) return { x: 0, y: 0 };
  const scaled = Math.min(1, (m - deadzone) / (1 - deadzone));
  return { x: (x / m) * scaled, y: (y / m) * scaled };
}

const TRIGGER_ON = 6; // out of 255: a resting trigger that reads a little above zero is not a press

const finite = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/** One controller's state as a pad sample, or null for a controller this does not know the layout of. */
export function samplePad(g: GamepadLike, deadzone = 0.1): PadSample | null {
  // Only the standard layout is understood. A browser that does not give one (some Firefox builds on some systems) shows an empty mapping.
  if (g.mapping !== 'standard' && g.buttons.length < 16) return null;
  let buttons = 0;
  for (const [index, bit] of BUTTON_OF) if (g.buttons[index]?.pressed) buttons |= bit;
  const trigger = (i: number): number => {
    const b = g.buttons[i];
    if (!b) return 0;
    const v = Math.round(Math.min(1, Math.max(0, finite(b.value))) * 255);
    return v >= TRIGGER_ON ? v : b.pressed ? 255 : 0;
  };
  const l2 = trigger(6);
  const r2 = trigger(7);
  const left = stick(finite(g.axes[0]), finite(g.axes[1]), deadzone);
  const right = stick(finite(g.axes[2]), finite(g.axes[3]), deadzone);
  const active = buttons !== 0 || l2 > 0 || r2 > 0 || left.x !== 0 || left.y !== 0 || right.x !== 0 || right.y !== 0;
  return { buttons, l2, r2, leftX: left.x, leftY: left.y, rightX: right.x, rightY: right.y, active };
}

/**
 * Add a controller to what the keyboard and mouse made. Buttons join; a trigger is the stronger of the two; a stick that
 * is being pushed replaces the other source's (so the mouse's look does not fight the thumb), and a stick left alone
 * leaves the mouse and the keys in charge.
 */
export function mergeGamepad(s: VirtualPadState, g: PadSample | null): void {
  if (!g || !g.active) return;
  s.buttons |= g.buttons;
  s.l2 = Math.max(s.l2, g.l2);
  s.r2 = Math.max(s.r2, g.r2);
  if (g.leftX !== 0 || g.leftY !== 0) {
    s.leftX = g.leftX;
    s.leftY = g.leftY;
  }
  if (g.rightX !== 0 || g.rightY !== 0) {
    s.rightX = g.rightX;
    s.rightY = g.rightY;
  }
}

/** A short name for the page to show: "DualSense", "DualShock 4", or what the browser calls it. */
export function padName(id: string): string {
  if (/054c.*0ce6|dualsense/i.test(id)) return 'DualSense';
  if (/054c.*(05c4|09cc)|dualshock/i.test(id)) return 'DualShock 4';
  const cleaned = id.replace(/\(.*?\)/g, '').trim();
  return cleaned.slice(0, 40) || t('Controller');
}

/** Reads the first controller that is there, every time it is asked (once per frame). */
export class GamepadInput {
  deadzone = 0.1;
  /** Called when a controller shows up or goes away, with its short name or null. */
  onChange: (name: string | null) => void = () => {};
  #name: string | null = null;
  #source: () => ReadonlyArray<GamepadLike | null>;

  /** `source` is where the controllers come from (the browser's list unless a test gives another). */
  constructor(source?: () => ReadonlyArray<GamepadLike | null>) {
    this.#source = source ?? (() => (typeof navigator !== 'undefined' && navigator.getGamepads ? Array.from(navigator.getGamepads()) : []));
  }

  /** The controller's sample now, or null when there is none (or it is not one this understands). */
  poll(): PadSample | null {
    let found: GamepadLike | null = null;
    for (const g of this.#source()) {
      if (g && g.connected !== false && (g.mapping === 'standard' || g.buttons.length >= 16)) {
        found = g;
        break;
      }
    }
    const name = found ? padName(found.id) : null;
    if (name !== this.#name) {
      this.#name = name;
      this.onChange(name);
    }
    return found ? samplePad(found, this.deadzone) : null;
  }
}

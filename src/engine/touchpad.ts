// SPDX-License-Identifier: AGPL-3.0-only
//
// A pad on a touch screen: fingers in, pad state out. No DOM here, so it can be tested as it is; the page (web/touch.ts)
// draws the controls and feeds this with where each finger is and which control, if any, lies under it.
//
// How the screen is used, the way phone games and the phone versions of remote play apps do it:
//   - A finger that comes down on a button presses it. Sliding to a neighbouring button of the same group (the d-pad,
//     the four face buttons) moves the press there, as a thumb rolls on a real pad.
//   - A finger that comes down on empty space on the left is the left stick: the stick's centre is where the finger
//     landed, and it follows the finger when dragged further than the stick's reach.
//   - A finger that comes down on empty space on the right moves the camera by dragging, like a mouse: the distance
//     dragged is handed on as mouse movement, so the same translation and speed limit apply as with a real mouse.
// Any number of fingers at once.

import { BUTTON, type ButtonName } from './types.ts';

export type TouchControl = ButtonName | 'l2' | 'r2';

/** Buttons a pressing finger may slide between. */
const SLIDE_GROUPS: TouchControl[][] = [
  ['dpad_up', 'dpad_right', 'dpad_down', 'dpad_left'],
  ['cross', 'moon', 'box', 'pyramid'],
];
const groupOf = (c: TouchControl): TouchControl[] | undefined => SLIDE_GROUPS.find((g) => g.includes(c));

export interface TouchOptions {
  /** How far the stick reaches from its centre, in the same unit as the finger positions (CSS pixels). */
  stickRadius: number;
  /** Movement below this share of the reach is no movement (a resting thumb). */
  stickDeadzone?: number;
  /** The share of the width, from the left, that belongs to the stick. The rest is the camera. Default 0.45. */
  stickZone?: number;
  /** Mouse counts per pixel dragged on the camera side. Default 4. */
  lookScale?: number;
}

type Finger =
  | { kind: 'button'; control: TouchControl }
  | { kind: 'stick'; cx: number; cy: number; x: number; y: number }
  | { kind: 'look'; x: number; y: number };

export interface TouchPadOutput {
  buttons: number;
  l2: number;
  r2: number;
  /** True while a finger is on the stick: then leftX and leftY replace whatever else drives the left stick. */
  stickActive: boolean;
  leftX: number;
  leftY: number;
}

export class TouchPad {
  options: Required<TouchOptions>;
  #fingers = new Map<number, Finger>();
  #lookDx = 0;
  #lookDy = 0;

  constructor(options: TouchOptions) {
    this.options = { stickDeadzone: 0.1, stickZone: 0.45, lookScale: 4, ...options };
  }

  /** A finger came down at (x, y) on a surface `width` wide. `control`: the button under it, or null for empty space. */
  down(id: number, x: number, y: number, width: number, control: TouchControl | null): void {
    if (control) this.#fingers.set(id, { kind: 'button', control });
    else if (x < width * this.options.stickZone && !this.#stickFinger()) this.#fingers.set(id, { kind: 'stick', cx: x, cy: y, x, y });
    else this.#fingers.set(id, { kind: 'look', x, y });
  }

  /** The finger moved. `control`: the button now under it, or null. */
  move(id: number, x: number, y: number, control: TouchControl | null): void {
    const f = this.#fingers.get(id);
    if (!f) return;
    if (f.kind === 'button') {
      // Roll from one button of a group to its neighbour; leaving the group keeps the press where it was.
      if (control && control !== f.control && groupOf(f.control)?.includes(control)) f.control = control;
    } else if (f.kind === 'stick') {
      f.x = x;
      f.y = y;
      // Dragged past the reach: the centre comes along, so pulling back acts at once.
      const dx = x - f.cx;
      const dy = y - f.cy;
      const far = Math.hypot(dx, dy);
      const r = this.options.stickRadius;
      if (far > r) {
        f.cx = x - (dx / far) * r;
        f.cy = y - (dy / far) * r;
      }
    } else {
      this.#lookDx += (x - f.x) * this.options.lookScale;
      this.#lookDy += (y - f.y) * this.options.lookScale;
      f.x = x;
      f.y = y;
    }
  }

  up(id: number): void {
    this.#fingers.delete(id);
  }

  /** Let go of everything (the page was hidden, the connection ended). */
  releaseAll(): void {
    this.#fingers.clear();
    this.#lookDx = this.#lookDy = 0;
  }

  #stickFinger(): Extract<Finger, { kind: 'stick' }> | undefined {
    for (const f of this.#fingers.values()) if (f.kind === 'stick') return f;
    return undefined;
  }

  /** Where the stick is drawn while a finger is on it: its centre and the finger, or null. */
  get stick(): { cx: number; cy: number; x: number; y: number } | null {
    const f = this.#stickFinger();
    return f ? { cx: f.cx, cy: f.cy, x: f.x, y: f.y } : null;
  }

  /** The controls being pressed, for drawing them as pressed. */
  get pressed(): TouchControl[] {
    const out: TouchControl[] = [];
    for (const f of this.#fingers.values()) if (f.kind === 'button') out.push(f.control);
    return out;
  }

  /** Camera movement since the last call, as mouse counts. */
  takeLook(): { dx: number; dy: number } {
    const out = { dx: this.#lookDx, dy: this.#lookDy };
    this.#lookDx = this.#lookDy = 0;
    return out;
  }

  get active(): boolean {
    return this.#fingers.size > 0;
  }

  get output(): TouchPadOutput {
    const out: TouchPadOutput = { buttons: 0, l2: 0, r2: 0, stickActive: false, leftX: 0, leftY: 0 };
    for (const f of this.#fingers.values()) {
      if (f.kind === 'button') {
        if (f.control === 'l2') out.l2 = 255;
        else if (f.control === 'r2') out.r2 = 255;
        else out.buttons |= BUTTON[f.control];
      } else if (f.kind === 'stick') {
        out.stickActive = true;
        const r = this.options.stickRadius;
        const dz = this.options.stickDeadzone;
        let x = (f.x - f.cx) / r;
        let y = (f.y - f.cy) / r;
        const m = Math.hypot(x, y);
        if (m <= dz) x = y = 0;
        else {
          // The deadzone is taken out of the range, not cut off it: just past it the stick starts from zero.
          const scaled = Math.min(1, (m - dz) / (1 - dz));
          x = (x / m) * scaled;
          y = (y / m) * scaled;
        }
        out.leftX = x;
        out.leftY = y;
      }
    }
    return out;
  }
}

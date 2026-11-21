// SPDX-License-Identifier: AGPL-3.0-only
//
// Shareable mapping profile (schema 0). A profile is DATA ONLY: it is validated
// and normalised before use, unknown fields are dropped, and nothing in it is
// ever executed. That is what makes it safe to download profiles from others.

import { BUTTON, type ButtonName } from './types.ts';
import { validateCalibration, type CalPoint } from './calibration.ts';

export const MAX_PROFILE_BYTES = 64 * 1024;

export interface MouseGyroConfig {
  /** Multiplier on the angular velocity written to the virtual gyro. */
  gain: number;
  /** Per-axis clamp in rad/s. Never above the 30 rad/s the console-facing library can carry. */
  maxRadPerSec: number;
  /** Which gyro axis carries yaw (mouse X) and pitch (mouse Y). Verify on a real console in M2. */
  yawAxis: 'x' | 'y' | 'z';
  pitchAxis: 'x' | 'y' | 'z';
  yawSign: 1 | -1;
  pitchSign: 1 | -1;
}

export interface MouseConfig {
  target: 'right_stick' | 'gyro' | 'off';
  /** Degrees of camera rotation per mouse count. */
  degPerCount: number;
  /** Response exponent: 1 = linear, >1 = finer at low speed, faster at high speed. */
  curve: number;
  /** Time constant of the low-pass filter on the turn rate. 0 = off. */
  smoothingMs: number;
  /** Hard cap on the camera turn rate, deg/s. This is the "speed limit". */
  maxTurnRate: number;
  /** Cap on stick deflection, 0..1. */
  maxDeflection: number;
  /** Vertical turn rate relative to horizontal. */
  verticalScale: number;
  invertY: boolean;
  gyro: MouseGyroConfig;
}

export interface Layer {
  name: string;
  /**
   * Input code that activates this layer while held. null for the default layer, and for layers that are
   * only switched on and off with a `toggle:<name>` action (for example a "vehicle" context).
   */
  holdKey: string | null;
  /** Scales the left stick while the layer is active (walk / precision modes). */
  leftStickScale: number;
  /**
   * How much faster or slower the GAME turns the camera while this layer is active (for example aiming
   * down sights). The engine divides the desired turn rate by it so the angle per mouse count stays the same.
   */
  lookScale: number;
  /**
   * Input code (KeyboardEvent.code, Mouse0..4, WheelUp/WheelDown) to action text.
   * A hold key of this layer is looked up here and nowhere else, so holding it never also fires its default binding.
   * Several actions can be combined with "+", for example "btn:pyramid+toggle:vehicle".
   *
   * An input code may carry an activator: "KeyG@long", "KeyG@double", "KeyG@start", "KeyG@release" (see Activator).
   * Without one, the binding is the plain press: the action lasts exactly as long as the key is held.
   */
  bindings: Record<string, string>;
}

export interface Profile {
  schema: 0;
  game: { name: string; platform: 'PS4' | 'PS5' | 'any'; id: string | null };
  author: string;
  version: string;
  license: string;
  /** The game's own settings this profile was tuned for. Recorded so others can match them. */
  inGame: {
    lookSensitivity: number | null;
    innerDeadzone: number;
    maxTurnRateAtFullStick: number;
    /** 1 = linear, >1 = slow near the centre, fast near the edge. Used when there is no measured table. */
    responseCurve: number;
    /** radial: the game applies its deadzone to the stick vector (most games). axial: per axis. */
    deadzoneShape: 'radial' | 'axial';
    /** Vertical turn rate relative to horizontal at the same stick value. */
    verticalRateRatio: number;
    gyroAim: boolean;
  };
  /**
   * Measured stick-to-turn-rate tables (horizontal axis). null = build a model from `inGame`.
   * `vertical` is only used for axial games and defaults to the horizontal table scaled by verticalRateRatio.
   */
  calibration: { horizontal: CalPoint[] | null; vertical: CalPoint[] | null };
  mouse: MouseConfig;
  keys: {
    rampUpMs: number;
    rampDownMs: number;
    /** How long a "tap" lasts on the pad, in ms: `tap:` actions, and a short press on a key that also has a long or double press. */
    tapMs: number;
    /** The least time a `hold:` action keeps the button pressed, in ms. */
    holdMs: number;
    /** A key held this long is a long press (for keys with a "@long" binding), in ms. */
    longPressMs: number;
    /** A second press within this time of the first is a double press (for keys with a "@double" binding), in ms. */
    doublePressMs: number;
  };
  layers: Layer[];
  network: { preset: 'saver' | 'balanced' | 'low-latency' | 'quality' };
}

/** A pad button or a trigger pressed all the way. */
export type Output = { button: ButtonName } | { trigger: 'l2' | 'r2' };

/**
 * Which kind of press of a key a binding is for. This is the model Steam Input and reWASD use, and it has one cost
 * that both document: once a key has a long or a double press, its plain press can no longer act the moment the key
 * goes down, because the engine has to see how the press ends first. Then the plain binding fires as a tap when the
 * key is let go early (after the double press time when there is a double press). "start" is the way around that: it
 * fires at once, whatever follows.
 *
 *   (none)    the plain press. Alone on a key: the action lasts as long as the key is held, with no delay.
 *   start     fires once when the key goes down, always.
 *   long      takes over when the key has been held for keys.longPressMs, and lasts until it is let go.
 *   double    the second of two presses within keys.doublePressMs, lasting as long as that press.
 *   release   fires once when the key is let go.
 */
export type Activator = 'regular' | 'start' | 'long' | 'double' | 'release';
export const ACTIVATORS: readonly Activator[] = ['regular', 'start', 'long', 'double', 'release'];

const BINDING_KEY = /^([A-Za-z0-9_]{1,24})(?:@(start|long|double|release))?$/;

/** "KeyG@long" -> { code: "KeyG", activator: "long" }. null when it is not a valid binding key. */
export function splitBindingKey(key: string): { code: string; activator: Activator } | null {
  const m = BINDING_KEY.exec(key);
  return m ? { code: m[1]!, activator: (m[2] as Activator | undefined) ?? 'regular' } : null;
}

export function bindingKey(code: string, activator: Activator): string {
  return activator === 'regular' ? code : `${code}@${activator}`;
}

export type Action =
  | { kind: 'button'; button: ButtonName }
  | { kind: 'stick'; stick: 'left' | 'right'; dir: 'up' | 'down' | 'left' | 'right'; amount: number }
  | { kind: 'trigger'; trigger: 'l2' | 'r2'; amount: number }
  /** Presses the button over and over while the key is held (games that need button mashing, such as GTA sprint). */
  | { kind: 'turbo'; button: ButtonName; hz: number }
  /** Switches a layer on or off each time the key is pressed. */
  | { kind: 'toggle'; layer: string }
  /**
   * Presses the button for a fixed short time when the key goes down, however long the key is held. For games where
   * one pad button does two things by press length: a key bound to this can never turn into the "held" one.
   */
  | { kind: 'tap'; out: Output; ms: number | null }
  /**
   * Presses the button while the key is held and for at least `ms`, even if the key is let go at once. The other
   * half: a quick key press that the game sees as "button held".
   */
  | { kind: 'hold'; out: Output; ms: number | null }
  /** Each press of the key switches the button on or off (hold to aim becomes press to aim, and so on). */
  | { kind: 'latch'; out: Output }
  /** Does nothing. Binds a key to nothing inside a layer so the default layer's binding does not show through. */
  | { kind: 'none' };

/**
 * Action text forms:
 *   btn:cross
 *   stick:left:up            stick:left:up:0.5   (amount 0..1, default 1)
 *   trigger:r2               trigger:r2:0.5
 *   turbo:cross              turbo:cross:12      (presses per second, 2..30, default 10)
 *   toggle:vehicle           (flip a layer on each key press)
 *   tap:box                  tap:box:60          (a press of fixed length in ms, 20..1000; default keys.tapMs)
 *   hold:box                 hold:box:800        (pressed while held and at least this long, 100..5000; default keys.holdMs)
 *   latch:l2                 (each key press switches it on or off)
 * tap, hold and latch take a button name or l2 / r2.
 */
export function parseAction(text: string): Action | null {
  const parts = text.split(':');
  const kind = parts[0];
  if (kind === 'turbo' && (parts.length === 2 || parts.length === 3)) {
    const name = parts[1] as string;
    const hz = parts.length === 3 ? Number(parts[2]) : 10;
    if (!Object.hasOwn(BUTTON, name) || !Number.isFinite(hz) || hz < 2 || hz > 30) return null;
    return { kind: 'turbo', button: name as ButtonName, hz };
  }
  if ((kind === 'tap' || kind === 'hold' || kind === 'latch') && (parts.length === 2 || (parts.length === 3 && kind !== 'latch'))) {
    const name = parts[1] as string;
    const out: Output | null = name === 'l2' || name === 'r2' ? { trigger: name } : Object.hasOwn(BUTTON, name) ? { button: name as ButtonName } : null;
    if (!out) return null;
    if (kind === 'latch') return { kind, out };
    const ms = parts.length === 3 ? Number(parts[2]) : null;
    const [min, max] = kind === 'tap' ? [20, 1000] : [100, 5000];
    if (ms !== null && (!Number.isFinite(ms) || ms < min || ms > max)) return null;
    return { kind, out, ms };
  }
  if (kind === 'toggle' && parts.length === 2) {
    return /^[A-Za-z0-9_-]{1,32}$/.test(parts[1] as string) ? { kind: 'toggle', layer: parts[1] as string } : null;
  }
  if (kind === 'btn' && parts.length === 2) {
    const name = parts[1] as string;
    return Object.hasOwn(BUTTON, name) ? { kind: 'button', button: name as ButtonName } : null;
  }
  if (kind === 'stick' && (parts.length === 3 || parts.length === 4)) {
    const stick = parts[1];
    const dir = parts[2];
    const amount = parts.length === 4 ? Number(parts[3]) : 1;
    if ((stick !== 'left' && stick !== 'right') || !Number.isFinite(amount) || amount <= 0 || amount > 1) return null;
    if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') return null;
    return { kind: 'stick', stick, dir, amount };
  }
  if (kind === 'trigger' && (parts.length === 2 || parts.length === 3)) {
    const trigger = parts[1];
    const amount = parts.length === 3 ? Number(parts[2]) : 1;
    if ((trigger !== 'l2' && trigger !== 'r2') || !Number.isFinite(amount) || amount <= 0 || amount > 1) return null;
    return { kind: 'trigger', trigger, amount };
  }
  if (kind === 'none' && parts.length === 1) return { kind: 'none' };
  return null;
}

/** One binding may combine up to 4 actions with "+". Returns null if any part is invalid. */
export function parseActions(text: string): Action[] | null {
  const parts = text.split('+');
  if (parts.length < 1 || parts.length > 4) return null;
  const actions: Action[] = [];
  for (const part of parts) {
    const action = parseAction(part);
    if (!action) return null;
    actions.push(action);
  }
  return actions;
}

const CODE_PATTERN = /^[A-Za-z0-9_]{1,24}$/;

export function defaultProfile(): Profile {
  return {
    schema: 0,
    game: { name: 'Default', platform: 'any', id: null },
    author: '',
    version: '0.1.0',
    license: 'CC0-1.0',
    inGame: {
      lookSensitivity: null,
      innerDeadzone: 0.1,
      maxTurnRateAtFullStick: 360,
      responseCurve: 1,
      deadzoneShape: 'radial',
      verticalRateRatio: 1,
      gyroAim: false,
    },
    calibration: { horizontal: null, vertical: null },
    mouse: {
      target: 'right_stick',
      degPerCount: 0.05,
      curve: 1,
      smoothingMs: 12,
      maxTurnRate: 360,
      maxDeflection: 1,
      verticalScale: 1,
      invertY: false,
      gyro: { gain: 1, maxRadPerSec: 30, yawAxis: 'y', pitchAxis: 'x', yawSign: 1, pitchSign: 1 },
    },
    keys: { rampUpMs: 30, rampDownMs: 50, tapMs: 80, holdMs: 600, longPressMs: 300, doublePressMs: 250 },
    layers: [
      {
        name: 'default',
        holdKey: null,
        leftStickScale: 1,
        lookScale: 1,
        // The general-purpose layout. Every key is a plain press: the button is down exactly as long as the key is,
        // so whatever a game does with short and long presses works as it does on a pad, with no delay added.
        // It follows what PC games and the PC versions of PlayStation games use (WASD, mouse buttons for the
        // triggers, Space jump, R reload, Shift sprint, Tab map), with the left hand never leaving the WASD area for
        // anything needed in play, and keeps away from keys a browser acts on by itself (Esc, Ctrl combinations,
        // F5, F11). See docs/keyboard-mouse-mapping.md.
        bindings: {
          // Left stick. Hold X to walk (the "walk" layer below).
          KeyW: 'stick:left:up',
          KeyS: 'stick:left:down',
          KeyA: 'stick:left:left',
          KeyD: 'stick:left:right',
          // Face buttons.
          Space: 'btn:cross',
          KeyC: 'btn:moon',
          KeyR: 'btn:box',
          KeyF: 'btn:pyramid',
          // Shoulders and triggers. The right mouse button is L2 through the "aim" layer below.
          Mouse0: 'trigger:r2',
          KeyQ: 'btn:l1',
          KeyE: 'btn:r1',
          Mouse3: 'btn:l1',
          Mouse4: 'btn:r1',
          // Stick clicks.
          ShiftLeft: 'btn:l3',
          KeyV: 'btn:r3',
          Mouse1: 'btn:r3',
          // D-pad: the number row for play, the arrow keys for menus.
          Digit1: 'btn:dpad_up',
          Digit2: 'btn:dpad_right',
          Digit3: 'btn:dpad_down',
          Digit4: 'btn:dpad_left',
          ArrowUp: 'btn:dpad_up',
          ArrowDown: 'btn:dpad_down',
          ArrowLeft: 'btn:dpad_left',
          ArrowRight: 'btn:dpad_right',
          // Menus with one hand on the arrows: Enter confirms, Backspace goes back.
          Enter: 'btn:cross',
          Backspace: 'btn:moon',
          // System buttons. Esc cannot be used: a browser takes it to release the mouse.
          Tab: 'btn:touchpad',
          KeyM: 'btn:touchpad',
          Backquote: 'btn:options',
          KeyO: 'btn:options',
          KeyP: 'btn:ps',
          KeyT: 'btn:share',
        },
      },
      // Not Ctrl: browsers keep Ctrl+W (close tab) and similar shortcuts for themselves.
      { name: 'walk', holdKey: 'KeyX', leftStickScale: 0.45, lookScale: 1, bindings: {} },
      // Right mouse button aims (L2). While it is held the game may turn the camera at a different speed;
      // set lookScale to that factor (the test bed can measure it) so the angle per mouse count stays the same.
      { name: 'aim', holdKey: 'Mouse2', leftStickScale: 1, lookScale: 1, bindings: { Mouse2: 'trigger:l2' } },
    ],
    network: { preset: 'balanced' },
  };
}

/**
 * Profile for a GTA V style third-person game. Only the buttons confirmed for GTA V on PlayStation are
 * grounded in a source (sprint = tap X repeatedly, jump = Square, aim = L2, enter vehicle = Triangle,
 * cover = R1, vehicle accelerate = R2). The vehicle brake on L2 and handbrake on Square are assumptions.
 */
export function gtaProfile(): Profile {
  const p = defaultProfile();
  p.game = { name: 'GTA V (third-person test)', platform: 'PS5', id: null };
  p.layers = [
    {
      name: 'default',
      holdKey: null,
      leftStickScale: 1,
      lookScale: 1,
      bindings: {
        // Everything of the general layout that is not said otherwise below (d-pad, menus, system buttons, stick clicks).
        ...defaultProfile().layers[0]!.bindings,
        // GTA V on PlayStation: sprint means tapping X repeatedly, so holding Shift auto-taps it.
        ShiftLeft: 'turbo:cross:10',
        Space: 'btn:box',
        // Enter / exit a vehicle, and switch the controls between on foot and driving.
        KeyF: 'btn:pyramid+toggle:vehicle',
        KeyQ: 'btn:r1',
        // Left to the general layout and NOT checked against the game: R (Square), C (Circle), E (R1), V and the
        // middle mouse button (R3), the number row and arrows (d-pad). Change them to what the game shows.
      },
    },
    { name: 'walk', holdKey: 'KeyX', leftStickScale: 0.45, lookScale: 1, bindings: {} },
    { name: 'aim', holdKey: 'Mouse2', leftStickScale: 1, lookScale: 1, bindings: { Mouse2: 'trigger:l2' } },
    {
      // Driving: W accelerates (R2) and S brakes / reverses (L2); A and D still steer with the left stick.
      name: 'vehicle',
      holdKey: null,
      leftStickScale: 1,
      lookScale: 1,
      bindings: { KeyW: 'trigger:r2', KeyS: 'trigger:l2', ShiftLeft: 'none' },
    },
  ];
  return p;
}

/**
 * An example of splitting one pad button into two keys by press length, for shooters where a button does one thing
 * when tapped and another when held (reload and pick up on the same button, crouch and prone on the same button).
 * It is an example to adapt, not the layout of one particular game: check the game's own button list.
 *
 *   R  taps Square, however long R is held        (reload, never "pick up" by holding too long)
 *   E  holds Square for at least keys.holdMs      (pick up / use with a quick press of E)
 *   C  taps Circle                                (crouch)
 *   Z  holds Circle                               (prone)
 *   G  R1, since E is now taken
 *   Caps Lock switches walking on and off
 */
export function shooterProfile(): Profile {
  const p = defaultProfile();
  p.game = { name: 'Shooter (tap and hold on separate keys)', platform: 'any', id: null };
  const b = p.layers[0]!.bindings;
  b.KeyR = 'tap:box';
  b.KeyE = 'hold:box';
  b.KeyC = 'tap:moon';
  b.KeyZ = 'hold:moon';
  b.KeyG = 'btn:r1';
  b.CapsLock = 'toggle:walk';
  return p;
}

/** The presets a person can start from. */
export const PRESETS: ReadonlyArray<{ id: string; name: string; make: () => Profile }> = [
  { id: 'default', name: '기본 (범용)', make: defaultProfile },
  { id: 'shooter', name: '슈터 예시 (짧게/길게를 다른 키로)', make: shooterProfile },
  { id: 'gta', name: 'GTA V 스타일', make: gtaProfile },
];

export type ParseResult = { ok: true; profile: Profile } | { ok: false; errors: string[] };

class Checker {
  errors: string[] = [];

  object(value: unknown, path: string): Record<string, unknown> | null {
    if (value === undefined) return null;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.errors.push(`${path}: must be an object`);
      return null;
    }
    return value as Record<string, unknown>;
  }

  num(src: Record<string, unknown> | null, key: string, path: string, min: number, max: number, def: number): number {
    const v = src?.[key];
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      this.errors.push(`${path}.${key}: must be a number within ${min}..${max}`);
      return def;
    }
    return v;
  }

  bool(src: Record<string, unknown> | null, key: string, path: string, def: boolean): boolean {
    const v = src?.[key];
    if (v === undefined) return def;
    if (typeof v !== 'boolean') {
      this.errors.push(`${path}.${key}: must be true or false`);
      return def;
    }
    return v;
  }

  str(src: Record<string, unknown> | null, key: string, path: string, maxLen: number, def: string): string {
    const v = src?.[key];
    if (v === undefined) return def;
    if (typeof v !== 'string' || v.length > maxLen) {
      this.errors.push(`${path}.${key}: must be a string of at most ${maxLen} characters`);
      return def;
    }
    return v;
  }

  oneOf<T extends string | number>(src: Record<string, unknown> | null, key: string, path: string, allowed: readonly T[], def: T): T {
    const v = src?.[key];
    if (v === undefined) return def;
    if (!allowed.includes(v as T)) {
      this.errors.push(`${path}.${key}: must be one of ${allowed.join(', ')}`);
      return def;
    }
    return v as T;
  }
}

/** Validate untrusted input and return a normalised copy. Unknown fields are dropped. */
export function validateProfile(input: unknown): ParseResult {
  const c = new Checker();
  const def = defaultProfile();
  const root = c.object(input, 'profile');
  if (root === null) {
    return { ok: false, errors: c.errors.length ? c.errors : ['profile: must be an object'] };
  }

  if (root.schema !== 0) c.errors.push('profile.schema: must be 0');

  const gameSrc = c.object(root.game, 'game');
  const gameId = gameSrc?.id;
  if (gameId !== undefined && gameId !== null && (typeof gameId !== 'string' || gameId.length > 64)) {
    c.errors.push('game.id: must be null or a string of at most 64 characters');
  }
  const game: Profile['game'] = {
    name: c.str(gameSrc, 'name', 'game', 80, def.game.name),
    platform: c.oneOf(gameSrc, 'platform', 'game', ['PS4', 'PS5', 'any'] as const, def.game.platform),
    id: typeof gameId === 'string' && gameId.length <= 64 ? gameId : null,
  };

  const inSrc = c.object(root.inGame, 'inGame');
  const lookSens = inSrc?.lookSensitivity;
  if (lookSens !== undefined && lookSens !== null && (typeof lookSens !== 'number' || !Number.isFinite(lookSens))) {
    c.errors.push('inGame.lookSensitivity: must be null or a number');
  }
  const inGame: Profile['inGame'] = {
    lookSensitivity: typeof lookSens === 'number' && Number.isFinite(lookSens) ? lookSens : null,
    innerDeadzone: c.num(inSrc, 'innerDeadzone', 'inGame', 0, 0.6, def.inGame.innerDeadzone),
    maxTurnRateAtFullStick: c.num(inSrc, 'maxTurnRateAtFullStick', 'inGame', 10, 5000, def.inGame.maxTurnRateAtFullStick),
    responseCurve: c.num(inSrc, 'responseCurve', 'inGame', 0.5, 3, def.inGame.responseCurve),
    deadzoneShape: c.oneOf(inSrc, 'deadzoneShape', 'inGame', ['radial', 'axial'] as const, def.inGame.deadzoneShape),
    verticalRateRatio: c.num(inSrc, 'verticalRateRatio', 'inGame', 0.1, 4, def.inGame.verticalRateRatio),
    gyroAim: c.bool(inSrc, 'gyroAim', 'inGame', def.inGame.gyroAim),
  };

  const calSrc = c.object(root.calibration, 'calibration');
  const readTable = (key: 'horizontal' | 'vertical'): CalPoint[] | null => {
    const raw = calSrc?.[key];
    if (raw === undefined || raw === null) return null;
    const errs = validateCalibration(raw, `calibration.${key}`);
    if (errs.length) {
      c.errors.push(...errs);
      return null;
    }
    return (raw as unknown[][]).map((p) => [p[0] as number, p[1] as number] as CalPoint);
  };
  const calibration: Profile['calibration'] = { horizontal: readTable('horizontal'), vertical: readTable('vertical') };

  const mSrc = c.object(root.mouse, 'mouse');
  const gSrc = c.object(mSrc?.gyro, 'mouse.gyro');
  const dm = def.mouse;
  const mouse: MouseConfig = {
    target: c.oneOf(mSrc, 'target', 'mouse', ['right_stick', 'gyro', 'off'] as const, dm.target),
    degPerCount: c.num(mSrc, 'degPerCount', 'mouse', 0.0001, 5, dm.degPerCount),
    curve: c.num(mSrc, 'curve', 'mouse', 0.5, 3, dm.curve),
    smoothingMs: c.num(mSrc, 'smoothingMs', 'mouse', 0, 200, dm.smoothingMs),
    maxTurnRate: c.num(mSrc, 'maxTurnRate', 'mouse', 1, 5000, dm.maxTurnRate),
    maxDeflection: c.num(mSrc, 'maxDeflection', 'mouse', 0.05, 1, dm.maxDeflection),
    verticalScale: c.num(mSrc, 'verticalScale', 'mouse', 0.1, 4, dm.verticalScale),
    invertY: c.bool(mSrc, 'invertY', 'mouse', dm.invertY),
    gyro: {
      gain: c.num(gSrc, 'gain', 'mouse.gyro', 0.1, 10, dm.gyro.gain),
      maxRadPerSec: c.num(gSrc, 'maxRadPerSec', 'mouse.gyro', 0.1, 30, dm.gyro.maxRadPerSec),
      yawAxis: c.oneOf(gSrc, 'yawAxis', 'mouse.gyro', ['x', 'y', 'z'] as const, dm.gyro.yawAxis),
      pitchAxis: c.oneOf(gSrc, 'pitchAxis', 'mouse.gyro', ['x', 'y', 'z'] as const, dm.gyro.pitchAxis),
      yawSign: c.oneOf(gSrc, 'yawSign', 'mouse.gyro', [1, -1] as const, dm.gyro.yawSign),
      pitchSign: c.oneOf(gSrc, 'pitchSign', 'mouse.gyro', [1, -1] as const, dm.gyro.pitchSign),
    },
  };
  if (mouse.gyro.yawAxis === mouse.gyro.pitchAxis) c.errors.push('mouse.gyro: yawAxis and pitchAxis must differ');

  const kSrc = c.object(root.keys, 'keys');
  const keys: Profile['keys'] = {
    rampUpMs: c.num(kSrc, 'rampUpMs', 'keys', 0, 500, def.keys.rampUpMs),
    rampDownMs: c.num(kSrc, 'rampDownMs', 'keys', 0, 500, def.keys.rampDownMs),
    tapMs: c.num(kSrc, 'tapMs', 'keys', 20, 500, def.keys.tapMs),
    holdMs: c.num(kSrc, 'holdMs', 'keys', 100, 5000, def.keys.holdMs),
    longPressMs: c.num(kSrc, 'longPressMs', 'keys', 100, 2000, def.keys.longPressMs),
    doublePressMs: c.num(kSrc, 'doublePressMs', 'keys', 100, 1000, def.keys.doublePressMs),
  };

  const layers: Layer[] = [];
  const rawLayers = root.layers;
  if (rawLayers === undefined) {
    layers.push(...def.layers);
  } else if (!Array.isArray(rawLayers) || rawLayers.length < 1 || rawLayers.length > 8) {
    c.errors.push('layers: must be an array of 1 to 8 layers');
  } else {
    const seen = new Set<string>();
    rawLayers.forEach((rawLayer: unknown, i: number) => {
      const path = `layers[${i}]`;
      const lSrc = c.object(rawLayer, path);
      const name = c.str(lSrc, 'name', path, 32, '');
      if (!name) c.errors.push(`${path}.name: required`);
      if (seen.has(name)) c.errors.push(`${path}.name: duplicate layer name "${name}"`);
      seen.add(name);
      const holdRaw = lSrc?.holdKey;
      let holdKey: string | null = null;
      if (holdRaw !== undefined && holdRaw !== null) {
        if (typeof holdRaw === 'string' && CODE_PATTERN.test(holdRaw)) holdKey = holdRaw;
        else c.errors.push(`${path}.holdKey: must be null or an input code like "ShiftLeft"`);
      }
      if (i === 0 && (name !== 'default' || holdKey !== null)) {
        c.errors.push('layers[0]: the first layer must be named "default" and have holdKey null');
      }
      const bindings: Record<string, string> = {};
      const bSrc = c.object(lSrc?.bindings, `${path}.bindings`);
      const entries = bSrc ? Object.entries(bSrc) : [];
      if (entries.length > 128) c.errors.push(`${path}.bindings: at most 128 bindings`);
      for (const [code, action] of entries.slice(0, 128)) {
        const key = splitBindingKey(code);
        if (!key) {
          c.errors.push(`${path}.bindings: invalid input code "${code.slice(0, 32)}"`);
        } else if (key.code.startsWith('Wheel') && key.activator !== 'regular') {
          c.errors.push(`${path}.bindings.${code}: a wheel notch has no length, so it cannot have a long, double, start or release press`);
        } else if (typeof action !== 'string' || parseActions(action) === null) {
          c.errors.push(`${path}.bindings.${code}: invalid action`);
        } else {
          bindings[code] = action;
        }
      }
      layers.push({
        name,
        holdKey,
        leftStickScale: c.num(lSrc, 'leftStickScale', path, 0.05, 1, 1),
        lookScale: c.num(lSrc, 'lookScale', path, 0.1, 4, 1),
        bindings,
      });
    });
    // A toggle must point at an existing layer other than the default one.
    const names = new Set(layers.map((l) => l.name));
    for (const layer of layers) {
      for (const [code, text] of Object.entries(layer.bindings)) {
        for (const action of parseActions(text) ?? []) {
          if (action.kind === 'toggle' && (action.layer === 'default' || !names.has(action.layer))) {
            c.errors.push(`layers.${layer.name}.bindings.${code}: toggle target "${action.layer}" is not a toggleable layer`);
          }
        }
      }
    }
  }

  const nSrc = c.object(root.network, 'network');
  const network: Profile['network'] = {
    preset: c.oneOf(nSrc, 'preset', 'network', ['saver', 'balanced', 'low-latency', 'quality'] as const, def.network.preset),
  };

  const profile: Profile = {
    schema: 0,
    game,
    author: c.str(root, 'author', 'profile', 64, ''),
    version: c.str(root, 'version', 'profile', 32, def.version),
    license: c.str(root, 'license', 'profile', 32, def.license),
    inGame,
    calibration,
    mouse,
    keys,
    layers,
    network,
  };

  return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, profile };
}

/** Parse profile text (for example a downloaded file). Rejects oversized input. */
export function parseProfileText(text: string): ParseResult {
  if (new TextEncoder().encode(text).length > MAX_PROFILE_BYTES) {
    return { ok: false, errors: [`profile: larger than ${MAX_PROFILE_BYTES} bytes`] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['profile: not valid JSON'] };
  }
  return validateProfile(data);
}

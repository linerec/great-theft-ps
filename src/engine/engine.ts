// SPDX-License-Identifier: AGPL-3.0-only
//
// MappingEngine: keyboard, mouse and wheel events in, virtual DualSense state out.
// Time is injected through tick(dt) so behaviour is deterministic and testable.

import { modelTable } from './calibration.ts';
import { LookFilter, VirtualGyro, rateToStick, type StickModel } from './mouse.ts';
import { parseActions, splitBindingKey, type Action, type Activator, type Layer, type Output, type Profile } from './profile.ts';
import { BUTTON, emptyPadState, type LookDiagnostics, type VirtualPadState } from './types.ts';

type Dir = 'up' | 'down' | 'left' | 'right';
const DIRS: Dir[] = ['up', 'down', 'left', 'right'];

interface Ramp {
  up: number;
  down: number;
  left: number;
  right: number;
}

/** What one input does, by kind of press (see Activator in profile.ts). */
type BindingSet = Partial<Record<Activator, Action[]>>;

interface CompiledLayer {
  layer: Layer;
  sets: Map<string, BindingSet>;
}

/** A key with a long or a double press: what the press turned out to be is only known as it goes on. */
interface PressState {
  set: BindingSet;
  downAt: number;
  down: boolean;
  /** The long press took over, or this is the second press of a double press. */
  active: 'long' | 'double' | null;
  activeSince: number;
  /** The first press was let go early; a second one may still follow. */
  waiting: boolean;
}

/** Something a pulse keeps pressed: a button, a trigger or a stick direction. */
type Simple = Extract<Action, { kind: 'button' | 'trigger' | 'stick' }>;

const toSimple = (out: Output): Simple => ('button' in out ? { kind: 'button', button: out.button } : { kind: 'trigger', trigger: out.trigger, amount: 1 });
const outputId = (out: Output): string => ('button' in out ? `b:${out.button}` : `t:${out.trigger}`);

/** How long a mouse wheel notch counts as "held". */
const WHEEL_PULSE_SECONDS = 0.06;

/** Gravity vector (in g) used for the virtual accelerometer. Unverified against a real console. */
const ACCEL_REST = { x: 0, y: 1, z: 0 };

function clampUnit(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y);
  return m > 1 ? [x / m, y / m] : [x, y];
}

export class MappingEngine {
  #profile: Profile;
  #layers: CompiledLayer[] = [];
  #model: StickModel = { shape: 'radial', verticalRatio: 1, horizontal: [], vertical: [] };
  #down = new Set<string>();
  /** Engine time at which each held input went down, for turbo phase. */
  #downAt = new Map<string, number>();
  /** Presses and releases since the last tick, in the order they happened. */
  #events: Array<{ code: string; down: boolean }> = [];
  /** Keys with a long or double press that are in the middle of one. */
  #presses = new Map<string, PressState>();
  /** Outputs kept pressed until a point in time: taps, the least duration of a hold. */
  #timed: Array<{ until: number; action: Simple }> = [];
  /** Outputs switched on by a latch action. */
  #latchedOut = new Map<string, Simple>();
  /** Layers switched on by a toggle action. */
  #latched = new Set<string>();
  #pulses = new Map<string, number>();
  #time = 0;
  #mouseDx = 0;
  #mouseDy = 0;
  #ramps: { left: Ramp; right: Ramp } = {
    left: { up: 0, down: 0, left: 0, right: 0 },
    right: { up: 0, down: 0, left: 0, right: 0 },
  };
  #look = new LookFilter();
  #gyro = new VirtualGyro();
  #diag: LookDiagnostics & { stickMagnitude: number } = { rateX: 0, rateY: 0, capped: false, stickMagnitude: 0 };
  #activeNames: string[] = [];

  constructor(profile: Profile) {
    this.#profile = profile;
    this.#compile();
  }

  get profile(): Profile {
    return this.#profile;
  }

  get diagnostics(): LookDiagnostics & { stickMagnitude: number } {
    return { ...this.#diag };
  }

  /** Names of the layers that were active on the last tick (held layers and toggled-on layers). */
  get activeLayers(): string[] {
    return [...this.#activeNames];
  }

  setProfile(profile: Profile): void {
    this.#profile = profile;
    const known = new Set(profile.layers.map((l) => l.name));
    for (const name of [...this.#latched]) if (!known.has(name)) this.#latched.delete(name);
    this.#compile();
    this.#look.reset();
    this.#gyro.reset();
  }

  keyDown(code: string): void {
    if (this.#down.has(code)) return;
    this.#down.add(code);
    this.#downAt.set(code, this.#time);
    this.#events.push({ code, down: true });
  }

  keyUp(code: string): void {
    if (!this.#down.delete(code)) return;
    this.#downAt.delete(code);
    this.#events.push({ code, down: false });
  }

  /** Mouse button index as in DOM MouseEvent.button (0 left, 1 middle, 2 right, 3/4 side buttons). */
  mouseButton(index: number, isDown: boolean): void {
    if (isDown) this.keyDown(`Mouse${index}`);
    else this.keyUp(`Mouse${index}`);
  }

  /** Relative mouse movement in counts. Accumulates until the next tick. */
  mouseMove(dx: number, dy: number): void {
    this.#mouseDx += dx;
    this.#mouseDy += dy;
  }

  wheel(deltaY: number): void {
    if (deltaY === 0) return;
    const code = deltaY < 0 ? 'WheelUp' : 'WheelDown';
    this.#pulses.set(code, WHEEL_PULSE_SECONDS);
    this.#events.push({ code, down: true });
  }

  /**
   * Release everything, for example when the window loses focus. Toggled layers stay as they are; buttons that were
   * latched on, taps that were still running and presses that were waiting to be decided do not.
   */
  releaseAll(): void {
    this.#down.clear();
    this.#downAt.clear();
    this.#events = [];
    this.#presses.clear();
    this.#timed = [];
    this.#latchedOut.clear();
    this.#pulses.clear();
    this.#mouseDx = 0;
    this.#mouseDy = 0;
  }

  /** Switch off all toggled layers, for example when the game and the profile have drifted out of sync. */
  clearLatched(): void {
    this.#latched.clear();
    this.#latchedOut.clear();
  }

  /** Buttons and triggers a latch action has switched on, as "b:cross" or "t:l2". */
  get latchedOutputs(): string[] {
    return [...this.#latchedOut.keys()];
  }

  get latchedLayers(): string[] {
    return [...this.#latched];
  }

  #compile(): void {
    const p = this.#profile;
    this.#layers = p.layers.map((layer) => {
      const sets = new Map<string, BindingSet>();
      for (const [key, text] of Object.entries(layer.bindings)) {
        const parsed = parseActions(text);
        const k = splitBindingKey(key);
        if (!parsed || !k) continue;
        const set = sets.get(k.code) ?? {};
        set[k.activator] = parsed;
        sets.set(k.code, set);
      }
      return { layer, sets };
    });
    this.#presses.clear();
    const g = p.inGame;
    const horizontal = p.calibration.horizontal ?? modelTable(g.innerDeadzone, g.maxTurnRateAtFullStick, g.responseCurve);
    const vertical =
      p.calibration.vertical ?? horizontal.map(([stick, rate]): [number, number] => [stick, rate * g.verticalRateRatio]);
    this.#model = { shape: g.deadzoneShape, verticalRatio: g.verticalRateRatio, horizontal, vertical };
  }

  #isHeld(code: string): boolean {
    return this.#down.has(code) || this.#pulses.has(code);
  }

  #activeLayers(): CompiledLayer[] {
    return this.#layers.filter(
      (l, i) =>
        i > 0 && ((l.layer.holdKey !== null && this.#isHeld(l.layer.holdKey)) || this.#latched.has(l.layer.name)),
    );
  }

  /**
   * What an input does right now. A hold key of an active layer is looked up in that layer only, so holding it
   * does not also fire its default binding. Anything else is looked up from the last active layer back to default.
   */
  #resolve(code: string, active: CompiledLayer[]): BindingSet | null {
    const owners = active.filter((l) => l.layer.holdKey === code);
    const chain = owners.length > 0 ? [...owners].reverse() : [...active].reverse().concat(this.#layers[0] ?? []);
    for (const l of chain) {
      const set = l.sets.get(code);
      if (set) return set;
    }
    return null;
  }

  /** Does this key wait to see how the press ends? (A wheel notch has no length, so it never does.) */
  #deferred(code: string, set: BindingSet): boolean {
    return (set.long !== undefined || set.double !== undefined) && !code.startsWith('Wheel');
  }

  #press(action: Simple, ms: number): void {
    this.#timed.push({ until: this.#time + ms / 1000, action });
  }

  #flipLayer(name: string): void {
    if (this.#latched.has(name)) this.#latched.delete(name);
    else this.#latched.add(name);
  }

  #flipOutput(out: Output): void {
    const id = outputId(out);
    if (this.#latchedOut.has(id)) this.#latchedOut.delete(id);
    else this.#latchedOut.set(id, toSimple(out));
  }

  /**
   * A group of actions starts being held (a plain press goes down, a long press takes over, the second press of a
   * double press goes down). The parts that happen once happen here; the parts that last are applied every tick.
   * `least`: keep buttons down for at least a tap, so that a press that is let go at once is still seen by the game.
   */
  #begin(actions: Action[] | undefined, least: boolean): void {
    const k = this.#profile.keys;
    for (const a of actions ?? []) {
      if (a.kind === 'toggle') this.#flipLayer(a.layer);
      else if (a.kind === 'latch') this.#flipOutput(a.out);
      else if (a.kind === 'tap') this.#press(toSimple(a.out), a.ms ?? k.tapMs);
      else if (a.kind === 'hold') this.#press(toSimple(a.out), a.ms ?? k.holdMs);
      else if (least && (a.kind === 'button' || a.kind === 'trigger' || a.kind === 'stick')) this.#press(a, k.tapMs);
      else if (least && a.kind === 'turbo') this.#press({ kind: 'button', button: a.button }, k.tapMs);
    }
  }

  /** A group of actions fires once, with nothing held: a short press that was decided late, a start or release press. */
  #fire(actions: Action[] | undefined): void {
    this.#begin(actions, true);
  }

  #pressed(code: string, layers: CompiledLayer[]): void {
    const set = this.#resolve(code, layers);
    if (!set) return;
    this.#fire(set.start);
    if (!this.#deferred(code, set)) {
      this.#begin(set.regular, false);
      return;
    }
    const before = this.#presses.get(code);
    if (before?.waiting && set.double && this.#time - before.downAt <= this.#profile.keys.doublePressMs / 1000) {
      this.#presses.set(code, { set, downAt: this.#time, down: true, active: 'double', activeSince: this.#time, waiting: false });
      this.#begin(set.double, true);
      return;
    }
    if (before?.waiting) this.#fire(before.set.regular); // the first press stood alone after all
    this.#presses.set(code, { set, downAt: this.#time, down: true, active: null, activeSince: this.#time, waiting: false });
  }

  #released(code: string, layers: CompiledLayer[]): void {
    const s = this.#presses.get(code);
    const set = s?.set ?? this.#resolve(code, layers);
    if (s?.down) {
      s.down = false;
      if (s.active !== null) this.#presses.delete(code);
      else if (s.set.double && this.#time - s.downAt <= this.#profile.keys.doublePressMs / 1000) s.waiting = true;
      else {
        this.#fire(s.set.regular); // let go before it became a long press: the plain press, as a tap
        this.#presses.delete(code);
      }
    }
    this.#fire(set?.release);
  }

  /** Presses that are decided by time passing: a key held long enough, a second press that did not come. */
  #decide(): void {
    const k = this.#profile.keys;
    for (const [code, s] of this.#presses) {
      if (s.down && s.active === null && s.set.long && this.#time - s.downAt >= k.longPressMs / 1000) {
        s.active = 'long';
        s.activeSince = this.#time;
        this.#begin(s.set.long, true);
      } else if (!s.down && s.waiting && this.#time - s.downAt > k.doublePressMs / 1000) {
        this.#fire(s.set.regular);
        this.#presses.delete(code);
      }
    }
  }

  /**
   * Run `seconds` of fixed-size ticks and call `onTick` with each resulting state.
   *
   * Mouse events arrive once per display frame (about 16 ms), not once per tick (4 ms). Feeding a whole
   * frame's movement into the first tick makes the speed spike to several times its true value and trips
   * the speed limit on a perfectly ordinary movement. Here the movement accumulated since the last call
   * is spread evenly over the ticks, which keeps both the speed and the total angle right.
   */
  runFor(seconds: number, tickSeconds: number, onTick: (state: VirtualPadState) => void): void {
    const n = Math.max(1, Math.round(seconds / tickSeconds));
    const dx = this.#mouseDx / n;
    const dy = this.#mouseDy / n;
    this.#mouseDx = 0;
    this.#mouseDy = 0;
    for (let i = 0; i < n; i++) {
      this.#mouseDx += dx;
      this.#mouseDy += dy;
      onTick(this.tick(tickSeconds));
    }
  }

  /** Advance the engine by `dt` seconds and return the virtual pad state. */
  tick(dt: number): VirtualPadState {
    const p = this.#profile;
    const state = emptyPadState();

    // Presses and releases act in the order they happened, each resolved with the layers active at that moment.
    for (const e of this.#events.splice(0)) {
      const layers = this.#activeLayers();
      if (e.down) this.#pressed(e.code, layers);
      else this.#released(e.code, layers);
    }
    this.#decide();

    const active = this.#activeLayers();
    this.#activeNames = active.map((l) => l.layer.name);
    let leftScale = 1;
    let lookScale = 1;
    for (const l of active) {
      leftScale *= l.layer.leftStickScale;
      lookScale *= l.layer.lookScale;
    }

    const targets = {
      left: { up: 0, down: 0, left: 0, right: 0 },
      right: { up: 0, down: 0, left: 0, right: 0 },
    };
    let l2 = 0;
    let r2 = 0;

    const output = (action: Simple): void => {
      if (action.kind === 'button') {
        state.buttons |= BUTTON[action.button];
      } else if (action.kind === 'stick') {
        const t = targets[action.stick];
        t[action.dir] = Math.max(t[action.dir], action.amount);
      } else if (action.trigger === 'l2') l2 = Math.max(l2, action.amount);
      else r2 = Math.max(r2, action.amount);
    };
    /** The lasting part of a group that is being held since `since`. */
    const hold = (actions: Action[] | undefined, since: number): void => {
      for (const action of actions ?? []) {
        if (action.kind === 'button' || action.kind === 'stick' || action.kind === 'trigger') output(action);
        else if (action.kind === 'hold') output(toSimple(action.out));
        else if (action.kind === 'turbo') {
          // Starts pressed, then alternates at `hz` presses per second.
          if (Math.floor((this.#time - since) * action.hz * 2 + 1e-9) % 2 === 0) state.buttons |= BUTTON[action.button];
        }
      }
    };

    const held = new Set<string>([...this.#down, ...this.#pulses.keys()]);
    for (const code of held) {
      const s = this.#presses.get(code);
      if (s) {
        if (s.down && s.active !== null) hold(s.set[s.active], s.activeSince);
        continue;
      }
      const set = this.#resolve(code, active);
      if (!set || this.#deferred(code, set)) continue;
      hold(set.regular, this.#downAt.get(code) ?? this.#time);
    }
    this.#timed = this.#timed.filter((t) => t.until > this.#time + 1e-9);
    for (const t of this.#timed) output(t.action);
    for (const action of this.#latchedOut.values()) output(action);
    state.l2 = Math.round(l2 * 255);
    state.r2 = Math.round(r2 * 255);

    // Ramp key-driven stick directions toward their targets.
    const upStep = p.keys.rampUpMs > 0 ? (dt * 1000) / p.keys.rampUpMs : 1;
    const downStep = p.keys.rampDownMs > 0 ? (dt * 1000) / p.keys.rampDownMs : 1;
    for (const side of ['left', 'right'] as const) {
      for (const dir of DIRS) {
        const cur = this.#ramps[side][dir];
        const target = targets[side][dir];
        this.#ramps[side][dir] = target > cur ? Math.min(target, cur + upStep) : Math.max(target, cur - downStep);
      }
    }

    const left = this.#ramps.left;
    const right = this.#ramps.right;
    let [lx, ly] = clampUnit(left.right - left.left, left.down - left.up);
    lx *= leftScale;
    ly *= leftScale;
    let [rx, ry] = clampUnit(right.right - right.left, right.down - right.up);

    // Mouse look. Always stepped so smoothing decays after the mouse stops.
    const dx = this.#mouseDx;
    const dy = this.#mouseDy;
    this.#mouseDx = 0;
    this.#mouseDy = 0;
    const m = p.mouse;
    let capped = false;
    let rateX = 0;
    let rateY = 0;
    if (m.target === 'off') {
      this.#look.reset();
      this.#gyro.reset();
    } else {
      const step = this.#look.step(m, dx, dy, dt);
      rateX = step.rateX;
      rateY = step.rateY;
      capped = step.capped;
      if (m.target === 'right_stick') {
        // `lookScale`: the game turns the camera at a different speed in this context (aiming, for example),
        // so ask the stick for the rate that, after the game's scaling, gives the camera rate we want.
        const stick = rateToStick(step.rateX / lookScale, step.rateY / lookScale, m, this.#model);
        [rx, ry] = clampUnit(rx + stick.x, ry + stick.y);
        capped ||= stick.capped;
      } else {
        const g = this.#gyro.step(m, step.rateX, step.rateY, dt, ACCEL_REST);
        state.gyro = g.gyro;
        state.accel = g.accel;
        state.orient = g.orient;
        capped ||= g.capped;
      }
    }

    state.leftX = lx;
    state.leftY = ly;
    state.rightX = rx;
    state.rightY = ry;
    this.#diag = { rateX, rateY, capped, stickMagnitude: Math.hypot(rx, ry) };

    for (const [code, remaining] of this.#pulses) {
      if (remaining - dt <= 0) this.#pulses.delete(code);
      else this.#pulses.set(code, remaining - dt);
    }
    this.#time += dt;
    return state;
  }
}

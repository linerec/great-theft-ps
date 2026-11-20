// SPDX-License-Identifier: AGPL-3.0-only
//
// MappingEngine: keyboard, mouse and wheel events in, virtual DualSense state out.
// Time is injected through tick(dt) so behaviour is deterministic and testable.

import { modelTable } from './calibration.ts';
import { LookFilter, VirtualGyro, rateToStick, type StickModel } from './mouse.ts';
import { parseActions, type Action, type Layer, type Profile } from './profile.ts';
import { BUTTON, emptyPadState, type LookDiagnostics, type VirtualPadState } from './types.ts';

type Dir = 'up' | 'down' | 'left' | 'right';
const DIRS: Dir[] = ['up', 'down', 'left', 'right'];

interface Ramp {
  up: number;
  down: number;
  left: number;
  right: number;
}

interface CompiledLayer {
  layer: Layer;
  actions: Map<string, Action[]>;
}

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
  /** Inputs pressed since the last tick, in order. Toggle actions fire on these. */
  #edges: string[] = [];
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
    this.#edges.push(code);
  }

  keyUp(code: string): void {
    this.#down.delete(code);
    this.#downAt.delete(code);
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
    this.#edges.push(code);
  }

  /** Release everything, for example when the window loses focus. Toggled layers stay as they are. */
  releaseAll(): void {
    this.#down.clear();
    this.#downAt.clear();
    this.#edges = [];
    this.#pulses.clear();
    this.#mouseDx = 0;
    this.#mouseDy = 0;
  }

  /** Switch off all toggled layers, for example when the game and the profile have drifted out of sync. */
  clearLatched(): void {
    this.#latched.clear();
  }

  get latchedLayers(): string[] {
    return [...this.#latched];
  }

  #compile(): void {
    const p = this.#profile;
    this.#layers = p.layers.map((layer) => {
      const actions = new Map<string, Action[]>();
      for (const [code, text] of Object.entries(layer.bindings)) {
        const parsed = parseActions(text);
        if (parsed) actions.set(code, parsed);
      }
      return { layer, actions };
    });
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
  #resolve(code: string, active: CompiledLayer[]): Action[] {
    const owners = active.filter((l) => l.layer.holdKey === code);
    const chain = owners.length > 0 ? [...owners].reverse() : [...active].reverse().concat(this.#layers[0] ?? []);
    for (const l of chain) {
      const actions = l.actions.get(code);
      if (actions) return actions;
    }
    return [];
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

    // Toggle actions fire on the press itself, resolved with the layers active at that moment.
    if (this.#edges.length > 0) {
      const before = this.#activeLayers();
      for (const code of this.#edges.splice(0)) {
        for (const action of this.#resolve(code, before)) {
          if (action.kind !== 'toggle') continue;
          if (this.#latched.has(action.layer)) this.#latched.delete(action.layer);
          else this.#latched.add(action.layer);
        }
      }
    }

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

    const held = new Set<string>([...this.#down, ...this.#pulses.keys()]);
    for (const code of held) {
      for (const action of this.#resolve(code, active)) {
        if (action.kind === 'button') {
          state.buttons |= BUTTON[action.button];
        } else if (action.kind === 'stick') {
          const t = targets[action.stick];
          t[action.dir] = Math.max(t[action.dir], action.amount);
        } else if (action.kind === 'trigger') {
          if (action.trigger === 'l2') l2 = Math.max(l2, action.amount);
          else r2 = Math.max(r2, action.amount);
        } else if (action.kind === 'turbo') {
          // Starts pressed, then alternates at `hz` presses per second.
          const heldFor = this.#time - (this.#downAt.get(code) ?? this.#time);
          if (Math.floor(heldFor * action.hz * 2 + 1e-9) % 2 === 0) state.buttons |= BUTTON[action.button];
        }
      }
    }
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

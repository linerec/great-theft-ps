// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { linearModel, rateAt, stickFor, validateCalibration } from '../src/engine/calibration.ts';
import { MappingEngine } from '../src/engine/engine.ts';
import { defaultProfile, parseAction, parseProfileText, validateProfile, type Profile } from '../src/engine/profile.ts';
import { BUTTON, GYRO_LIMIT_RAD_S, type VirtualPadState } from '../src/engine/types.ts';

const DT = 0.004; // 250 Hz

function profileWith(patch: (p: Profile) => void): Profile {
  const p = defaultProfile();
  patch(p);
  return p;
}

/** Feed `counts` mouse counts spread evenly over `seconds`, then keep ticking for `tail` seconds. */
function moveMouse(
  engine: MappingEngine,
  axis: 'x' | 'y',
  counts: number,
  seconds: number,
  tail = 0,
  onTick?: (state: VirtualPadState) => void,
): void {
  const ticks = Math.round(seconds / DT);
  let sent = 0;
  for (let i = 0; i < ticks; i++) {
    const target = Math.round(((i + 1) * counts) / ticks);
    const n = target - sent;
    sent = target;
    if (axis === 'x') engine.mouseMove(n, 0);
    else engine.mouseMove(0, n);
    onTick?.(engine.tick(DT));
  }
  for (let i = 0; i < Math.round(tail / DT); i++) onTick?.(engine.tick(DT));
}

function settle(engine: MappingEngine, seconds: number): VirtualPadState {
  let s = engine.tick(DT);
  for (let i = 0; i < Math.round(seconds / DT); i++) s = engine.tick(DT);
  return s;
}

describe('calibration', () => {
  it('inverse is consistent with the forward table', () => {
    const table = linearModel(0.1, 360);
    for (const rate of [1, 20, 90, 200, 359]) {
      const { stick, saturated } = stickFor(table, rate);
      assert.equal(saturated, false);
      assert.ok(Math.abs(rateAt(table, stick) - rate) < 1e-9, `rate ${rate}`);
    }
  });

  it('jumps over the inner deadzone for tiny rates', () => {
    const { stick } = stickFor(linearModel(0.1, 360), 0.5);
    assert.ok(stick > 0.1 && stick < 0.11, `stick ${stick}`);
  });

  it('reports saturation above the table range and returns zero for zero', () => {
    assert.equal(stickFor(linearModel(0.1, 360), 500).saturated, true);
    assert.deepEqual(stickFor(linearModel(0.1, 360), 0), { stick: 0, saturated: false });
  });

  it('handles a measured non-linear table', () => {
    const table: [number, number][] = [[0, 0], [0.1, 0], [0.3, 30], [0.6, 150], [1, 400]];
    assert.deepEqual(validateCalibration(table, 't'), []);
    const { stick } = stickFor(table, 90);
    assert.ok(Math.abs(rateAt(table, stick) - 90) < 1e-9);
  });

  it('rejects invalid tables', () => {
    assert.ok(validateCalibration([[0, 0], [0.5, 100]], 't').length > 0, 'last point must be stick 1');
    assert.ok(validateCalibration([[0, 0], [0.6, 100], [0.4, 120], [1, 200]], 't').length > 0, 'non increasing stick');
    assert.ok(validateCalibration([[0, 0], [0.5, 200], [1, 100]], 't').length > 0, 'decreasing rate');
    assert.ok(validateCalibration([[0.1, 0], [1, 100]], 't').length > 0, 'first point must be zero');
    assert.ok(validateCalibration('x', 't').length > 0);
  });
});

describe('mouse to stick', () => {
  it('turns the camera by the intended angle (closed loop through the game model)', () => {
    const p = profileWith((q) => {
      q.mouse.smoothingMs = 0;
      q.mouse.degPerCount = 0.05;
    });
    const engine = new MappingEngine(p);
    const table = linearModel(p.inGame.innerDeadzone, p.inGame.maxTurnRateAtFullStick);
    let angle = 0;
    moveMouse(engine, 'x', 400, 1, 0.2, (s) => {
      angle += rateAt(table, Math.abs(s.rightX)) * Math.sign(s.rightX) * DT;
    });
    assert.ok(Math.abs(angle - 20) < 0.2, `expected 20 deg, got ${angle}`);
  });

  it('keeps the angle with smoothing on', () => {
    const p = profileWith((q) => {
      q.mouse.smoothingMs = 25;
    });
    const engine = new MappingEngine(p);
    const table = linearModel(p.inGame.innerDeadzone, p.inGame.maxTurnRateAtFullStick);
    let angle = 0;
    moveMouse(engine, 'x', 400, 1, 0.6, (s) => {
      angle += rateAt(table, Math.abs(s.rightX)) * Math.sign(s.rightX) * DT;
    });
    assert.ok(Math.abs(angle - 20) / 20 < 0.03, `expected about 20 deg, got ${angle}`);
  });

  it('works with a measured non-linear calibration table', () => {
    const table: [number, number][] = [[0, 0], [0.1, 0], [0.3, 30], [0.6, 150], [1, 400]];
    const p = profileWith((q) => {
      q.calibration.horizontal = table;
      q.mouse.smoothingMs = 0;
      q.mouse.maxTurnRate = 400;
    });
    const engine = new MappingEngine(p);
    let angle = 0;
    moveMouse(engine, 'x', 1000, 1, 0.2, (s) => {
      angle += rateAt(table, Math.abs(s.rightX)) * Math.sign(s.rightX) * DT;
    });
    assert.ok(Math.abs(angle - 50) < 0.5, `expected 50 deg, got ${angle}`);
  });

  it('enforces the speed limit and reports it', () => {
    const p = profileWith((q) => {
      q.mouse.smoothingMs = 0;
      q.mouse.maxTurnRate = 100;
    });
    const engine = new MappingEngine(p);
    // 5000 counts/s * 0.05 deg = 250 deg/s requested, capped at 100.
    moveMouse(engine, 'x', 5000, 0.2);
    engine.mouseMove(20, 0);
    const state = engine.tick(DT);
    assert.equal(engine.diagnostics.capped, true);
    assert.ok(Math.abs(engine.diagnostics.rateX - 100) < 1e-6);
    const expected = stickFor(linearModel(0.1, 360), 100).stick;
    assert.ok(Math.abs(state.rightX - expected) < 1e-9, `stick ${state.rightX} vs ${expected}`);
  });

  it('enforces the stick deflection cap', () => {
    const p = profileWith((q) => {
      q.mouse.smoothingMs = 0;
      q.mouse.maxTurnRate = 360;
      q.mouse.maxDeflection = 0.5;
    });
    const engine = new MappingEngine(p);
    engine.mouseMove(2000, 0);
    const state = engine.tick(DT);
    assert.ok(Math.hypot(state.rightX, state.rightY) <= 0.5 + 1e-9);
    assert.equal(engine.diagnostics.capped, true);
  });

  it('clears the inner deadzone for tiny movements and returns to zero when idle', () => {
    const p = profileWith((q) => {
      q.mouse.smoothingMs = 30;
    });
    const engine = new MappingEngine(p);
    engine.mouseMove(1, 0);
    const s = engine.tick(DT);
    assert.ok(Math.abs(s.rightX) > p.inGame.innerDeadzone, `stick ${s.rightX}`);
    const idle = settle(engine, 0.6);
    assert.equal(idle.rightX, 0);
    assert.equal(idle.rightY, 0);
  });

  it('applies the vertical scale and invert options', () => {
    const p = profileWith((q) => {
      q.mouse.smoothingMs = 0;
      q.mouse.verticalScale = 0.5;
      q.mouse.invertY = true;
    });
    const engine = new MappingEngine(p);
    engine.mouseMove(0, 20); // 20 * 0.05 deg * 0.5 / 0.004 s = 125 deg/s, below the 360 deg/s cap
    const s = engine.tick(DT);
    assert.ok(s.rightY < 0, 'inverted: moving the mouse down looks up');
    const expectedRate = (20 * 0.05 * 0.5) / DT;
    assert.ok(Math.abs(engine.diagnostics.rateY + expectedRate) < 1e-6);
    assert.equal(engine.diagnostics.capped, false);
  });

  it('a finer curve reduces slow movement and leaves the cap speed unchanged', () => {
    const slowRate = (curve: number): number => {
      const e = new MappingEngine(profileWith((q) => {
        q.mouse.smoothingMs = 0;
        q.mouse.curve = curve;
      }));
      e.mouseMove(10, 0); // 10 * 0.05 / 0.004 = 125 deg/s
      e.tick(DT);
      return e.diagnostics.rateX;
    };
    assert.ok(slowRate(1.5) < slowRate(1));
    // The curve is anchored at the speed limit: a request equal to maxTurnRate maps to itself.
    const atCap = new MappingEngine(profileWith((q) => {
      q.mouse.smoothingMs = 0;
      q.mouse.curve = 1.5;
    }));
    atCap.mouseMove(28.8, 0); // 28.8 * 0.05 / 0.004 = 360 deg/s = maxTurnRate
    atCap.tick(DT);
    assert.ok(Math.abs(atCap.diagnostics.rateX - 360) < 1e-6);
  });
});

describe('mouse to virtual gyro', () => {
  const gyroProfile = (patch?: (p: Profile) => void): Profile =>
    profileWith((q) => {
      q.mouse.target = 'gyro';
      q.mouse.smoothingMs = 0;
      q.mouse.maxTurnRate = 5000;
      patch?.(q);
    });

  it('integrates a 90 degree yaw into a matching orientation quaternion', () => {
    const engine = new MappingEngine(gyroProfile());
    let last: VirtualPadState | undefined;
    moveMouse(engine, 'x', 900, 1, 0, (s) => (last = s)); // 900 * 0.05 = 45 deg
    moveMouse(engine, 'x', 900, 1, 0, (s) => (last = s)); // another 45 deg
    assert.ok(last);
    const half = Math.PI / 4;
    assert.ok(Math.abs(last.orient.w - Math.cos(half)) < 1e-3, `w ${last.orient.w}`);
    assert.ok(Math.abs(last.orient.y - Math.sin(half)) < 1e-3, `y ${last.orient.y}`);
    assert.ok(Math.abs(Math.hypot(last.orient.x, last.orient.y, last.orient.z, last.orient.w) - 1) < 1e-9);
    assert.equal(engine.diagnostics.capped, false);
  });

  it('clamps the gyro to the limit the console-facing library can carry', () => {
    const engine = new MappingEngine(gyroProfile((q) => (q.mouse.degPerCount = 1)));
    engine.mouseMove(5000, 0); // far above 30 rad/s
    const s = engine.tick(DT);
    assert.ok(Math.abs(s.gyro.y - GYRO_LIMIT_RAD_S) < 1e-9, `gyro.y ${s.gyro.y}`);
    assert.equal(engine.diagnostics.capped, true);
  });

  it('keeps the accelerometer a unit gravity vector while rotating', () => {
    const engine = new MappingEngine(gyroProfile());
    let last: VirtualPadState | undefined;
    moveMouse(engine, 'y', 600, 1, 0, (s) => (last = s));
    assert.ok(last);
    assert.ok(Math.abs(Math.hypot(last.accel.x, last.accel.y, last.accel.z) - 1) < 1e-9);
  });

  it('leaves the stick untouched in gyro mode and honours axis mapping', () => {
    const engine = new MappingEngine(gyroProfile((q) => {
      q.mouse.gyro.yawAxis = 'z';
      q.mouse.gyro.pitchAxis = 'x';
      q.mouse.gyro.yawSign = -1;
    }));
    engine.mouseMove(100, 0);
    const s = engine.tick(DT);
    assert.equal(s.rightX, 0);
    assert.ok(s.gyro.z < 0 && s.gyro.y === 0);
  });
});

describe('keyboard', () => {
  it('maps WASD to the left stick and normalises diagonals', () => {
    const engine = new MappingEngine(defaultProfile());
    engine.keyDown('KeyW');
    engine.keyDown('KeyD');
    const s = settle(engine, 0.2);
    assert.ok(Math.abs(Math.hypot(s.leftX, s.leftY) - 1) < 1e-9);
    assert.ok(s.leftY < 0 && s.leftX > 0, 'up is negative Y, right is positive X');
  });

  it('cancels opposite keys and ramps smoothly', () => {
    const engine = new MappingEngine(profileWith((q) => (q.keys.rampUpMs = 100)));
    engine.keyDown('KeyA');
    engine.keyDown('KeyD');
    assert.equal(settle(engine, 0.3).leftX, 0);
    engine.keyUp('KeyA');
    const first = engine.tick(DT);
    assert.ok(first.leftX > 0 && first.leftX < 0.5, `ramping, got ${first.leftX}`);
  });

  it('applies the walk layer to the left stick and swallows its hold key', () => {
    const engine = new MappingEngine(defaultProfile());
    engine.keyDown('KeyW');
    engine.keyDown('KeyX');
    const s = settle(engine, 0.2);
    assert.ok(Math.abs(s.leftY + 0.45) < 1e-9, `leftY ${s.leftY}`);
    assert.equal(s.buttons, 0);
  });

  it('maps buttons, analog triggers and mouse buttons', () => {
    const engine = new MappingEngine(defaultProfile());
    engine.keyDown('Space');
    engine.mouseButton(0, true);
    const s = engine.tick(DT);
    assert.equal(s.buttons & BUTTON.cross, BUTTON.cross);
    assert.equal(s.r2, 255);
    engine.mouseButton(0, false);
    assert.equal(engine.tick(DT).r2, 0);
  });

  it('treats a wheel notch as a short press and releaseAll clears input', () => {
    const p = profileWith((q) => {
      q.layers[0]!.bindings['WheelUp'] = 'btn:l1';
    });
    const engine = new MappingEngine(p);
    engine.wheel(-1);
    assert.equal(engine.tick(DT).buttons & BUTTON.l1, BUTTON.l1);
    settle(engine, 0.1);
    assert.equal(engine.tick(DT).buttons & BUTTON.l1, 0);
    engine.keyDown('KeyW');
    engine.releaseAll();
    assert.equal(settle(engine, 0.2).leftY, 0);
  });

  it('supports partial trigger and stick amounts', () => {
    const p = profileWith((q) => {
      q.layers[0]!.bindings['KeyZ'] = 'trigger:l2:0.5';
    });
    const engine = new MappingEngine(p);
    engine.keyDown('KeyZ');
    assert.equal(engine.tick(DT).l2, 128);
  });
});

describe('profile validation', () => {
  it('accepts the default profile and round-trips through JSON', () => {
    const text = JSON.stringify(defaultProfile());
    const r = parseProfileText(text);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.profile, defaultProfile());
  });

  it('fills defaults for missing fields and drops unknown fields', () => {
    const r = validateProfile({ schema: 0, evil: { run: 'rm -rf /' }, mouse: { degPerCount: 0.1, extra: 1 } });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.profile.mouse.degPerCount, 0.1);
      assert.equal(r.profile.mouse.maxTurnRate, 360);
      assert.equal('evil' in r.profile, false);
      assert.equal('extra' in r.profile.mouse, false);
    }
  });

  it('rejects bad values with clear paths', () => {
    const cases: [unknown, RegExp][] = [
      [{ schema: 1 }, /schema/],
      [{ schema: 0, mouse: { maxDeflection: 2 } }, /mouse\.maxDeflection/],
      [{ schema: 0, mouse: { target: 'laser' } }, /mouse\.target/],
      [{ schema: 0, calibration: { horizontal: [[0, 0], [0.5, 10]] } }, /calibration\.horizontal/],
      [{ schema: 0, layers: [{ name: 'default', holdKey: null, bindings: { KeyW: 'btn:nope' } }] }, /KeyW/],
      [{ schema: 0, layers: [{ name: 'x', holdKey: null, bindings: {} }] }, /first layer/],
      [{ schema: 0, layers: [{ name: 'default', holdKey: null, bindings: { 'bad code': 'btn:cross' } }] }, /invalid input code/],
      [{ schema: 0, mouse: { gyro: { yawAxis: 'x', pitchAxis: 'x' } } }, /must differ/],
      ['nope', /object/],
    ];
    for (const [input, pattern] of cases) {
      const r = validateProfile(input);
      assert.equal(r.ok, false, JSON.stringify(input));
      if (!r.ok) assert.ok(r.errors.some((e) => pattern.test(e)), `${JSON.stringify(input)} -> ${r.errors.join('; ')}`);
    }
  });

  it('rejects oversized and malformed text', () => {
    assert.equal(parseProfileText('{'.repeat(10)).ok, false);
    assert.equal(parseProfileText(' '.repeat(70 * 1024)).ok, false);
  });

  it('parses action text strictly', () => {
    assert.deepEqual(parseAction('stick:left:up:0.5'), { kind: 'stick', stick: 'left', dir: 'up', amount: 0.5 });
    assert.equal(parseAction('stick:left:up:2'), null);
    assert.equal(parseAction('btn:cross:extra'), null);
    assert.equal(parseAction('trigger:r3'), null);
    assert.equal(parseAction('toString'), null);
  });
});

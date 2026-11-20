// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the GTA V style third-person test bed and the engine features it needs:
// turbo (sprint = tap X), layer toggle (on foot <-> vehicle), hold-key layers (aim), aim look scale.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MappingEngine } from '../src/engine/engine.ts';
import { defaultProfile, gtaProfile, parseAction, parseActions, validateProfile, type Profile } from '../src/engine/profile.ts';
import { BUTTON, emptyPadState } from '../src/engine/types.ts';
import { applyMeasuredCalibration, measureCalibration } from '../src/testbed/measure.ts';
import { TpsGame, defaultTpsSettings, rayBox, type TpsSettings } from '../src/testbed/tps.ts';

const DT = 0.004;

interface Rig {
  profile: Profile;
  settings: TpsSettings;
  engine: MappingEngine;
  game: TpsGame;
}

function rig(patchProfile?: (p: Profile) => void, patchGame?: (s: TpsSettings) => void): Rig {
  const profile = gtaProfile();
  patchProfile?.(profile);
  const settings = defaultTpsSettings();
  patchGame?.(settings);
  return { profile, settings, engine: new MappingEngine(profile), game: new TpsGame(settings) };
}

function step(r: Rig): void {
  r.game.update(r.engine.tick(DT), DT);
}

function hold(r: Rig, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) step(r);
}

function drive(r: Rig, dx: number, dy: number, seconds: number, tail = 0.5): void {
  const ticks = Math.round(seconds / DT);
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < ticks; i++) {
    const tx = Math.round(((i + 1) * dx) / ticks);
    const ty = Math.round(((i + 1) * dy) / ticks);
    r.engine.mouseMove(tx - sx, ty - sy);
    sx = tx;
    sy = ty;
    step(r);
  }
  hold(r, tail);
}

const pad = (patch: (p: ReturnType<typeof emptyPadState>) => void): ReturnType<typeof emptyPadState> => {
  const p = emptyPadState();
  patch(p);
  return p;
};

describe('engine: actions for a third-person game', () => {
  it('parses turbo, toggle, none and compound actions strictly', () => {
    assert.deepEqual(parseAction('turbo:cross:12'), { kind: 'turbo', button: 'cross', hz: 12 });
    assert.deepEqual(parseAction('turbo:cross'), { kind: 'turbo', button: 'cross', hz: 10 });
    assert.equal(parseAction('turbo:cross:1'), null);
    assert.equal(parseAction('turbo:cross:99'), null);
    assert.equal(parseAction('turbo:nope'), null);
    assert.deepEqual(parseAction('toggle:vehicle'), { kind: 'toggle', layer: 'vehicle' });
    assert.equal(parseAction('toggle:bad name'), null);
    assert.deepEqual(parseAction('none'), { kind: 'none' });
    assert.equal(parseActions('btn:pyramid+toggle:vehicle')?.length, 2);
    assert.equal(parseActions('btn:pyramid+bogus'), null);
    assert.equal(parseActions('btn:cross+btn:cross+btn:cross+btn:cross+btn:cross'), null);
  });

  it('holding a turbo key presses the button about 10 times per second, starting immediately', () => {
    const engine = new MappingEngine(gtaProfile());
    engine.keyDown('ShiftLeft');
    let edges = 0;
    let prev = false;
    let firstTickPressed = false;
    for (let i = 0; i < 250; i++) {
      const on = (engine.tick(DT).buttons & BUTTON.cross) !== 0;
      if (i === 0) firstTickPressed = on;
      if (on && !prev) edges++;
      prev = on;
    }
    assert.equal(firstTickPressed, true);
    assert.ok(edges >= 9 && edges <= 11, `${edges} presses in one second`);
    engine.keyUp('ShiftLeft');
    assert.equal(engine.tick(DT).buttons & BUTTON.cross, 0);
  });

  it('F presses Triangle and toggles the vehicle layer once per press, not while held', () => {
    const engine = new MappingEngine(gtaProfile());
    engine.keyDown('KeyF');
    let s = engine.tick(DT);
    assert.equal(s.buttons & BUTTON.pyramid, BUTTON.pyramid);
    for (let i = 0; i < 100; i++) s = engine.tick(DT);
    assert.deepEqual(engine.latchedLayers, ['vehicle']);
    engine.keyUp('KeyF');
    engine.tick(DT);
    engine.keyDown('KeyF');
    engine.tick(DT);
    assert.deepEqual(engine.latchedLayers, []);
    assert.ok(!engine.activeLayers.includes('vehicle'));
  });

  it('in the vehicle layer W is the right trigger and S the left trigger, A and D still steer', () => {
    const engine = new MappingEngine(gtaProfile());
    engine.keyDown('KeyF');
    engine.keyUp('KeyF');
    engine.keyDown('KeyW');
    engine.keyDown('KeyD');
    let s = engine.tick(DT);
    for (let i = 0; i < 50; i++) s = engine.tick(DT);
    assert.equal(s.r2, 255);
    assert.equal(s.leftY, 0, 'W must not also push the stick forward');
    assert.ok(s.leftX > 0.9);
    engine.keyUp('KeyW');
    engine.keyDown('KeyS');
    s = engine.tick(DT);
    assert.equal(s.l2, 255);
    // Sprint is on foot only: Shift is bound to "none" inside the vehicle layer.
    engine.keyDown('ShiftLeft');
    assert.equal(engine.tick(DT).buttons & BUTTON.cross, 0);
  });

  it('a hold key is looked up in its own layer only (right click = L2, nothing from default)', () => {
    const engine = new MappingEngine(gtaProfile());
    engine.mouseButton(2, true);
    const s = engine.tick(DT);
    assert.equal(s.l2, 255);
    assert.ok(engine.activeLayers.includes('aim'));
    engine.mouseButton(2, false);
    assert.equal(engine.tick(DT).l2, 0);
  });

  it('rejects a toggle that points at a missing or default layer', () => {
    const bad = gtaProfile();
    bad.layers[0]!.bindings['KeyG'] = 'toggle:nowhere';
    assert.equal(validateProfile(bad).ok, false);
    const bad2 = gtaProfile();
    bad2.layers[0]!.bindings['KeyG'] = 'toggle:default';
    assert.equal(validateProfile(bad2).ok, false);
    assert.equal(validateProfile(gtaProfile()).ok, true);
    assert.equal(validateProfile(defaultProfile()).ok, true);
  });
});

describe('third-person game is pad-only and camera relative', () => {
  it('the left stick moves relative to the camera yaw', () => {
    const g = new TpsGame();
    g.yaw = 90; // camera looks south (+Z)
    const z0 = g.z;
    const x0 = g.x;
    const forward = pad((p) => (p.leftY = -1));
    for (let i = 0; i < 125; i++) g.update(forward, DT);
    assert.ok(g.z - z0 > 1.5, `moved ${g.z - z0} south`);
    assert.ok(Math.abs(g.x - x0) < 0.05);
  });

  it('walk, jog and run follow how far the stick is pushed', () => {
    const speedAt = (stick: number): number => {
      const g = new TpsGame();
      const p = pad((q) => (q.leftY = -stick));
      for (let i = 0; i < 250; i++) g.update(p, DT);
      return g.speed;
    };
    assert.ok(speedAt(0.3) < 2, `walk ${speedAt(0.3)}`);
    const jog = speedAt(0.7);
    assert.ok(jog > 2.5 && jog < 4.2, `jog ${jog}`);
    assert.ok(Math.abs(speedAt(1) - 5.2) < 0.05, `run ${speedAt(1)}`);
  });

  it('sprinting needs X pressed over and over: holding X does not sprint, tapping does', () => {
    // Pressed during the first half of every period: `hz` presses per second.
    const tapping = (i: number, hz: number): boolean => Math.floor(i * DT * hz * 2) % 2 === 0;
    const heldX = new TpsGame();
    const taps = new TpsGame();
    for (let i = 0; i < 500; i++) {
      heldX.update(pad((p) => ((p.leftY = -1), (p.buttons = BUTTON.cross))), DT);
      const pressed = tapping(i, 10);
      taps.update(pad((p) => ((p.leftY = -1), (p.buttons = pressed ? BUTTON.cross : 0))), DT);
    }
    assert.ok(Math.abs(heldX.speed - 5.2) < 0.05, `held ${heldX.speed}`);
    assert.ok(taps.speed > 7, `tapped ${taps.speed}`);
    // Too slow a tapping rate cannot keep the sprint up: sample many moments and look at the best.
    const slow = new TpsGame();
    let slowPeakAfterStart = 0;
    for (let i = 0; i < 2000; i++) {
      const pressed = tapping(i, 2);
      slow.update(pad((p) => ((p.leftY = -1), (p.buttons = pressed ? BUTTON.cross : 0))), DT);
      if (i > 1000) slowPeakAfterStart = Math.max(slowPeakAfterStart, slow.speed);
    }
    assert.ok(slowPeakAfterStart < taps.speed - 1.5, `2 Hz taps reach ${slowPeakAfterStart}, 10 Hz reach ${taps.speed}`);
  });

  it('jumps with Square and lands', () => {
    const g = new TpsGame();
    g.update(pad((p) => (p.buttons = BUTTON.box)), DT);
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      g.update(emptyPadState(), DT);
      peak = Math.max(peak, g.y);
    }
    assert.ok(peak > 0.8, `peak ${peak}`);
    assert.equal(g.y, 0);
  });

  it('aims with L2: the camera moves in close and the reticle appears', () => {
    const g = new TpsGame();
    const aim = pad((p) => (p.l2 = 255));
    for (let i = 0; i < 250; i++) g.update(aim, DT);
    assert.equal(g.aiming, true);
    assert.ok(g.aimAmount > 0.99 && g.fov < 51);
  });

  it('shoots along the camera ray: hits a target in front, not one behind a building', () => {
    const g = new TpsGame();
    const o = g.cameraPose();
    const cp = Math.cos((o.pitch * Math.PI) / 180);
    g.targets = [
      {
        x: o.x + cp * Math.cos((o.yaw * Math.PI) / 180) * 10,
        z: o.z + cp * Math.sin((o.yaw * Math.PI) / 180) * 10,
        flash: 0,
        respawn: 0,
      },
    ];
    g.update(pad((p) => (p.r2 = 255)), DT);
    assert.equal(g.hits, 1);

    const blocked = new TpsGame();
    blocked.x = 14;
    blocked.z = 20;
    blocked.yaw = 270; // facing north, the building (8..20, 8..18) is in the way
    blocked.targets = [{ x: 14, z: 6, flash: 0, respawn: 0 }];
    blocked.update(pad((p) => (p.r2 = 255)), DT);
    assert.equal(blocked.shots, 1);
    assert.equal(blocked.hits, 0);
  });

  it('ray/box helper agrees with simple cases', () => {
    assert.equal(rayBox(0, 0.5, 0.5, 1, 0, 0, 5, 0, 0, 6, 1, 1), 5);
    assert.equal(rayBox(0, 0.5, 0.5, -1, 0, 0, 5, 0, 0, 6, 1, 1), Infinity);
  });
});

describe('driving', () => {
  const nearCar = (): TpsGame => {
    const g = new TpsGame();
    g.x = 46;
    g.z = 41;
    return g;
  };

  it('Triangle near the car gets in, R2 accelerates, steering turns, L2 brakes, Triangle gets out', () => {
    const g = nearCar();
    g.update(pad((p) => (p.buttons = BUTTON.pyramid)), DT);
    assert.equal(g.inVehicle, true);
    g.update(emptyPadState(), DT);

    for (let i = 0; i < 500; i++) g.update(pad((p) => (p.r2 = 255)), DT);
    assert.ok(g.car.speed > 12, `speed ${g.car.speed}`);
    const heading = g.car.heading;
    for (let i = 0; i < 125; i++) g.update(pad((p) => ((p.r2 = 255), (p.leftX = 1))), DT);
    assert.ok(Math.abs(((g.car.heading - heading + 540) % 360) - 180) > 5, 'steering right changes the heading');

    for (let i = 0; i < 600; i++) g.update(pad((p) => (p.l2 = 255)), DT);
    assert.ok(g.car.speed <= 0.5, `braked to ${g.car.speed}`);

    g.update(pad((p) => (p.buttons = BUTTON.pyramid)), DT);
    assert.equal(g.inVehicle, false);
  });

  it('cannot get in from far away, and L2 from standstill reverses', () => {
    const far = new TpsGame();
    far.update(pad((p) => (p.buttons = BUTTON.pyramid)), DT);
    assert.equal(far.inVehicle, false);

    const g = nearCar();
    g.update(pad((p) => (p.buttons = BUTTON.pyramid)), DT);
    g.update(emptyPadState(), DT);
    for (let i = 0; i < 250; i++) g.update(pad((p) => (p.l2 = 255)), DT);
    assert.ok(g.car.speed < -2, `reverse ${g.car.speed}`);
  });

  it('the camera swings back behind the car when the right stick is left alone', () => {
    const g = nearCar();
    g.update(pad((p) => (p.buttons = BUTTON.pyramid)), DT);
    g.update(emptyPadState(), DT);
    g.yaw = 100; // look away from the heading (0)
    for (let i = 0; i < 1500; i++) g.update(pad((p) => (p.r2 = 255)), DT);
    const diff = Math.abs(((g.yaw - g.car.heading + 540) % 360) - 180);
    assert.ok(diff < 15, `camera ${g.yaw}, car ${g.car.heading}`);
  });
});

describe('WASD + mouse in the GTA style profile', () => {
  it('mouse movement turns the third-person camera by the intended angle', () => {
    const r = rig();
    drive(r, 400, 0, 1);
    assert.ok(Math.abs(r.game.yawTotal - 20) < 0.3, `turned ${r.game.yawTotal}`);
    const d = rig();
    drive(d, 300, 300, 1);
    assert.ok(Math.abs(d.game.yawTotal - 15) < 0.5, `yaw ${d.game.yawTotal}`);
    assert.ok(Math.abs(d.game.pitch - (-8 - 15)) < 0.5, `pitch ${d.game.pitch}`);
  });

  it('W runs, Shift (auto-tapped X) sprints, X key walks', () => {
    const run = rig();
    run.engine.keyDown('KeyW');
    hold(run, 2);
    assert.ok(Math.abs(run.game.speed - 5.2) < 0.1, `run ${run.game.speed}`);

    const sprint = rig();
    sprint.engine.keyDown('KeyW');
    sprint.engine.keyDown('ShiftLeft');
    hold(sprint, 2);
    assert.ok(sprint.game.speed > 7, `sprint ${sprint.game.speed}`);

    const walk = rig();
    walk.engine.keyDown('KeyW');
    walk.engine.keyDown('KeyX');
    hold(walk, 2);
    assert.ok(walk.game.speed < 2, `walk ${walk.game.speed}`);
  });

  it('left click shoots and right click aims', () => {
    const r = rig();
    r.engine.mouseButton(2, true);
    hold(r, 0.5);
    assert.equal(r.game.aiming, true);
    r.engine.mouseButton(0, true);
    hold(r, 0.5);
    assert.ok(r.game.shots >= 3, `shots ${r.game.shots}`);
  });

  it('on foot to driving and back, all from the keyboard: F, W, A or D, S, F', () => {
    const r = rig();
    r.game.x = 46;
    r.game.z = 41;
    r.engine.keyDown('KeyF');
    hold(r, 0.05);
    r.engine.keyUp('KeyF');
    assert.equal(r.game.inVehicle, true);
    assert.deepEqual(r.engine.latchedLayers, ['vehicle']);

    r.engine.keyDown('KeyW');
    hold(r, 2);
    assert.ok(r.game.car.speed > 8, `driving ${r.game.car.speed}`);
    r.engine.keyDown('KeyD');
    hold(r, 1);
    assert.ok(Math.abs(((r.game.car.heading + 540) % 360) - 180) > 3, 'steered');
    r.engine.keyUp('KeyW');
    r.engine.keyUp('KeyD');
    r.engine.keyDown('KeyS');
    hold(r, 3);
    r.engine.keyUp('KeyS');
    assert.ok(r.game.car.speed < 0.5, `S brakes to a stop (and then reverses): ${r.game.car.speed}`);
    hold(r, 6); // coast to a halt before getting out
    assert.ok(Math.abs(r.game.car.speed) < 0.5, `coasted to ${r.game.car.speed}`);
    r.engine.keyDown('KeyF');
    hold(r, 0.05);
    r.engine.keyUp('KeyF');
    assert.equal(r.game.inVehicle, false);
    assert.deepEqual(r.engine.latchedLayers, []);
  });
});

describe('what the mapping cannot know, and how it is handled', () => {
  it('aim sensitivity differs in the game: unmapped it is off, with an aim layer scale it is exact', () => {
    const off = rig(undefined, (s) => (s.aimLookScale = 0.5));
    off.engine.mouseButton(2, true);
    drive(off, 400, 0, 1);
    assert.ok(Math.abs(off.game.yawTotal - 10) < 0.5, `unmapped ${off.game.yawTotal}`);

    const exact = rig(
      (p) => (p.layers.find((l) => l.name === 'aim')!.lookScale = 0.5),
      (s) => (s.aimLookScale = 0.5),
    );
    exact.engine.mouseButton(2, true);
    drive(exact, 400, 0, 1);
    assert.ok(Math.abs(exact.game.yawTotal - 20) / 20 < 0.03, `with lookScale ${exact.game.yawTotal}`);
  });

  it('auto calibration measures the aim scale and stores it in the aim layer', () => {
    const settings = { ...defaultTpsSettings(), aimLookScale: 0.55 };
    const m = measureCalibration(() => new TpsGame({ ...settings }));
    assert.ok(Math.abs(m.aimLookScale - 0.55) < 0.01, `measured ${m.aimLookScale}`);
    const profile = gtaProfile();
    applyMeasuredCalibration(profile, m);
    assert.ok(Math.abs(profile.layers.find((l) => l.name === 'aim')!.lookScale - 0.55) < 0.01);
    const r = { profile, settings, engine: new MappingEngine(profile), game: new TpsGame(settings) };
    r.engine.mouseButton(2, true);
    drive(r, 400, 0, 1);
    assert.ok(Math.abs(r.game.yawTotal - 20) / 20 < 0.03, `calibrated aim ${r.game.yawTotal}`);
  });

  it('calibration works for the third-person game too, including a curved response', () => {
    const settings = { ...defaultTpsSettings(), responseCurve: 1.5, innerDeadzone: 0.15, verticalRatio: 0.7 };
    const profile = gtaProfile();
    applyMeasuredCalibration(profile, measureCalibration(() => new TpsGame({ ...settings })));
    const r = { profile, settings, engine: new MappingEngine(profile), game: new TpsGame(settings) };
    drive(r, 600, 0, 1);
    assert.ok(Math.abs(r.game.yawTotal - 30) / 30 < 0.04, `yaw ${r.game.yawTotal}`);
  });

  it('GTA style look acceleration breaks a fixed angle per count on sustained fast sweeps; off it is exact', () => {
    // 3000 counts/s * 0.05 deg = 150 deg/s held for a second pushes the stick past the acceleration threshold.
    const accel = rig(undefined, (s) => (s.lookAcceleration = 1));
    drive(accel, 3000, 0, 1);
    assert.ok(accel.game.yawTotal > 150 * 1.15, `with acceleration turned ${accel.game.yawTotal} (150 expected)`);

    const none = rig(undefined, (s) => (s.lookAcceleration = 0));
    drive(none, 3000, 0, 1);
    assert.ok(Math.abs(none.game.yawTotal - 150) / 150 < 0.02, `no acceleration turned ${none.game.yawTotal}`);

    // Slow movement never reaches the threshold, so it is unaffected either way.
    const slow = rig(undefined, (s) => (s.lookAcceleration = 1));
    drive(slow, 400, 0, 1);
    assert.ok(Math.abs(slow.game.yawTotal - 20) < 0.3, `slow ${slow.game.yawTotal}`);
  });

  it('assisted aim pulls the camera toward a target and shifts the angle (the mapping cannot know)', () => {
    const g = new TpsGame({ ...defaultTpsSettings(), aimAssist: true });
    const o = g.cameraPose();
    g.targets = [{ x: o.x + 10, z: o.z + 1.2, flash: 0, respawn: 0 }];
    const aim = pad((p) => (p.l2 = 255));
    const before = g.yaw;
    for (let i = 0; i < 250; i++) g.update(aim, DT);
    assert.ok(g.yaw !== before, 'the camera moved by itself');
  });
});

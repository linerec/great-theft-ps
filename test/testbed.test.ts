// SPDX-License-Identifier: AGPL-3.0-only
//
// Integration tests: real keyboard/mouse events -> MappingEngine -> virtual pad ->
// the pad-only test bed game. These check the end result a player would see.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateCalibration } from '../src/engine/calibration.ts';
import { MappingEngine } from '../src/engine/engine.ts';
import { defaultProfile, type Profile } from '../src/engine/profile.ts';
import { emptyPadState } from '../src/engine/types.ts';
import { FpsGame, defaultGameSettings, gameLookRates, type GameSettings } from '../src/testbed/fps.ts';
import { applyMeasuredCalibration, measureCalibration } from '../src/testbed/measure.ts';

const DT = 0.004;

interface Rig {
  profile: Profile;
  settings: GameSettings;
  engine: MappingEngine;
  game: FpsGame;
}

function rig(patchProfile?: (p: Profile) => void, patchGame?: (g: GameSettings) => void): Rig {
  const profile = defaultProfile();
  patchProfile?.(profile);
  const settings = defaultGameSettings();
  patchGame?.(settings);
  return { profile, settings, engine: new MappingEngine(profile), game: new FpsGame(settings) };
}

function step(r: Rig): void {
  r.game.update(r.engine.tick(DT), DT);
}

/** Move the mouse by (dx, dy) counts spread evenly over `seconds`, then keep ticking for `tail` seconds. */
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
  for (let i = 0; i < Math.round(tail / DT); i++) step(r);
}

function hold(r: Rig, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) step(r);
}

function calibrate(r: Rig): void {
  applyMeasuredCalibration(r.profile, measureCalibration(r.settings));
  r.engine.setProfile(r.profile);
}

describe('test bed game is pad-only and behaves like a console game', () => {
  it('applies the inner deadzone and turns at the full-stick rate', () => {
    const s = defaultGameSettings();
    assert.deepEqual(gameLookRates(s, 0.05, 0), { yaw: 0, down: 0 });
    const full = gameLookRates(s, 1, 0);
    assert.ok(Math.abs(full.yaw - 360) < 1e-9);
    const half = gameLookRates(s, 0.55, 0); // (0.55-0.1)/0.9 = 0.5
    assert.ok(Math.abs(half.yaw - 180) < 1e-9);
  });

  it('a held stick turns the camera 360 degrees in one second', () => {
    const game = new FpsGame();
    const pad = emptyPadState();
    pad.rightX = 1;
    for (let i = 0; i < 250; i++) game.update(pad, DT);
    assert.ok(Math.abs(game.yawTotal - 360) < 0.01, `turned ${game.yawTotal}`);
  });

  it('moves forward with the left stick, strafes and collides with walls', () => {
    const forward = new FpsGame();
    const pad = emptyPadState();
    pad.leftY = -1;
    for (let i = 0; i < 250; i++) forward.update(pad, DT);
    assert.ok(Math.abs(forward.x - (8.5 + 3.2)) < 0.05, `x ${forward.x}`);

    const strafe = new FpsGame();
    strafe.x = 4.5;
    strafe.y = 7.5;
    const right = emptyPadState();
    right.leftX = 1;
    for (let i = 0; i < 125; i++) strafe.update(right, DT);
    assert.ok(strafe.y > 8.9 && Math.abs(strafe.x - 4.5) < 1e-9, `y ${strafe.y}`);

    for (let i = 0; i < 1250; i++) forward.update(pad, DT);
    assert.ok(forward.x < 15 - 0.2 && forward.x > 14.5, `stopped at the wall, x ${forward.x}`);
  });

  it('hits a target in front and is blocked by a wall in between', () => {
    const g = new FpsGame();
    g.targets = [{ x: 12.5, y: 8.5, flash: 0, respawn: 0 }];
    const fire = emptyPadState();
    fire.r2 = 255;
    g.update(fire, DT);
    assert.equal(g.hits, 1);

    const blocked = new FpsGame();
    blocked.yaw = 90; // facing south into the pillar at (8,9)
    blocked.targets = [{ x: 8.5, y: 12.5, flash: 0, respawn: 0 }];
    blocked.update(fire, DT);
    assert.equal(blocked.shots, 1);
    assert.equal(blocked.hits, 0);
  });

  it('respawns a hit target somewhere else', () => {
    const g = new FpsGame();
    g.targets = [{ x: 12.5, y: 8.5, flash: 0, respawn: 0 }];
    const fire = emptyPadState();
    fire.r2 = 255;
    g.update(fire, DT);
    const idle = emptyPadState();
    for (let i = 0; i < 300; i++) g.update(idle, DT);
    const t = g.targets[0]!;
    assert.equal(t.respawn <= 0, true);
    assert.ok(!(t.x === 12.5 && t.y === 8.5));
  });
});

describe('WASD + mouse drive the pad-only game', () => {
  it('W moves forward and D strafes right through the mapping', () => {
    const r = rig();
    r.engine.keyDown('KeyW');
    hold(r, 1);
    assert.ok(Math.abs(r.game.x - (8.5 + 3.2)) < 0.1, `x ${r.game.x}`);
    r.engine.keyUp('KeyW');
    r.game.reset();
    r.game.x = 4.5;
    r.game.y = 7.5;
    r.engine.keyDown('KeyD');
    hold(r, 0.5);
    assert.ok(r.game.y > 8.8, `y ${r.game.y}`);
  });

  it('left click fires and right click aims down sights', () => {
    const r = rig();
    r.engine.mouseButton(0, true);
    hold(r, 0.5);
    assert.ok(r.game.shots >= 3, `shots ${r.game.shots}`);
    r.engine.mouseButton(0, false);
    r.engine.mouseButton(2, true);
    hold(r, 0.5);
    assert.ok(r.game.fov < 60, `fov ${r.game.fov}`);
  });

  it('mouse movement turns the camera by the intended angle (400 counts x 0.05 deg = 20 deg)', () => {
    const r = rig();
    drive(r, 400, 0, 1);
    assert.ok(Math.abs(r.game.yawTotal - 20) < 0.3, `turned ${r.game.yawTotal}`);
  });

  it('looking down with the mouse looks down in the game (non-inverted)', () => {
    const r = rig();
    drive(r, 0, 200, 1);
    assert.ok(Math.abs(r.game.pitch + 10) < 0.3, `pitch ${r.game.pitch}`);
  });

  it('turns by the intended angles on a diagonal sweep (radial-deadzone game)', () => {
    const r = rig();
    drive(r, 300, 300, 1);
    assert.ok(Math.abs(r.game.yawTotal - 15) < 0.5, `yaw ${r.game.yawTotal}`);
    assert.ok(Math.abs(r.game.pitch + 15) < 0.5, `pitch ${r.game.pitch}`);
  });

  it('keeps the angle for slow diagonal movement near the deadzone', () => {
    const r = rig();
    drive(r, 40, 40, 1); // 2 deg/s on each axis, just above the deadzone
    assert.ok(Math.abs(r.game.yawTotal - 2) < 0.15, `yaw ${r.game.yawTotal}`);
    assert.ok(Math.abs(r.game.pitch + 2) < 0.15, `pitch ${r.game.pitch}`);
  });

  it('honours the speed limit: a violent flick cannot exceed it', () => {
    const r = rig((p) => (p.mouse.maxTurnRate = 120));
    let peak = 0;
    for (let i = 0; i < 125; i++) {
      r.engine.mouseMove(80, 0);
      step(r);
      peak = Math.max(peak, Math.abs(r.game.lastYawRate));
    }
    assert.ok(peak <= 120.5, `peak ${peak}`);
    assert.ok(peak > 110, `peak ${peak}`);
  });

  it('a game with a non-linear response curve is off until calibrated, then accurate', () => {
    const uncalibrated = rig(undefined, (g) => (g.responseCurve = 1.6));
    drive(uncalibrated, 400, 0, 1);
    assert.ok(uncalibrated.game.yawTotal < 10, `uncalibrated turned ${uncalibrated.game.yawTotal}`);

    const r = rig(undefined, (g) => (g.responseCurve = 1.6));
    calibrate(r);
    drive(r, 400, 0, 1);
    assert.ok(Math.abs(r.game.yawTotal - 20) / 20 < 0.03, `calibrated turned ${r.game.yawTotal}`);
    const fast = rig(undefined, (g) => (g.responseCurve = 1.6));
    calibrate(fast);
    drive(fast, 1200, 0, 1);
    assert.ok(Math.abs(fast.game.yawTotal - 60) / 60 < 0.03, `calibrated fast turned ${fast.game.yawTotal}`);
  });

  it('calibration also fixes an axial-deadzone game with a different vertical rate', () => {
    const r = rig(undefined, (g) => {
      g.deadzoneShape = 'axial';
      g.innerDeadzone = 0.2;
      g.verticalRatio = 0.6;
      g.responseCurve = 1.3;
    });
    calibrate(r);
    assert.equal(r.profile.inGame.deadzoneShape, 'axial');
    drive(r, 300, 300, 1);
    assert.ok(Math.abs(r.game.yawTotal - 15) / 15 < 0.04, `yaw ${r.game.yawTotal}`);
    assert.ok(Math.abs(r.game.pitch + 15) / 15 < 0.04, `pitch ${r.game.pitch}`);
  });

  it('virtual gyro turns a gyro-aim game with no stick ceiling', () => {
    const r = rig(
      (p) => {
        p.mouse.target = 'gyro';
        p.mouse.maxTurnRate = 5000;
      },
      (g) => (g.gyroAim = true),
    );
    drive(r, 900, 0, 1);
    assert.ok(Math.abs(r.game.yawTotal - 45) < 0.6, `yaw ${r.game.yawTotal}`);
    // 1500 deg/s is far beyond the 360 deg/s a full stick gives.
    const fast = rig(
      (p) => {
        p.mouse.target = 'gyro';
        p.mouse.maxTurnRate = 5000;
      },
      (g) => (g.gyroAim = true),
    );
    let peak = 0;
    for (let i = 0; i < 100; i++) {
      fast.engine.mouseMove(30, 0); // 30 * 0.05 / 0.004 = 375 deg/s ... then faster:
      step(fast);
    }
    for (let i = 0; i < 100; i++) {
      fast.engine.mouseMove(120, 0); // 1500 deg/s
      step(fast);
      peak = Math.max(peak, Math.abs(fast.game.lastYawRate));
    }
    assert.ok(peak > 1000, `peak ${peak}`);
  });

  it('ADS scaling in the game changes the angle (the mapping does not know about ADS)', () => {
    const r = rig(undefined, (g) => (g.adsLookScale = 0.5));
    r.engine.mouseButton(2, true);
    drive(r, 400, 0, 1);
    assert.ok(Math.abs(r.game.yawTotal - 10) < 0.5, `yaw ${r.game.yawTotal}`);
  });
});

describe('frame-batched mouse input', () => {
  // A browser delivers mouse movement once per display frame (4 ticks of 4 ms), not once per tick.
  const FRAME_TICKS = 4;

  // 2400 counts/s * 0.05 deg = 120 deg/s, delivered as 40 counts per 16 ms frame (62 frames, 124 deg total).
  const naive = (r: Rig): number => {
    let peak = 0;
    for (let frame = 0; frame < 62; frame++) {
      r.engine.mouseMove(40, 0); // the whole frame lands in the first tick
      for (let i = 0; i < FRAME_TICKS; i++) {
        step(r);
        peak = Math.max(peak, Math.abs(r.game.lastYawRate));
      }
    }
    for (let i = 0; i < 125; i++) step(r);
    return peak;
  };
  const spread = (r: Rig): number => {
    let peak = 0;
    for (let frame = 0; frame < 62; frame++) {
      r.engine.mouseMove(40, 0);
      r.engine.runFor(FRAME_TICKS * DT, DT, (s) => {
        r.game.update(s, DT);
        peak = Math.max(peak, Math.abs(r.game.lastYawRate));
      });
    }
    for (let i = 0; i < 125; i++) step(r);
    return peak;
  };

  it('naive batching makes the speed jump around: peak far above the true 120 deg/s', () => {
    const r = rig(); // default 12 ms smoothing hides it from the total angle but not from the speed
    const peak = naive(r);
    assert.ok(Math.abs(r.game.yawTotal - 124) < 1.5, `turned ${r.game.yawTotal}`);
    assert.ok(peak > 180, `peak ${peak} deg/s`);
  });

  it('without smoothing, naive batching clips at the speed limit and loses angle', () => {
    const r = rig((p) => (p.mouse.smoothingMs = 0));
    naive(r);
    assert.ok(r.game.yawTotal < 100, `naive turned ${r.game.yawTotal} (124 without loss)`);
  });

  it('runFor keeps the speed steady and the angle right, with or without smoothing', () => {
    for (const smoothingMs of [12, 0]) {
      const r = rig((p) => (p.mouse.smoothingMs = smoothingMs));
      const peak = spread(r);
      assert.ok(Math.abs(r.game.yawTotal - 124) < 1.5, `smoothing ${smoothingMs}: turned ${r.game.yawTotal}`);
      assert.ok(peak < 135, `smoothing ${smoothingMs}: peak ${peak} deg/s (true speed is 120)`);
    }
  });

  it('runFor with no pending movement behaves like plain ticks', () => {
    const a = rig();
    const b = rig();
    a.engine.keyDown('KeyW');
    b.engine.keyDown('KeyW');
    for (let i = 0; i < 100; i++) step(a);
    for (let i = 0; i < 25; i++) b.engine.runFor(FRAME_TICKS * DT, DT, (s) => b.game.update(s, DT));
    assert.ok(Math.abs(a.game.x - b.game.x) < 1e-9);
  });
});

describe('black-box calibration', () => {
  it('measures a valid table with the deadzone edge, full-stick rate and shape', () => {
    const m = measureCalibration(defaultGameSettings());
    assert.deepEqual(validateCalibration(m.horizontal, 'm'), []);
    const edge = m.horizontal.find((p) => p[0] > 0)![0];
    assert.ok(Math.abs(edge - 0.1) < 0.002, `deadzone edge ${edge}`);
    assert.ok(Math.abs(m.fullStickRate - 360) < 1);
    assert.ok(Math.abs(m.verticalRateRatio - 1) < 1e-6);
    assert.equal(m.deadzoneShape, 'radial');
  });

  it('detects an axial deadzone and a different vertical rate', () => {
    const m = measureCalibration({ ...defaultGameSettings(), deadzoneShape: 'axial', innerDeadzone: 0.2, verticalRatio: 0.6 });
    assert.equal(m.deadzoneShape, 'axial');
    assert.ok(Math.abs(m.verticalRateRatio - 0.6) < 0.01, `ratio ${m.verticalRateRatio}`);
  });
});

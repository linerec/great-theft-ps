// SPDX-License-Identifier: AGPL-3.0-only
//
// The whole measuring procedure (src/engine/lookcalibrate.ts) against a made-up game whose real response is known.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { flickRate, rng, SimIo, World, type GameOptions } from './support/lookworld.ts';
import { rateAt, validateCalibration, type CalPoint } from '../src/engine/calibration.ts';
import { CalibrationError, calibrateLook, choosePitchLevels, DEFAULT_LEVELS, type CalibrationProgress, type LookIo } from '../src/engine/lookcalibrate.ts';
import type { TimedFrame } from '../src/engine/lookmeasure.ts';

/** A game table with a deadzone: nothing up to `dz`, then straight up to `full` degrees a second. */
const linear = (dz: number, full: number): CalPoint[] => [[0, 0], [dz, 0], [1, full]];
const curved = (dz: number, full: number, curve: number): CalPoint[] => {
  const pts: CalPoint[] = [[0, 0], [dz, 0]];
  for (let i = 1; i <= 16; i++) pts.push([i === 16 ? 1 : dz + ((1 - dz) * i) / 16, full * Math.pow(i / 16, curve)]);
  return pts;
};

/** What the measurement should say for a stick level: the flick-window average of the game (window 100..700 ms after it shows). */
const expected = (g: GameOptions, s: number): number => flickRate(g, s, (g.latencyMs ?? 0) + 100, (g.latencyMs ?? 0) + 700);

/** A SimIo that remembers every stick it was asked to hold. */
class RecordingIo extends SimIo {
  calls: Array<{ kind: 'hold' | 'rest'; x: number; y: number; ms: number }> = [];
  override async hold(x: number, y: number, ms: number, stop?: (f: TimedFrame[]) => boolean): Promise<TimedFrame[]> {
    this.calls.push({ kind: 'hold', x, y, ms });
    return super.hold(x, y, ms, stop);
  }
  override async rest(ms: number): Promise<TimedFrame[]> {
    this.calls.push({ kind: 'rest', x: 0, y: 0, ms });
    return super.rest(ms);
  }
}

describe('measuring a game\'s response from its picture', () => {
  const game: GameOptions = { table: linear(0.22, 200), latencyMs: 120, rampStart: 0.5, rampMs: 400, verticalRatio: 0.6 };

  it('recovers the response of a game with a deadzone, a delay and a camera that speeds up the longer the stick is held', async () => {
    const io = new RecordingIo(game);
    const progress: CalibrationProgress[] = [];
    const r = await calibrateLook(io, { onProgress: (p) => void progress.push(p) });

    assert.equal(r.scaleSource, 'turn', 'the scale came from a full turn of the camera');
    assert.ok(Math.abs(r.pxPerDeg - 3.2) / 3.2 < 0.04, `pixels per degree ${r.pxPerDeg.toFixed(3)} (3.2)`);
    assert.ok(Math.abs(r.latencyMs - 120) <= 50, `delay ${r.latencyMs} ms (120)`);
    assert.deepEqual(validateCalibration(r.table, 'table'), []);
    assert.ok(Math.abs(r.innerDeadzone - 0.22) < 0.05, `deadzone ${r.innerDeadzone.toFixed(3)} (0.22)`);

    for (const s of [0.3, 0.4, 0.5, 0.6, 0.8, 1]) {
      const want = expected(game, s);
      const got = rateAt(r.table, s);
      assert.ok(Math.abs(got - want) <= 0.08 * want + 2, `stick ${s}: ${got.toFixed(1)} deg/s, the game gives ${want.toFixed(1)}`);
    }
    for (const s of [0.05, 0.1, 0.15, 0.2]) assert.ok(rateAt(r.table, s) < 3, `nothing happens at ${s}`);

    assert.ok(r.verticalRateRatio !== null && r.verticalRateRatio > 0.42 && r.verticalRateRatio < 0.68, `vertical ${r.verticalRateRatio} (about 0.6)`);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.levels.length, DEFAULT_LEVELS.length);
    assert.ok(r.levels.every((l) => l.ok));

    // Progress runs from 1 to the last step, in order, and names what it is doing.
    assert.equal(progress.length, progress.at(-1)!.steps);
    assert.deepEqual(progress.map((p) => p.step), progress.map((_, i) => i + 1));
    assert.deepEqual([...new Set(progress.map((p) => p.phase))], ['prepare', 'turn', 'yaw', 'build', 'pitch']);

    // Only the right stick is ever touched, within its range, and the stick is let go at the end.
    for (const c of io.calls) assert.ok(Math.abs(c.x) <= 1 && Math.abs(c.y) <= 1);
    assert.equal(io.calls.at(-1)!.kind, 'rest');
    assert.deepEqual(io.stick, { x: 0, y: 0 });
    assert.ok(Math.abs(io.pitch) <= 25);
  });

  it('recovers a different game: a bigger deadzone, a curve, a faster camera, a longer delay, and a stream at 30 frames a second', async () => {
    const g: GameOptions = { table: curved(0.3, 320, 1.6), latencyMs: 250, rampStart: 1, rampMs: 1, verticalRatio: 0.8 };
    const r = await calibrateLook(new SimIo({ ...g, fps: 30, seed: 11, world: new World({ seed: 9 }) }));
    assert.equal(r.scaleSource, 'turn');
    assert.ok(Math.abs(r.latencyMs - 250) <= 70, `delay ${r.latencyMs}`);
    assert.ok(Math.abs(r.innerDeadzone - 0.3) < 0.06, `deadzone ${r.innerDeadzone.toFixed(3)}`);
    for (const s of [0.4, 0.6, 0.8, 1]) {
      const want = expected(g, s);
      const got = rateAt(r.table, s);
      assert.ok(Math.abs(got - want) <= 0.1 * want + 3, `stick ${s}: ${got.toFixed(1)} deg/s, the game gives ${want.toFixed(1)}`);
    }
    assert.ok(r.verticalRateRatio !== null && Math.abs(r.verticalRateRatio - 0.8) < 0.12, `vertical ${r.verticalRateRatio}`);
  });

  it('falls back to an assumed field of view, and says so, when the camera cannot be seen coming all the way round', async () => {
    const g: GameOptions = { table: linear(0.2, 120), latencyMs: 100 };
    const r = await calibrateLook(new SimIo(g), { spinMaxMs: 1500 }); // a full turn at 120 deg/s takes 3 s
    assert.equal(r.scaleSource, 'assumed');
    assert.ok(r.warnings.some((w) => w.code === 'scale-assumed'));
    // The made-up world has 3.2 pixels a degree, which is what 256 pixels over 80 degrees comes to: so the table is still right.
    assert.ok(Math.abs(rateAt(r.table, 1) - expected(g, 1)) < 0.1 * 120);
  });

  it('measures what a game with no deadzone does', async () => {
    const g: GameOptions = { table: [[0, 0], [1, 150]], latencyMs: 80 };
    const r = await calibrateLook(new SimIo(g), { levels: [0.1, 0.2, 0.4, 0.6, 0.8, 1], pitchLevels: [0.6] });
    assert.ok(r.innerDeadzone < 0.05, `deadzone ${r.innerDeadzone}`);
    assert.ok(Math.abs(rateAt(r.table, 0.5) - 75) < 10);
  });
});

describe('which deflections are used for up and down', () => {
  const levels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  it('takes moderate ones: fast enough to measure, slow enough not to reach how far the camera can look', () => {
    const picked = choosePitchLevels(linear(0.2, 200), levels);
    assert.ok(picked.length >= 2 && picked.length <= 3);
    for (const s of picked) assert.ok(rateAt(linear(0.2, 200), s) >= 10 && rateAt(linear(0.2, 200), s) <= 70, `stick ${s}`);
  });
  it('takes the gentlest one that turns the camera when the game is fast', () => {
    const t: CalPoint[] = [[0, 0], [0.1, 0], [0.12, 150], [1, 400]];
    assert.deepEqual(choosePitchLevels(t, levels), [0.2]);
  });
  it('takes none when nothing turns the camera gently or at all', () => assert.deepEqual(choosePitchLevels([[0, 0], [1, 5]], levels), []));
});

describe('when the measurement cannot be made', () => {
  const frame = (v: number, t: number): TimedFrame => ({ t, img: { w: 256, h: 144, data: new Uint8Array(256 * 144).fill(v) } });

  it('says there is no video when frames do not come', async () => {
    const io: LookIo = { hold: async () => [], rest: async () => [frame(90, 0), frame(90, 100)] };
    await assert.rejects(calibrateLook(io), (e: unknown) => e instanceof CalibrationError && e.code === 'no-video');
  });

  it('says there is nothing to follow when the picture is blank (a menu, a loading screen)', async () => {
    const still = Array.from({ length: 40 }, (_, i) => frame(90, i * 16));
    const io: LookIo = { hold: async () => still, rest: async () => still };
    await assert.rejects(calibrateLook(io), (e: unknown) => e instanceof CalibrationError && e.code === 'no-texture');
  });

  it('says the camera did not turn when the stick changes nothing (a menu, a cut scene)', async () => {
    const world = new World({ seed: 2 });
    const rand = rng(1);
    const mk = (n: number): TimedFrame[] => Array.from({ length: n }, (_, i) => ({ t: i * 16.7, img: world.render(0, 0, 0, 1.5, rand) }));
    const io: LookIo = { hold: async (_x, _y, ms) => mk(Math.round(ms / 16.7)), rest: async (ms) => mk(Math.round(ms / 16.7)) };
    await assert.rejects(calibrateLook(io), (e: unknown) => e instanceof CalibrationError && e.code === 'no-motion');
  });

  it('can be stopped between steps, and stops touching the stick at once', async () => {
    const io = new RecordingIo({ table: linear(0.2, 200), latencyMs: 100 });
    let stop = false;
    await assert.rejects(
      calibrateLook(io, { onProgress: (p) => void (p.phase === 'yaw' && p.stick === 0.2 && (stop = true)), aborted: () => stop }),
      (e: unknown) => e instanceof CalibrationError && e.code === 'aborted',
    );
    // The last thing it did before stopping was between steps, with the stick let go.
    assert.equal(io.calls.at(-1)!.kind, 'rest');
    assert.ok(io.calls.length < 12);
  });
});

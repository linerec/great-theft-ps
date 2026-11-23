// SPDX-License-Identifier: AGPL-3.0-only
//
// Measuring a game's stick-to-camera response on a real console, from its video. This project's own.
//
// The procedure, run while the game is in a scene where the camera can turn (not a menu, not a cut scene):
//   1. Rest, and look at the picture: is there video, is there enough in it to follow?
//   2. Hold the right stick to the right at full deflection until the picture comes all the way round to where it was:
//      one full turn is 360 degrees, which gives the scale (pixels per degree) without knowing the game's field of
//      view. The first movement shows how long the stick takes to be seen (console, network, video).
//   3. For each deflection from small to full, alternating left and right so the camera stays about where it was: hold,
//      and measure how fast the picture moves in a window that starts a little after the first movement. The window is
//      what a flick of the mouse looks like (about half a second), so a game that speeds up the longer the stick is
//      held is measured the way the mouse will use it.
//   4. A few short pushes up and down for the vertical rate relative to the horizontal.
// Then the table (see buildTable).
//
// Nothing here knows about the browser: the stick and the frames come through `LookIo`, so the whole procedure is tested
// against a simulated game (test/lookcalibrate.test.ts).

import { rateAt, type CalPoint } from './calibration.ts';
import { buildTable, measureRate, onsetMs, RevisitDetector, shiftAlongX, type TimedFrame } from './lookmeasure.ts';

export interface LookIo {
  /**
   * Hold the right stick at (x, y) for at most `ms`, then give the frames shown meanwhile, timed in ms from the moment
   * the stick was set. `stop` is asked after every new frame with all the frames so far; true ends the hold early.
   */
  hold(x: number, y: number, ms: number, stop?: (frames: TimedFrame[]) => boolean): Promise<TimedFrame[]>;
  /** Let go of the stick and wait `ms`; the frames shown meanwhile, timed from the start of the wait. */
  rest(ms: number): Promise<TimedFrame[]>;
}

export type WarningCode = 'scale-assumed' | 'latency-assumed' | 'low-support' | 'direction-mixed' | 'pitch-missing';

export interface CalibrationWarning {
  code: WarningCode;
  detail?: string;
}

export type CalibrationErrorCode = 'no-video' | 'no-texture' | 'no-motion' | 'aborted' | 'failed';

export class CalibrationError extends Error {
  code: CalibrationErrorCode;

  constructor(code: CalibrationErrorCode, message: string) {
    super(message);
    this.name = 'CalibrationError';
    this.code = code;
  }
}

export interface CalibrationProgress {
  step: number;
  steps: number;
  phase: 'prepare' | 'turn' | 'yaw' | 'pitch' | 'build';
  /** The deflection being measured, for yaw and pitch. */
  stick?: number;
}

export interface CalibrateOptions {
  /** Horizontal deflections to measure, small to full. */
  levels?: number[];
  /** Deflections for the vertical measurement. Left out, they are chosen from the horizontal table (see choosePitchLevels). */
  pitchLevels?: number[];
  /** Length of the measuring window, ms. Default 600. */
  windowMs?: number;
  /** How the horizontal field of view is assumed when no full turn could be seen, degrees. Default 80. */
  assumedHFovDeg?: number;
  /** The longest the full-turn step may take, ms. Default 8000. */
  spinMaxMs?: number;
  /** Rest between steps, ms (the video's delay is added). Default 500. */
  restMs?: number;
  onProgress?: (p: CalibrationProgress) => void;
  aborted?: () => boolean;
}

export const DEFAULT_LEVELS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

/**
 * Which deflections to use for the vertical measurement. How far up and down the camera can look is limited, so a push
 * must not turn it far: only deflections at which the horizontal rate is moderate are used (fast enough to measure,
 * slow enough that a third of a second does not reach the limit), up to three of them spread over that range.
 */
export function choosePitchLevels(table: CalPoint[], levels: number[]): number[] {
  const usable = levels.filter((s) => {
    const r = rateAt(table, s);
    return r >= 10 && r <= 70;
  });
  if (usable.length === 0) {
    // A fast game: the gentlest deflection that turns the camera at all.
    const first = levels.find((s) => rateAt(table, s) >= 8);
    return first === undefined ? [] : [first];
  }
  return usable.length <= 3 ? usable : [usable[0]!, usable[Math.floor(usable.length / 2)]!, usable[usable.length - 1]!];
}

export interface CalibrationLevel {
  stick: number;
  /** Turn rate in the window, degrees per second; NaN when it could not be measured. */
  degPerSec: number;
  pxPerSec: number;
  /** Share of frame pairs that gave a clear answer. */
  support: number;
  ok: boolean;
}

export interface CalibrationResult {
  table: CalPoint[];
  innerDeadzone: number;
  fullStickRate: number;
  /** Vertical rate relative to horizontal, or null when it could not be measured. */
  verticalRateRatio: number | null;
  pxPerDeg: number;
  /** 'turn': from a full turn of the camera. 'assumed': from the assumed field of view. */
  scaleSource: 'turn' | 'assumed';
  /** How long a stick takes to be seen in the video, ms. */
  latencyMs: number;
  levels: CalibrationLevel[];
  warnings: CalibrationWarning[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export async function calibrateLook(io: LookIo, o: CalibrateOptions = {}): Promise<CalibrationResult> {
  const levels = o.levels ?? DEFAULT_LEVELS;
  const windowMs = o.windowMs ?? 600;
  const restMs = o.restMs ?? 500;
  const warnings: CalibrationWarning[] = [];
  // The vertical steps are planned once the horizontal table is known; until then three are counted.
  let steps = 2 + levels.length + (o.pitchLevels?.length ?? 3) + 1;
  let step = 0;
  const progress = (phase: CalibrationProgress['phase'], stick?: number): void => {
    if (o.aborted?.()) throw new CalibrationError('aborted', 'stopped');
    o.onProgress?.({ step: ++step, steps, phase, ...(stick !== undefined ? { stick } : {}) });
  };

  // 1. Is there something to follow?
  progress('prepare');
  const still = await io.rest(700);
  if (still.length < 12) throw new CalibrationError('no-video', `only ${still.length} frames came in 0.7 s`);
  const ref = still[still.length - 1]!.img;
  const look = shiftAlongX(still[0]!.img, ref);
  if (look.textured < 4) throw new CalibrationError('no-texture', `only ${look.textured} of ${look.total} parts of the picture have anything in them to follow`);

  // 2. One full turn: scale and delay.
  progress('turn');
  const detector = new RevisitDetector(ref);
  let fed = 0;
  const spin = await io.hold(1, 0, o.spinMaxMs ?? 8000, (frames) => {
    while (fed < frames.length) if (detector.push(frames[fed++]!)) return true;
    return false;
  });
  await io.rest(restMs + 1000); // the camera goes on turning for a while after the stick is let go (and the video lags)
  const spinRate = measureRate(spin, 0, Infinity, 'x');
  const onset = onsetMs(spin, 'x');
  if (!spinRate || onset === null) throw new CalibrationError('no-motion', 'the picture did not move with the stick at full deflection');
  const latency = Math.round(onset);

  const assumedPpd = ref.w / (o.assumedHFovDeg ?? 80);
  let pxPerDeg = assumedPpd;
  let scaleSource: CalibrationResult['scaleSource'] = 'assumed';
  const rev = detector.result;
  if (rev) {
    const upto = spin.filter((f) => f.t <= rev.t);
    const path = measureRate(upto, 0, rev.t, 'x');
    if (path) {
      // The path covers a full turn less (or plus) what is left over: the picture at the end is `rev.shift` pixels from the start.
      const full = Math.abs(path.displacement) - Math.sign(path.displacement) * rev.shift;
      const ppd = full / 360;
      if (ppd >= 1.2 && ppd <= 9) {
        pxPerDeg = ppd;
        scaleSource = 'turn';
      }
    }
  }
  if (scaleSource === 'assumed') warnings.push({ code: 'scale-assumed', detail: `${(ref.w / pxPerDeg).toFixed(0)} degrees across` });

  // 3. Horizontal levels.
  const measured: CalibrationLevel[] = [];
  const signs: number[] = [];
  for (let k = 0; k < levels.length; k++) {
    const s = levels[k]!;
    progress('yaw', s);
    const dir = k % 2 === 0 ? 1 : -1;
    const frames = await io.hold(dir * s, 0, latency + 100 + windowMs + 100);
    await io.rest(restMs + latency);
    const m = measureRate(frames, latency + 100, latency + 100 + windowMs, 'x');
    const ok = m !== null && m.support >= 0.5;
    const pxPerSec = m ? m.pxPerSec : NaN;
    const degPerSec = ok ? Math.abs(pxPerSec) / pxPerDeg : NaN;
    if (ok && degPerSec > 3) signs.push(Math.sign(pxPerSec) * dir);
    measured.push({ stick: s, degPerSec, pxPerSec, support: m ? m.support : 0, ok });
  }
  const weak = measured.filter((l) => !l.ok).length;
  if (weak > 0) warnings.push({ code: 'low-support', detail: `${weak} of ${measured.length} levels could not be measured clearly` });
  if (signs.length >= 4) {
    const same = signs.filter((x) => x === signs[0]).length;
    if (same < signs.length - 1) warnings.push({ code: 'direction-mixed' });
  }

  progress('build');
  let built;
  try {
    built = buildTable(measured.filter((l) => l.ok).map((l) => ({ stick: l.stick, rate: l.degPerSec })));
  } catch (e) {
    throw new CalibrationError('no-motion', (e as Error).message);
  }

  // 4. Vertical.
  const pitchLevels = o.pitchLevels ?? choosePitchLevels(built.table, levels);
  steps = step + pitchLevels.length;
  const ratios: number[] = [];
  for (const s of pitchLevels) {
    progress('pitch', s);
    const yaw = rateAt(built.table, s);
    const got: number[] = [];
    for (const dir of [-1, 1]) {
      const frames = await io.hold(0, dir * s, latency + 80 + 300 + 100);
      await io.rest(restMs + latency);
      const m = measureRate(frames, latency + 80, latency + 80 + 300, 'y');
      if (m && m.support >= 0.5) got.push(Math.abs(m.pxPerSec) / pxPerDeg);
    }
    if (got.length > 0 && yaw > 5) ratios.push(got.reduce((a, b) => a + b, 0) / got.length / yaw);
  }
  let verticalRateRatio: number | null = null;
  if (ratios.length > 0) verticalRateRatio = clamp(Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100) / 100, 0.1, 4);
  else warnings.push({ code: 'pitch-missing' });

  return { table: built.table, innerDeadzone: built.innerDeadzone, fullStickRate: built.fullStickRate, verticalRateRatio, pxPerDeg, scaleSource, latencyMs: latency, levels: measured, warnings };
}

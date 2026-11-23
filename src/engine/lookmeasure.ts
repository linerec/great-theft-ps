// SPDX-License-Identifier: AGPL-3.0-only
//
// Measuring how fast a game turns the camera, from its VIDEO. This project's own. No browser APIs: it works on small
// grey-scale pictures, so it is tested on its own (test/lookmeasure.test.ts) with a synthetic world.
//
// Why from the video: a console tells nothing about its camera. What can be seen is how far the picture moves between
// two frames while the right stick is held at a known value. That gives the game's stick-to-turn-rate table, the thing
// the mouse mapping needs (see calibration.ts and "How mouse look works" in the README).
//
// The pieces:
//  - shiftAlongX / shiftAlongY: how far the picture moved between two frames, in pixels, by block matching. Many blocks
//    vote and the median wins, so what stays put (the character, the HUD) and what moves by itself (traffic) are outvoted
//    by the background, as long as that is the larger part of the picture.
//  - measureRate: pixels per second over a stretch of frames, with the gap between the two frames of a pair chosen so
//    that the picture moves a few pixels (a tenth of a pixel cannot be told from noise).
//  - similarity / RevisitDetector: has the camera come all the way round? One full turn is 360 degrees by definition,
//    which gives the scale (pixels per degree) without knowing the game's field of view.
//  - buildTable: stick level -> degrees per second, as a table the engine can use (CalPoint[]).

import { validateCalibration, rateAt, type CalPoint } from './calibration.ts';

/** A grey-scale picture, 0..255 per pixel, row by row. */
export interface Gray {
  w: number;
  h: number;
  data: ArrayLike<number>;
}

/** A picture and the moment it was shown, in ms on any clock that runs evenly. */
export interface TimedFrame {
  t: number;
  img: Gray;
}

export interface ShiftOptions {
  /** The most the picture may have moved along the axis, px. Default 32. */
  search?: number;
  /** How far across the axis to look as well, px (the camera is not turned that way, so a little). Default 1. */
  cross?: number;
  /** Blocks along and across the axis. Default 8 x 4. */
  cols?: number;
  rows?: number;
  /** Every n-th pixel of a block is compared. Default 2. */
  stride?: number;
  /** A block whose pixels differ from their mean by less than this on average is flat (sky, a wall) and is skipped. Default 3. */
  minTexture?: number;
}

export interface ShiftEstimate {
  /** How far the picture moved from `a` to `b`, px; positive is to the right (down for the vertical version). NaN: not measurable. */
  shift: number;
  /** Blocks with enough texture, blocks that gave a clear answer, and blocks that agree with the median to within a pixel. */
  textured: number;
  used: number;
  agree: number;
  total: number;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};

/** The picture turned on its side, so that a vertical shift can be measured with the horizontal code. */
export function transpose(g: Gray): Gray {
  const out = new Uint8Array(g.w * g.h);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) out[x * g.h + y] = g.data[y * g.w + x]!;
  return { w: g.h, h: g.w, data: out };
}

/** How far the picture moved sideways from `a` to `b`: block matching, median over the blocks that gave a clear answer. */
export function shiftAlongX(a: Gray, b: Gray, o: ShiftOptions = {}): ShiftEstimate {
  const S = o.search ?? 32;
  const C = o.cross ?? 1;
  const cols = o.cols ?? 8;
  const rows = o.rows ?? 4;
  const stride = o.stride ?? 2;
  const minTexture = o.minTexture ?? 3;
  const w = a.w;
  const h = a.h;
  if (b.w !== w || b.h !== h) throw new Error('the two pictures differ in size');
  const total = cols * rows;
  const x0 = S;
  const x1 = w - S;
  const y0 = C;
  const y1 = h - C;
  const bw = Math.floor((x1 - x0) / cols);
  const bh = Math.floor((y1 - y0) / rows);
  if (bw < 4 || bh < 4) return { shift: NaN, textured: 0, used: 0, agree: 0, total };
  const A = a.data;
  const B = b.data;
  const nS = 2 * S + 1;
  const curve = new Float64Array(nS);
  const shifts: number[] = [];
  let textured = 0;
  for (let ri = 0; ri < rows; ri++) {
    for (let ci = 0; ci < cols; ci++) {
      const bx = x0 + ci * bw;
      const by = y0 + ri * bh;
      let sum = 0;
      let n = 0;
      for (let y = by; y < by + bh; y += stride) for (let x = bx; x < bx + bw; x += stride, n++) sum += A[y * w + x]!;
      const mean = sum / n;
      let dev = 0;
      for (let y = by; y < by + bh; y += stride) for (let x = bx; x < bx + bw; x += stride) dev += Math.abs(A[y * w + x]! - mean);
      if (dev / n < minTexture) continue;
      textured++;
      curve.fill(Infinity);
      for (let sy = -C; sy <= C; sy++) {
        for (let sx = -S; sx <= S; sx++) {
          let sad = 0;
          for (let y = by; y < by + bh; y += stride) {
            const ra = y * w;
            const rb = (y + sy) * w + sx;
            for (let x = bx; x < bx + bw; x += stride) sad += Math.abs(A[ra + x]! - B[rb + x]!);
          }
          if (sad < curve[sx + S]!) curve[sx + S] = sad;
        }
      }
      let best = 0;
      for (let i = 1; i < nS; i++) if (curve[i]! < curve[best]!) best = i;
      if (best === 0 || best === nS - 1) continue; // at the edge of what is searched: the real shift may be further out
      const med = [...curve].sort((p, q) => p - q)[nS >> 1]!;
      if ((med - curve[best]!) / (med + n) < 0.05) continue; // no clear match
      const c0 = curve[best - 1]!;
      const c1 = curve[best]!;
      const c2 = curve[best + 1]!;
      const den = c0 - 2 * c1 + c2;
      const sub = den > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (c0 - c2)) / den)) : 0;
      shifts.push(best - S + sub);
    }
  }
  if (shifts.length < 3) return { shift: NaN, textured, used: shifts.length, agree: 0, total };
  const med = median(shifts);
  const agreeing = shifts.filter((s) => Math.abs(s - med) <= 1);
  return { shift: agreeing.reduce((s, x) => s + x, 0) / agreeing.length, textured, used: shifts.length, agree: agreeing.length, total };
}

/** The same for up and down. The camera turns less that way, so less is searched; the blocks are laid out to fit. */
export function shiftAlongY(a: Gray, b: Gray, o: ShiftOptions = {}): ShiftEstimate {
  return shiftAlongX(transpose(a), transpose(b), { search: 16, cols: 4, rows: 8, ...o });
}

export type Axis = 'x' | 'y';

/** A picture made smaller by averaging `f` x `f` pixels, kept for as long as the picture lives. */
const shrunk = new WeakMap<object, Map<number, Gray>>();
export function shrink(g: Gray, f: number): Gray {
  if (f <= 1) return g;
  let byFactor = shrunk.get(g);
  if (!byFactor) shrunk.set(g, (byFactor = new Map()));
  const have = byFactor.get(f);
  if (have) return have;
  const w = Math.floor(g.w / f);
  const h = Math.floor(g.h / f);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) sum += g.data[(y * f + j) * g.w + x * f + i]!;
      out[y * w + x] = sum / (f * f);
    }
  }
  const made = { w, h, data: out };
  byFactor.set(f, made);
  return made;
}

/** How far the picture may have moved between two frames, before it has to be looked at from further away (px at full size). */
const reach = (axis: Axis, f: number): number => (f === 1 ? (axis === 'x' ? 32 : 16) : axis === 'x' ? 28 : 14);

/** One measurement at one distance: the shift is in pixels of the picture as it was given, whatever the factor. */
function shiftAt(axis: Axis, a: Gray, b: Gray, f: number, search?: number): ShiftEstimate {
  const A = shrink(a, f);
  const B = shrink(b, f);
  const S = f === 1 ? search ?? reach(axis, 1) : reach(axis, 2);
  const o: ShiftOptions = axis === 'x' ? (f === 1 ? { search: S } : { search: S, cols: 4, rows: 4 }) : f === 1 ? { search: S } : { search: S, cols: 4, rows: 4 };
  const e = axis === 'x' ? shiftAlongX(A, B, o) : shiftAlongY(A, B, o);
  return { ...e, shift: e.shift * f };
}

export interface RateMeasure {
  /** Signed: the picture moved this many pixels a second (right / down is positive). */
  pxPerSec: number;
  /** Pairs of frames that gave a clear answer, out of those tried. */
  accepted: number;
  pairs: number;
  /** accepted / pairs */
  support: number;
  /** The gap between the two frames of a pair, in frames. */
  lag: number;
  /** 1, or 2 when the picture moved too far between frames to follow at full size and was looked at from further away. */
  factor: number;
  /** Total movement of the picture over the stretch, px, and the time that covers, s. */
  displacement: number;
  seconds: number;
}

const accepted = (e: ShiftEstimate): boolean => Number.isFinite(e.shift) && e.agree >= 3 && e.agree / Math.max(1, e.textured) >= 0.5;

/**
 * How fast the picture moved over the frames shown between `from` and `to` (ms), in pixels a second. Null when it cannot
 * be told (too few frames, nothing to match). A picture that moves too far between frames is looked at again from
 * further away (half size).
 */
export function measureRate(frames: TimedFrame[], from: number, to: number, axis: Axis, o: { search?: number } = {}): RateMeasure | null {
  const sel = frames.filter((f) => f.t >= from && f.t <= to);
  if (sel.length < 4) return null;
  for (const f of [1, 2]) {
    const r = measureRateAt(sel, axis, f, o.search);
    if (r) return r;
  }
  return null;
}

function measureRateAt(sel: TimedFrame[], axis: Axis, factor: number, search: number | undefined): RateMeasure | null {
  const S = factor === 1 ? search ?? reach(axis, 1) : reach(axis, 2);
  const est = (i: number, j: number): ShiftEstimate => shiftAt(axis, sel[i]!.img, sel[j]!.img, factor, search);

  // The gap between the two frames of a pair: the smallest at which the picture has moved about two pixels, and not so
  // far that it leaves what is searched. At least two pairs have to fit in the stretch.
  const candidates = [1, 2, 3, 4, 6, 8, 12, 16, 24].filter((l) => 2 * l <= sel.length - 1);
  if (candidates.length === 0) candidates.push(1);
  let chosen = candidates[candidates.length - 1]!;
  let any = false;
  for (const L of candidates) {
    const sizes: number[] = [];
    for (const at of [0.25, 0.5, 0.75]) {
      const i = Math.floor((sel.length - 1 - L) * at);
      const e = est(i, i + L);
      if (accepted(e)) sizes.push(Math.abs(e.shift) / factor);
    }
    if (sizes.length === 0) {
      if (L === 1) return null; // nothing can be matched even between neighbours: too far (or nothing to see)
      continue;
    }
    any = true;
    const typical = median(sizes);
    if (typical > 0.7 * S) {
      if (L === 1) return null; // too far between neighbours at this size: look from further away
      chosen = candidates[candidates.indexOf(L) - 1]!;
      break;
    }
    if (typical >= 2) {
      chosen = L;
      break;
    }
  }
  if (!any) return null;
  const lag = chosen;

  let sumD = 0;
  let sumT = 0;
  let pairs = 0;
  let ok = 0;
  for (let i = 0; i + lag < sel.length; i += lag) {
    pairs++;
    const e = est(i, i + lag);
    if (!accepted(e)) continue;
    ok++;
    sumD += e.shift;
    sumT += sel[i + lag]!.t - sel[i]!.t;
  }
  if (ok < 2 || sumT <= 0) return null;
  return { pxPerSec: sumD / (sumT / 1000), accepted: ok, pairs, support: ok / pairs, lag, factor, displacement: sumD, seconds: sumT / 1000 };
}

/**
 * When the picture first starts to move, ms on the frames' clock, or null if it does not. For a stick set at the start
 * of `frames`, this is how long the console, the network and the video take to show the first movement.
 */
export function onsetMs(frames: TimedFrame[], axis: Axis, minPx = 1.2): number | null {
  const pair = (i: number): ShiftEstimate => {
    for (const f of [1, 2]) {
      const e = shiftAt(axis, frames[i]!.img, frames[i + 1]!.img, f);
      if (accepted(e) && Math.abs(e.shift) / f <= 0.7 * reach(axis, f)) return e;
    }
    return { shift: NaN, textured: 0, used: 0, agree: 0, total: 0 };
  };
  for (let i = 0; i + 2 < frames.length; i++) {
    const e = pair(i);
    if (!accepted(e) || Math.abs(e.shift) < minPx) continue;
    const next = pair(i + 1);
    // The picture moved somewhere between the two frames of the first pair: the middle is the best guess.
    if (accepted(next) && Math.abs(next.shift) >= minPx * 0.7 && Math.sign(next.shift) === Math.sign(e.shift)) return (frames[i]!.t + frames[i + 1]!.t) / 2;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ one full turn

/**
 * How much of the picture is back where it was: the largest share of textured blocks that match `ref` (correlation of
 * at least 0.8) when the picture is moved by one and the same number of pixels, within `maxShift`. 1 for the same
 * picture. What stays put on a turning camera (the character, the HUD) is the part that matches at no shift at all, and is
 * all that is left while the rest is somewhere else; when the camera has come round, the rest matches at some shift,
 * which is how far from the exact place the frame happens to be. Returns the share and the shift.
 */
export function similarity(ref: Gray, img: Gray, o: { maxShift?: number; cols?: number; rows?: number; minTexture?: number } = {}): { share: number; shift: number } {
  if (ref.w !== img.w || ref.h !== img.h) throw new Error('the two pictures differ in size');
  const R = o.maxShift ?? 0;
  const cols = o.cols ?? 8;
  const rows = o.rows ?? 4;
  const minTexture = o.minTexture ?? 3;
  const bw = Math.floor((ref.w - 2 * R) / cols);
  const bh = Math.floor(ref.h / rows);
  const stride = R > 0 ? 2 : 1;
  const matches = new Int32Array(2 * R + 1);
  let textured = 0;
  const A = ref.data;
  const B = img.data;
  for (let ri = 0; ri < rows; ri++) {
    for (let ci = 0; ci < cols; ci++) {
      const bx = R + ci * bw;
      const by = ri * bh;
      let sa = 0;
      let n = 0;
      for (let y = by; y < by + bh; y += stride) for (let x = bx; x < bx + bw; x += stride, n++) sa += A[y * ref.w + x]!;
      const ma = sa / n;
      let saa = 0;
      let dev = 0;
      for (let y = by; y < by + bh; y += stride) {
        for (let x = bx; x < bx + bw; x += stride) {
          const da = A[y * ref.w + x]! - ma;
          saa += da * da;
          dev += Math.abs(da);
        }
      }
      if (dev / n < minTexture) continue;
      textured++;
      for (let d = -R; d <= R; d++) {
        let sb = 0;
        for (let y = by; y < by + bh; y += stride) for (let x = bx; x < bx + bw; x += stride) sb += B[y * ref.w + x + d]!;
        const mb = sb / n;
        let sbb = 0;
        let sab = 0;
        for (let y = by; y < by + bh; y += stride) {
          for (let x = bx; x < bx + bw; x += stride) {
            const da = A[y * ref.w + x]! - ma;
            const db = B[y * ref.w + x + d]! - mb;
            sbb += db * db;
            sab += da * db;
          }
        }
        if (saa > 0 && sbb > 0 && sab / Math.sqrt(saa * sbb) >= 0.8) matches[d + R]!++;
      }
    }
  }
  if (textured === 0) return { share: 0, shift: 0 };
  let best = R;
  for (let i = 0; i < matches.length; i++) if (matches[i]! > matches[best]! || (matches[i]! === matches[best]! && Math.abs(i - R) < Math.abs(best - R))) best = i;
  return { share: matches[best]! / textured, shift: best - R };
}

export interface Revisit {
  /** The frame, on the frames' clock, at which the picture looks most like the start again. */
  t: number;
  similarity: number;
  /** How far that frame is from the exact place, px (positive: the picture there is to the right of the start's). */
  shift: number;
  img: Gray;
  /** The frames pushed up to and including it. */
  index: number;
}

/**
 * Watches the frames of a camera that is turning and says when the picture has come back to what it was at the start:
 * one full turn. Feed it the frames in order; `push` returns true once the best match has been passed.
 */
export class RevisitDetector {
  #ref: Gray;
  #left = false;
  #floor = 1;
  #peak: Revisit | null = null;
  #n = 0;
  #t0 = -1;
  #minElapsed: number;
  #reach: number;

  constructor(ref: Gray, o: { minElapsedMs?: number; maxShift?: number } = {}) {
    this.#ref = ref;
    this.#minElapsed = o.minElapsedMs ?? 300;
    this.#reach = o.maxShift ?? 24;
  }

  get result(): Revisit | null {
    return this.#peak;
  }

  /** The lowest similarity seen so far: what stayed put while the rest moved away. */
  get floor(): number {
    return this.#floor;
  }

  push(f: TimedFrame): boolean {
    const index = this.#n++;
    if (this.#t0 < 0) this.#t0 = f.t;
    const { share, shift } = similarity(this.#ref, f.img, { maxShift: this.#reach });
    // Before the camera has moved, everything matches; the question is what matches while it is moving.
    if (!this.#left) {
      const far = similarity(this.#ref, f.img, { maxShift: 0 }).share;
      this.#floor = Math.min(this.#floor, far);
      if (far <= 0.6 && f.t - this.#t0 >= this.#minElapsed) this.#left = true;
      return false;
    }
    // What stays put (the character, the HUD) and what moves by itself never match at the same shift as the background, so
    // at the exact place the match is the background's share, well above what stayed put all along.
    const back = Math.max(0.5, this.#floor + 0.3);
    if (share >= back && (!this.#peak || share > this.#peak.similarity)) this.#peak = { t: f.t, similarity: share, shift, img: f.img, index };
    if (!this.#peak) return false;
    return share < this.#peak.similarity - 0.05 || f.t - this.#peak.t > 300;
  }
}

// ------------------------------------------------------------------------------------------------ the table

/** Non-decreasing values closest to `values` (pool adjacent violators). */
export function isotonic(values: number[]): number[] {
  const blocks: Array<{ sum: number; n: number }> = [];
  for (const v of values) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  return blocks.flatMap((b) => Array<number>(b.n).fill(b.sum / b.n));
}

export interface TableLevel {
  /** Stick deflection, 0..1. */
  stick: number;
  /** Turn rate measured at that deflection, degrees per second. */
  rate: number;
}

export interface BuiltTable {
  table: CalPoint[];
  /** The deflection at which the camera starts to turn. */
  innerDeadzone: number;
  /** The turn rate at full deflection, degrees per second. */
  fullStickRate: number;
}

/**
 * The stick-to-turn-rate table from measured levels. Measurements are noisy, so the rates are made non-decreasing; the
 * deadzone is where the rising part of the curve would meet zero; the result is a table `validateCalibration` accepts,
 * ending at full deflection. Throws if there is nothing to build it from.
 */
export function buildTable(levels: TableLevel[]): BuiltTable {
  const pts = levels.filter((l) => Number.isFinite(l.rate) && l.stick > 0 && l.stick <= 1).sort((a, b) => a.stick - b.stick);
  if (pts.length < 3) throw new Error('too few measured levels to build a table');
  const rates = isotonic(pts.map((p) => Math.max(0, p.rate)));
  const top = rates[rates.length - 1]!;
  if (top < 1) throw new Error('the camera did not turn');
  const eps = Math.max(0.5, 0.02 * top);
  const i0 = rates.findIndex((r) => r >= eps);
  const stickAt = (i: number): number => pts[i]!.stick;
  const slopeFrom = (i: number): number => (i + 1 < pts.length && rates[i + 1]! > rates[i]! ? (rates[i + 1]! - rates[i]!) / (stickAt(i + 1) - stickAt(i)) : 0);

  let dz: number;
  if (i0 === 0) {
    const slope = slopeFrom(0);
    dz = slope > 0 ? stickAt(0) - rates[0]! / slope : 0;
    dz = Math.min(Math.max(0, dz), stickAt(0) * 0.95);
  } else {
    const slope = slopeFrom(i0);
    dz = slope > 0 ? stickAt(i0) - rates[i0]! / slope : (stickAt(i0 - 1) + stickAt(i0)) / 2;
    dz = Math.min(Math.max(dz, stickAt(i0 - 1)), stickAt(i0));
  }

  const table: CalPoint[] = [[0, 0]];
  if (dz > 0.003) table.push([dz, 0]);
  for (let i = i0; i < pts.length; i++) {
    const last = table[table.length - 1]!;
    if (stickAt(i) <= last[0] + 1e-6) continue;
    table.push([stickAt(i), Math.max(last[1], rates[i]!)]);
  }
  const last = table[table.length - 1]!;
  if (last[0] < 1) {
    const prev = table.length >= 2 ? table[table.length - 2]! : last;
    const slope = last[0] > prev[0] ? Math.max(0, (last[1] - prev[1]) / (last[0] - prev[0])) : 0;
    table.push([1, last[1] + slope * (1 - last[0])]);
  } else if (last[0] > 1) {
    last[0] = 1;
  }
  const problems = validateCalibration(table, 'table');
  if (problems.length > 0) throw new Error(`the measured table is not valid: ${problems.join('; ')}`);
  return { table, innerDeadzone: dz, fullStickRate: table[table.length - 1]![1] };
}

/** The turn rate a table gives at a deflection (re-exported for callers that only import this module). */
export { rateAt };

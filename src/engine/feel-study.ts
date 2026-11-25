// SPDX-License-Identifier: AGPL-3.0-only
//
// A study of how the mouse should feel. There is no formula for it: a person plays with one setting after another and says
// how good each was. This file is the part that does not need a browser or a console, in three pieces:
//
//   1. the candidates  a fixed round of settings to try (known starting points, one-knob-at-a-time variations around the
//                      middle one, and points that spread over the rest of the space), in a fixed order, to be tried blind;
//   2. the ratings     what is kept about one try: the score, which situations were good or bad, what was being played, the
//                      values in effect, how the hand moved while it was tried. Checked strictly, because a server keeps them;
//   3. the analysis    which knob moves the score and which way, which behaviours of the filter (start delay, run-on after a
//                      stop, evenness of a slow pan, how far a swipe turns) go with a good score, what the best setting seems
//                      to be and how sure that is, and what to try next.
//
// The behaviours come from running the real engine (behaviorMetrics), so a score can be explained by what the filter DOES,
// not only by the numbers it was given: two different settings that start a turn equally late get the same explanation.

import { modelTable, rateAt } from './calibration.ts';
import { MappingEngine } from './engine.ts';
import { defaultProfile } from './profile.ts';

// ------------------------------------------------------------------ the values being tried

/** The mouse settings of the profile that the controls (and the study) change. */
export interface Feel {
  /** Degrees of camera rotation per mouse count. */
  degPerCount: number;
  /** Time constant of the low-pass filter, ms. */
  smoothingMs: number;
  /** The turn rate (deg/s) at which the filter has faded out completely; 0 = it works the same at every speed. */
  smoothingFadeRate: number;
  /** How long the camera may go on turning after the hand stopped, to pay what the speed limit held back, ms. */
  carryMs: number;
  /** 1 = linear. */
  curve: number;
}

/** What a candidate sets. The sensitivity is the person's own: it is what they tune by ear, and it is recorded with every rating. */
export type Knobs = Pick<Feel, 'smoothingMs' | 'smoothingFadeRate' | 'carryMs' | 'curve'>;
export type KnobKey = keyof Knobs;

export interface KnobSpec {
  key: KnobKey;
  label: string;
  unit: string;
  lo: number;
  hi: number;
  /** A point of the unit interval as a value of this knob (rounded to what a person can tell apart; some of the interval means "off"). */
  fromUnit(u: number): number;
  /** The reverse, for measuring distances between settings. */
  toUnit(v: number): number;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

export const KNOBS: readonly KnobSpec[] = [
  {
    key: 'smoothingMs', label: '부드러움', unit: 'ms', lo: 0, hi: 30,
    fromUnit: (u) => (u < 0.1 ? 0 : Math.round(30 * u)),
    toUnit: (v) => (v === 0 ? 0.05 : v / 30),
  },
  {
    key: 'smoothingFadeRate', label: '해제 속도', unit: '°/s', lo: 0, hi: 160,
    fromUnit: (u) => (u < 0.15 ? 0 : Math.round((20 + (140 * (u - 0.15)) / 0.85) / 5) * 5),
    toUnit: (v) => (v === 0 ? 0.075 : 0.15 + (0.85 * (Math.min(160, Math.max(20, v)) - 20)) / 140),
  },
  {
    key: 'carryMs', label: '이어 돌기', unit: 'ms', lo: 0, hi: 600,
    fromUnit: (u) => (u < 0.08 ? 0 : Math.round((600 * u) / 20) * 20),
    toUnit: (v) => (v === 0 ? 0.04 : v / 600),
  },
  {
    key: 'curve', label: '곡선', unit: '', lo: 0.8, hi: 1.5,
    fromUnit: (u) => r2(Math.round((0.8 + 0.7 * u) / 0.05) * 0.05),
    toUnit: (v) => (v - 0.8) / 0.7,
  },
];

/** "Fade rate 0" means the same smoothing at every speed, which is what a very high fade rate is: put it past the top for any arithmetic. */
const fadeValue = (v: number): number => (v === 0 ? 240 : v);

export const knobsEqual = (a: Knobs, b: Knobs): boolean => a.smoothingMs === b.smoothingMs && a.smoothingFadeRate === b.smoothingFadeRate && a.carryMs === b.carryMs && a.curve === b.curve;

/** Words for a setting, in the order of the panel. */
export function describeKnobs(k: Knobs): string {
  return `부드러움 ${k.smoothingMs} ms · 해제 ${k.smoothingFadeRate === 0 ? '안 함' : `${k.smoothingFadeRate} °/s`} · 이어 돌기 ${k.carryMs} ms · 곡선 ${k.curve}`;
}

// ------------------------------------------------------------------ the candidates

export interface Candidate {
  /** "r1-07": the round and the place in its order. Fixed once a round has been given out, because ratings refer to it. */
  id: string;
  kind: 'anchor' | 'single' | 'space';
  set: Knobs;
}

/** The middle one: the other candidates of the one-at-a-time kind differ from it in a single knob. */
export const CENTER: Knobs = { smoothingMs: 12, smoothingFadeRate: 40, carryMs: 300, curve: 1 };
/** The three starting points the panel has always had (web/mouse-feel.ts has the same numbers; a test keeps them together). */
export const ANCHORS: readonly Knobs[] = [
  { smoothingMs: 0, smoothingFadeRate: 0, carryMs: 300, curve: 1 },
  CENTER,
  { smoothingMs: 12, smoothingFadeRate: 0, carryMs: 300, curve: 1 },
];
const SINGLES: readonly Knobs[] = [
  { ...CENTER, smoothingMs: 0 },
  { ...CENTER, smoothingMs: 28 },
  { ...CENTER, smoothingFadeRate: 15 },
  { ...CENTER, smoothingFadeRate: 120 },
  { ...CENTER, carryMs: 0 },
  { ...CENTER, carryMs: 600 },
  { ...CENTER, curve: 0.85 },
  { ...CENTER, curve: 1.4 },
];

/** A small seeded generator (mulberry32), so a round is the same on every computer. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const radical = (index: number, base: number): number => {
  let f = 1;
  let r = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    r += f * (i % base);
  }
  return r;
};
const HALTON_BASES = [2, 3, 5, 7];
const unitOf = (k: Knobs): number[] => KNOBS.map((s) => s.toUnit(k[s.key]));
const distance = (a: number[], b: number[]): number => Math.hypot(...a.map((v, i) => v - b[i]!));

/** `count` settings spread over the space: the farthest of a shifted Halton sequence from everything chosen so far, again and again. */
export function spreadPoints(count: number, avoid: readonly Knobs[], seed: number): Knobs[] {
  const random = rng(seed);
  const shift = HALTON_BASES.map(() => random());
  const pool: Knobs[] = [];
  for (let i = 1; i <= 600; i++) {
    const u = HALTON_BASES.map((b, d) => (radical(i, b) + shift[d]!) % 1);
    const set = Object.fromEntries(KNOBS.map((s, d) => [s.key, s.fromUnit(u[d]!)])) as unknown as Knobs;
    if (!pool.some((p) => knobsEqual(p, set))) pool.push(set);
  }
  const placed = avoid.map(unitOf);
  const chosen: Knobs[] = [];
  while (chosen.length < count) {
    let best = -1;
    let bestGap = -1;
    pool.forEach((p, i) => {
      if (chosen.some((c) => knobsEqual(c, p)) || avoid.some((a) => knobsEqual(a, p))) return;
      const u = unitOf(p);
      const gap = Math.min(...placed.map((q) => distance(u, q)));
      if (gap > bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    if (best < 0) break;
    chosen.push(pool[best]!);
    placed.push(unitOf(pool[best]!));
  }
  return chosen;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The first round: the three known starting points first (they teach the person's scale: this is what "good" and "bad"
 * look like), then everything else in a shuffled order, so that the position in the order says nothing about the setting.
 */
export function designRound(roundId: string, seed: number, total: number): Candidate[] {
  const random = rng(seed);
  const spreadCount = Math.max(0, total - ANCHORS.length - SINGLES.length);
  const space = spreadPoints(spreadCount, [...ANCHORS, ...SINGLES], seed + 7);
  const raw: Array<Omit<Candidate, 'id'>> = [
    ...shuffled(ANCHORS, random).map((set) => ({ kind: 'anchor' as const, set })),
    ...shuffled<Omit<Candidate, 'id'>>([...SINGLES.map((set) => ({ kind: 'single' as const, set })), ...space.map((set) => ({ kind: 'space' as const, set }))], random),
  ];
  return raw.map((c, i) => ({ id: `${roundId}-${String(i + 1).padStart(2, '0')}`, ...c }));
}

export interface Round {
  id: string;
  name: string;
  candidates: readonly Candidate[];
}

export const ROUND_1: Round = { id: 'r1', name: '1라운드', candidates: designRound('r1', 20261125, 48) };
export const ROUNDS: readonly Round[] = [ROUND_1];

/** Every this many ratings a setting already rated is offered again: the same setting scored twice shows how much the scores themselves move. */
export const RETEST_EVERY = 8;

/**
 * Which setting to try next, given what has been rated. The ones not yet rated come in the round's order; every
 * RETEST_EVERY ratings the oldest one rated only once comes back instead (blind, so it is not recognised by its number
 * alone); when everything has been rated, the least rated come first. Never null: there is always something to try.
 */
export function nextCandidate(round: Round, rated: ReadonlyArray<{ preset: string }>): { candidate: Candidate; retest: boolean } {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  rated.forEach((r, i) => {
    counts.set(r.preset, (counts.get(r.preset) ?? 0) + 1);
    if (!firstSeen.has(r.preset)) firstSeen.set(r.preset, i);
  });
  const inRound = round.candidates.filter((c) => counts.has(c.id));
  const retestsDone = inRound.reduce((sum, c) => sum + (counts.get(c.id)! - 1), 0);
  const unrated = round.candidates.find((c) => !counts.has(c.id));
  const total = inRound.reduce((sum, c) => sum + counts.get(c.id)!, 0);
  const due = total > 0 && total % RETEST_EVERY === 0 && retestsDone < total / RETEST_EVERY;
  if (unrated && !due) return { candidate: unrated, retest: false };
  const once = inRound.filter((c) => counts.get(c.id) === 1).sort((a, b) => firstSeen.get(a.id)! - firstSeen.get(b.id)!);
  if (unrated && once[0]) return { candidate: once[0], retest: true };
  if (unrated) return { candidate: unrated, retest: false };
  const least = [...round.candidates].sort((a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0) || (firstSeen.get(a.id) ?? 0) - (firstSeen.get(b.id) ?? 0))[0]!;
  return { candidate: least, retest: true };
}

// ------------------------------------------------------------------ the ratings

export const SITUATIONS = [
  { key: 'slow', label: '천천히 조준', hint: '아주 천천히 미세하게 맞출 때' },
  { key: 'flick', label: '빠른 휘두름', hint: '뒤돌기·크게 휙 돌릴 때 (돌린 만큼 도는가)' },
  { key: 'track', label: '따라가기', hint: '움직이는 대상을 일정한 속도로 따라갈 때' },
  { key: 'stop', label: '멈춤', hint: '손을 멈추면 시점도 딱 멈추는가 (밀림·튐)' },
  { key: 'start', label: '시작', hint: '움직이기 시작하면 바로 반응하는가' },
  { key: 'smooth', label: '매끄러움', hint: '끊기거나 떨리지 않는가' },
] as const;
export type SituationKey = (typeof SITUATIONS)[number]['key'];

export const SCENES = [
  { key: 'foot', label: '걷기' },
  { key: 'aim', label: '총 조준' },
  { key: 'snipe', label: '저격' },
  { key: 'drive', label: '운전' },
  { key: 'other', label: '기타' },
] as const;
export type SceneKey = (typeof SCENES)[number]['key'];

export const PLAYOUTS = ['smooth', 'balanced', 'immediate'] as const;
export type Playout = (typeof PLAYOUTS)[number];

/** Upper edges (deg/s of camera, as the hand asks for it) of the bins the hand's speed is sorted into; one bin more for what is faster. */
export const SPEED_EDGES = [0.5, 5, 20, 60, 150, 400] as const;
export const SPEED_BINS = SPEED_EDGES.length + 1;

export interface GameModel {
  innerDeadzone: number;
  maxTurnRateAtFullStick: number;
  responseCurve: number;
}
export const DEFAULT_GAME: GameModel = { innerDeadzone: 0.1, maxTurnRateAtFullStick: 360, responseCurve: 1 };

export interface FeelRating {
  /** Made by the page; a second delivery of the same one is recognised and ignored. */
  id: string;
  /** ISO time. */
  at: string;
  round: string;
  preset: string;
  /** The values in effect when it was scored (not the candidate's: the person may have changed the sensitivity, or anything else). */
  feel: Feel;
  /** The candidate's values were changed by hand during the try (not counting the sensitivity). */
  changed: boolean;
  /** 1 (bad) to 10 (as good as a real mouse). */
  score: number;
  /** Situations that were bad (-1) or good (1); the others were not judged. */
  flags: Partial<Record<SituationKey, -1 | 1>>;
  scene: SceneKey | null;
  note: string;
  playout: Playout | null;
  /** The picture's own delay and the input-to-picture time, ms, when they were known. */
  delayMs: number | null;
  latencyMs: number | null;
  /** What the engine believed about the game's response while this was tried (a measured table makes the numbers below approximate). */
  game: GameModel & { measured: boolean };
  trial: {
    /** Seconds with the mouse in the game's hands. */
    seconds: number;
    /** The share of those seconds spent in each hand-speed bin (SPEED_EDGES). */
    speedShare: number[];
  };
}

export type ParsedRating = { ok: true; rating: FeelRating } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SITUATION_KEYS = new Set<string>(SITUATIONS.map((s) => s.key));
const SCENE_KEYS = new Set<string>(SCENES.map((s) => s.key));

/** Checks one rating strictly and returns a clean copy (only known fields, in range). A server keeps what passes and nothing else. */
export function parseRating(v: unknown, now: number = Date.now()): ParsedRating {
  const bad = (error: string): ParsedRating => ({ ok: false, error });
  if (!isObject(v)) return bad('not an object');
  const num = (o: unknown, key: string, lo: number, hi: number): number | undefined => {
    const x = isObject(o) ? o[key] : undefined;
    return typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : undefined;
  };
  const text = (o: Record<string, unknown>, key: string, max: number): string | undefined => (typeof o[key] === 'string' && (o[key] as string).length <= max ? (o[key] as string) : undefined);

  const id = text(v, 'id', 64);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return bad('id');
  const at = text(v, 'at', 40);
  const atMs = at ? Date.parse(at) : NaN;
  if (!at || !Number.isFinite(atMs) || atMs < Date.UTC(2020, 0, 1) || atMs > now + 86400_000) return bad('at');
  const round = text(v, 'round', 24);
  const preset = text(v, 'preset', 40);
  if (!round || !/^[A-Za-z0-9_-]+$/.test(round) || !preset || !/^[A-Za-z0-9_-]+$/.test(preset)) return bad('round or preset');

  const f = v.feel;
  const degPerCount = num(f, 'degPerCount', 0.005, 0.3);
  const smoothingMs = num(f, 'smoothingMs', 0, 200);
  const smoothingFadeRate = num(f, 'smoothingFadeRate', 0, 2000);
  const carryMs = num(f, 'carryMs', 0, 2000);
  const curve = num(f, 'curve', 0.5, 3);
  if (degPerCount === undefined || smoothingMs === undefined || smoothingFadeRate === undefined || carryMs === undefined || curve === undefined) return bad('feel');

  const score = v.score;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 10) return bad('score');

  const flags: FeelRating['flags'] = {};
  if (v.flags !== undefined) {
    if (!isObject(v.flags)) return bad('flags');
    for (const [k, x] of Object.entries(v.flags)) {
      if (!SITUATION_KEYS.has(k) || (x !== -1 && x !== 1 && x !== 0)) return bad('flags');
      if (x !== 0) flags[k as SituationKey] = x as -1 | 1;
    }
  }
  const scene = v.scene === null || v.scene === undefined ? null : typeof v.scene === 'string' && SCENE_KEYS.has(v.scene) ? (v.scene as SceneKey) : undefined;
  if (scene === undefined) return bad('scene');
  const note = v.note === undefined ? '' : text(v, 'note', 200);
  if (note === undefined) return bad('note');
  const playout = v.playout === null || v.playout === undefined ? null : (PLAYOUTS as readonly unknown[]).includes(v.playout) ? (v.playout as Playout) : undefined;
  if (playout === undefined) return bad('playout');
  const optional = (key: string, hi: number): number | null | undefined => (v[key] === null || v[key] === undefined ? null : num(v, key, 0, hi));
  const delayMs = optional('delayMs', 5000);
  const latencyMs = optional('latencyMs', 10000);
  if (delayMs === undefined || latencyMs === undefined) return bad('delay');

  const g = v.game;
  const innerDeadzone = num(g, 'innerDeadzone', 0, 0.6);
  const maxTurn = num(g, 'maxTurnRateAtFullStick', 10, 5000);
  const responseCurve = num(g, 'responseCurve', 0.5, 3);
  if (innerDeadzone === undefined || maxTurn === undefined || responseCurve === undefined || !isObject(g) || typeof g.measured !== 'boolean') return bad('game');

  const t = v.trial;
  const seconds = num(t, 'seconds', 0, 86400);
  const share = isObject(t) ? t.speedShare : undefined;
  if (seconds === undefined || !Array.isArray(share) || share.length !== SPEED_BINS || share.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1)) return bad('trial');

  return {
    ok: true,
    rating: {
      id, at, round, preset,
      feel: { degPerCount, smoothingMs, smoothingFadeRate, carryMs, curve },
      changed: v.changed === true,
      score, flags, scene, note: note ?? '', playout, delayMs, latencyMs,
      game: { innerDeadzone, maxTurnRateAtFullStick: maxTurn, responseCurve, measured: g.measured },
      trial: { seconds, speedShare: (share as number[]).map((x) => Math.round(x * 1000) / 1000) },
    },
  };
}

/** What the hand did while a setting was being tried: how long the game had the mouse, and in which speeds. */
export class TrialMeter {
  #seconds = 0;
  #bins = new Array<number>(SPEED_BINS).fill(0);
  #window = 0;
  #wx = 0;
  #wy = 0;
  readonly windowSeconds: number;

  constructor(windowSeconds = 0.1) {
    this.windowSeconds = windowSeconds;
  }

  /** One tick of the engine: the counts the hand made (the speed is judged over a window, because one tick of whole counts says little). */
  tick(dt: number, dx: number, dy: number, degPerCount: number, locked: boolean): void {
    if (!locked) {
      this.#window = 0;
      this.#wx = 0;
      this.#wy = 0;
      return;
    }
    this.#window += dt;
    this.#wx += dx;
    this.#wy += dy;
    if (this.#window + 1e-9 < this.windowSeconds) return;
    const speed = (Math.hypot(this.#wx, this.#wy) * degPerCount) / this.#window;
    let bin = SPEED_EDGES.findIndex((edge) => speed < edge);
    if (bin < 0) bin = SPEED_BINS - 1;
    this.#bins[bin]! += this.#window;
    this.#seconds += this.#window;
    this.#window = 0;
    this.#wx = 0;
    this.#wy = 0;
  }

  snapshot(): { seconds: number; speedShare: number[] } {
    const total = this.#seconds || 1;
    return { seconds: Math.round(this.#seconds * 10) / 10, speedShare: this.#bins.map((b) => Math.round((b / total) * 1000) / 1000) };
  }

  reset(): void {
    this.#seconds = 0;
    this.#bins.fill(0);
    this.#window = 0;
    this.#wx = 0;
    this.#wy = 0;
  }
}

// ------------------------------------------------------------------ what a setting does, by running the engine

export interface BehaviorMetrics {
  /** ms from the hand starting at a steady 45 / 120 deg/s until the stick is at 90 % of where it settles. */
  lagSlow: number;
  lagFast: number;
  /** ms from the hand stopping until the stick is back under 2 %: the camera keeps turning that long. */
  slideSlow: number;
  slideFast: number;
  /** Unevenness of the angle turned per 16 ms frame at 3 and 15 deg/s (spread as a share of its mean; 0 = perfectly even). */
  jitterSlow: number;
  jitterMid: number;
  /** The share of a 90 degree swipe (0.15 s) that the camera turns in the end. */
  swipe: number;
  /** Camera turn rate over hand rate, steady, at 15 / 45 / 250 deg/s. */
  gainSlow: number;
  gainMid: number;
  gainFast: number;
}
export const METRIC_LABELS: Record<keyof BehaviorMetrics, string> = {
  lagSlow: '시작 지연 (45°/s)', lagFast: '시작 지연 (120°/s)', slideSlow: '멈춘 뒤 밀림 (45°/s)', slideFast: '멈춘 뒤 밀림 (120°/s)',
  jitterSlow: '울퉁불퉁함 (3°/s)', jitterMid: '울퉁불퉁함 (15°/s)', swipe: '90° 휘두름이 도는 비율', gainSlow: '배율 (15°/s)', gainMid: '배율 (45°/s)', gainFast: '배율 (250°/s)',
};

const TICK = 0.004;
const mean = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const cv = (a: readonly number[]): number => {
  const m = mean(a);
  return m === 0 ? 0 : Math.sqrt(mean(a.map((v) => (v - m) ** 2))) / m;
};

/** What the filter does to a hand that moves at a steady speed and then stops (or only moves a while), in whole mouse counts as a sensor makes them. */
export function behaviorMetrics(feel: Feel, game: GameModel = DEFAULT_GAME): BehaviorMetrics {
  const table = modelTable(game.innerDeadzone, game.maxTurnRateAtFullStick, game.responseCurve);
  const run = (degPerSec: number, handSeconds: number, tailSeconds: number): { sticks: number[]; handTicks: number } => {
    const p = defaultProfile();
    Object.assign(p.mouse, feel);
    p.inGame = { ...p.inGame, ...game };
    const engine = new MappingEngine(p);
    let rest = 0;
    const handTicks = Math.round(handSeconds / TICK);
    const sticks: number[] = [];
    for (let i = 0; i < handTicks + Math.round(tailSeconds / TICK); i++) {
      if (i < handTicks) {
        rest += (degPerSec / feel.degPerCount) * TICK;
        const whole = Math.trunc(rest);
        rest -= whole;
        engine.mouseMove(whole, 0);
      }
      sticks.push(Math.abs(engine.tick(TICK).rightX));
    }
    return { sticks, handTicks };
  };
  const settle = (t: { sticks: number[]; handTicks: number }): number => mean(t.sticks.slice(Math.round(0.5 / TICK), t.handTicks));
  const lag = (t: { sticks: number[]; handTicks: number }): number => {
    const level = settle(t);
    const i = t.sticks.findIndex((v) => v >= 0.9 * level);
    return Math.round((i < 0 ? t.handTicks : i) * TICK * 1000);
  };
  const slide = (t: { sticks: number[]; handTicks: number }): number => {
    const level = settle(t);
    const after = t.sticks.slice(t.handTicks);
    const i = after.findIndex((v) => v < 0.02 * Math.max(level, 0.01));
    return Math.round((i < 0 ? after.length : i) * TICK * 1000);
  };
  const frames = (t: { sticks: number[]; handTicks: number }): number[] => {
    const out: number[] = [];
    for (let i = Math.round(0.5 / TICK); i + 4 <= t.handTicks; i += 4) out.push(t.sticks.slice(i, i + 4).reduce((a, s) => a + rateAt(table, s) * TICK, 0));
    return out;
  };
  const gain = (t: { sticks: number[]; handTicks: number }, hand: number): number => mean(t.sticks.slice(Math.round(0.5 / TICK), t.handTicks).map((s) => rateAt(table, s))) / hand;

  const at3 = run(3, 2, 0);
  const at15 = run(15, 2, 0);
  const at45 = run(45, 1.5, 1);
  const at120 = run(120, 1.5, 1);
  const at250 = run(250, 1.5, 0);
  const swipe = run(600, 0.15, 1.5);
  const turned = swipe.sticks.reduce((a, s) => a + rateAt(table, s) * TICK, 0);
  return {
    lagSlow: lag(at45), lagFast: lag(at120), slideSlow: slide(at45), slideFast: slide(at120),
    jitterSlow: cv(frames(at3)), jitterMid: cv(frames(at15)),
    swipe: turned / 90,
    gainSlow: gain(at15, 15), gainMid: gain(at45, 45), gainFast: gain(at250, 250),
  };
}

// ------------------------------------------------------------------ the analysis

/** Solves a x = b (a is n by n) by Gaussian elimination with row exchanges. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const pivot = m[c]![c]! || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = m[r]![c]! / pivot;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= m[r]![k]! * x[k]!;
    x[r] = s / (m[r]![r]! || 1e-12);
  }
  return x;
}

function inverse(a: number[][]): number[][] {
  const n = a.length;
  const cols = Array.from({ length: n }, (_, j) => solve(a, Array.from({ length: n }, (_, i) => (i === j ? 1 : 0))));
  return Array.from({ length: n }, (_, i) => cols.map((col) => col[i]!));
}

/** A ridge regression: the columns are put on one scale first, so that the penalty treats them alike. */
interface Ridge {
  /** The score a raw feature row is predicted to get. */
  predict(x: readonly number[]): number;
  /** Per column, on the standardised scale: the change of the score when that column goes up by one standard deviation of the data. */
  coef: number[];
  /** The standard deviation of each raw column in the data. */
  colSd: number[];
  /** Leave-one-out R squared: how much of the scores' spread is predicted for ratings the model has not seen. Under 0: worse than the mean. */
  looR2: number;
}

function ridge(matrix: readonly (readonly number[])[], y: readonly number[], lambda: number): Ridge {
  const cols = matrix[0]!.length;
  const colMean = Array.from({ length: cols }, (_, j) => mean(matrix.map((m) => m[j]!)));
  const colSd = Array.from({ length: cols }, (_, j) => Math.sqrt(mean(matrix.map((m) => (m[j]! - colMean[j]!) ** 2))) || 1);
  const X = matrix.map((m) => m.map((v, j) => (v - colMean[j]!) / colSd[j]!));
  const yMean = mean(y);
  const gram = Array.from({ length: cols }, (_, i) => Array.from({ length: cols }, (_, j) => X.reduce((s, x) => s + x[i]! * x[j]!, 0) + (i === j ? lambda : 0)));
  const xty = Array.from({ length: cols }, (_, j) => X.reduce((s, x, i) => s + x[j]! * (y[i]! - yMean), 0));
  const coef = solve(gram, xty);

  // Leave one out without refitting: a row's residual, divided by what is left of it after the row's own pull on the fit.
  const inv = inverse(gram);
  let press = 0;
  let total = 0;
  X.forEach((x, i) => {
    const pred = yMean + x.reduce((s, v, j) => s + v * coef[j]!, 0);
    let h = 1 / y.length;
    for (let a = 0; a < cols; a++) for (let b = 0; b < cols; b++) h += x[a]! * inv[a]![b]! * x[b]!;
    press += ((y[i]! - pred) / Math.max(1e-6, 1 - h)) ** 2;
    total += (y[i]! - yMean) ** 2;
  });
  return {
    predict: (x) => yMean + x.reduce((s, v, j) => s + ((v - colMean[j]!) / colSd[j]!) * coef[j]!, 0),
    coef, colSd, looR2: total === 0 ? 0 : 1 - press / total,
  };
}

const LAMBDAS = [0.3, 1, 3, 10, 30, 100];
/** The penalty that predicts unseen ratings best. */
function bestRidge(matrix: readonly (readonly number[])[], y: readonly number[]): Ridge {
  let best: Ridge | null = null;
  for (const lambda of LAMBDAS) {
    const r = ridge(matrix, y, lambda);
    if (!best || r.looR2 > best.looR2) best = r;
  }
  return best!;
}

// Two ways to describe a setting to the regression: by its knobs, and by what the filter does with a hand (behaviorMetrics).
// The knobs interact (smoothing hardly matters where the fade has already taken it away), which a straight line in the knobs cannot say;
// what the filter does is closer to what a person feels, so the same line reads better there.

const KNOB_NAMES = KNOBS.map((k) => k.label);
const knobUnits = (k: Knobs): number[] => [(k.smoothingMs - 15) / 15, (fadeValue(k.smoothingFadeRate) - 125) / 115, (k.carryMs - 300) / 300, (k.curve - 1.15) / 0.35];
/** The knobs (and, when asked, their squares and products), then the log sensitivity and the order the rating was made in. */
function knobFeatures(set: Knobs, sens: number, order: number, quadratic: boolean): number[] {
  const z = knobUnits(set);
  const out = [...z];
  if (quadratic) for (let i = 0; i < 4; i++) for (let j = i; j < 4; j++) out.push(z[i]! * z[j]!);
  out.push(sens, order);
  return out;
}

interface Feature {
  key: string;
  label: string;
  of(m: BehaviorMetrics): number;
}
const FEATURES: readonly Feature[] = [
  { key: 'lagSlow', label: '시작 지연 45°/s (ms)', of: (m) => m.lagSlow },
  { key: 'lagFast', label: '시작 지연 120°/s (ms)', of: (m) => m.lagFast },
  { key: 'slideSlow', label: '멈춘 뒤 밀림 45°/s (ms)', of: (m) => m.slideSlow },
  { key: 'slideFast', label: '멈춘 뒤 밀림 120°/s (ms)', of: (m) => m.slideFast },
  { key: 'jitterSlow', label: '울퉁불퉁 3°/s (%)', of: (m) => m.jitterSlow * 100 },
  { key: 'jitterMid', label: '울퉁불퉁 15°/s (%)', of: (m) => m.jitterMid * 100 },
  { key: 'swipeShort', label: '휘두름이 덜 도는 정도 (%)', of: (m) => Math.max(0, 1 - m.swipe) * 100 },
  { key: 'gainSlow', label: '배율 15°/s (1에서 벗어남 %)', of: (m) => (m.gainSlow - 1) * 100 },
  { key: 'gainMid', label: '배율 45°/s (1에서 벗어남 %)', of: (m) => (m.gainMid - 1) * 100 },
];
const behaviorFeatures = (m: BehaviorMetrics, sens: number, order: number): number[] => [...FEATURES.map((f) => f.of(m)), sens, order];

interface Row {
  set: Knobs;
  game: GameModel;
  feel: Feel;
  sens: number;
  order: number;
  y: number;
}

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
const sortNum = (a: readonly number[]): number[] => [...a].sort((x, y) => x - y);

function ranks(a: readonly number[]): number[] {
  const order = a.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(a.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k = i; k <= j; k++) out[order[k]![1]] = (i + j) / 2;
    i = j + 1;
  }
  return out;
}
function pearson(a: readonly number[], b: readonly number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return saa === 0 || sbb === 0 ? 0 : sab / Math.sqrt(saa * sbb);
}
const spearman = (a: readonly number[], b: readonly number[]): number => pearson(ranks(a), ranks(b));

/** A point of the design space as a setting; `u` has one number per knob. */
const knobsFromUnit = (u: readonly number[]): Knobs => Object.fromEntries(KNOBS.map((k, j) => [k.key, k.fromUnit(u[j]!)])) as unknown as Knobs;

export interface Report {
  /** Ratings that count (long enough). */
  used: number;
  skipped: { tooShort: number };
  candidates: Array<{ id: string; kind: Candidate['kind'] | 'custom'; n: number; mean: number; sd: number; set: Knobs; flagged: Partial<Record<SituationKey, number>> }>;
  /** How much the same setting's scores differ from one try to the next (standard deviation, points); null without repeats. */
  noise: { pairs: number; sd: number } | null;
  /** Change of the score per ten ratings, after what the settings explain (a person's scale tends to move as they go). */
  drift: number | null;
  /** Effect on the score of each knob going over its range, with a 90 % interval from resampling. */
  effects: Array<{ key: KnobKey; label: string; effect: number; lo: number; hi: number }>;
  /** Spearman correlation of each behaviour with the score. */
  behavior: Array<{ key: keyof BehaviorMetrics; label: string; r: number; lo: number; hi: number }>;
  /** Per situation: how often it was marked, and which way each knob moves "good minus bad". */
  situations: Array<{ key: SituationKey; label: string; good: number; bad: number; effects: Array<{ key: KnobKey; label: string; effect: number }> | null }>;
  scenes: Array<{ key: SceneKey | 'unknown'; label: string; n: number; mean: number }>;
  surface: null | {
    /** Which description of a setting predicts unseen ratings better; the best setting below comes from it. */
    model: 'behavior' | 'knobs';
    looR2: { behavior: number; knobs: number };
    best: Knobs;
    predicted: number;
    bestBehavior: BehaviorMetrics;
    /** What each behaviour is worth: the score change when it goes up by one standard deviation of what was tried, with a 90 % interval. */
    weights: Array<{ key: string; label: string; weight: number; lo: number; hi: number }>;
    /** The middle half of each knob among the best settings of resampled fits: narrow = the data agree. */
    spread: Record<KnobKey, [number, number]>;
    /** Settings worth trying next: the best guess, then those the data are least sure about among the ones that could be good. */
    next: Knobs[];
  };
  notes: string[];
}

export interface AnalyzeOptions {
  /** Ratings with less time than this with the mouse in the game's hands are left out (nothing was felt). */
  minSeconds?: number;
  /** For repeatable resampling. */
  seed?: number;
  /** How many resamples (the intervals and the spread of the best setting come from these). */
  resamples?: number;
  /** How many settings to propose for the next round. */
  proposals?: number;
  /** How many settings the search for the best looks at. */
  searchPoints?: number;
}

/**
 * What the scores say. It is honest about how little they may say: with few ratings no best setting is named, and when
 * the fit cannot predict a rating it has not seen (looR2 near or under 0) the report says so.
 */
export function analyzeRatings(all: readonly FeelRating[], options: AnalyzeOptions = {}): Report {
  const minSeconds = options.minSeconds ?? 8;
  const B = options.resamples ?? 60;
  const notes: string[] = [];
  const ordered = [...all].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const used = ordered.filter((r) => r.trial.seconds >= minSeconds);
  const report: Report = {
    used: used.length, skipped: { tooShort: ordered.length - used.length }, candidates: [], noise: null, drift: null, effects: [], behavior: [], situations: [], scenes: [], surface: null, notes,
  };
  if (report.skipped.tooShort > 0) notes.push(`${report.skipped.tooShort}개는 마우스를 ${minSeconds}초 넘게 쓰지 않아 뺐습니다.`);
  if (used.length === 0) return report;

  // The candidates, best first.
  const byPreset = new Map<string, FeelRating[]>();
  for (const r of used) (byPreset.get(r.preset) ?? byPreset.set(r.preset, []).get(r.preset)!).push(r);
  const kindOf = (id: string): Candidate['kind'] | 'custom' => ROUNDS.flatMap((r) => r.candidates).find((c) => c.id === id)?.kind ?? 'custom';
  for (const [id, rs] of byPreset) {
    const scores = rs.map((r) => r.score);
    const m = mean(scores);
    const flagged: Partial<Record<SituationKey, number>> = {};
    for (const s of SITUATIONS) {
      const sum = rs.reduce((acc, r) => acc + (r.flags[s.key] ?? 0), 0);
      if (sum !== 0) flagged[s.key] = Math.round((sum / rs.length) * 100) / 100;
    }
    const last = rs[rs.length - 1]!;
    report.candidates.push({ id, kind: kindOf(id), n: rs.length, mean: m, sd: Math.sqrt(mean(scores.map((v) => (v - m) ** 2))), set: knobsOf(last.feel), flagged });
  }
  report.candidates.sort((a, b) => b.mean - a.mean || a.id.localeCompare(b.id));

  // How much a score moves when nothing changed: pooled over the settings tried more than once.
  let dfSum = 0;
  let ssSum = 0;
  let pairs = 0;
  for (const rs of byPreset.values()) {
    if (rs.length < 2) continue;
    const m = mean(rs.map((r) => r.score));
    ssSum += rs.reduce((s, r) => s + (r.score - m) ** 2, 0);
    dfSum += rs.length - 1;
    pairs++;
  }
  if (dfSum > 0) report.noise = { pairs, sd: Math.sqrt(ssSum / dfSum) };
  else notes.push('같은 후보를 두 번 평가한 것이 없어, 점수 자체의 흔들림은 모릅니다.');

  const rows: Row[] = used.map((r, i) => ({ set: knobsOf(r.feel), game: { innerDeadzone: r.game.innerDeadzone, maxTurnRateAtFullStick: r.game.maxTurnRateAtFullStick, responseCurve: r.game.responseCurve }, feel: r.feel, sens: Math.log(r.feel.degPerCount), order: i, y: r.score }));
  if (used.length < 10) {
    notes.push('평가가 10개보다 적어 효과·최적값 분석은 아직 하지 않습니다.');
    return report;
  }
  const random = rng(options.seed ?? 1);
  const resample = (): number[] => rows.map(() => Math.floor(random() * rows.length));
  const y = rows.map((r) => r.y);

  // Main effects of the knobs, with intervals from resampling the ratings.
  const linearMatrix = rows.map((r) => knobFeatures(r.set, r.sens, r.order, false));
  // One fixed penalty for the point estimate and for the resamples, so that the interval is around the number shown.
  const linear = ridge(linearMatrix, y, 3);
  const range = KNOBS.map((k, j) => {
    // The fade's sweep starts at its lowest real value: "off" is not an end of the range, it is past the other one.
    const lo = knobUnits({ ...CENTER, [k.key]: k.key === 'smoothingFadeRate' ? 20 : k.lo })[j]!;
    const hi = knobUnits({ ...CENTER, [k.key]: k.hi })[j]!;
    return hi - lo;
  });
  const effectOf = (r: Ridge, j: number): number => (r.coef[j]! / r.colSd[j]!) * range[j]!;
  const draws: number[][] = KNOBS.map(() => []);
  for (let b = 0; b < B; b++) {
    const pick = resample();
    const f = ridge(pick.map((i) => linearMatrix[i]!), pick.map((i) => y[i]!), 3);
    KNOBS.forEach((_, j) => draws[j]!.push(effectOf(f, j)));
  }
  report.effects = KNOBS.map((k, j) => {
    const s = sortNum(draws[j]!);
    return { key: k.key, label: k.label, effect: effectOf(linear, j), lo: quantile(s, 0.05), hi: quantile(s, 0.95) };
  });
  report.drift = (linear.coef[linear.coef.length - 1]! / linear.colSd[linear.colSd.length - 1]!) * 10;

  // What the filter does, against the scores.
  const metricCache = new Map<string, BehaviorMetrics>();
  const metricsFor = (feel: Feel, game: GameModel): BehaviorMetrics => {
    const key = JSON.stringify([feel, game.innerDeadzone, game.maxTurnRateAtFullStick, game.responseCurve]);
    let m = metricCache.get(key);
    if (!m) metricCache.set(key, (m = behaviorMetrics(feel, game)));
    return m;
  };
  const metrics = rows.map((r) => metricsFor(r.feel, r.game));
  for (const key of Object.keys(METRIC_LABELS) as Array<keyof BehaviorMetrics>) {
    const xs = metrics.map((m) => m[key]);
    if (new Set(xs).size < 2) continue;
    const draw: number[] = [];
    for (let b = 0; b < B; b++) {
      const pick = resample();
      draw.push(spearman(pick.map((i) => xs[i]!), pick.map((i) => y[i]!)));
    }
    const s = sortNum(draw);
    report.behavior.push({ key, label: METRIC_LABELS[key], r: spearman(xs, y), lo: quantile(s, 0.05), hi: quantile(s, 0.95) });
  }
  report.behavior.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  // Situations: where the person said a try was good or bad, which way did the knobs go?
  for (const s of SITUATIONS) {
    const flags = used.map((r) => r.flags[s.key] ?? 0);
    const good = flags.filter((v) => v > 0).length;
    const bad = flags.filter((v) => v < 0).length;
    let effects: Report['situations'][number]['effects'] = null;
    if (good + bad >= 8) {
      const f = ridge(linearMatrix, flags, 3);
      effects = KNOBS.map((k, j) => ({ key: k.key, label: k.label, effect: effectOf(f, j) }));
    }
    report.situations.push({ key: s.key, label: s.label, good, bad, effects });
  }

  // Scenes.
  const scenes = new Map<string, number[]>();
  for (const r of used) (scenes.get(r.scene ?? 'unknown') ?? scenes.set(r.scene ?? 'unknown', []).get(r.scene ?? 'unknown')!).push(r.score);
  for (const [key, scores] of scenes) report.scenes.push({ key: key as SceneKey | 'unknown', label: SCENES.find((s) => s.key === key)?.label ?? '구분 안 함', n: scores.length, mean: mean(scores) });
  report.scenes.sort((a, b) => b.n - a.n);

  if (used.length < 20) {
    notes.push('평가가 20개보다 적어 최적값을 찾는 모델은 아직 만들지 않습니다.');
    return report;
  }

  // Two models of the score, by the knobs (with their squares and products) and by what the filter does; the one that predicts unseen ratings better is used.
  const quadMatrix = rows.map((r) => knobFeatures(r.set, r.sens, r.order, true));
  const behaviorMatrix = rows.map((r, i) => behaviorFeatures(metrics[i]!, r.sens, r.order));
  const knobsModel = bestRidge(quadMatrix, y);
  const behaviorModel = bestRidge(behaviorMatrix, y);
  const model: 'behavior' | 'knobs' = behaviorModel.looR2 >= knobsModel.looR2 ? 'behavior' : 'knobs';

  // The settings searched: the ones tried and a spread of others. The person's sensitivity is the latest one; the order is the middle of the session.
  const sensNow = mean(rows.slice(-10).map((r) => r.sens));
  const orderNow = mean(rows.map((r) => r.order));
  const game = rows[rows.length - 1]!.game;
  const pool: Knobs[] = [...new Map(rows.map((r) => [JSON.stringify(r.set), r.set])).values()];
  for (let i = 0; i < (options.searchPoints ?? 400); i++) pool.push(knobsFromUnit(KNOBS.map(() => random())));
  const degNow = Math.exp(sensNow);
  const poolMetrics = (set: Knobs): BehaviorMetrics => metricsFor({ degPerCount: degNow, ...set }, game);
  const featuresOf = (which: 'behavior' | 'knobs', set: Knobs): number[] => (which === 'knobs' ? knobFeatures(set, sensNow, orderNow, true) : behaviorFeatures(poolMetrics(set), sensNow, orderNow));
  const poolX = pool.map((set) => featuresOf(model, set));
  const matrix = model === 'knobs' ? quadMatrix : behaviorMatrix;
  const fitted = model === 'knobs' ? knobsModel : behaviorModel;
  let bestAt = 0;
  poolX.forEach((x, i) => {
    if (fitted.predict(x) > fitted.predict(poolX[bestAt]!)) bestAt = i;
  });
  // A few small steps around the winner (the pool is a coarse net in four dimensions).
  let best = pool[bestAt]!;
  let bestValue = fitted.predict(poolX[bestAt]!);
  for (let i = 0; i < 120; i++) {
    const set = knobsFromUnit(unitOf(best).map((v) => Math.min(1, Math.max(0, v + (random() - 0.5) * 0.1))));
    const value = fitted.predict(featuresOf(model, set));
    if (value > bestValue) {
      best = set;
      bestValue = value;
    }
  }

  // Resampled fits: the spread of where the best setting lands, what each behaviour is worth, and where the fits disagree most.
  const fits = Array.from({ length: Math.min(B, 40) }, () => {
    const pick = resample();
    return ridge(pick.map((i) => matrix[i]!), pick.map((i) => y[i]!), 10);
  });
  const bestPerFit = fits.map((f) => pool[poolX.reduce((a, x, i) => (f.predict(x) > f.predict(poolX[a]!) ? i : a), 0)]!);
  const spread = Object.fromEntries(KNOBS.map((k) => {
    const s = sortNum(bestPerFit.map((b) => b[k.key]));
    return [k.key, [quantile(s, 0.25), quantile(s, 0.75)] as [number, number]];
  })) as Record<KnobKey, [number, number]>;
  const weightFits = Array.from({ length: Math.min(B, 40) }, () => {
    const pick = resample();
    return ridge(pick.map((i) => behaviorMatrix[i]!), pick.map((i) => y[i]!), 10);
  });
  const weightFit = ridge(behaviorMatrix, y, 10);
  const weights = FEATURES.map((f, j) => {
    const s = sortNum(weightFits.map((w) => w.coef[j]!));
    return { key: f.key, label: f.label, weight: weightFit.coef[j]!, lo: quantile(s, 0.05), hi: quantile(s, 0.95) };
  });
  const scored = pool.map((set, i) => {
    const preds = fits.map((f) => f.predict(poolX[i]!));
    const m = mean(preds);
    return { set, up: m + Math.sqrt(mean(preds.map((p) => (p - m) ** 2))) };
  }).sort((a, b) => b.up - a.up);
  const next: Knobs[] = [best];
  for (const c of scored) {
    if (next.length >= (options.proposals ?? 12)) break;
    if (next.some((n) => distance(unitOf(n), unitOf(c.set)) < 0.25)) continue;
    next.push(c.set);
  }
  report.surface = { model, looR2: { behavior: behaviorModel.looR2, knobs: knobsModel.looR2 }, best, predicted: bestValue, bestBehavior: poolMetrics(best), weights, spread, next };
  if (fitted.looR2 < 0.1) notes.push(`모델이 아직 보지 못한 평가를 거의 못 맞힙니다(R² ${fitted.looR2.toFixed(2)}). 아래 최적값은 믿지 말고, 더 평가해 보세요.`);
  return report;
}

const knobsOf = (f: Feel): Knobs => ({ smoothingMs: f.smoothingMs, smoothingFadeRate: f.smoothingFadeRate, carryMs: f.carryMs, curve: f.curve });

/** The report as text for a person. */
export function formatReport(r: Report): string {
  const lines: string[] = [];
  const f1 = (v: number): string => v.toFixed(1);
  const sgn = (v: number, d = 1): string => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
  lines.push(`평가 ${r.used}개 분석${r.skipped.tooShort ? ` (짧은 ${r.skipped.tooShort}개 제외)` : ''}`);
  if (r.noise) lines.push(`같은 후보를 다시 평가했을 때 점수 흔들림: ±${f1(r.noise.sd)}점 (${r.noise.pairs}쌍). 이보다 작은 차이는 우연일 수 있습니다.`);
  if (r.drift !== null && Math.abs(r.drift) >= 0.3) lines.push(`평가 순서에 따른 점수 이동: 10개마다 ${sgn(r.drift)}점 (점수 기준이 변하고 있습니다)`);
  lines.push('', '후보 순위');
  for (const c of r.candidates.slice(0, 12)) {
    const flags = Object.entries(c.flagged).map(([k, v]) => `${SITUATIONS.find((s) => s.key === k)?.label}${v! > 0 ? '+' : '−'}`).join(' ');
    lines.push(`  ${c.id.padEnd(6)} ${f1(c.mean)}점 (${c.n}회)  ${describeKnobs(c.set)}${flags ? `  [${flags}]` : ''}`);
  }
  if (r.candidates.length > 12) lines.push(`  … 나머지 ${r.candidates.length - 12}개, 가장 낮은 것 ${r.candidates[r.candidates.length - 1]!.id} ${f1(r.candidates[r.candidates.length - 1]!.mean)}점`);
  if (r.effects.length) {
    lines.push('', '값을 범위 끝에서 끝까지 올렸을 때 점수 변화 (90% 구간)');
    for (const e of r.effects) lines.push(`  ${e.label}: ${sgn(e.effect)}  (${sgn(e.lo)} ~ ${sgn(e.hi)})${e.lo > 0 || e.hi < 0 ? '  ← 구간이 0을 지나지 않음' : ''}`);
  }
  if (r.behavior.length) {
    lines.push('', '필터가 실제로 하는 일과 점수의 상관 (−1~1)');
    for (const b of r.behavior.slice(0, 6)) lines.push(`  ${b.label}: ${sgn(b.r, 2)}  (${b.lo.toFixed(2)} ~ ${b.hi.toFixed(2)})`);
  }
  const judged = r.situations.filter((s) => s.good + s.bad > 0);
  if (judged.length) {
    lines.push('', '상황별 표시 (좋음/아쉬움 횟수, 값을 올릴 때 좋음−아쉬움의 변화)');
    for (const s of judged) {
      const fx = s.effects ? s.effects.filter((e) => Math.abs(e.effect) >= 0.2).map((e) => `${e.label} ${sgn(e.effect)}`).join(', ') : '표시가 8개 미만이라 아직 모름';
      lines.push(`  ${s.label}: 좋음 ${s.good} / 아쉬움 ${s.bad}  → ${fx || '뚜렷한 방향 없음'}`);
    }
  }
  if (r.scenes.length > 1) lines.push('', `장면별 평균: ${r.scenes.map((s) => `${s.label} ${f1(s.mean)}점(${s.n})`).join(' · ')}`);
  if (r.surface) {
    const s = r.surface;
    lines.push('', `두 모델이 안 본 평가를 맞히는 정도(R²): 필터 동작 기준 ${s.looR2.behavior.toFixed(2)}, 노브 기준 ${s.looR2.knobs.toFixed(2)} → ${s.model === 'behavior' ? '필터 동작' : '노브'} 기준을 씁니다`);
    lines.push('필터 동작 한 가지가 표준편차만큼 커질 때 점수 변화 (90% 구간)');
    for (const w of s.weights) lines.push(`  ${w.label}: ${sgn(w.weight, 2)}  (${sgn(w.lo, 2)} ~ ${sgn(w.hi, 2)})`);
    lines.push('', `모델이 가리키는 최적 (예측 ${f1(s.predicted)}점)`);
    lines.push(`  ${describeKnobs(s.best)}`);
    lines.push(`  그 동작: 시작 지연 ${s.bestBehavior.lagFast} ms · 멈춘 뒤 밀림 ${s.bestBehavior.slideFast} ms · 천천히 움직일 때 울퉁불퉁 ${(s.bestBehavior.jitterSlow * 100).toFixed(0)}% · 90° 휘두름 ${(s.bestBehavior.swipe * 100).toFixed(0)}%`);
    lines.push(`  다시 뽑아 본 최적값의 중간 절반: ${KNOBS.map((k) => `${k.label} ${s.spread[k.key][0]}~${s.spread[k.key][1]}`).join(' · ')}`);
    lines.push('', '다음 라운드 후보');
    s.next.forEach((k, i) => lines.push(`  ${i + 1}. ${describeKnobs(k)}`));
  }
  for (const n of r.notes) lines.push('', `※ ${n}`);
  return lines.join('\n');
}

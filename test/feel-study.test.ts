// SPDX-License-Identifier: AGPL-3.0-only
//
// The mouse-feel study: a fixed round of candidates, strict ratings, and an analysis that has to find out what a person
// prefers from their scores. The last part is tested against a made-up person whose taste is known (and who is a little
// inconsistent), so that "the analysis found it" means something.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzeRatings, ANCHORS, behaviorMetrics, CENTER, DEFAULT_GAME, describeKnobs, formatReport, KNOBS, knobsEqual, nextCandidate, parseRating, RETEST_EVERY, rng, ROUND_1, SPEED_BINS, TrialMeter,
  type Candidate, type FeelRating, type Knobs,
} from '../src/engine/feel-study.ts';
import { clearMissing, missingKeys, translate } from '../src/i18n/index.ts';
import { FEEL_PRESETS } from '../web/mouse-feel.ts';

const feelOf = (k: Knobs, degPerCount = 0.05) => ({ degPerCount, ...k });

describe('the first round of candidates', () => {
  const round = ROUND_1.candidates;

  it('has 48 different settings with ids in order', () => {
    assert.equal(round.length, 48);
    assert.deepEqual(round.map((c) => c.id), Array.from({ length: 48 }, (_, i) => `r1-${String(i + 1).padStart(2, '0')}`));
    for (let i = 0; i < round.length; i++) for (let j = i + 1; j < round.length; j++) assert.ok(!knobsEqual(round[i]!.set, round[j]!.set), `${round[i]!.id} and ${round[j]!.id} are the same setting`);
  });

  it('is the same on every computer, because ratings refer to it (a rating names its candidate)', () => {
    assert.equal(describeKnobs(round[3]!.set), 'Smoothing 6 ms · release 155 °/s · carry-over 0 ms · curve 1.3');
    assert.equal(round[4]!.kind, 'single');
  });

  it('starts with the three known starting points, which are the ones the panel offers', () => {
    assert.deepEqual(round.slice(0, 3).map((c) => c.kind), ['anchor', 'anchor', 'anchor']);
    const offered = FEEL_PRESETS.map((p) => p.set);
    for (const a of ANCHORS) assert.ok(offered.some((o) => knobsEqual(o, a)), `${describeKnobs(a)} is not one of the panel's presets`);
    assert.equal(ANCHORS.length, offered.length);
  });

  it('has one-knob-at-a-time variations of the middle one: they differ from it in exactly one knob', () => {
    const singles = round.filter((c) => c.kind === 'single');
    assert.equal(singles.length, 8);
    for (const c of singles) {
      const differing = KNOBS.filter((k) => c.set[k.key] !== CENTER[k.key]);
      assert.equal(differing.length, 1, `${c.id} differs in ${differing.map((k) => k.key)}`);
    }
    // Each knob is moved both ways.
    for (const k of KNOBS) assert.equal(singles.filter((c) => c.set[k.key] !== CENTER[k.key] && c.set[k.key] !== undefined && KNOBS.every((o) => o.key === k.key || c.set[o.key] === CENTER[o.key])).length, 2, k.key);
  });

  it('stays inside what the controls accept, and uses the whole range of every knob', () => {
    for (const c of round) {
      assert.ok(c.set.smoothingMs >= 0 && c.set.smoothingMs <= 30, c.id);
      assert.ok(c.set.smoothingFadeRate === 0 || (c.set.smoothingFadeRate >= 15 && c.set.smoothingFadeRate <= 160), c.id);
      assert.ok(c.set.carryMs >= 0 && c.set.carryMs <= 600, c.id);
      assert.ok(c.set.curve >= 0.8 && c.set.curve <= 1.5, c.id);
    }
    for (const k of KNOBS) {
      const values = round.map((c) => c.set[k.key]);
      assert.ok(Math.min(...values) <= k.lo + (k.hi - k.lo) * 0.15 && Math.max(...values) >= k.hi - (k.hi - k.lo) * 0.15, `${k.key} spans ${Math.min(...values)}..${Math.max(...values)}`);
    }
  });

  it('spreads the rest over the space: no two of them nearly the same', () => {
    const space = round.filter((c) => c.kind === 'space');
    assert.equal(space.length, 37);
    const unit = (c: Candidate): number[] => KNOBS.map((k) => k.toUnit(c.set[k.key]));
    let closest = Infinity;
    for (let i = 0; i < space.length; i++) for (let j = i + 1; j < space.length; j++) closest = Math.min(closest, Math.hypot(...unit(space[i]!).map((v, d) => v - unit(space[j]!)[d]!)));
    assert.ok(closest > 0.12, `the two closest are ${closest.toFixed(3)} apart`);
  });
});

describe('which candidate comes next', () => {
  const ratedUpTo = (n: number): Array<{ preset: string }> => ROUND_1.candidates.slice(0, n).map((c) => ({ preset: c.id }));

  it('goes through the round in order', () => {
    assert.equal(nextCandidate(ROUND_1, []).candidate.id, 'r1-01');
    assert.equal(nextCandidate(ROUND_1, ratedUpTo(3)).candidate.id, 'r1-04');
  });

  it(`offers the oldest single rating again after every ${RETEST_EVERY} ratings, so the noise of the scores can be seen`, () => {
    const next = nextCandidate(ROUND_1, ratedUpTo(RETEST_EVERY));
    assert.equal(next.retest, true);
    assert.equal(next.candidate.id, 'r1-01');
    // Once it has been done, the round goes on.
    const after = nextCandidate(ROUND_1, [...ratedUpTo(RETEST_EVERY), { preset: 'r1-01' }]);
    assert.equal(after.retest, false);
    assert.equal(after.candidate.id, `r1-${String(RETEST_EVERY + 1).padStart(2, '0')}`);
  });

  it('comes back to the least rated ones when everything has been rated, and never runs out', () => {
    const all = ROUND_1.candidates.map((c) => ({ preset: c.id }));
    const next = nextCandidate(ROUND_1, all);
    assert.equal(next.retest, true);
    assert.ok(next.candidate);
  });
});

function goodRating(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1b2c3d4e5', at: '2026-11-25T14:00:00.000Z', round: 'r1', preset: 'r1-07',
    feel: feelOf(CENTER), changed: false, score: 7, flags: { stop: -1, slow: 1, flick: 0 }, scene: 'aim', note: '꽤 괜찮음',
    playout: 'balanced', delayMs: 48, latencyMs: 90, game: { ...DEFAULT_GAME, measured: false },
    trial: { seconds: 41.5, speedShare: [0.1, 0.2, 0.3, 0.2, 0.1, 0.05, 0.05] },
    ...over,
  };
}

describe('parseRating', () => {
  const now = Date.parse('2026-11-25T15:00:00Z');

  it('accepts a whole rating and gives back a clean copy', () => {
    const p = parseRating({ ...goodRating(), extra: 'ignored', password: 'x' }, now);
    assert.ok(p.ok);
    if (!p.ok) return;
    assert.equal(p.rating.score, 7);
    assert.deepEqual(p.rating.flags, { stop: -1, slow: 1 }, 'a situation marked 0 is the same as not marked');
    assert.equal('extra' in p.rating, false);
    assert.equal('password' in p.rating, false);
  });

  it('accepts a rating without the optional parts', () => {
    const p = parseRating({ ...goodRating(), flags: undefined, scene: null, note: undefined, playout: null, delayMs: null, latencyMs: undefined }, now);
    assert.ok(p.ok, JSON.stringify(p));
  });

  const refused: Array<[string, Record<string, unknown>]> = [
    ['a score of 0', { score: 0 }],
    ['a score of 11', { score: 11 }],
    ['a score with a fraction', { score: 6.5 }],
    ['a score as text', { score: '7' }],
    ['an id with a slash', { id: 'a/../b1234567' }],
    ['an id that is too short', { id: 'abc' }],
    ['a time that is not a time', { at: 'yesterday' }],
    ['a time far in the future', { at: '2030-01-01T00:00:00Z' }],
    ['a sensitivity out of range', { feel: feelOf(CENTER, 5) }],
    ['a missing knob', { feel: { degPerCount: 0.05, smoothingMs: 5 } }],
    ['a smoothing that is not a number', { feel: { ...feelOf(CENTER), smoothingMs: 'x' } }],
    ['an unknown situation', { flags: { cooking: 1 } }],
    ['a situation marked 2', { flags: { stop: 2 } }],
    ['an unknown scene', { scene: 'moon' }],
    ['a note that is too long', { note: 'x'.repeat(201) }],
    ['an unknown way of showing the picture', { playout: 'fast' }],
    ['a game model out of range', { game: { ...DEFAULT_GAME, measured: false, innerDeadzone: 0.9 } }],
    ['a speed share with the wrong number of bins', { trial: { seconds: 20, speedShare: [1] } }],
    ['a negative time', { trial: { seconds: -1, speedShare: new Array(SPEED_BINS).fill(0) } }],
  ];
  for (const [name, over] of refused) {
    it(`refuses ${name}`, () => {
      assert.equal(parseRating(goodRating(over), now).ok, false);
    });
  }
  it('refuses what is not an object', () => {
    for (const v of [null, 5, 'x', [], undefined]) assert.equal(parseRating(v, now).ok, false);
  });
});

describe('TrialMeter: what the hand did while a setting was tried', () => {
  it('counts only the time the game had the mouse', () => {
    const m = new TrialMeter(0.1);
    for (let i = 0; i < 250; i++) m.tick(0.004, 1, 0, 0.05, false);
    assert.equal(m.snapshot().seconds, 0);
    for (let i = 0; i < 250; i++) m.tick(0.004, 1, 0, 0.05, true);
    assert.equal(m.snapshot().seconds, 1);
  });

  it('sorts the time by the hand\'s speed over a window, not by single ticks of whole counts', () => {
    const m = new TrialMeter(0.1);
    // 3 counts every 4 ms is 750 counts a second; at 0.05 degrees a count that is 37.5 deg/s: the 20..60 bin
    for (let i = 0; i < 500; i++) m.tick(0.004, 3, 0, 0.05, true);
    const s = m.snapshot();
    assert.equal(s.seconds, 2);
    assert.equal(s.speedShare[3], 1);
    // one count every fourth tick is about 3 deg/s all the time (the 0.5..5 bin), not "fast" in the quarter of the ticks that have a count
    const slow = new TrialMeter(0.1);
    for (let i = 0; i < 500; i++) slow.tick(0.004, i % 4 === 0 ? 1 : 0, 0, 0.05, true);
    assert.equal(slow.snapshot().speedShare[1], 1, JSON.stringify(slow.snapshot().speedShare));
  });

  it('shares add up to one, and reset forgets', () => {
    const m = new TrialMeter();
    for (let i = 0; i < 1000; i++) m.tick(0.004, i % 50 < 20 ? 8 : 0, 0, 0.05, true);
    assert.ok(Math.abs(m.snapshot().speedShare.reduce((a, b) => a + b, 0) - 1) < 0.01);
    m.reset();
    assert.deepEqual(m.snapshot(), { seconds: 0, speedShare: new Array(SPEED_BINS).fill(0) });
  });
});

describe('behaviorMetrics: what a setting does, by running the engine', () => {
  const m = (k: Knobs) => behaviorMetrics(feelOf(k));

  it('says the unfiltered one starts and stops at once, and the fixed 12 ms one does not', () => {
    const sharp = m({ smoothingMs: 0, smoothingFadeRate: 0, carryMs: 300, curve: 1 });
    const smooth = m({ smoothingMs: 12, smoothingFadeRate: 0, carryMs: 300, curve: 1 });
    assert.equal(sharp.lagFast, 0);
    assert.equal(sharp.slideFast, 0);
    assert.ok(smooth.lagFast >= 12, `lag ${smooth.lagFast}`);
    assert.ok(smooth.slideFast >= 60, `slide ${smooth.slideFast}`);
  });

  it('says the filter that fades out with speed keeps the slow pan even and still has no delay on a turn (the reason for it)', () => {
    const sharp = m({ smoothingMs: 0, smoothingFadeRate: 0, carryMs: 300, curve: 1 });
    const smooth = m({ smoothingMs: 12, smoothingFadeRate: 0, carryMs: 300, curve: 1 });
    const balanced = m(CENTER);
    assert.ok(balanced.jitterSlow < sharp.jitterSlow * 0.6, `${balanced.jitterSlow} against ${sharp.jitterSlow}`);
    assert.ok(Math.abs(balanced.jitterSlow - smooth.jitterSlow) < 0.03);
    assert.equal(balanced.lagFast, 0);
    assert.equal(balanced.slideFast, 0);
  });

  it('says what the carry-over does: without it a fast swipe turns much less than the hand did', () => {
    assert.ok(m({ ...CENTER, carryMs: 0 }).swipe < 0.75);
    assert.ok(m({ ...CENTER, carryMs: 300 }).swipe > 0.95);
  });

  it('says what a curve does to the gain at a middle speed', () => {
    assert.ok(Math.abs(m(CENTER).gainMid - 1) < 0.02);
    assert.ok(m({ ...CENTER, curve: 1.4 }).gainMid < 0.6);
    assert.ok(m({ ...CENTER, curve: 0.85 }).gainMid > 1.2);
  });

  it('is the same every time it is asked', () => {
    assert.deepEqual(m(CENTER), m(CENTER));
  });
});

// A made-up person whose taste is known: they dislike a late start, a run-on after the stop, an uneven slow pan, a swipe that
// does not turn as far as the hand, and a gain that is not 1. Their scores are rounded and a little inconsistent.
const taste = (k: Knobs): number => {
  const b = behaviorMetrics(feelOf(k));
  const u = 9 - 0.05 * b.lagFast - 0.04 * b.slideFast - 8 * b.jitterSlow - 3 * Math.max(0, 1 - b.swipe) - 4 * Math.abs(b.gainMid - 1) - 2 * Math.abs(b.gainSlow - 1);
  return Math.max(1, Math.min(10, u));
};

function makeSession(count: number, seed: number, noiseSd: number): FeelRating[] {
  const random = rng(seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const out: FeelRating[] = [];
  for (let i = 0; i < count; i++) {
    const c = i < ROUND_1.candidates.length ? ROUND_1.candidates[i]! : ROUND_1.candidates[(i * 5) % 8]!;
    out.push({
      id: `t${String(i).padStart(8, '0')}`, at: new Date(Date.UTC(2026, 10, 25, 12, 0, i)).toISOString(), round: 'r1', preset: c.id,
      feel: feelOf(c.set), changed: false, score: Math.max(1, Math.min(10, Math.round(taste(c.set) + noiseSd * gauss()))), flags: {}, scene: 'aim', note: '', playout: 'smooth', delayMs: 50, latencyMs: 80,
      game: { ...DEFAULT_GAME, measured: false }, trial: { seconds: 30, speedShare: [0, 0.2, 0.3, 0.3, 0.15, 0.05, 0] },
    });
  }
  return out;
}

describe('analyzeRatings, against a person whose taste is known', () => {
  const ratings = makeSession(56, 5, 0.6);
  const report = analyzeRatings(ratings, { seed: 3 });
  const truth = ROUND_1.candidates.map((c) => [c.id, taste(c.set)] as const).sort((a, b) => b[1] - a[1]);

  it('puts the candidates the person likes best at the top', () => {
    const top = report.candidates.slice(0, 4).map((c) => c.id);
    const truly = truth.slice(0, 8).map((t) => t[0]);
    assert.ok(top.filter((id) => truly.includes(id)).length >= 3, `top ${top} against the truly best ${truly}`);
  });

  it('measures how much the scores themselves move when nothing changed', () => {
    assert.ok(report.noise, 'there are repeated candidates');
    assert.ok(report.noise!.sd > 0.3 && report.noise!.sd < 1.1, `noise ${report.noise!.sd} (the made-up person is off by 0.6 and rounds to whole points)`);
  });

  it('says smoothing lowers the score and carry-over raises it, with an interval that does not include 0', () => {
    const smoothing = report.effects.find((e) => e.key === 'smoothingMs')!;
    const carry = report.effects.find((e) => e.key === 'carryMs')!;
    assert.ok(smoothing.effect < -0.5 && smoothing.hi < 0, JSON.stringify(smoothing));
    assert.ok(carry.effect > 0.3 && carry.lo > -0.5, JSON.stringify(carry));
  });

  it('finds that a late start and a run-on after the stop are what the person minds', () => {
    const w = (key: string): number => report.surface!.weights.find((x) => x.key === key)!.weight;
    assert.ok(report.surface, 'enough ratings for a model');
    assert.ok(w('lagFast') < -0.2, `lagFast ${w('lagFast')}`);
    assert.ok(w('slideFast') < -0.5, `slideFast ${w('slideFast')}`);
    assert.ok(w('jitterSlow') < -0.2, `jitterSlow ${w('jitterSlow')}`);
  });

  it('names a best setting that is really about as good as the best there is', () => {
    const best = report.surface!.best;
    let top = 0;
    const random = rng(9);
    for (let i = 0; i < 1500; i++) top = Math.max(top, taste(Object.fromEntries(KNOBS.map((k) => [k.key, k.fromUnit(random())])) as unknown as Knobs));
    assert.ok(taste(best) > top - 0.8, `the named best is worth ${taste(best).toFixed(2)}, the best of 1500 random settings ${top.toFixed(2)}`);
  });

  it('proposes more settings to try, the first being its best guess, all different', () => {
    const next = report.surface!.next;
    assert.ok(next.length >= 8);
    assert.ok(knobsEqual(next[0]!, report.surface!.best));
    for (let i = 0; i < next.length; i++) for (let j = i + 1; j < next.length; j++) assert.ok(!knobsEqual(next[i]!, next[j]!));
  });

  it('gives the same answer for the same ratings and seed', () => {
    assert.deepEqual(analyzeRatings(ratings, { seed: 3 }).surface?.best, report.surface!.best);
  });

  it('writes a report that names the best candidate, the noise and the best setting', () => {
    const text = formatReport(report);
    assert.ok(text.includes(report.candidates[0]!.id));
    assert.ok(text.includes('How much the score moved'));
    assert.ok(text.includes('The best setting the model points at'));
  });

  it('writes the same report in Korean, with the same numbers, for a page that is read in Korean (and English where no Korean was written)', () => {
    clearMissing();
    const ko = formatReport(report, 'ko');
    assert.ok(ko.includes('점수 흔들림'));
    assert.ok(ko.includes('모델이 가리키는 최적'));
    assert.ok(ko.includes(report.candidates[0]!.id));
    assert.ok(ko.includes(describeKnobs(report.surface!.best, (en, vars) => translate('ko', en, vars))));
    assert.ok(!/\{\w+\}/.test(ko), 'every {value} was filled in');
    assert.equal(missingKeys().filter((k) => !k.startsWith('A sentence nobody')).length, 0, `no Korean for: ${missingKeys().join(' | ')}`);
  });
});

describe('analyzeRatings with little to go on', () => {
  it('says so, and does not name a best, when there are only a few ratings', () => {
    const r = analyzeRatings(makeSession(6, 1, 0.5));
    assert.equal(r.used, 6);
    assert.equal(r.surface, null);
    assert.equal(r.effects.length, 0);
    assert.ok(r.notes.some((n) => n.en.includes('Fewer than 10 ratings')));
  });

  it('does not build a model of the best setting from fewer than twenty ratings', () => {
    const r = analyzeRatings(makeSession(14, 1, 0.5));
    assert.ok(r.effects.length > 0);
    assert.equal(r.surface, null);
  });

  it('leaves out a rating made with hardly any time with the mouse', () => {
    const list = makeSession(12, 2, 0.5);
    list[0]!.trial.seconds = 2;
    const r = analyzeRatings(list);
    assert.equal(r.used, 11);
    assert.equal(r.skipped.tooShort, 1);
  });

  it('copes with no ratings at all', () => {
    assert.equal(analyzeRatings([]).used, 0);
  });

  it('does not find a best setting in scores that mean nothing (the model has to predict ratings it has not seen)', () => {
    const random = rng(77);
    const noise = makeSession(56, 5, 0.6).map((r) => ({ ...r, score: 1 + Math.floor(random() * 10) }));
    const r = analyzeRatings(noise, { seed: 3 });
    const fit = Math.max(r.surface!.looR2.behavior, r.surface!.looR2.knobs);
    assert.ok(fit < 0.25, `the fit claims R² ${fit.toFixed(2)} on scores that are random`);
    assert.ok(r.notes.some((n) => n.en.includes('Do not trust the best setting')), r.notes.map((n) => n.en).join('|'));
  });
});

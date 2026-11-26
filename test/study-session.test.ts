// SPDX-License-Identifier: AGPL-3.0-only
//
// The way one person goes through the study: what "save", "skip" and "back" do, and what is refused.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CENTER, DEFAULT_GAME, RETEST_EVERY, ROUND_1, type Knobs } from '../src/engine/feel-study.ts';
import { StudySession, type TrialContext } from '../web/study-session.ts';

let counter = 0;
const make = (o: ConstructorParameters<typeof StudySession>[0] = {}): StudySession => new StudySession({ newId: () => `id${String(++counter).padStart(10, '0')}`, now: () => new Date('2026-11-25T14:00:00Z'), ...o });
const ctxFor = (s: StudySession, over: Partial<TrialContext> = {}): TrialContext => ({
  feel: { degPerCount: 0.05, ...s.candidate!.set }, playout: 'balanced', delayMs: 42.4, latencyMs: 88.6, game: { ...DEFAULT_GAME, measured: false }, trial: { seconds: 30, speedShare: [0, 0.1, 0.4, 0.3, 0.1, 0.1, 0] }, ...over,
});
const original: Knobs = { smoothingMs: 12, smoothingFadeRate: 0, carryMs: 300, curve: 1 };

describe('going through the round', () => {
  it('starts with the first candidate and remembers what the person had before', () => {
    const s = make();
    const c = s.start(original);
    assert.equal(c.id, 'r1-01');
    assert.equal(s.active, true);
    assert.deepEqual(s.state.original, original);
  });

  it('gives the original values back on stop, and is no longer running', () => {
    const s = make();
    s.start(original);
    assert.deepEqual(s.stop(), original);
    assert.equal(s.active, false);
    assert.equal(s.candidate, null);
    assert.equal(s.stop(), null, 'a second stop has nothing to give back');
  });

  it('does not replace the saved original when started again while running', () => {
    const s = make();
    s.start(original);
    s.start({ ...CENTER, curve: 1.3 });
    assert.deepEqual(s.state.original, original);
  });

  it('refuses to save without a score, and nothing is lost: the candidate stays', () => {
    const s = make();
    s.start(original);
    assert.deepEqual(s.save(ctxFor(s)), { ok: false, error: 'no-score' });
    assert.equal(s.candidate!.id, 'r1-01');
    assert.equal(s.ratings.length, 0);
  });

  it('refuses to save when nothing is running', () => {
    const idle = make();
    const ctx: TrialContext = { feel: { degPerCount: 0.05, ...CENTER }, playout: null, delayMs: null, latencyMs: null, game: { ...DEFAULT_GAME, measured: false }, trial: { seconds: 30, speedShare: new Array(7).fill(0) } };
    assert.deepEqual(idle.save(ctx), { ok: false, error: 'not-running' });
  });

  it('keeps a rating with what was in force, moves on to the next candidate and clears the form', () => {
    const s = make();
    s.start(original);
    s.setScore(8);
    s.setFlag('stop', -1);
    s.setFlag('slow', 1);
    s.setNote('좋다');
    s.setScene('aim');
    const first = s.candidate!;
    const r = s.save(ctxFor(s));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.rating.preset, first.id);
    assert.equal(r.rating.score, 8);
    assert.deepEqual(r.rating.flags, { stop: -1, slow: 1 });
    assert.equal(r.rating.scene, 'aim');
    assert.equal(r.rating.note, '좋다');
    assert.equal(r.rating.changed, false);
    assert.equal(r.rating.delayMs, 42, 'whole milliseconds');
    assert.equal(r.rating.latencyMs, 89);
    assert.equal(r.next.id, 'r1-02');
    assert.equal(s.candidate!.id, 'r1-02');
    assert.deepEqual(s.pending, { score: null, flags: {}, note: '' });
    assert.equal(s.state.scene, 'aim', 'the scene is the person\'s state, not the form\'s: it stays for the next one');
  });

  it('notes that the values were changed by hand during the try (and that a changed sensitivity alone is not that)', () => {
    const s = make();
    s.start(original);
    s.setScore(6);
    const edited = s.save(ctxFor(s, { feel: { degPerCount: 0.05, ...s.candidate!.set, smoothingMs: s.candidate!.set.smoothingMs + 3 } }));
    assert.ok(edited.ok && edited.rating.changed);
    s.setScore(6);
    const tuned = s.save(ctxFor(s, { feel: { degPerCount: 0.08, ...s.candidate!.set } }));
    assert.ok(tuned.ok && !tuned.rating.changed);
    assert.equal(tuned.ok && tuned.rating.feel.degPerCount, 0.08, 'the sensitivity in force is recorded');
  });

  it('refuses what the server would refuse, saying which part', () => {
    const s = make();
    s.start(original);
    s.setScore(5);
    const r = s.save(ctxFor(s, { feel: { degPerCount: 9, ...s.candidate!.set } }));
    assert.deepEqual(r, { ok: false, error: 'invalid', detail: 'feel' });
    assert.equal(s.ratings.length, 0);
  });

  it('leaves out a delay that was not measured (NaN, negative) instead of failing the rating', () => {
    const s = make();
    s.start(original);
    s.setScore(5);
    const r = s.save(ctxFor(s, { delayMs: Number.NaN, latencyMs: -3 }));
    assert.ok(r.ok);
    assert.equal(r.ok && r.rating.delayMs, null);
    assert.equal(r.ok && r.rating.latencyMs, null);
  });

  it(`offers the first ones again after ${RETEST_EVERY} ratings, marked as a second try`, () => {
    const s = make();
    s.start(original);
    for (let i = 0; i < RETEST_EVERY; i++) {
      s.setScore(5);
      assert.ok(s.save(ctxFor(s)).ok);
    }
    assert.equal(s.candidate!.id, 'r1-01');
    assert.equal(s.retest, true);
    assert.deepEqual(s.progress, { rated: RETEST_EVERY, total: 48, ratings: RETEST_EVERY });
  });
});

describe('skip and undo', () => {
  it('passes a candidate over and brings it back when everything else has been tried', () => {
    const s = make();
    s.start(original);
    const skipped = s.candidate!.id;
    assert.equal(s.skip()!.id, 'r1-02');
    assert.equal(s.ratings.length, 0);
    // Rate everything else: the skipped one comes up after the last of them.
    let guard = 0;
    while (s.candidate!.id !== skipped && guard++ < 100) {
      s.setScore(5);
      assert.ok(s.save(ctxFor(s)).ok);
    }
    assert.ok(guard < 100, 'it came back');
    assert.ok(s.ratings.length >= 47, `${s.ratings.length} ratings before it came back`);
  });

  it('takes back a rating that was kept: it is dropped, and the candidate is there to be rated again', () => {
    const s = make();
    s.start(original);
    s.setScore(5);
    s.save(ctxFor(s));
    assert.equal(s.candidate!.id, 'r1-02');
    const kept = s.ratings[0]!;
    s.markSent([kept.id]);
    const undone = s.undo()!;
    assert.equal(undone.candidate.id, 'r1-01');
    assert.equal(undone.removed?.id, kept.id);
    assert.equal(undone.wasSent, true, 'the page has to take it back from the server too');
    assert.equal(s.ratings.length, 0);
    assert.equal(s.retest, false, 'nothing of it is left, so it is a first try again');
    assert.equal(s.sent.has(kept.id), false);
    assert.deepEqual(s.pending, { score: null, flags: {}, note: '' });
    assert.equal(s.undo(), null, 'nothing before the first');
  });

  it('takes back a pass, and only that: an earlier rating of the same candidate stays', () => {
    const s = make();
    s.start(original);
    s.setScore(5);
    s.save(ctxFor(s));
    assert.equal(s.skip()!.id, 'r1-03');
    const undone = s.undo()!;
    assert.equal(undone.candidate.id, 'r1-02');
    assert.equal(undone.removed, null);
    assert.equal(s.ratings.length, 1);
    assert.deepEqual(s.state.skipped, []);
  });

  it('can be taken back step by step', () => {
    const s = make();
    s.start(original);
    for (let i = 0; i < 3; i++) {
      s.setScore(6);
      s.save(ctxFor(s));
    }
    assert.equal(s.undo()!.candidate.id, 'r1-03');
    assert.equal(s.undo()!.candidate.id, 'r1-02');
    assert.equal(s.undo()!.candidate.id, 'r1-01');
    assert.equal(s.ratings.length, 0);
  });

  it('reads what an earlier version of the page kept (a list of ids), and can undo through it without dropping a rating', () => {
    const s = make({ state: { active: true, currentId: 'r1-02', history: ['r1-01'] as unknown as never } });
    const undone = s.undo()!;
    assert.equal(undone.candidate.id, 'r1-01');
    assert.equal(undone.removed, null);
  });
});

describe('scoring while playing', () => {
  it('gives the score and keeps the rating in one go, and moves on', () => {
    const s = make();
    s.start(original);
    const r = s.rate(9, ctxFor(s));
    assert.ok(r.ok);
    assert.equal(r.ok && r.rating.score, 9);
    assert.equal(s.candidate!.id, 'r1-02');
  });

  it('keeps nothing when the mouse had too little time, and says how long to go on', () => {
    const s = make();
    s.start(original);
    s.setFlag('stop', -1);
    const r = s.rate(3, ctxFor(s, { trial: { seconds: 5.2, speedShare: new Array(7).fill(0) } }));
    assert.deepEqual(r, { ok: false, error: 'too-short', secondsLeft: 3 });
    assert.equal(s.ratings.length, 0);
    assert.equal(s.candidate!.id, 'r1-01');
    assert.deepEqual(s.pending.flags, { stop: -1 }, 'what was marked is not lost');
    assert.equal(s.pending.score, 3, 'nor is the score: the key can be pressed again');
    assert.ok(s.save(ctxFor(s)).ok, 'once there has been time, saving needs no second press');
  });

  it('does not rate when nothing is running', () => {
    const idle = make();
    assert.deepEqual(idle.rate(5, { feel: { degPerCount: 0.05, ...CENTER }, playout: null, delayMs: null, latencyMs: null, game: { ...DEFAULT_GAME, measured: false }, trial: { seconds: 30, speedShare: new Array(7).fill(0) } }), { ok: false, error: 'not-running' });
  });
});

describe('the form', () => {
  it('keeps the score a whole number between 1 and 10', () => {
    const s = make();
    assert.equal(s.setScore(7.6), 8);
    assert.equal(s.setScore(99), 10);
    assert.equal(s.setScore(-4), 1);
  });

  it('marks a situation bad and takes the mark back with the same key', () => {
    const s = make();
    assert.equal(s.toggleBad('stop'), -1);
    assert.deepEqual(s.pending.flags, { stop: -1 });
    assert.equal(s.toggleBad('stop'), 0);
    assert.deepEqual(s.pending.flags, {});
    s.setFlag('flick', 1);
    assert.equal(s.toggleBad('flick'), -1, 'a good mark is replaced by a bad one');
  });

  it('keeps a note to 200 characters', () => {
    const s = make();
    s.setNote('x'.repeat(500));
    assert.equal(s.pending.note.length, 200);
  });
});

describe('what has been sent', () => {
  it('knows which ratings the server has not got yet', () => {
    const s = make();
    s.start(original);
    for (let i = 0; i < 3; i++) {
      s.setScore(5 + i);
      s.save(ctxFor(s));
    }
    assert.equal(s.unsent.length, 3);
    s.markSent([s.ratings[0]!.id, s.ratings[1]!.id]);
    assert.deepEqual(s.unsent.map((r) => r.id), [s.ratings[2]!.id]);
  });

  it('takes a rating back, from both lists', () => {
    const s = make();
    s.start(original);
    s.setScore(5);
    s.save(ctxFor(s));
    const id = s.ratings[0]!.id;
    s.markSent([id]);
    assert.equal(s.remove(id), true);
    assert.equal(s.ratings.length, 0);
    assert.equal(s.sent.has(id), false);
    assert.equal(s.remove(id), false);
  });

  it('comes back as it was left (what a page keeps and reads on the next visit), and drops entries that are not valid', () => {
    const s = make();
    s.start(original);
    for (let i = 0; i < 4; i++) {
      s.setScore(4 + i);
      s.save(ctxFor(s));
    }
    s.markSent([s.ratings[0]!.id]);
    const again = make({ ratings: [...s.ratings, { id: 'x', score: 99 }, null], sent: [...s.sent], state: JSON.parse(JSON.stringify(s.state)) });
    assert.equal(again.ratings.length, 4);
    assert.equal(again.active, true);
    assert.equal(again.candidate!.id, s.candidate!.id);
    assert.equal(again.unsent.length, 3);
    assert.equal(again.progress.ratings, 4);
  });

  it('starts over from the next unrated candidate if the stored one is not in the round any more', () => {
    const s = make({ state: { active: true, currentId: 'r9-99' } });
    assert.equal(s.candidate!.id, ROUND_1.candidates[0]!.id);
  });
});

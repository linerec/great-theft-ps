// SPDX-License-Identifier: AGPL-3.0-only
//
// One person's way through the study of the mouse feel (src/engine/feel-study.ts): which candidate is being tried, what has been
// said about it so far, the ratings made, and which of them the server has. No page, no storage and no network in here, so
// that the rules (what happens on "save", on "skip", on "back"; when a rating is refused) are tested on their own; the page
// (study-ui.ts) keeps the state in this browser and sends the ratings.

import {
  knobsEqual, nextCandidate, parseRating, ROUND_1, SITUATIONS, type Candidate, type Feel, type FeelRating, type GameModel, type Knobs, type Playout, type Round, type SceneKey, type SituationKey,
} from '../src/engine/feel-study.ts';

/** What is kept between visits to the page. */
export interface StudyState {
  active: boolean;
  roundId: string;
  /** The candidate being tried now. */
  currentId: string | null;
  /** It is a second (or later) try of a candidate that was rated before. */
  retest: boolean;
  /** The person's own values from before the study, to put back when it ends (the sensitivity is not part of them). */
  original: Knobs | null;
  /** Candidates the person passed over; they come back when everything else has been tried. */
  skipped: string[];
  /** The candidates shown before this one, for "back". */
  history: string[];
  scene: SceneKey | null;
}

/** What the page knows when a rating is made. */
export interface TrialContext {
  feel: Feel;
  playout: Playout | null;
  delayMs: number | null;
  latencyMs: number | null;
  game: GameModel & { measured: boolean };
  trial: { seconds: number; speedShare: number[] };
}

export interface Pending {
  score: number | null;
  flags: Partial<Record<SituationKey, -1 | 1>>;
  note: string;
}

export type SaveResult = { ok: true; rating: FeelRating; next: Candidate; retest: boolean } | { ok: false; error: 'not-running' | 'no-score' | 'invalid'; detail?: string };

const knobsOfFeel = (f: Feel): Knobs => ({ smoothingMs: f.smoothingMs, smoothingFadeRate: f.smoothingFadeRate, carryMs: f.carryMs, curve: f.curve });
/** An id that is new on every device and every time (crypto.randomUUID needs a secure page; getRandomValues does not). */
function randomId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Date.now().toString(36) + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}
const finiteWithin = (v: number | null, hi: number): number | null => (v !== null && Number.isFinite(v) && v >= 0 && v <= hi ? Math.round(v) : null);

export const emptyState = (roundId: string): StudyState => ({ active: false, roundId, currentId: null, retest: false, original: null, skipped: [], history: [], scene: null });

export class StudySession {
  readonly round: Round;
  /** Everything rated on this device, oldest first. */
  ratings: FeelRating[];
  readonly sent: Set<string>;
  state: StudyState;
  pending: Pending = { score: null, flags: {}, note: '' };
  #newId: () => string;
  #now: () => Date;

  constructor(o: { round?: Round; ratings?: readonly unknown[]; sent?: readonly string[]; state?: Partial<StudyState>; newId?: () => string; now?: () => Date } = {}) {
    this.round = o.round ?? ROUND_1;
    // What was kept in the browser is checked as the server would: a hand-edited or damaged entry is not carried along.
    this.ratings = (o.ratings ?? []).map((r) => parseRating(r)).flatMap((p) => (p.ok ? [p.rating] : []));
    this.sent = new Set(o.sent ?? []);
    this.state = { ...emptyState(this.round.id), ...o.state, roundId: this.round.id };
    this.#newId = o.newId ?? randomId;
    this.#now = o.now ?? (() => new Date());
    if (this.state.currentId && !this.round.candidates.some((c) => c.id === this.state.currentId)) this.state.currentId = null;
    if (this.state.active && !this.state.currentId) this.state.currentId = this.#pick().candidate.id;
  }

  get active(): boolean {
    return this.state.active;
  }

  get candidate(): Candidate | null {
    return this.round.candidates.find((c) => c.id === this.state.currentId) ?? null;
  }

  get retest(): boolean {
    return this.state.retest;
  }

  /** Ratings of this round, in the order they were made. */
  get ratingsInRound(): FeelRating[] {
    return this.ratings.filter((r) => r.round === this.round.id);
  }

  /** How far the round has come: candidates rated at least once, out of all of them, and the ratings made altogether. */
  get progress(): { rated: number; total: number; ratings: number } {
    const rated = new Set(this.ratingsInRound.map((r) => r.preset));
    return { rated: this.round.candidates.filter((c) => rated.has(c.id)).length, total: this.round.candidates.length, ratings: this.ratingsInRound.length };
  }

  #pick(): { candidate: Candidate; retest: boolean } {
    const rated = this.ratingsInRound;
    const seen = new Set(rated.map((r) => r.preset));
    let skipped = new Set(this.state.skipped);
    // Passed-over ones come back once nothing else is left unrated.
    if (this.round.candidates.every((c) => seen.has(c.id) || skipped.has(c.id))) {
      this.state.skipped = [];
      skipped = new Set();
    }
    const open = this.round.candidates.filter((c) => !skipped.has(c.id));
    return nextCandidate({ ...this.round, candidates: open }, rated);
  }

  #show(c: Candidate, retest: boolean): Candidate {
    this.state.currentId = c.id;
    this.state.retest = retest;
    this.pending = { score: null, flags: {}, note: '' };
    return c;
  }

  /** Begin: the candidate to put in force. `original` is what the person had before and is put back on stop. */
  start(original: Knobs): Candidate {
    if (!this.state.active) this.state.original = { ...original };
    this.state.active = true;
    const next = this.#pick();
    return this.#show(next.candidate, next.retest);
  }

  /** End: the person's own values from before, to put back. */
  stop(): Knobs | null {
    const original = this.state.original;
    this.state.active = false;
    this.state.currentId = null;
    this.state.original = null;
    this.state.history = [];
    this.pending = { score: null, flags: {}, note: '' };
    return original;
  }

  /** The score goes up or down from where it is (5 when it has not been touched), within 1 to 10. */
  bumpScore(delta: number): number {
    this.pending.score = Math.min(10, Math.max(1, (this.pending.score ?? 5) + delta));
    return this.pending.score;
  }

  setScore(score: number): number {
    this.pending.score = Math.min(10, Math.max(1, Math.round(score)));
    return this.pending.score;
  }

  /** A situation is marked bad, then not marked: the quick way to say "this was bad" while playing. */
  toggleBad(key: SituationKey): -1 | 0 {
    if (this.pending.flags[key] === -1) {
      delete this.pending.flags[key];
      return 0;
    }
    this.pending.flags[key] = -1;
    return -1;
  }

  setFlag(key: SituationKey, value: -1 | 0 | 1): void {
    if (!SITUATIONS.some((s) => s.key === key)) return;
    if (value === 0) delete this.pending.flags[key];
    else this.pending.flags[key] = value;
  }

  setScene(scene: SceneKey | null): void {
    this.state.scene = scene;
  }

  setNote(note: string): void {
    this.pending.note = note.slice(0, 200);
  }

  /** Keeps the rating and moves on to the next candidate. Refuses when nothing is running, no score was given, or the server would refuse it. */
  save(ctx: TrialContext): SaveResult {
    const current = this.candidate;
    if (!this.state.active || !current) return { ok: false, error: 'not-running' };
    if (this.pending.score === null) return { ok: false, error: 'no-score' };
    const parsed = parseRating({
      id: this.#newId(), at: this.#now().toISOString(), round: this.round.id, preset: current.id,
      feel: ctx.feel, changed: !knobsEqual(current.set, knobsOfFeel(ctx.feel)), score: this.pending.score, flags: this.pending.flags, scene: this.state.scene, note: this.pending.note,
      playout: ctx.playout, delayMs: finiteWithin(ctx.delayMs, 5000), latencyMs: finiteWithin(ctx.latencyMs, 10000), game: ctx.game, trial: ctx.trial,
    }, this.#now().getTime());
    if (!parsed.ok) return { ok: false, error: 'invalid', detail: parsed.error };
    this.ratings.push(parsed.rating);
    this.state.history.push(current.id);
    const next = this.#pick();
    this.#show(next.candidate, next.retest);
    return { ok: true, rating: parsed.rating, next: next.candidate, retest: next.retest };
  }

  /** Passes the current candidate over (it comes back later) without a rating. */
  skip(): Candidate | null {
    const current = this.candidate;
    if (!this.state.active || !current) return null;
    if (!this.state.skipped.includes(current.id)) this.state.skipped.push(current.id);
    this.state.history.push(current.id);
    const next = this.#pick();
    return this.#show(next.candidate, next.retest);
  }

  /** Goes back to the candidate shown before this one (to rate it again, or to rate it after all). */
  back(): Candidate | null {
    const id = this.state.history.pop();
    const c = id ? this.round.candidates.find((x) => x.id === id) : undefined;
    if (!c) return null;
    this.state.skipped = this.state.skipped.filter((s) => s !== c.id);
    return this.#show(c, this.ratingsInRound.some((r) => r.preset === c.id));
  }

  get unsent(): FeelRating[] {
    return this.ratings.filter((r) => !this.sent.has(r.id));
  }

  markSent(ids: Iterable<string>): void {
    for (const id of ids) this.sent.add(id);
  }

  /** Takes back a rating (a mistaken score). */
  remove(id: string): boolean {
    const at = this.ratings.findIndex((r) => r.id === id);
    if (at < 0) return false;
    this.ratings.splice(at, 1);
    this.sent.delete(id);
    return true;
  }
}

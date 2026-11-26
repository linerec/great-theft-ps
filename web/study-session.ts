// SPDX-License-Identifier: AGPL-3.0-only
//
// One person's way through the study of the mouse feel (src/engine/feel-study.ts): which candidate is being tried, what has been
// said about it so far, the ratings made, and which of them the server has. No page, no storage and no network in here, so
// that the rules (what happens on "save", on "skip", on "back"; when a rating is refused) are tested on their own; the page
// (study-ui.ts) keeps the state in this browser and sends the ratings.

import {
  knobsEqual, MIN_TRIAL_SECONDS, nextCandidate, parseRating, ROUND_1, SITUATIONS, type Candidate, type Feel, type FeelRating, type GameModel, type Knobs, type Playout, type Round, type SceneKey, type SituationKey,
} from '../src/engine/feel-study.ts';

export interface HistoryEntry {
  id: string;
  /** The rating that was kept for it, when one was. */
  rating: string | null;
}

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
  /** What was done with the candidates shown before this one (a rating kept, or a pass), for "undo". */
  history: HistoryEntry[];
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

export type SaveResult =
  | { ok: true; rating: FeelRating; next: Candidate; retest: boolean }
  | { ok: false; error: 'not-running' | 'no-score' | 'invalid'; detail?: string }
  /** Not enough time with the mouse in the game's hands to have felt anything: nothing is kept, and `secondsLeft` says how long to go on. */
  | { ok: false; error: 'too-short'; secondsLeft: number };

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
  readonly minSeconds: number;
  #newId: () => string;
  #now: () => Date;

  constructor(o: { round?: Round; ratings?: readonly unknown[]; sent?: readonly string[]; state?: Partial<StudyState>; minSeconds?: number; newId?: () => string; now?: () => Date } = {}) {
    this.round = o.round ?? ROUND_1;
    // What was kept in the browser is checked as the server would: a hand-edited or damaged entry is not carried along.
    this.ratings = (o.ratings ?? []).map((r) => parseRating(r)).flatMap((p) => (p.ok ? [p.rating] : []));
    this.sent = new Set(o.sent ?? []);
    this.state = { ...emptyState(this.round.id), ...o.state, roundId: this.round.id };
    // What an earlier version of the page kept was a list of ids.
    this.state.history = (Array.isArray(this.state.history) ? (this.state.history as unknown[]) : []).flatMap((h) => (typeof h === 'string' ? [{ id: h, rating: null }] : h && typeof (h as HistoryEntry).id === 'string' ? [{ id: (h as HistoryEntry).id, rating: typeof (h as HistoryEntry).rating === 'string' ? (h as HistoryEntry).rating : null }] : []));
    this.minSeconds = o.minSeconds ?? MIN_TRIAL_SECONDS;
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

  /** Gives the score and keeps the rating in one go (a key press while playing). */
  rate(score: number, ctx: TrialContext): SaveResult {
    if (!this.state.active || !this.candidate) return { ok: false, error: 'not-running' };
    this.setScore(score);
    return this.save(ctx);
  }

  /**
   * Keeps the rating and moves on to the next candidate. Refuses when nothing is running, no score was given, too little time
   * was spent with the mouse (the score is kept for when there has been), or the server would refuse it.
   */
  save(ctx: TrialContext): SaveResult {
    const current = this.candidate;
    if (!this.state.active || !current) return { ok: false, error: 'not-running' };
    if (this.pending.score === null) return { ok: false, error: 'no-score' };
    if (ctx.trial.seconds < this.minSeconds) return { ok: false, error: 'too-short', secondsLeft: Math.ceil(this.minSeconds - ctx.trial.seconds) };
    const parsed = parseRating({
      id: this.#newId(), at: this.#now().toISOString(), round: this.round.id, preset: current.id,
      feel: ctx.feel, changed: !knobsEqual(current.set, knobsOfFeel(ctx.feel)), score: this.pending.score, flags: this.pending.flags, scene: this.state.scene, note: this.pending.note,
      playout: ctx.playout, delayMs: finiteWithin(ctx.delayMs, 5000), latencyMs: finiteWithin(ctx.latencyMs, 10000), game: ctx.game, trial: ctx.trial,
    }, this.#now().getTime());
    if (!parsed.ok) return { ok: false, error: 'invalid', detail: parsed.error };
    this.ratings.push(parsed.rating);
    this.state.history.push({ id: current.id, rating: parsed.rating.id });
    const next = this.#pick();
    this.#show(next.candidate, next.retest);
    return { ok: true, rating: parsed.rating, next: next.candidate, retest: next.retest };
  }

  /** Passes the current candidate over (it comes back later) without a rating. */
  skip(): Candidate | null {
    const current = this.candidate;
    if (!this.state.active || !current) return null;
    if (!this.state.skipped.includes(current.id)) this.state.skipped.push(current.id);
    this.state.history.push({ id: current.id, rating: null });
    const next = this.#pick();
    return this.#show(next.candidate, next.retest);
  }

  /**
   * Takes back the last thing done: a rating that was kept is dropped (and the candidate is there to be rated again), a pass is
   * undone. `wasSent` says whether the server had the dropped rating, so that the page can take it back there too.
   */
  undo(): { candidate: Candidate; removed: FeelRating | null; wasSent: boolean } | null {
    for (let last = this.state.history.pop(); last; last = this.state.history.pop()) {
      const candidate = this.round.candidates.find((x) => x.id === last.id);
      if (!candidate) continue;
      let removed: FeelRating | null = null;
      let wasSent = false;
      if (last.rating !== null) {
        const at = this.ratings.findIndex((r) => r.id === last.rating);
        if (at >= 0) {
          removed = this.ratings.splice(at, 1)[0]!;
          wasSent = this.sent.delete(removed.id);
        }
      } else {
        this.state.skipped = this.state.skipped.filter((id) => id !== candidate.id);
      }
      this.#show(candidate, this.ratingsInRound.some((r) => r.preset === candidate.id));
      return { candidate, removed, wasSent };
    }
    return null;
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

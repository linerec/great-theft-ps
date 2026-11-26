// SPDX-License-Identifier: AGPL-3.0-only
//
// The study of the mouse feel (L): one candidate setting after another is put in force, the person plays with it and gives it a
// score, and the scores are kept here and on the server for the analysis (src/engine/feel-study.ts). The rules for what happens
// on a score, a pass and an undo are in study-session.ts, where they are tested; this file is the part that needs a page.
//
// It is made to be done with the hand on the mouse and the keyboard, never reaching for the pointer:
//   - Start locks the mouse at once and puts the panel away;
//   - a strip over the picture (visible while the game has the mouse too) says which setting this is, how far along, and whether
//     there has been time enough to score it;
//   - one key scores AND moves on (1-9, 0 = 10); keys mark what felt off; [ undoes; ] passes.
// The values of a candidate are hidden until asked for: a number seen first colours the feel.

import { describeKnobs, MIN_TRIAL_SECONDS, SCENES, SITUATIONS, type FeelRating, type SituationKey } from '../src/engine/feel-study.ts';
import { getLang, N_, onLang, t, type Vars } from '../src/i18n/index.ts';
import { StudySession, type SaveResult } from './study-session.ts';
import { mouseFeel, stage, trialMeter } from './tester.ts';
import { save, saved, toast } from './ui.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const KEY_RATINGS = 'gtp.study.ratings';
const KEY_SENT = 'gtp.study.sent';
const KEY_STATE = 'gtp.study.state';
/** How many ratings make a first look, a model of the best setting, and a solid round (what the analysis needs; see feel-study.ts). */
const GOALS = [10, 20, 50] as const;

function load<T>(key: string, fallback: T): T {
  try {
    const text = saved(key, '');
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

const session = new StudySession({ ratings: load<unknown[]>(KEY_RATINGS, []), sent: load<string[]>(KEY_SENT, []), state: load(KEY_STATE, {}) });
const persist = (): void => {
  save(KEY_RATINGS, JSON.stringify(session.ratings));
  save(KEY_SENT, JSON.stringify([...session.sent]));
  save(KEY_STATE, JSON.stringify(session.state));
};

const label = (id: string): string => `#${id.split('-')[1] ?? id}`;
let delayMs: number | null = null;
let latencyMs: number | null = null;
document.addEventListener('gtp:stats', (e) => {
  const d = (e as CustomEvent<{ delayMs: number; latencyMs: number }>).detail;
  delayMs = d.delayMs;
  latencyMs = d.latencyMs > 0 ? d.latencyMs : null;
});

/** A sentence kept to be put into words when it is drawn (so that a change of language changes it too). */
interface Say {
  en: string;
  vars?: Vars;
}
const say = (s: Say | null): string => (s ? t(s.en, s.vars) : '');

// ------------------------------------------------------------------ small DOM helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}
function button(text: string, onClick: () => void, cls = 'btn small', id = ''): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  if (id) b.id = id;
  b.addEventListener('click', onClick);
  return b;
}
/** A toggle button for a set of choices: pressed = chosen. */
function chip(text: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const b = button(text, onClick, 'study-chip');
  b.setAttribute('aria-pressed', String(pressed));
  return b;
}

// ------------------------------------------------------------------ what happens

let flashText = '';
let flashUntil = 0;
/** Something to say over the picture for a moment (the keys cannot show it anywhere else while the game has the mouse). */
function flash(text: string, ms = 2400): void {
  flashText = text;
  flashUntil = performance.now() + ms;
  paintStrip();
}

/** A score was given before there had been time enough: it is kept and saved by itself as soon as there has been. */
let armed = false;

function putInForce(): void {
  const c = session.candidate;
  if (c) mouseFeel.set(c.set);
  trialMeter.reset();
  armed = false;
}

function closePanel(): void {
  $('studyPanel').querySelector<HTMLElement>('[data-close]')?.click();
}

function start(): void {
  if (!session.active) {
    const f = mouseFeel.read();
    session.start({ smoothingMs: f.smoothingMs, smoothingFadeRate: f.smoothingFadeRate, carryMs: f.carryMs, curve: f.curve });
    putInForce();
    persist();
  }
  // The panel goes first: the strip over the picture is not shown while the panel is open.
  closePanel();
  paint();
  // The click that came here is the gesture the browser wants for locking the mouse.
  void stage.lock().catch(() => undefined);
}

function resume(): void {
  closePanel();
  paintStrip();
  void stage.lock().catch(() => undefined);
}

function end(): void {
  const original = session.stop();
  if (original) mouseFeel.set(original);
  armed = false;
  persist();
  paint();
  toast(t('Study finished. Your own values are back.'), 'info');
}

const MILESTONES: Record<number, string> = {
  10: N_('That is 10 ratings: enough for a first look. Press Esc and open the analysis.'),
  20: N_('That is 20 ratings: enough for the analysis to name a best setting.'),
  50: N_('That is 50 ratings: a solid first round. Rate more, or look at the analysis.'),
};

function afterSave(r: Extract<SaveResult, { ok: true }>): void {
  persist();
  putInForce();
  const p = session.progress;
  let text = t('Saved {score} for {id} · now {next}', { score: r.rating.score, id: label(r.rating.preset), next: label(r.next.id) });
  const note = MILESTONES[p.ratings];
  if (note) text += ` — ${t(note)}`;
  // The moment the last setting is tried for the first time.
  else if (p.rated === p.total && session.ratingsInRound.filter((x) => x.preset === r.rating.preset).length === 1) text += ` — ${t('All {total} settings tried. Press Esc to see the analysis.', { total: p.total })}`;
  paint();
  flash(text, note ? 6000 : 2200);
  void sync();
}

const context = () => {
  const playout = $<HTMLSelectElement>('playoutMode').value;
  return { feel: mouseFeel.read(), playout: playout === 'smooth' || playout === 'balanced' || playout === 'immediate' ? (playout as 'smooth' | 'balanced' | 'immediate') : null, delayMs, latencyMs, game: mouseFeel.game(), trial: trialMeter.snapshot() };
};

/** A score: kept and on to the next, unless the mouse has not had time yet (then it waits for that). */
function rate(score: number): void {
  const result = session.rate(score, context());
  if (result.ok) return afterSave(result);
  if (result.error === 'too-short') {
    armed = true;
    flash(t('Score {score} noted. It is saved after {n} more s with the mouse.', { score, n: result.secondsLeft }));
    paint();
  } else if (result.error === 'invalid') {
    toast(t('Could not save that ({detail})', { detail: result.detail ?? '' }), 'warn');
  }
}

function undo(): void {
  const r = session.undo();
  if (!r) return flash(t('Nothing to undo'));
  putInForce();
  persist();
  paint();
  if (r.removed && r.wasSent) void fetch(`/api/study/ratings/${encodeURIComponent(r.removed.id)}`, { method: 'DELETE' }).catch(() => undefined);
  flash(r.removed ? t('Score removed · back to {id}', { id: label(r.candidate.id) }) : t('Back to {id}', { id: label(r.candidate.id) }));
}

function skip(): void {
  const c = session.skip();
  if (!c) return;
  putInForce();
  persist();
  paint();
  flash(t('Skipped · now {id}', { id: label(c.id) }));
}

function mark(k: SituationKey): void {
  const now = session.toggleBad(k);
  const name = t(SITUATIONS.find((s) => s.key === k)!.label);
  paint();
  flash(now === -1 ? t('Marked as off: {name}', { name }) : t('Mark removed: {name}', { name }));
}

async function removeRating(r: FeelRating): Promise<void> {
  const wasSent = session.sent.has(r.id);
  session.remove(r.id);
  persist();
  paint();
  if (wasSent) await fetch(`/api/study/ratings/${encodeURIComponent(r.id)}`, { method: 'DELETE' }).catch(() => undefined);
}

// ------------------------------------------------------------------ the panel

let valuesOpen = false;
let listOpen = false;
let syncNote: Say | null = null;
let reportOpen = false;

function sceneChips(): HTMLElement {
  const row = el('div', 'study-chips');
  for (const s of SCENES) row.append(chip(t(s.label), session.state.scene === s.key, () => (session.setScene(session.state.scene === s.key ? null : s.key), persist(), paint())));
  return row;
}

function progressBlock(): HTMLElement {
  const p = session.progress;
  const goal = GOALS.find((g) => p.ratings < g);
  const wrap = el('div', 'study-progress');
  const bar = el('div', 'meter');
  const fill = el('span');
  fill.style.width = `${Math.round((p.rated / p.total) * 100)}%`;
  bar.append(fill);
  bar.setAttribute('aria-hidden', 'true');
  wrap.append(el('p', 'muted small', t('{rated} of {total} settings tried · {ratings} ratings', { rated: p.rated, total: p.total, ratings: p.ratings })), bar);
  const next =
    goal === 10 ? t('{n} more ratings for a first look at the analysis.', { n: goal - p.ratings })
    : goal === 20 ? t('{n} more ratings for the analysis to name a best setting.', { n: goal - p.ratings })
    : goal === 50 ? t('{n} more ratings for a solid first round (50 to 100 is best).', { n: goal - p.ratings })
    : t('Plenty of ratings. More make the answer sharper.');
  wrap.append(el('p', 'muted small', next));
  return wrap;
}

function idleScreen(): Node[] {
  const p = session.progress;
  const steps = el('ol', 'study-steps');
  steps.append(
    el('li', '', t('Start locks the mouse and puts the first setting in force. Play for 15 to 30 seconds: look around slowly, turn sharply, aim at something, stop.')),
    el('li', '', t('Press a number key to score it: 1 is unusable, 10 feels like a real keyboard and mouse (0 counts as 10). The next setting starts at once.')),
    el('li', '', t('Esc lets go of the mouse and brings this panel back (the star button, or L): for the analysis, undo and finishing.')),
  );
  // Start comes first: the panel is small, and the one thing to do must not be below the fold.
  return [
    el('p', 'muted small', t('Find the mouse feel that suits you. Try settings one after another and score each. They are numbered and their values are hidden, so you judge by feel.')),
    button(p.ratings > 0 ? t('Continue') : t('Start'), start, 'btn primary study-go', 'studyStart'),
    progressBlock(),
    steps,
    el('div', 'study-label', el('span', '', t('Pick what you will be doing (optional):'))),
    sceneChips(),
  ];
}

function runningScreen(): Node[] {
  const c = session.candidate!;
  const out: Node[] = [];
  out.push(el('div', 'study-head', el('b', '', label(c.id)), el('span', 'muted small', t('{rated} of {total} tried', { rated: session.progress.rated, total: session.progress.total }))));
  if (!stage.locked) out.push(button(t('Resume (locks the mouse)'), resume, 'btn primary study-go', 'studyResume'));
  const scale = el('div', 'study-scale');
  scale.setAttribute('role', 'group');
  scale.setAttribute('aria-label', t('Score from 1 to 10'));
  for (let n = 1; n <= 10; n++) {
    const b = button(String(n), () => rate(n), '');
    b.setAttribute('aria-pressed', String(session.pending.score === n));
    scale.append(b);
  }
  out.push(el('div', 'study-label', el('span', '', t('Score it (saves and moves on)')), el('output', '', session.pending.score === null ? '-' : `${session.pending.score} / 10`)));
  out.push(scale, el('p', 'muted small study-anchor', el('span', '', t('1 unusable')), el('span', '', t('10 like a real keyboard and mouse'))));
  const marks = el('div', 'study-chips');
  for (const [i, s] of SITUATIONS.entries()) {
    const b = chip(`${MARK_LETTERS[i]} · ${t(s.label)}`, session.pending.flags[s.key] === -1, () => mark(s.key));
    b.title = t(s.hint);
    marks.append(b);
  }
  out.push(el('div', 'study-label', el('span', '', t('What felt off? (optional)'))), marks);
  out.push(el('div', 'study-label', el('span', '', t('Doing')))), out.push(sceneChips());
  const values = el('details', 'study-values', el('summary', '', t('Show the values (seeing them colours the feel)')), el('p', 'muted small', `${describeKnobs(c.set)} · ${t('sensitivity')} ${mouseFeel.read().degPerCount.toFixed(3)}`));
  values.open = valuesOpen;
  values.addEventListener('toggle', () => (valuesOpen = values.open));
  out.push(values);
  out.push(el('div', 'study-actions', button(t('Undo'), undo, 'btn small', 'studyUndo'), button(t('Skip'), skip, 'btn small', 'studySkip'), button(t('Finish (your values back)'), end, 'btn small', 'studyEnd')));
  out.push(el('p', 'muted small study-keys', t('While the mouse is locked: 1–9 and 0 score, Y U I H J K mark what felt off, [ or Backspace undoes, ] skips, PageUp and PageDown change the sensitivity.')));
  out.push(progressBlock());
  return out;
}

function tools(): HTMLElement {
  const row = el('div', 'study-tools', button(t('See the analysis'), openReport, 'btn small', 'studyReport'), button(t('Copy my scores'), () => void copyText(JSON.stringify(session.ratings), t('Copied {n} scores', { n: session.ratings.length })), 'btn small', 'studyCopy'));
  const status = say(syncNote) || (session.ratings.length ? t('{sent} of {total} are on the server', { sent: session.ratings.length - session.unsent.length, total: session.ratings.length }) : '');
  if (status) row.append(el('p', 'muted small', status));
  return row;
}

function history(): HTMLElement {
  const details = el('details', 'study-list');
  const count = el('span', '', `(${session.ratings.length})`);
  details.append(el('summary', '', t('My ratings'), ' ', count));
  const list = el('ol');
  for (const r of [...session.ratings].reverse().slice(0, 60)) {
    const off = SITUATIONS.filter((s) => r.flags[s.key] === -1).map((s) => t(s.label));
    const text = el('span', '', `${label(r.preset)} · ${t('score {score}', { score: r.score })}${off.length ? ` · ${t('off: {list}', { list: off.join(', ') })}` : ''}`);
    const del = el('button', '', '✕');
    del.type = 'button';
    del.title = t('Delete this rating');
    del.setAttribute('aria-label', t('Delete the rating of {id}', { id: label(r.preset) }));
    del.addEventListener('click', () => void removeRating(r));
    list.append(el('li', '', text, del));
  }
  details.append(list);
  details.open = listOpen;
  details.addEventListener('toggle', () => (listOpen = details.open));
  return details;
}

const MARK_LETTERS = ['Y', 'U', 'I', 'H', 'J', 'K'] as const;

function paintPanel(): void {
  const panel = $('studyPanel');
  const body = $('studyBody');
  const top = panel.scrollTop;
  const running = session.active && session.candidate !== null;
  body.replaceChildren(...(running ? runningScreen() : idleScreen()), tools(), history());
  panel.scrollTop = top;
}

// ------------------------------------------------------------------ the strip over the picture

const strip = el('div', 'study-strip');
strip.hidden = true;
strip.setAttribute('role', 'status');
const stripId = el('b', 'ss-id');
const stripProgress = el('span', 'ss-progress');
const stripStatus = el('span', 'ss-status');
const stripMarks = el('div', 'ss-marks');
const stripLine = el('div', 'ss-line');
strip.append(el('div', 'ss-top', stripId, stripProgress, stripStatus), stripMarks, stripLine);
$('ps5Stage').append(strip);

function paintStrip(): void {
  const live = !$('hud').hidden;
  const showing = session.active && session.candidate !== null && live;
  strip.hidden = !showing || !$('studyPanel').hidden;
  // The picture's own hint ("click the screen to start controlling") would sit under the strip: the strip says it better.
  $('ps5Stage').dataset.study = String(showing && !strip.hidden);
  if (!showing) return;
  const p = session.progress;
  stripId.textContent = label(session.candidate!.id);
  stripProgress.textContent = `${p.rated} / ${p.total}`;
  const seconds = trialMeter.snapshot().seconds;
  const left = Math.ceil(MIN_TRIAL_SECONDS - seconds);
  if (armed && session.pending.score !== null) stripStatus.textContent = t('Score {score} noted · saving in {n} s', { score: session.pending.score, n: Math.max(0, left) });
  else if (left > 0) stripStatus.textContent = stage.locked ? t('Play {n} more s, then score it', { n: left }) : t('Click the picture to lock the mouse');
  else stripStatus.textContent = t('Ready: press 1–9 (0 = 10) to score it');
  stripStatus.dataset.ready = String(left <= 0 && !armed);
  // The marks, with their keys.
  const wanted = SITUATIONS.map((s, i) => `${MARK_LETTERS[i]}|${t(s.label)}|${session.pending.flags[s.key] === -1}`).join(';');
  if (stripMarks.dataset.drawn !== wanted) {
    stripMarks.dataset.drawn = wanted;
    stripMarks.replaceChildren(
      ...SITUATIONS.map((s, i) => {
        const c = el('span', 'ss-chip', el('kbd', '', MARK_LETTERS[i]!), t(s.label));
        c.dataset.on = String(session.pending.flags[s.key] === -1);
        return c;
      }),
    );
  }
  const flashing = performance.now() < flashUntil;
  stripLine.textContent = flashing ? flashText : t('1–9, 0: score · Y U I H J K: what felt off · [ undo · ] skip · Esc: panel');
  stripLine.dataset.flash = String(flashing);
}
setInterval(paintStrip, 250);

// ------------------------------------------------------------------ the whole

function paint(): void {
  const running = session.active && session.candidate !== null;
  $<HTMLButtonElement>('hudStudy').dataset.running = String(running);
  paintPanel();
  paintStrip();
}

// ------------------------------------------------------------------ the server

let syncing = false;
async function sync(): Promise<void> {
  if (syncing || session.unsent.length === 0) return;
  syncing = true;
  try {
    for (let guard = 0; guard < 50 && session.unsent.length > 0; guard++) {
      const batch = session.unsent.slice(0, 40);
      const res = await fetch('/api/study/ratings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ratings: batch }) });
      if (!res.ok) {
        syncNote = res.status === 401 ? { en: N_('You were logged out, so the server did not get them. They are kept on this device.') } : { en: N_('The server could not keep them. They are kept on this device and sent again later.') };
        return;
      }
      // What the server refused would be refused again: it is kept here, and not sent in a loop.
      session.markSent(batch.map((r) => r.id));
      const answer = (await res.json()) as { rejected?: unknown[]; full?: number };
      syncNote = answer.rejected?.length ? { en: N_('The server refused {n}.'), vars: { n: answer.rejected.length } } : answer.full ? { en: N_('The server has reached its limit for scores.') } : null;
      persist();
    }
  } catch {
    syncNote = { en: N_('The connection was lost, so the server did not get them. They are kept on this device and sent again later.') };
  } finally {
    syncing = false;
    persist();
    paint();
  }
}
window.addEventListener('online', () => void sync());

// ------------------------------------------------------------------ analysis and copying

async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 'ok', 2000);
  } catch {
    toast(t('Could not copy. The browser may have blocked the clipboard.'), 'warn');
  }
}

// The analysis runs in a worker: it takes a second or two, and a stream that is running must not wait for it.
let worker: Worker | null = null;
function analyze(): Promise<string> {
  return new Promise((resolve) => {
    try {
      worker ??= new Worker(new URL('./study-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(t('This browser cannot run the analysis.'));
      return;
    }
    worker.onmessage = (e: MessageEvent<{ text: string }>) => resolve(e.data.text);
    worker.onerror = (e) => resolve(t('The analysis failed ({detail})', { detail: e.message || t('the worker script could not be loaded') }));
    worker.postMessage({ ratings: session.ratings, lang: getLang() });
  });
}
const reportDialog = $<HTMLDialogElement>('studyReportDialog');
function openReport(): void {
  reportOpen = true;
  $('studyReportText').textContent = t('Analysing…');
  if (!reportDialog.open) reportDialog.showModal();
  void analyze().then((text) => {
    if (reportOpen) $('studyReportText').textContent = text;
  });
}
$<HTMLButtonElement>('studyReportClose').addEventListener('click', () => {
  reportOpen = false;
  reportDialog.close();
});
$<HTMLButtonElement>('studyReportCopy').addEventListener('click', () => void copyText($('studyReportText').textContent ?? '', t('Analysis copied')));

// ------------------------------------------------------------------ the keys that work while the game has the mouse

const SCORE_KEYS: Record<string, number> = {
  Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5, Digit6: 6, Digit7: 7, Digit8: 8, Digit9: 9, Digit0: 10,
  Numpad1: 1, Numpad2: 2, Numpad3: 3, Numpad4: 4, Numpad5: 5, Numpad6: 6, Numpad7: 7, Numpad8: 8, Numpad9: 9, Numpad0: 10,
};
/** Letters the game's layouts do not use (see profile.ts): the keys of the study must not be ones that are played with. */
const MARK_KEYS: Record<string, SituationKey> = Object.fromEntries(SITUATIONS.map((s, i) => [`Key${MARK_LETTERS[i]}`, s.key]));

/** Keys that went down and have not come up: a held key counts once (an undo that repeated would take back every rating). */
const held = new Set<string>();
window.addEventListener('keyup', (e) => held.delete(e.code), true);
window.addEventListener('blur', () => held.clear());

/** A key during a try. True when the study took it (the game must not get it). */
function key(code: string): boolean {
  if (!session.active || !session.candidate) return false;
  const ours = code in SCORE_KEYS || code in MARK_KEYS || code === 'BracketLeft' || code === 'Backspace' || code === 'BracketRight';
  if (!ours) return false;
  if (held.has(code)) return true;
  held.add(code);
  if (code in SCORE_KEYS) rate(SCORE_KEYS[code]!);
  else if (code in MARK_KEYS) mark(MARK_KEYS[code]!);
  else if (code === 'BracketRight') skip();
  else undo();
  return true;
}

export const study = {
  key,
  paint,
  get active(): boolean {
    return session.active;
  },
};

// ------------------------------------------------------------------ start up

// A score that was waiting for time is saved when there has been enough.
setInterval(() => {
  if (armed && session.active && session.pending.score !== null && trialMeter.snapshot().seconds >= MIN_TRIAL_SECONDS) {
    const r = session.save(context());
    if (r.ok) afterSave(r);
  }
}, 250);

onLang(() => paint());
// What a restored session needs: its candidate in force again (the saved profile may be from before), and what was not sent.
if (session.active) putInForce();
paint();
setTimeout(() => void sync(), 3000);

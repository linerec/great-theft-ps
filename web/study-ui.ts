// SPDX-License-Identifier: AGPL-3.0-only
//
// The panel of the mouse-feel study (L): one candidate setting after another is put in force, the person plays with it and
// says how it was, and the scores are kept here and on the server for the analysis (src/engine/feel-study.ts). The rules for
// what happens on save, skip and back are in study-session.ts, where they are tested; this file is the part that needs a page.
//
// While the game has the mouse, the keys carry the whole loop (a score, what was bad, save and next), so that a try is not
// interrupted by reaching for the pointer. The candidate's values are hidden until asked for: a number seen first colours the feel.

import { describeKnobs, SCENES, SITUATIONS, type FeelRating, type SceneKey, type SituationKey } from '../src/engine/feel-study.ts';
import { StudySession } from './study-session.ts';
import { mouseFeel, trialMeter } from './tester.ts';
import { save, saved, toast } from './ui.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const KEY_RATINGS = 'gtp.study.ratings';
const KEY_SENT = 'gtp.study.sent';
const KEY_STATE = 'gtp.study.state';
/** A try with less time than this with the mouse in the game's hands is left out of the analysis (the analysis says so too). */
const MIN_SECONDS = 8;

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

// ------------------------------------------------------------------ the form

const scoreRow = $<HTMLElement>('studyScore');
for (let n = 1; n <= 10; n++) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.score = String(n);
  b.textContent = String(n);
  b.addEventListener('click', () => {
    session.setScore(n);
    paint();
  });
  scoreRow.append(b);
}

const sitRows = $<HTMLElement>('studySituations');
for (const s of SITUATIONS) {
  const row = document.createElement('div');
  row.dataset.sit = s.key;
  row.title = s.hint;
  const name = document.createElement('span');
  name.textContent = s.label;
  const seg = document.createElement('div');
  seg.className = 'seg';
  // Two buttons: neither pressed is "normal", and pressing the one that is down takes it back.
  for (const [v, text] of [[-1, '아쉬움'], [1, '좋음']] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = String(v);
    b.textContent = text;
    b.addEventListener('click', () => {
      session.setFlag(s.key, session.pending.flags[s.key] === v ? 0 : v);
      paint();
    });
    seg.append(b);
  }
  row.append(name, seg);
  sitRows.append(row);
}

const sceneRow = $<HTMLElement>('studyScene');
for (const s of SCENES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.scene = s.key;
  b.textContent = s.label;
  b.addEventListener('click', () => {
    session.setScene(session.state.scene === s.key ? null : s.key);
    paint();
  });
  sceneRow.append(b);
}
const noteInput = $<HTMLInputElement>('studyNote');
noteInput.addEventListener('input', () => session.setNote(noteInput.value));

// ------------------------------------------------------------------ what is shown

function paint(): void {
  const running = session.active && session.candidate !== null;
  $('studyIdle').hidden = running;
  $('studyRun').hidden = !running;
  $<HTMLButtonElement>('studyEnd').hidden = !running;
  const p = session.progress;
  $('studyIdleCount').textContent = p.ratings > 0 ? `지금까지 후보 ${p.rated}/${p.total}개, 평가 ${p.ratings}개를 했습니다. 이어서 할 수 있습니다.` : '';
  $<HTMLButtonElement>('studyStart').textContent = p.ratings > 0 ? '이어서 하기' : '실험 시작';
  $<HTMLButtonElement>('hudStudy').dataset.running = String(running);
  if (running) {
    const c = session.candidate!;
    $('studyId').textContent = label(c.id);
    $('studyProgress').textContent = `후보 ${p.rated}/${p.total} · 평가 ${p.ratings}개`;
    $('studyValues').textContent = `${describeKnobs(c.set)} · 감도 ${mouseFeel.read().degPerCount.toFixed(3)}`;
  }
  const score = session.pending.score;
  $('studyScoreOut').textContent = score === null ? '-' : `${score} / 10`;
  for (const b of scoreRow.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.score) === score));
  for (const row of sitRows.querySelectorAll<HTMLElement>('[data-sit]')) {
    const v = session.pending.flags[row.dataset.sit as SituationKey] ?? 0;
    for (const b of row.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === v));
  }
  for (const b of sceneRow.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.scene === session.state.scene));
  if (document.activeElement !== noteInput) noteInput.value = session.pending.note;
  $('studyListCount').textContent = `(${session.ratings.length})`;
  paintList();
  paintSync();
}

function paintList(): void {
  const list = $<HTMLElement>('studyList');
  list.replaceChildren(
    ...[...session.ratings].reverse().slice(0, 60).map((r) => {
      const li = document.createElement('li');
      const bad = SITUATIONS.filter((s) => r.flags[s.key] === -1).map((s) => `${s.label}−`);
      const good = SITUATIONS.filter((s) => r.flags[s.key] === 1).map((s) => `${s.label}+`);
      const text = document.createElement('span');
      text.textContent = `${label(r.preset)} · ${r.score}점 ${[...good, ...bad].join(' ')}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✕';
      del.title = '이 기록 지우기';
      del.setAttribute('aria-label', `${label(r.preset)} 기록 지우기`);
      del.addEventListener('click', () => void removeRating(r));
      li.append(text, del);
      return li;
    }),
  );
}

let syncNote = '';
function paintSync(): void {
  const total = session.ratings.length;
  $('studySync').textContent = total === 0 ? '' : syncNote || `서버에 ${total - session.unsent.length}/${total}개 저장됨`;
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
        syncNote = res.status === 401 ? '로그인이 풀려 서버에 못 보냈습니다. 이 기기에는 저장돼 있습니다.' : '서버에 저장하지 못했습니다. 이 기기에는 저장돼 있고, 나중에 다시 보냅니다.';
        return;
      }
      // What the server refused would be refused again: it is kept here, and not sent in a loop.
      session.markSent(batch.map((r) => r.id));
      const answer = (await res.json()) as { rejected?: unknown[]; full?: number };
      syncNote = answer.rejected?.length ? `서버가 ${answer.rejected.length}개를 받지 않았습니다.` : answer.full ? '서버의 보관 한도에 도달했습니다.' : '';
      persist();
    }
  } catch {
    syncNote = '연결이 끊겨 서버에 못 보냈습니다. 이 기기에는 저장돼 있고, 나중에 다시 보냅니다.';
  } finally {
    syncing = false;
    persist();
    paintSync();
  }
}
window.addEventListener('online', () => void sync());

async function removeRating(r: FeelRating): Promise<void> {
  const wasSent = session.sent.has(r.id);
  session.remove(r.id);
  persist();
  paint();
  if (wasSent) await fetch(`/api/study/ratings/${encodeURIComponent(r.id)}`, { method: 'DELETE' }).catch(() => undefined);
}

// ------------------------------------------------------------------ the loop

function putInForce(): void {
  const c = session.candidate;
  if (c) mouseFeel.set(c.set);
  trialMeter.reset();
}

function start(): void {
  if (session.active) return;
  const f = mouseFeel.read();
  session.start({ smoothingMs: f.smoothingMs, smoothingFadeRate: f.smoothingFadeRate, carryMs: f.carryMs, curve: f.curve });
  putInForce();
  persist();
  paint();
}

function end(): void {
  const original = session.stop();
  if (original) mouseFeel.set(original);
  persist();
  paint();
  toast('실험을 끝냈습니다. 원래 값으로 돌렸습니다.', 'info');
}

function saveRating(): void {
  const playout = $<HTMLSelectElement>('playoutMode').value;
  const trial = trialMeter.snapshot();
  const result = session.save({
    feel: mouseFeel.read(), playout: playout === 'smooth' || playout === 'balanced' || playout === 'immediate' ? playout : null, delayMs, latencyMs, game: mouseFeel.game(), trial,
  });
  if (!result.ok) {
    toast(result.error === 'no-score' ? '점수를 먼저 정하세요 (= 올리기, - 내리기)' : result.error === 'invalid' ? `저장하지 못했습니다 (${result.detail})` : '실험이 시작되지 않았습니다', 'warn', 2500);
    return;
  }
  persist();
  putInForce();
  paint();
  toast(`${result.rating.score}점 저장 · 다음 ${label(result.next.id)}${trial.seconds < MIN_SECONDS ? ` (마우스를 쓴 시간이 ${trial.seconds}초라 분석에서는 빠집니다)` : ''}`, trial.seconds < MIN_SECONDS ? 'warn' : 'ok', 2200);
  void sync();
}

function previous(): void {
  const c = session.back();
  if (!c) return;
  putInForce();
  persist();
  paint();
  toast(`이전 후보 ${label(c.id)}`, 'info', 1500);
}

function skip(): void {
  const c = session.skip();
  if (!c) return;
  putInForce();
  persist();
  paint();
  toast(`건너뜀 · 다음 ${label(c.id)}`, 'info', 1500);
}

$<HTMLButtonElement>('studyStart').addEventListener('click', start);
$<HTMLButtonElement>('studyEnd').addEventListener('click', end);
$<HTMLButtonElement>('studySave').addEventListener('click', saveRating);
$<HTMLButtonElement>('studyBack').addEventListener('click', previous);
$<HTMLButtonElement>('studySkip').addEventListener('click', skip);

async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 'ok', 2000);
  } catch {
    toast('복사하지 못했습니다. 브라우저가 클립보드를 막았을 수 있습니다.', 'warn');
  }
}
$<HTMLButtonElement>('studyCopy').addEventListener('click', () => void copyText(JSON.stringify(session.ratings), `기록 ${session.ratings.length}개를 복사했습니다`));

// The analysis runs in a worker: it takes a second or two, and a stream that is running must not wait for it.
let worker: Worker | null = null;
function analyze(): Promise<string> {
  return new Promise((resolve) => {
    try {
      worker ??= new Worker(new URL('./study-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve('이 브라우저에서는 분석을 돌릴 수 없습니다.');
      return;
    }
    worker.onmessage = (e: MessageEvent<{ text: string }>) => resolve(e.data.text);
    worker.onerror = (e) => resolve(`분석 중 오류가 났습니다. (${e.message || '작업 스크립트를 불러오지 못했습니다'})`);
    worker.postMessage({ ratings: session.ratings });
  });
}
const reportDialog = $<HTMLDialogElement>('studyReportDialog');
$<HTMLButtonElement>('studyReport').addEventListener('click', () => {
  $('studyReportText').textContent = '분석하는 중…';
  reportDialog.showModal();
  void analyze().then((text) => ($('studyReportText').textContent = text));
});
$<HTMLButtonElement>('studyReportClose').addEventListener('click', () => reportDialog.close());
$<HTMLButtonElement>('studyReportCopy').addEventListener('click', () => void copyText($('studyReportText').textContent ?? '', '분석을 복사했습니다'));

// ------------------------------------------------------------------ the keys that work while the game has the mouse

const BAD_KEYS: Record<string, SituationKey> = { Digit5: 'slow', Digit6: 'flick', Digit7: 'track', Digit8: 'stop', Digit9: 'start', Digit0: 'smooth' };
const NUMPAD_SCORES: Record<string, number> = { Numpad1: 1, Numpad2: 2, Numpad3: 3, Numpad4: 4, Numpad5: 5, Numpad6: 6, Numpad7: 7, Numpad8: 8, Numpad9: 9, Numpad0: 10 };

/** A key during a try. True when the study took it (the game must not get it). The keys are not bound by any layout. */
function key(code: string): boolean {
  if (!session.active) return false;
  const say = (text: string): void => toast(text, 'info', 900);
  if (code === 'Equal' || code === 'NumpadAdd' || code === 'Minus' || code === 'NumpadSubtract') {
    say(`점수 ${session.bumpScore(code === 'Equal' || code === 'NumpadAdd' ? 1 : -1)} / 10`);
  } else if (code in NUMPAD_SCORES) {
    say(`점수 ${session.setScore(NUMPAD_SCORES[code]!)} / 10`);
  } else if (code in BAD_KEYS) {
    const k = BAD_KEYS[code]!;
    const now = session.toggleBad(k);
    say(`${SITUATIONS.find((s) => s.key === k)!.label}: ${now === -1 ? '아쉬움 표시' : '표시 해제'}`);
  } else if (code === 'BracketRight') {
    saveRating();
    return true;
  } else if (code === 'BracketLeft') {
    previous();
    return true;
  } else {
    return false;
  }
  paint();
  return true;
}

export const study = { key, paint, get active(): boolean { return session.active; } };

// What a restored session needs: its candidate in force again (the saved profile may be from before), and what was not sent.
if (session.active) putInForce();
paint();
setTimeout(() => void sync(), 3000);

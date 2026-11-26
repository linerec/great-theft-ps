// SPDX-License-Identifier: AGPL-3.0-only
//
// The shell: three places and the way between them.
//   PS5             the main page (console, route, picture)
//   Practice range  the test games that show what a keyboard and mouse do to a pad
//   Settings        input mapping, consoles, advanced
// The picture area (#stageBox) is one element that is moved between PS5 and the practice range, because the input engine and
// the video player both draw on the same canvas.

// The language first: everything below draws words, and finds it set.
import './lang.ts';
import { locale, onLang, t } from '../src/i18n/index.ts';
import './account-ui.ts';
import './dev-reload.ts';
import { setMode, type Mode } from './tester.ts';
import './ps5.ts';
import './player-ui.ts';
import { applyTheme, currentTheme, setTheme, THEME_TEXT, type Theme } from './ui.ts';

type View = 'ps5' | 'lab' | 'settings';
const VIEWS: Record<View, string> = { ps5: 'consolePanel', lab: 'viewLab', settings: 'viewSettings' };
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const gameParam = params.get('mode');
let labGame: Exclude<Mode, 'console'> = gameParam === 'tps' ? 'tps' : 'fps';

function setView(next: View, push = true): void {
  for (const [v, id] of Object.entries(VIEWS)) $<HTMLElement>(id).hidden = v !== next;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav button')) {
    if (b.dataset.view === next) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (next === 'ps5') {
    $<HTMLElement>('ps5Stage').append($<HTMLElement>('stageBox'));
    setMode('console', false);
  } else if (next === 'lab') {
    $<HTMLElement>('labStage').append($<HTMLElement>('stageBox'));
    setMode(labGame, false);
  }
  if (push) history.replaceState(null, '', `${location.pathname}${location.search}#${next}`);
  window.scrollTo({ top: 0 });
  document.dispatchEvent(new CustomEvent('gtp:view', { detail: next }));
}

for (const b of document.querySelectorAll<HTMLButtonElement>('.nav button')) b.addEventListener('click', () => setView(b.dataset.view as View));
$<HTMLSelectElement>('gameMode').addEventListener('change', (e) => {
  labGame = (e.target as HTMLSelectElement).value === 'tps' ? 'tps' : 'fps';
});

// Settings: one pane at a time.
function setPane(id: string): void {
  for (const p of document.querySelectorAll<HTMLElement>('.pane')) p.hidden = p.id !== id;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.subnav button')) b.setAttribute('aria-pressed', String(b.dataset.pane === id));
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.subnav button')) b.addEventListener('click', () => setPane(b.dataset.pane!));
setPane('paneGeneral');

// Light, dark, or whatever the device says: the button in the header goes round them, the settings pick one.
const THEME_ICON: Record<Theme, string> = { auto: '#i-auto', light: '#i-sun', dark: '#i-moon' };
function paintTheme(): void {
  const theme = currentTheme();
  const name = t(THEME_TEXT[theme]);
  $('themeIcon').setAttribute('href', THEME_ICON[theme]);
  $<HTMLButtonElement>('themeBtn').setAttribute('aria-label', t('Screen color: {theme} (click to change)', { theme: name }));
  $<HTMLButtonElement>('themeBtn').title = t('Screen color: {theme}', { theme: name });
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === theme));
}
// The button's words are drawn from the theme, so they follow the language too (this runs after the page's own words changed).
onLang(paintTheme);
$<HTMLButtonElement>('themeBtn').addEventListener('click', () => {
  const order: Theme[] = ['auto', 'light', 'dark'];
  setTheme(order[(order.indexOf(currentTheme()) + 1) % order.length]!);
  paintTheme();
});
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
  b.addEventListener('click', () => {
    setTheme(b.dataset.themeChoice as Theme);
    paintTheme();
  });
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(currentTheme()));
applyTheme(currentTheme());
paintTheme();

// Buttons elsewhere that open the dialogs of the PS5 page.
$<HTMLButtonElement>('setAdd').addEventListener('click', () => {
  setView('ps5');
  document.dispatchEvent(new CustomEvent('gtp:open-add'));
});
$<HTMLButtonElement>('setRoutes').addEventListener('click', () => {
  setView('ps5');
  document.dispatchEvent(new CustomEvent('gtp:open-routes'));
});

const hash = location.hash.slice(1);
setView(hash === 'lab' || hash === 'settings' ? hash : gameParam === 'fps' || gameParam === 'tps' ? 'lab' : 'ps5', false);
$<HTMLSelectElement>('gameMode').value = labGame;

// What is running, in small print at the bottom: after a push, this is how to see that the server has it.
interface Version {
  commit?: string;
  subject?: string;
  startedAt?: string;
}
let version: Version | null = null;
// Kept and drawn again when the language changes: the words and the date format belong to it.
function paintVersion(): void {
  const el = document.getElementById('versionLine');
  const v = version;
  if (!el || !v?.commit) return;
  const vars = { commit: v.commit, subject: v.subject ?? '' };
  // h23 and not hour12: false, which some browsers write as 24:05 just after midnight.
  el.textContent = v.startedAt
    ? t('Version {commit} · {subject} · started {time}', { ...vars, time: new Date(v.startedAt).toLocaleString(locale(), { hourCycle: 'h23' }) })
    : t('Version {commit} · {subject}', vars);
}
onLang(paintVersion);
void fetch('/api/version')
  .then((r) => (r.ok ? r.json() : null))
  .then((v: Version | null) => {
    version = v;
    paintVersion();
  })
  .catch(() => {});

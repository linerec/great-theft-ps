// SPDX-License-Identifier: AGPL-3.0-only
//
// The shell: three places and the way between them.
//   PS5      the main page (console, route, picture)
//   연습장    the test games that show what a keyboard and mouse do to a pad
//   설정      input mapping, consoles, advanced
// The picture area (#stageBox) is one element that is moved between PS5 and 연습장, because the input engine and the video
// player both draw on the same canvas.

import './account-ui.ts';
import { setMode, type Mode } from './tester.ts';
import './ps5.ts';

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
setPane('paneInput');

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

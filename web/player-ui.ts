// SPDX-License-Identifier: AGPL-3.0-only
//
// The controls over the picture: full screen, a bar that shows when the mouse moves and goes away when the game has the
// mouse, a signal indicator with a chart of the connection, screenshots and clips, the options panel, the key layout.
// The decisions (when the bar hides, how good the connection is, names and formats) are in player-logic.ts, where they are
// tested; this file is the part that needs a browser. The input itself stays in tester.ts.

import { QUALITY_PRESETS, type QualityPreset } from '../src/bridge/quality.ts';
import {
  captureName, DEFAULT_LOOK, formatClock, HudVisibility, lookFilter, MAX_CLIP_SECONDS, pickClipFormat, QUALITY_BARS, QUALITY_TEXT, rateConnection, readLook, Series, type PictureLook,
} from './player-logic.ts';
import { FEEL_PRESETS, presetOf, stepSensitivity } from './mouse-feel.ts';
import { consoleName } from './ps5.ts';
import { mouseFeel, stage } from './tester.ts';
import { save, saved, toast } from './ui.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const player = $<HTMLElement>('ps5Stage');
const hudEl = $<HTMLElement>('hud');
const canvas = stage.canvas;
const sound = $<HTMLInputElement>('soundToggle');

const hud = new HudVisibility();
let live = false;
let view: 'ps5' | 'lab' | 'settings' = 'ps5';
let playingSince = 0;

// ------------------------------------------------------------------ full screen

type FullApi = 'standard' | 'webkit' | 'none';
const fullApi: FullApi = typeof player.requestFullscreen === 'function' ? 'standard' : typeof (player as unknown as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen === 'function' ? 'webkit' : 'none';
const fullElement = (): Element | null => document.fullscreenElement ?? (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement ?? null;
const isFull = (): boolean => fullElement() === player || document.body.classList.contains('stage-full');
type KeyboardLock = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };
const keyboard = (): KeyboardLock | undefined => (navigator as unknown as { keyboard?: KeyboardLock }).keyboard;
let keyboardLocked = false;
let toldAboutEsc = false;

/**
 * Full screen for the player (picture, bar and panels together). Where the browser has none for a page (an iPhone), the
 * player covers the window instead, which is as far as such a browser lets a page go; "Add to Home Screen" is the rest.
 */
async function enterFull(): Promise<void> {
  if (fullApi === 'none') {
    document.body.classList.add('stage-full');
  } else {
    try {
      const request = fullApi === 'standard' ? player.requestFullscreen({ navigationUI: 'hide' }) : (player as unknown as { webkitRequestFullscreen(): Promise<void> | void }).webkitRequestFullscreen();
      await request;
    } catch {
      document.body.classList.add('stage-full'); // refused (an embedded page, a policy): cover the window all the same
    }
    // With the keyboard locked, the browser keeps Esc (and shortcuts like Ctrl+W) for the page: Esc then only lets go of
    // the mouse, and holding it leaves full screen. Without it, Esc does both at once, which is what a browser does.
    try {
      await keyboard()?.lock?.(['Escape', 'KeyW', 'KeyT', 'KeyN', 'KeyS', 'KeyR', 'KeyP', 'F5']);
      keyboardLocked = !!keyboard()?.lock;
    } catch {
      keyboardLocked = false;
    }
    // A phone is held sideways to play.
    try {
      await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape');
    } catch {
      /* not allowed here (iPhone, a desktop): nothing to do */
    }
  }
  hud.poke(performance.now());
  paintFull();
  if (keyboardLocked && live && !toldAboutEsc) {
    toldAboutEsc = true;
    toast('전체 화면 중입니다. Esc는 마우스를 풀고, 길게 누르면 전체 화면이 꺼집니다.', 'info', 5000);
  }
}

async function exitFull(): Promise<void> {
  document.body.classList.remove('stage-full');
  if (keyboardLocked) {
    keyboard()?.unlock?.();
    keyboardLocked = false;
  }
  try {
    (screen.orientation as unknown as { unlock?: () => void }).unlock?.();
  } catch {
    /* nothing was locked */
  }
  if (fullElement()) {
    try {
      await (document.exitFullscreen?.() ?? (document as unknown as { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen?.());
    } catch {
      /* already out */
    }
  }
  paintFull();
}

const toggleFull = (): Promise<void> => (isFull() ? exitFull() : enterFull());

function paintFull(): void {
  const on = isFull();
  $<HTMLButtonElement>('hudFull').setAttribute('aria-pressed', String(on));
  $<HTMLButtonElement>('hudFull').title = on ? '전체 화면 끄기 (F)' : '전체 화면 (F)';
  $('hudFullIcon').setAttribute('href', on ? '#i-shrink' : '#i-expand');
  $('heroFullIcon').setAttribute('href', on ? '#i-shrink' : '#i-expand');
  $<HTMLButtonElement>('heroFull').setAttribute('aria-pressed', String(on));
  player.dataset.full = String(on);
}
const onFullChange = (): void => {
  // Left by the browser itself (Esc held, F11): put away what was set up for it.
  if (!fullElement() && !document.body.classList.contains('stage-full')) {
    if (keyboardLocked) {
      keyboard()?.unlock?.();
      keyboardLocked = false;
    }
    try {
      (screen.orientation as unknown as { unlock?: () => void }).unlock?.();
    } catch {
      /* nothing was locked */
    }
  }
  hud.poke(performance.now());
  paintFull();
};
document.addEventListener('fullscreenchange', onFullChange);
document.addEventListener('webkitfullscreenchange', onFullChange);
$<HTMLButtonElement>('hudFull').addEventListener('click', () => void toggleFull());
$<HTMLButtonElement>('heroFull').addEventListener('click', () => void toggleFull());
document.addEventListener('gtp:toggle-fullscreen', () => void toggleFull());

// ------------------------------------------------------------------ a wider picture

const theaterBtn = $<HTMLButtonElement>('hudTheater');
function setTheater(on: boolean): void {
  document.body.classList.toggle('theater', on);
  theaterBtn.setAttribute('aria-pressed', String(on));
  theaterBtn.title = on ? '넓게 보기 끄기 (T)' : '넓게 보기 (T)';
  save('gtp.theater', on ? '1' : '0');
}
setTheater(saved('gtp.theater') === '1');
theaterBtn.addEventListener('click', () => setTheater(!document.body.classList.contains('theater')));

// ------------------------------------------------------------------ the panels

const PANELS = ['statsPanel', 'keysPanel', 'feelPanel', 'optPanel'] as const;
type PanelId = (typeof PANELS)[number];
const panelEl = (id: PanelId): HTMLElement => $<HTMLElement>(id);
const panelButton: Record<PanelId, string> = { statsPanel: 'hudStats', keysPanel: 'hudKeys', feelPanel: 'hudFeel', optPanel: 'hudOpts' };
/** The panels on the left share one place: opening one closes the others. */
const LEFT: readonly PanelId[] = ['statsPanel', 'keysPanel', 'feelPanel'];

/** The options live in the card beside the picture; while the panel is open they are in it (so they are in reach in full screen). */
function moveOptions(into: 'panel' | 'card'): void {
  const box = $<HTMLElement>('connOptions');
  $<HTMLElement>(into === 'panel' ? 'optPanelSlot' : 'optSlot').append(box);
  $<HTMLElement>('optSlot').dataset.moved = String(into === 'panel');
}

function openPanel(id: PanelId, open: boolean): void {
  if (open) {
    if (LEFT.includes(id)) for (const other of LEFT) if (other !== id) openPanel(other, false);
    if (id === 'feelPanel') paintFeel();
    if (id === 'keysPanel') {
      $('keysName').textContent = $('layoutName').textContent ?? '';
      const list = $<HTMLElement>('keysList');
      list.replaceChildren(...[...$<HTMLElement>('layoutList').children].map((n) => n.cloneNode(true)));
    }
    if (id === 'optPanel') moveOptions('panel');
  } else if (id === 'optPanel' && !panelEl(id).hidden) moveOptions('card');
  panelEl(id).hidden = !open;
  $<HTMLButtonElement>(panelButton[id]).setAttribute('aria-pressed', String(open));
  hud.panelOpen = PANELS.some((p) => !panelEl(p).hidden);
  hud.poke(performance.now());
}
const togglePanel = (id: PanelId): void => openPanel(id, panelEl(id).hidden);
const closePanels = (): void => PANELS.forEach((p) => openPanel(p, false));
$<HTMLButtonElement>('hudStats').addEventListener('click', () => togglePanel('statsPanel'));
$<HTMLButtonElement>('hudKeys').addEventListener('click', () => togglePanel('keysPanel'));
$<HTMLButtonElement>('hudFeel').addEventListener('click', () => togglePanel('feelPanel'));
$<HTMLButtonElement>('hudOpts').addEventListener('click', () => togglePanel('optPanel'));
$<HTMLButtonElement>('hudQuality').addEventListener('click', () => togglePanel('statsPanel'));
for (const b of hudEl.querySelectorAll<HTMLButtonElement>('[data-close]')) b.addEventListener('click', () => openPanel(b.dataset.close as PanelId, false));

// ------------------------------------------------------------------ the mouse feel

const feelHint = $<HTMLElement>('feelHint');
const feelPresets = $<HTMLElement>('feelPresets');
for (const p of FEEL_PRESETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.preset = p.id;
  b.textContent = p.name;
  b.addEventListener('click', () => mouseFeel.set(p.set));
  feelPresets.append(b);
}
const feelSliders = [
  { input: $<HTMLInputElement>('qSens'), out: $<HTMLOutputElement>('q_sens'), key: 'degPerCount', text: (v: number) => v.toFixed(3) },
  { input: $<HTMLInputElement>('qSmooth'), out: $<HTMLOutputElement>('q_smooth'), key: 'smoothingMs', text: (v: number) => v.toFixed(0) },
  { input: $<HTMLInputElement>('qFade'), out: $<HTMLOutputElement>('q_fade'), key: 'smoothingFadeRate', text: (v: number) => (v === 0 ? '안 함' : v.toFixed(0)) },
  { input: $<HTMLInputElement>('qCarry'), out: $<HTMLOutputElement>('q_carry'), key: 'carryMs', text: (v: number) => v.toFixed(0) },
] as const;
for (const sl of feelSliders) sl.input.addEventListener('input', () => mouseFeel.set({ [sl.key]: Number(sl.input.value) }));

/** Show what the profile has (it changes from here, from the settings page, and from the keys while playing). */
function paintFeel(): void {
  const f = mouseFeel.read();
  for (const sl of feelSliders) {
    sl.input.value = String(f[sl.key]);
    sl.out.textContent = sl.text(f[sl.key]);
  }
  const now = presetOf(f);
  for (const b of feelPresets.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.preset === now));
  feelHint.textContent = FEEL_PRESETS.find((p) => p.id === now)?.hint ?? '직접 맞춘 값입니다.';
}
document.addEventListener('gtp:profile', paintFeel);
paintFeel();

// The delay of the picture is the other half of how a mouse feels (the hand moves, the picture answers): the three ways
// of showing frames (the options panel has the same choice) sit beside the numbers they change.
{
  const select = $<HTMLSelectElement>('playoutMode');
  const row = $<HTMLElement>('feelDelay');
  const paint = (): void => {
    for (const b of row.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.playout === select.value));
  };
  for (const b of row.querySelectorAll<HTMLButtonElement>('button')) {
    b.addEventListener('click', () => {
      select.value = b.dataset.playout ?? 'smooth';
      select.dispatchEvent(new Event('change'));
    });
  }
  select.addEventListener('change', paint);
  paint();
  document.addEventListener('gtp:stats', (e) => {
    if (panelEl('feelPanel').hidden) return;
    const d = (e as CustomEvent<{ delayMs: number; latencyMs: number }>).detail;
    $('q_delay').textContent = `표시 +${d.delayMs.toFixed(0)} ms · 입력→화면 ${d.latencyMs > 0 ? `${d.latencyMs.toFixed(0)} ms` : '-'}`;
  });
}

// The measuring of the game's response lives in the settings (calibrate-console.ts); here are its buttons and its words, so
// that it can be started with the game in view, which is where the person has to be in order to choose a safe place for it.
{
  const mirror = [
    { from: 'consoleCalibrate', to: 'feelCal', prop: 'disabled' },
    { from: 'consoleCalibrateStop', to: 'feelCalStop', prop: 'hidden' },
    { from: 'consoleCalibrateApply', to: 'feelCalApply', prop: 'hidden' },
  ] as const;
  const sync = (): void => {
    for (const m of mirror) {
      const to = $<HTMLButtonElement>(m.to);
      const from = $<HTMLButtonElement>(m.from);
      if (m.prop === 'disabled') to.disabled = from.disabled;
      else to.hidden = from.hidden;
    }
  };
  const observer = new MutationObserver(sync);
  for (const m of mirror) observer.observe($(m.from), { attributes: true });
  const status = $<HTMLElement>('consoleCalibrateStatus');
  const hint = $<HTMLElement>('feelCalStatus');
  const first = hint.textContent ?? '';
  new MutationObserver(() => void (hint.textContent = status.textContent || first)).observe(status, { childList: true, characterData: true, subtree: true });
  for (const [mine, theirs] of [['feelCal', 'consoleCalibrate'], ['feelCalStop', 'consoleCalibrateStop'], ['feelCalApply', 'consoleCalibrateApply']] as const) {
    $<HTMLButtonElement>(mine).addEventListener('click', () => $<HTMLButtonElement>(theirs).click());
  }
  sync();
}

/** The keys that work while the game has the mouse: sensitivity up and down, the next starting point. */
function feelKey(code: string): boolean {
  if (code === 'PageUp' || code === 'PageDown') {
    const next = stepSensitivity(mouseFeel.read().degPerCount, code === 'PageUp' ? 1 : -1);
    mouseFeel.set({ degPerCount: next });
    toast(`마우스 감도 ${next.toFixed(3)}`, 'info', 1100);
    return true;
  }
  if (code === 'Home') {
    const now = presetOf(mouseFeel.read());
    const at = FEEL_PRESETS.findIndex((p) => p.id === now);
    const next = FEEL_PRESETS[(at + 1) % FEEL_PRESETS.length]!;
    mouseFeel.set(next.set);
    toast(`마우스 느낌: ${next.name}`, 'info', 1400);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ the connection: signal, numbers, charts

const rtt = new Series(60);
const fpsSeries = new Series(60);
const hitchSeries = new Series(60);
const hudQuality = $<HTMLButtonElement>('hudQuality');

function spark(c: HTMLCanvasElement, values: readonly number[], size: number, top: number): void {
  const g = c.getContext('2d');
  if (!g) return;
  const w = c.width;
  const h = c.height;
  g.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const max = Math.max(top, ...values, 1);
  const step = w / (size - 1);
  const x0 = w - (values.length - 1) * step; // the newest value at the right edge
  const y = (v: number): number => h - 6 - (v / max) * (h - 12);
  g.beginPath();
  values.forEach((v, i) => (i === 0 ? g.moveTo(x0, y(v)) : g.lineTo(x0 + i * step, y(v))));
  g.lineJoin = 'round';
  g.lineWidth = 3;
  g.strokeStyle = '#5b9bff';
  g.stroke();
  g.lineTo(x0 + (values.length - 1) * step, h);
  g.lineTo(x0, h);
  g.closePath();
  g.fillStyle = 'rgba(91, 155, 255, .18)';
  g.fill();
}

interface StatsEvent {
  fps: number; kbps: number; rttMs: number; latencyMs: number; delayMs: number; hitches: number; hitchesTotal: number;
}
document.addEventListener('gtp:stats', (e) => {
  const s = (e as CustomEvent<StatsEvent>).detail;
  rtt.push(s.rttMs);
  fpsSeries.push(s.fps);
  hitchSeries.push(s.hitches);
  const preset = $<HTMLSelectElement>('qualityPreset').value as QualityPreset;
  const q = rateConnection({ fps: s.fps, wantFps: QUALITY_PRESETS[preset]?.fps ?? 0, rttMs: s.rttMs, hitchesLast10s: hitchSeries.sumLast(10) });
  hudQuality.dataset.q = q;
  hudQuality.dataset.bars = String(QUALITY_BARS[q]);
  hudQuality.title = `연결 상태: ${QUALITY_TEXT[q]} (눌러서 자세히)`;
  $('hudQText').textContent = s.fps > 0 ? `${s.fps} fps${s.rttMs > 0 ? ` · ${Math.round(s.rttMs)} ms` : ''}` : '신호 없음';
  if (playingSince) $('cPlayed').textContent = formatClock((performance.now() - playingSince) / 1000);
  if (!panelEl('statsPanel').hidden) {
    $('sparkRttNow').textContent = s.rttMs > 0 ? `${Math.round(s.rttMs)} ms` : '';
    $('sparkFpsNow').textContent = `${s.fps} fps · ${s.kbps} kbps`;
    spark($<HTMLCanvasElement>('sparkRtt'), rtt.values, rtt.size, 60);
    spark($<HTMLCanvasElement>('sparkFps'), fpsSeries.values, fpsSeries.size, QUALITY_PRESETS[preset]?.fps ?? 60);
  }
});

// ------------------------------------------------------------------ screenshot and clip

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}

async function screenshot(): Promise<void> {
  if (!live) return;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return void toast('스크린샷을 만들지 못했습니다', 'err');
  download(blob, captureName(new Date(), 'png'));
  const flash = $<HTMLElement>('shotFlash');
  flash.classList.remove('go');
  void flash.offsetWidth; // restart the animation
  flash.classList.add('go');
  toast('스크린샷을 저장했습니다 (다운로드 폴더)', 'ok');
}
$<HTMLButtonElement>('hudShot').addEventListener('click', () => void screenshot());

let clip: { recorder: MediaRecorder; chunks: Blob[]; startedAt: number; ext: string; mime: string; timer: ReturnType<typeof setInterval> } | null = null;

function startClip(): void {
  if (!live || clip) return;
  if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') return void toast('이 브라우저는 녹화를 지원하지 않습니다', 'warn');
  const format = pickClipFormat((t) => MediaRecorder.isTypeSupported(t));
  if (!format) return void toast('이 브라우저는 녹화할 수 있는 형식이 없습니다', 'warn');
  const stream = canvas.captureStream(60);
  const audio = stage.captureAudio();
  for (const track of audio?.getAudioTracks() ?? []) stream.addTrack(track);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: format.type, videoBitsPerSecond: 8_000_000 });
  } catch {
    return void toast('녹화를 시작하지 못했습니다', 'err');
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: format.type.split(';')[0] });
    if (blob.size === 0) return void toast('녹화된 내용이 없습니다', 'warn');
    download(blob, captureName(new Date(), format.ext));
    toast(`녹화를 저장했습니다 (${(blob.size / 1_000_000).toFixed(1)} MB, 다운로드 폴더)`, 'ok');
  };
  recorder.start(1000);
  const startedAt = performance.now();
  const timer = setInterval(() => {
    const s = (performance.now() - startedAt) / 1000;
    $('hudRecTime').textContent = formatClock(s);
    if (s >= MAX_CLIP_SECONDS) {
      toast(`녹화는 ${MAX_CLIP_SECONDS / 60}분까지입니다. 여기까지 저장합니다.`, 'info');
      stopClip();
    }
  }, 250);
  clip = { recorder, chunks, startedAt, ext: format.ext, mime: format.type, timer };
  $('hudRecTime').textContent = '0:00';
  $<HTMLElement>('hudRec').hidden = false;
  paintClip();
  toast(audio ? '녹화를 시작했습니다 (R로 끝냄)' : '녹화를 시작했습니다. 소리는 담기지 않습니다. (R로 끝냄)', 'info');
}

function stopClip(): void {
  if (!clip) return;
  clearInterval(clip.timer);
  try {
    clip.recorder.stop();
  } catch {
    /* already stopped */
  }
  clip = null;
  $<HTMLElement>('hudRec').hidden = true;
  paintClip();
}
const toggleClip = (): void => (clip ? stopClip() : startClip());
function paintClip(): void {
  const b = $<HTMLButtonElement>('hudRecBtn');
  b.setAttribute('aria-pressed', String(!!clip));
  b.classList.toggle('recording', !!clip);
  b.title = clip ? '녹화 끝내고 저장 (R)' : '녹화 (R)';
  $('hudRecIcon').setAttribute('href', clip ? '#i-stop' : '#i-record');
}
$<HTMLButtonElement>('hudRecBtn').addEventListener('click', toggleClip);

// ------------------------------------------------------------------ sound

const muteBtn = $<HTMLButtonElement>('hudMute');
function paintSound(): void {
  const on = sound.checked;
  muteBtn.setAttribute('aria-pressed', String(!on));
  muteBtn.title = on ? '소리 끄기 (M)' : '소리 켜기 (M)';
  $('hudMuteIcon').setAttribute('href', on ? '#i-volume' : '#i-mute');
}
const toggleSound = (): void => {
  sound.checked = !sound.checked;
  sound.dispatchEvent(new Event('change'));
};
muteBtn.addEventListener('click', toggleSound);
sound.addEventListener('change', paintSound);
paintSound();

const volume = $<HTMLInputElement>('volume');
{
  const v = Number(saved('gtp.volume', '100'));
  volume.value = String(Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100);
  stage.setVolume(Number(volume.value) / 100);
}
volume.addEventListener('input', () => {
  stage.setVolume(Number(volume.value) / 100);
  save('gtp.volume', volume.value);
});

// ------------------------------------------------------------------ how the picture looks

let look: PictureLook = DEFAULT_LOOK;
try {
  look = readLook(JSON.parse(saved('gtp.look', 'null')));
} catch {
  look = DEFAULT_LOOK;
}
const lookInputs = { brightness: $<HTMLInputElement>('lookBrightness'), contrast: $<HTMLInputElement>('lookContrast'), saturation: $<HTMLInputElement>('lookSaturation') };
const fitSelect = $<HTMLSelectElement>('fitMode');

function applyLook(): void {
  // Only the PS5 page: the lab's test games are drawn on the same canvas and are shown as they are.
  const on = view === 'ps5';
  canvas.style.filter = on ? lookFilter(look) : '';
  canvas.style.objectFit = on ? look.fit : '';
}
function paintLook(): void {
  fitSelect.value = look.fit;
  for (const key of ['brightness', 'contrast', 'saturation'] as const) {
    lookInputs[key].value = String(look[key]);
    $(`o_look${key[0]!.toUpperCase()}${key.slice(1)}`).textContent = `${look[key]}%`;
  }
}
function changeLook(next: PictureLook): void {
  look = next;
  save('gtp.look', JSON.stringify(look));
  paintLook();
  applyLook();
}
fitSelect.addEventListener('change', () => changeLook(readLook({ ...look, fit: fitSelect.value })));
for (const key of ['brightness', 'contrast', 'saturation'] as const) lookInputs[key].addEventListener('input', () => changeLook(readLook({ ...look, [key]: Number(lookInputs[key].value) })));
$<HTMLButtonElement>('lookReset').addEventListener('click', () => changeLook(DEFAULT_LOOK));
paintLook();

document.addEventListener('gtp:view', (e) => {
  view = (e as CustomEvent<'ps5' | 'lab' | 'settings'>).detail;
  applyLook();
  if (view !== 'ps5') {
    closePanels();
    if (isFull()) void exitFull();
  }
});
applyLook();

// ------------------------------------------------------------------ the bar: when it shows

function paintHud(): void {
  // The pointer on the bar or on an open panel keeps them there. Asked of the browser each time, so that a panel that closes
  // under the pointer does not leave the bar thinking it is still being pointed at.
  hud.hovering = [$('hudBar'), ...PANELS.map(panelEl)].some((el) => !el.hidden && el.matches(':hover'));
  const visible = hud.visible(performance.now());
  hudEl.dataset.visible = String(visible);
  $<HTMLElement>('hudTip').hidden = stage.locked;
  player.dataset.idle = String(live && !visible && !stage.locked);
  player.dataset.locked = String(stage.locked);
}
setInterval(paintHud, 150);

// The bar is shown at once, not at the next look of the timer: a click that comes right after the mouse moved must land on
// the bar's button, not on the picture under it (which would take the mouse).
const poke = (): void => {
  hud.poke(performance.now());
  paintHud();
};
player.addEventListener('pointermove', poke);
player.addEventListener('pointerdown', poke);
window.addEventListener('keydown', poke);
document.addEventListener('pointerlockchange', () => {
  hud.setLocked(stage.locked, performance.now());
  if (stage.locked) closePanels();
  paintHud();
});
$<HTMLButtonElement>('hudDisconnect').addEventListener('click', () => $<HTMLButtonElement>('bridgeDisconnect').click());

// ------------------------------------------------------------------ the screen stays on while it plays

let wake: { release(): Promise<void> } | null = null;
async function keepAwake(): Promise<void> {
  try {
    const api = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (live && api && !wake && document.visibilityState === 'visible') wake = await api.request('screen');
  } catch {
    /* refused (low power mode) or not there: the device's own timeout decides */
  }
}
document.addEventListener('visibilitychange', () => {
  wake = null; // the browser lets go of it when the page is hidden
  if (document.visibilityState === 'visible') void keepAwake();
});

// ------------------------------------------------------------------ the connection starts and ends

document.addEventListener('gtp:link', (e) => {
  const state = (e as CustomEvent<{ state: string }>).detail.state;
  const now = state === 'ready';
  if (now === live) return;
  live = now;
  hud.setLive(live, performance.now());
  hudEl.hidden = !live;
  player.dataset.live = String(live);
  if (live) {
    playingSince = performance.now();
    rtt.clear();
    fpsSeries.clear();
    hitchSeries.clear();
    $('hudName').textContent = consoleName();
    void keepAwake();
  } else {
    playingSince = 0;
    $('cPlayed').textContent = '-';
    stopClip(); // what was recorded up to now is kept
    closePanels();
    void wake?.release().catch(() => {});
    wake = null;
    if (keyboardLocked) {
      keyboard()?.unlock?.();
      keyboardLocked = false;
    }
  }
  paintHud();
});

// ------------------------------------------------------------------ keys (when the game does not have them)

const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));

window.addEventListener('keydown', (e) => {
  if (view !== 'ps5') return;
  if (e.code === 'Escape') {
    // With the keyboard locked the browser leaves Esc to the page, so letting go of the mouse is done here.
    if (stage.locked) stage.unlock();
    else if (PANELS.some((p) => !panelEl(p).hidden)) closePanels();
    return;
  }
  // The few keys that tune the mouse work while the game has it too (they are not the game's: no layout binds them).
  if (live && stage.locked && !e.ctrlKey && !e.metaKey && !e.altKey && feelKey(e.code)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  // A canvas that has the keyboard (reached with Tab, no mouse lock) is playing: its keys are the game's.
  if (stage.locked || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || document.activeElement === canvas || document.querySelector('dialog[open]')) return;
  const act = (fn: () => void): void => {
    e.preventDefault();
    fn();
  };
  switch (e.code) {
    case 'KeyF': return act(() => void toggleFull());
    case 'KeyT': return act(() => setTheater(!document.body.classList.contains('theater')));
    case 'KeyM': return act(toggleSound);
    case 'KeyP': return act(() => void screenshot());
    case 'KeyR': return act(toggleClip);
    case 'KeyS': return act(() => live && togglePanel('statsPanel'));
    case 'KeyK': return act(() => live && togglePanel('keysPanel'));
    case 'KeyG': return act(() => live && togglePanel('feelPanel'));
    case 'KeyO': return act(() => live && togglePanel('optPanel'));
    default:
      if (e.key === '?') act(() => $<HTMLDialogElement>('shortcutsDialog').showModal());
  }
}, true);

$<HTMLButtonElement>('shortcutsOpen').addEventListener('click', () => $<HTMLDialogElement>('shortcutsDialog').showModal());
$<HTMLButtonElement>('shortcutsClose').addEventListener('click', () => $<HTMLDialogElement>('shortcutsDialog').close());

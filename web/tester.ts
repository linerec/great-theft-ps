// SPDX-License-Identifier: AGPL-3.0-only
//
// Test bed page: real keyboard and mouse -> MappingEngine -> virtual pad -> a pad-only game
// (a small FPS, or a GTA V style third-person game). The games never see a keyboard or a mouse.
// Everything runs on a fixed 250 Hz clock.

import { MappingEngine } from '../src/engine/engine.ts';
import { describeKnobs, ROUND_1, TrialMeter } from '../src/engine/feel-study.ts';
import { defaultProfile, gtaProfile, parseProfileText, PRESETS, validateProfile, type Profile } from '../src/engine/profile.ts';
import { BUTTON, BUTTON_NAMES, emptyPadState, type VirtualPadState } from '../src/engine/types.ts';
import { FpsGame, defaultGameSettings } from '../src/testbed/fps.ts';
import { applyMeasuredCalibration, measureCalibration, type GameFactory } from '../src/testbed/measure.ts';
import { renderGame } from '../src/testbed/render.ts';
import { TpsGame, defaultTpsSettings } from '../src/testbed/tps.ts';
import { renderTps } from '../src/testbed/tpsrender.ts';
import { CODEC } from '../src/bridge/protocol.ts';
import { QUALITY_PRESETS, megabytesPerHour, type QualityPreset } from '../src/bridge/quality.ts';
import { clearMissing, getLang, LANG_NAMES, missingKeys, N_, onLang, t, translate } from '../src/i18n/index.ts';
import { BridgeClient } from './bridge-client.ts';
import { describeLayout, mountKeymap } from './keymap.ts';
import { mountTouch, prefersTouch } from './touch.ts';
import { AudioPlayer } from './audio-player.ts';
import { mountConsoleCalibration } from './calibrate-console.ts';
import { GamepadInput, mergeGamepad, type PadSample } from './gamepad.ts';
import { VideoPlayer } from './video-player.ts';
import { RawMouseGate, SENSITIVITY_MAX, SENSITIVITY_MIN, type Feel } from './mouse-feel.ts';
import { toast } from './ui.ts';

const TICK = 0.004;
type Mode = 'fps' | 'tps' | 'console';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const view = $<HTMLCanvasElement>('game');
const viewCtx = view.getContext('2d') as CanvasRenderingContext2D;
const padCanvas = $<HTMLCanvasElement>('pad');
const ctx = padCanvas.getContext('2d') as CanvasRenderingContext2D;
const params = new URLSearchParams(location.search);

const modeParam = params.get('mode');
// The console is the main thing; the test games live in the practice view ("Practice" in the page) and are chosen with ?mode=fps or ?mode=tps.
let mode: Mode = modeParam === 'tps' || modeParam === 'fps' ? modeParam : 'console';
export type { Mode };
const fps = new FpsGame(defaultGameSettings());
const tps = new TpsGame(defaultTpsSettings());
/** The test game the readouts refer to. In console mode there is no game, so this is only a placeholder. */
const active = (): FpsGame | TpsGame => (mode === 'tps' ? tps : fps);
const presetProfile = (m: Mode): Profile => (m === 'tps' ? gtaProfile() : defaultProfile());

const client = new BridgeClient();
const player = new VideoPlayer(document.getElementById('game') as HTMLCanvasElement);
player.fitCanvas = true;
/** The console's sound. It is unlocked in the tap that connects (see connectConsole). */
const audio = new AudioPlayer();
/** The size the test games draw at. A console's picture resizes the canvas to its own size; this puts it back. */
const BASE_VIEW = { width: view.width, height: view.height };

let profile: Profile = presetProfile(mode);
const engine = new MappingEngine(profile);
let state: VirtualPadState = engine.tick(TICK);
/** What the readout says about the mouse lock: a sentence (N_), shown through t() each time the readout is drawn. */
let lockNote: string = N_('Released');
/**
 * While the console game is being measured (calibrate-console.ts) the pad is not the keyboard's and mouse's: this is the
 * right stick the measurement holds. Null the rest of the time.
 */
let calibStick: { x: number; y: number } | null = null;

// Rotation measurement: mouse counts fed since the mark vs. degrees the game actually turned.
let measureCounts = 0;
let yawMark = 0;

function resetMeasure(): void {
  measureCounts = 0;
  yawMark = active().yawTotal;
}

/** What the hand did, for the study of the mouse feel: the counts since the input loop last looked, and the meter that sorts them by speed. */
export const trialMeter = new TrialMeter();
let meterDx = 0;
let meterDy = 0;

function feedMouse(dx: number, dy: number): void {
  if (calibStick) return;
  engine.mouseMove(dx, dy);
  measureCounts += dx;
  meterDx += dx;
  meterDy += dy;
}

// ---------------------------------------------------------------- controls

interface Field {
  id: string;
  get: () => number;
  set: (v: number) => void;
  digits: number;
  /** true: edits the mapping profile. false: edits a test bed game's hidden settings. */
  profileField: boolean;
}

const field = (profileField: boolean) => (id: string, get: () => number, set: (v: number) => void, digits: number): Field => ({
  id,
  get,
  set,
  digits,
  profileField,
});
const pf = field(true);
const gf = field(false);

const aimLayer = () => profile.layers.find((l) => l.name === 'aim');

const FIELDS: Field[] = [
  pf('degPerCount', () => profile.mouse.degPerCount, (v) => (profile.mouse.degPerCount = v), 3),
  pf('curve', () => profile.mouse.curve, (v) => (profile.mouse.curve = v), 2),
  pf('smoothingMs', () => profile.mouse.smoothingMs, (v) => (profile.mouse.smoothingMs = v), 0),
  pf('smoothingFadeRate', () => profile.mouse.smoothingFadeRate, (v) => (profile.mouse.smoothingFadeRate = v), 0),
  pf('maxTurnRate', () => profile.mouse.maxTurnRate, (v) => (profile.mouse.maxTurnRate = v), 0),
  pf('carryMs', () => profile.mouse.carryMs, (v) => (profile.mouse.carryMs = v), 0),
  pf('maxDeflection', () => profile.mouse.maxDeflection, (v) => (profile.mouse.maxDeflection = v), 2),
  pf('verticalScale', () => profile.mouse.verticalScale, (v) => (profile.mouse.verticalScale = v), 2),
  pf('innerDeadzone', () => profile.inGame.innerDeadzone, (v) => (profile.inGame.innerDeadzone = v), 2),
  pf('maxTurnRateAtFullStick', () => profile.inGame.maxTurnRateAtFullStick, (v) => (profile.inGame.maxTurnRateAtFullStick = v), 0),
  pf('responseCurve', () => profile.inGame.responseCurve, (v) => (profile.inGame.responseCurve = v), 2),
  pf('verticalRateRatio', () => profile.inGame.verticalRateRatio, (v) => (profile.inGame.verticalRateRatio = v), 2),
  pf('tapMs', () => profile.keys.tapMs, (v) => (profile.keys.tapMs = v), 0),
  pf('holdMs', () => profile.keys.holdMs, (v) => (profile.keys.holdMs = v), 0),
  pf('longPressMs', () => profile.keys.longPressMs, (v) => (profile.keys.longPressMs = v), 0),
  pf('doublePressMs', () => profile.keys.doublePressMs, (v) => (profile.keys.doublePressMs = v), 0),
  pf('aimLayerScale', () => aimLayer()?.lookScale ?? 1, (v) => {
    const l = aimLayer();
    if (l) l.lookScale = v;
  }, 2),
  gf('gInnerDeadzone', () => fps.settings.innerDeadzone, (v) => (fps.settings.innerDeadzone = v), 2),
  gf('gMaxTurnRate', () => fps.settings.maxTurnRate, (v) => (fps.settings.maxTurnRate = v), 0),
  gf('gResponseCurve', () => fps.settings.responseCurve, (v) => (fps.settings.responseCurve = v), 2),
  gf('gVerticalRatio', () => fps.settings.verticalRatio, (v) => (fps.settings.verticalRatio = v), 2),
  gf('gAdsLookScale', () => fps.settings.adsLookScale, (v) => (fps.settings.adsLookScale = v), 2),
  gf('tInnerDeadzone', () => tps.settings.innerDeadzone, (v) => (tps.settings.innerDeadzone = v), 2),
  gf('tMaxTurnRate', () => tps.settings.maxTurnRate, (v) => (tps.settings.maxTurnRate = v), 0),
  gf('tResponseCurve', () => tps.settings.responseCurve, (v) => (tps.settings.responseCurve = v), 2),
  gf('tVerticalRatio', () => tps.settings.verticalRatio, (v) => (tps.settings.verticalRatio = v), 2),
  gf('tLookAcceleration', () => tps.settings.lookAcceleration, (v) => (tps.settings.lookAcceleration = v), 2),
  gf('tAimLookScale', () => tps.settings.aimLookScale, (v) => (tps.settings.aimLookScale = v), 2),
];

function syncControls(): void {
  for (const f of FIELDS) {
    $<HTMLInputElement>(f.id).value = String(f.get());
    $<HTMLOutputElement>(`o_${f.id}`).textContent = f.get().toFixed(f.digits);
  }
  $<HTMLSelectElement>('gameMode').value = mode;
  $<HTMLSelectElement>('mouseTarget').value = profile.mouse.target;
  $<HTMLSelectElement>('inShape').value = profile.inGame.deadzoneShape;
  $<HTMLSelectElement>('gShape').value = fps.settings.deadzoneShape;
  $<HTMLSelectElement>('tShape').value = tps.settings.deadzoneShape;
  $<HTMLInputElement>('invertY').checked = profile.mouse.invertY;
  $<HTMLInputElement>('gGyro').checked = fps.settings.gyroAim;
  $<HTMLInputElement>('tAimAssist').checked = tps.settings.aimAssist;
  $<HTMLTextAreaElement>('profileJson').value = JSON.stringify(profile, null, 2);
}

/** Called whenever the profile in use changed in any way. Set once the editor and the legend exist (further down). */
let onProfileChanged: () => void = () => {};

function applyProfile(next: Profile): void {
  profile = next;
  engine.setProfile(profile);
  onProfileChanged();
}

function refreshJson(): void {
  $<HTMLTextAreaElement>('profileJson').value = JSON.stringify(profile, null, 2);
}

for (const f of FIELDS) {
  $<HTMLInputElement>(f.id).addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    f.set(v);
    $<HTMLOutputElement>(`o_${f.id}`).textContent = v.toFixed(f.digits);
    if (f.profileField) {
      applyProfile(profile);
      refreshJson();
    }
  });
}

function onSelect(id: string, apply: (value: string) => void, profileSide: boolean): void {
  $<HTMLSelectElement>(id).addEventListener('change', (e) => {
    apply((e.target as HTMLSelectElement).value);
    if (profileSide) applyProfile(profile);
    syncControls();
  });
}
onSelect('mouseTarget', (v) => (profile.mouse.target = v as Profile['mouse']['target']), true);
onSelect('inShape', (v) => (profile.inGame.deadzoneShape = v as Profile['inGame']['deadzoneShape']), true);
onSelect('gShape', (v) => (fps.settings.deadzoneShape = v as 'radial' | 'axial'), false);
onSelect('tShape', (v) => (tps.settings.deadzoneShape = v as 'radial' | 'axial'), false);

$<HTMLInputElement>('invertY').addEventListener('change', (e) => {
  profile.mouse.invertY = (e.target as HTMLInputElement).checked;
  applyProfile(profile);
  syncControls();
});
$<HTMLInputElement>('gGyro').addEventListener('change', (e) => {
  fps.settings.gyroAim = (e.target as HTMLInputElement).checked;
});
$<HTMLInputElement>('tAimAssist').addEventListener('change', (e) => {
  tps.settings.aimAssist = (e.target as HTMLInputElement).checked;
});

/** What the profile line says now, as a way of saying it when that is known (so that it can be said again in a new language). */
let saidProfile: (() => string) | null = null;
/** `text` is the line, or a function that says it in the language of the moment (the line is then said again when the language changes). */
function message(text: string | (() => string), kind: '' | 'error' | 'ok'): void {
  const el = $<HTMLElement>('profileMsg');
  saidProfile = typeof text === 'function' ? text : null;
  el.textContent = typeof text === 'function' ? text() : text;
  el.className = `msg ${kind}`;
}
onLang(() => {
  if (saidProfile) $<HTMLElement>('profileMsg').textContent = saidProfile();
});

/** Which thing the shared stage and the input engine serve: a test game, or the console. The shell (app.ts) decides what is shown. */
export function setMode(next: Mode, loadPreset: boolean): void {
  const from = mode;
  mode = next;
  // Coming back to the console from a test bed: the console's own profile again, not the test bed's preset.
  if (next === 'console' && from !== 'console') applyProfile(workingProfile() ?? defaultProfile());
  $<HTMLElement>('fpsSettings').hidden = mode !== 'fps';
  $<HTMLElement>('tpsSettings').hidden = mode !== 'tps';
  $<HTMLElement>('hintFps').hidden = mode !== 'fps';
  $<HTMLElement>('hintTps').hidden = mode !== 'tps';
  $<HTMLElement>('hintConsole').hidden = mode !== 'console';
  $<HTMLButtonElement>('autoCalibrate').disabled = mode === 'console';
  if (mode !== 'console' && client.state !== 'idle') client.disconnect();
  if (mode !== 'console' && (view.width !== BASE_VIEW.width || view.height !== BASE_VIEW.height)) {
    view.width = BASE_VIEW.width;
    view.height = BASE_VIEW.height;
  }
  if (loadPreset && mode !== 'console') {
    applyProfile(presetProfile(mode));
    engine.releaseAll();
    engine.clearLatched();
  }
  resetMeasure();
  syncControls();
  if (loadPreset && mode !== 'console') {
    const loaded = mode;
    message(
      () =>
        loaded === 'tps'
          ? t('Loaded the GTA V style profile (Shift = auto-mash X, F = get in + switch to vehicle controls).')
          : t('Loaded the first-person FPS default profile.'),
      'ok',
    );
  }
}

// ---------------------------------------------------------------- console (bridge) connection

const bridgeUrl = $<HTMLInputElement>('bridgeUrl');
bridgeUrl.value = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
// Normally there is no token. Only a bridge that listens beyond its own computer prints a URL ending in #token=...;
// take it from there and remove it from the address bar.
let bridgeToken = '';
/** For the other modules of the page (ps5.ts) that call the bridge's /api/. Empty on a bridge that needs no token. */
export const getBridgeToken = (): string => bridgeToken;
/** Which registered console the next connection is for (set by the PS5 page). */
let consoleMac = '';
export const setConsoleMac = (mac: string): void => {
  consoleMac = mac;
};
{
  const local = location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname === '[::1]';
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromHash) {
    bridgeToken = fromHash;
    // On the bridge's own computer the token is taken out of the address bar. On another device it stays: a phone's
    // "Add to Home Screen" keeps the address as it is, and that is how the page opened from there gets the token.
    if (local) history.replaceState(null, '', location.pathname + location.search);
    else {
      try {
        localStorage.setItem('gtp.token', fromHash);
      } catch {
        /* then the address has to carry it every time */
      }
    }
  } else if (!local) {
    try {
      bridgeToken = localStorage.getItem('gtp.token') ?? '';
    } catch {
      /* no storage */
    }
  }
}

const qualityNote = (): void => {
  const q = QUALITY_PRESETS[$<HTMLSelectElement>('qualityPreset').value as QualityPreset];
  $<HTMLElement>('qualityNote').textContent = t('{width}×{height} {fps}fps {kbps}kbps ≈ {mb}MB/hour', { width: q.width, height: q.height, fps: q.fps, kbps: q.bitrateKbps, mb: megabytesPerHour(q.bitrateKbps).toFixed(0) });
};
onLang(() => qualityNote());
$<HTMLSelectElement>('qualityPreset').addEventListener('change', () => {
  qualityNote();
  if (client.state !== 'ready') return;
  // A console fixes resolution and frame rate when the stream starts: a change means connecting again.
  if (client.link === 'ps5') connectConsole();
  else client.sendJson({ type: 'quality', preset: $<HTMLSelectElement>('qualityPreset').value });
});
{
  // ?quality=saver|balanced|low-latency|quality picks the starting quality (for measurement runs).
  const asked = params.get('quality');
  if (asked && asked in QUALITY_PRESETS) $<HTMLSelectElement>('qualityPreset').value = asked;
}
qualityNote();

// ---------------------------------------------------------------- console registration (talks to the bridge's /api/)

interface ApiReply {
  ok: boolean;
  status: number;
  data: Record<string, any>;
}
async function api(method: string, path: string, body?: unknown): Promise<ApiReply> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (bridgeToken) headers.Authorization = `Bearer ${bridgeToken}`;
  const res = await fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { ok: res.ok, status: res.status, data };
}

const regMsg = $<HTMLElement>('regMsg');
/**
 * The line under the registration form. What it says is kept as a way of saying it (not as text), so that it can be said
 * again in the new language when the language changes.
 */
let saying: { text: () => string; kind: 'ok' | 'err' | '' } | null = null;
const say = (text: () => string, kind: 'ok' | 'err' | '' = ''): void => {
  saying = { text, kind };
  regMsg.textContent = text();
  regMsg.dataset.kind = kind;
};
onLang(() => {
  if (saying) regMsg.textContent = saying.text();
});
/** What the bridge's reasons are called for the person (sentences, shown through t()). */
const REG_HINT: Record<string, string> = {
  'account-id-needed': N_('A PSN account ID is needed the first time.'),
  rejected: N_('The console refused. Check that the code is correct and has not changed, and that the account ID is right. Look at the code on the console\'s device-linking screen again and enter it anew.'),
  refused: N_('The console refused the connection. Try again with the console\'s device-linking screen open.'),
  timeout: N_('The console is not responding. Check that it is on, that the device-linking screen is open, and that it is on the same network.'),
  'not-found': N_('The console is not responding at that address.'),
};
/** A reason, and the bridge's own words after it when it gave some. */
const withDetail = (reason: string, message: unknown): string => (message ? t('{reason} ({message})', { reason, message: String(message) }) : reason);

/** Why a call to the bridge's /api/ did not work, in words that say what to do. `null` means no answer at all. */
export function whyNoApi(r: { status: number; data: Record<string, any> } | null): string {
  if (!r) return t('Could not reach the server at this address ({host}). Check that the bridge is running.', { host: location.host });
  if (r.status === 404) return t('This address ({host}) looks like another server that only serves files, not the bridge. Run npm run dev in a terminal and open the address it prints.', { host: location.host });
  if (r.status === 401) return t('The bridge asks for a token. Open the address the bridge printed (#token=…).');
  if (r.status === 403 || r.status === 421) return t('The bridge refused a connection that came to this address. Open the address the bridge printed (usually http://127.0.0.1:port/).');
  return r.data.message
    ? t('The bridge returned an error (HTTP {status}: {message}).', { status: r.status, message: String(r.data.message) })
    : t('The bridge returned an error (HTTP {status}).', { status: r.status });
}

async function refreshRegistered(): Promise<void> {
  const list = $<HTMLElement>('regList');
  const r = await api('GET', '/api/consoles').catch(() => null);
  list.textContent = '';
  if (!r || !r.ok) {
    const li = document.createElement('li');
    li.textContent = whyNoApi(r);
    list.append(li);
    return;
  }
  const consoles = (r.data.consoles ?? []) as Array<{ mac: string; nickname: string; target: string; host: string }>;
  for (const c of consoles) {
    const li = document.createElement('li');
    li.textContent = `${c.nickname || t('(no name)')} · ${c.target} · ${c.host} · ${c.mac}  `;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = t('Delete');
    del.addEventListener('click', () => void api('DELETE', `/api/consoles/${encodeURIComponent(c.mac)}`).then(refreshRegistered));
    li.append(del);
    list.append(li);
  }
  if (consoles.length === 0) {
    const li = document.createElement('li');
    li.textContent = t('None yet.');
    list.append(li);
  }
  $<HTMLElement>('regAccountNote').textContent = r.data.accountIdSaved ? t('(Using the saved value. Enter a new one to change it)') : t('(Digits or Base64. Needed only the first time)');
  document.dispatchEvent(new CustomEvent('gtp:consoles'));
}
// The list is drawn from what the bridge says, so it is asked again to be drawn in the new language.
onLang(() => void refreshRegistered());

interface FoundHost {
  address: string;
  name: string;
  type: string;
  state: string;
  registered: boolean;
}
/** What the last search found (null: none yet, or it failed), so that the list can be drawn again in another language. */
let foundHosts: FoundHost[] | null = null;
function paintHosts(): void {
  if (!foundHosts) return;
  const select = $<HTMLSelectElement>('regHost');
  const chosen = select.value;
  select.textContent = '';
  for (const h of foundHosts) {
    const o = document.createElement('option');
    o.value = h.address;
    o.textContent = t('{name} ({address}) · {state} · {registered}', {
      name: h.name || h.type,
      address: h.address,
      state: h.state === 'ready' ? t('Powered on') : t('Standby'),
      registered: h.registered ? t('Registered') : t('Not registered'),
    });
    select.append(o);
  }
  if (foundHosts.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = t('(none found)');
    select.append(o);
  } else if (foundHosts.some((h) => h.address === chosen)) select.value = chosen;
}
onLang(paintHosts);

$<HTMLButtonElement>('regScan').addEventListener('click', async () => {
  say(() => t('Searching…'));
  const r = await api('GET', '/api/discover').catch(() => null);
  foundHosts = null;
  $<HTMLSelectElement>('regHost').textContent = '';
  if (!r || !r.ok) return say(() => t('Could not find a console. {reason}', { reason: whyNoApi(r) }), 'err');
  const hosts = (r.data.hosts ?? []) as FoundHost[];
  foundHosts = hosts;
  paintHosts();
  if (hosts.length === 0) return say(() => t('The console is not responding. Check that it is on and on the same network; you can also enter the IP address yourself.'), 'err');
  $<HTMLInputElement>('regAddr').value = hosts[0]!.address;
  say(() => (hosts.some((h) => h.state !== 'ready') ? t('A console is in standby. Turn it on to register it.') : t('Consoles found: {count}.', { count: hosts.length })), 'ok');
});
$<HTMLSelectElement>('regHost').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v) $<HTMLInputElement>('regAddr').value = v;
});

// Getting the account id from Sony. The page only shows Sony's login link and takes the pasted address; the exchange
// happens in the bridge, and nothing but the last four digits of the id ever comes back.
void api('GET', '/api/psn/login-url')
  .then((r) => {
    if (r.ok && typeof r.data.url === 'string') $<HTMLAnchorElement>('psnLogin').href = r.data.url;
  })
  .catch(() => {});
$<HTMLInputElement>('psnAck').addEventListener('change', (e) => {
  $<HTMLButtonElement>('psnGo').disabled = !(e.target as HTMLInputElement).checked;
});
const PSN_HINT: Record<string, string> = {
  'acknowledge-needed': N_('Read the notice and tick the box first.'),
  'invalid-input': N_('The pasted value is not right. After logging in, copy the whole address from the address bar of the page that says “redirect”.'),
  'login-rejected': N_('Sony did not accept the login code. A code can be used only once and expires quickly. Log in again and paste the new address.'),
  network: N_('Could not connect to Sony. Check your internet connection.'),
  'too-many': N_('Too many attempts. Try again in a minute.'),
};
$<HTMLButtonElement>('psnGo').addEventListener('click', async () => {
  const urlInput = $<HTMLInputElement>('psnUrl');
  const button = $<HTMLButtonElement>('psnGo');
  if (!urlInput.value.trim()) return say(() => t('Paste the address of the page that appears after you log in.'), 'err');
  const pasted = urlInput.value;
  urlInput.value = ''; // the one-time code leaves the page the moment it is sent, not after the answer
  button.disabled = true;
  say(() => t('Getting the account ID from Sony…'));
  try {
    const r = await api('POST', '/api/psn/account-id', { redirectUrl: pasted, acknowledge: $<HTMLInputElement>('psnAck').checked });
    if (r.ok) {
      const hint = String(r.data.hint ?? '');
      say(() => t('Account ID fetched and saved (last 4 digits {hint}). Now just enter the code and register.', { hint }), 'ok');
      await refreshRegistered();
    } else {
      const reason = PSN_HINT[String(r.data.error ?? '')] ?? N_('Could not get the account ID.');
      say(() => withDetail(t(reason), r.data.message), 'err');
    }
  } catch {
    say(() => t('Could not connect to the bridge.'), 'err');
  } finally {
    urlInput.value = ''; // a one-time login code does not belong on the page any longer
    button.disabled = !$<HTMLInputElement>('psnAck').checked;
  }
});

$<HTMLButtonElement>('regGo').addEventListener('click', async () => {
  const pinInput = $<HTMLInputElement>('regPin');
  const accountInput = $<HTMLInputElement>('regAccount');
  const address = $<HTMLInputElement>('regAddr').value.trim();
  const pin = pinInput.value.replace(/[\s-]/g, '');
  if (!address) return say(() => t('Enter the console\'s IP address or press “Find console”.'), 'err');
  if (!/^\d{8}$/.test(pin)) return say(() => t('The code is the 8-digit number shown on the console.'), 'err');
  const body: Record<string, string> = { host: address, pin };
  pinInput.value = ''; // a PIN is single use: off the page as soon as it is sent
  if (accountInput.value.trim()) body.accountId = accountInput.value.trim();
  const button = $<HTMLButtonElement>('regGo');
  button.disabled = true;
  say(() => t('Registering… Do not close the device-linking screen on the console.'));
  try {
    const r = await api('POST', '/api/register', body);
    if (r.ok) {
      const name = String(r.data.console?.nickname || address);
      say(() => t('Registered: {name}', { name }), 'ok');
      accountInput.value = '';
      await refreshRegistered();
    } else {
      const reason = REG_HINT[String(r.data.error ?? '')] ?? N_('Could not register.');
      say(() => withDetail(t(reason), r.data.message), 'err');
    }
  } catch {
    say(() => t('Could not connect to the bridge.'), 'err');
  } finally {
    pinInput.value = ''; // a PIN is single use; do not leave it on the page
    button.disabled = false;
  }
});
void refreshRegistered();

/** The quality the page asks for when it connects: a console fixes resolution and frame rate when the stream starts. */
const chosenQuality = (): { preset: string } => ({ preset: $<HTMLSelectElement>('qualityPreset').value });
function connectConsole(): void {
  // A browser lets a page make sound only after a tap or click, and this runs in one: unlock before anything is awaited.
  audio.unlock();
  audio.close();
  player.close();
  hitchesSeen = 0;
  client.connect(bridgeUrl.value, bridgeToken, consoleMac, chosenQuality(), lockToggle.checked);
}
$<HTMLButtonElement>('bridgeConnect').addEventListener('click', connectConsole);

// ---------------------------------------------------------------- the console's sound
const soundToggle = $<HTMLInputElement>('soundToggle');
try {
  soundToggle.checked = localStorage.getItem('gtp.sound') !== '0';
} catch {
  /* not remembered */
}
audio.setMuted(!soundToggle.checked);
soundToggle.addEventListener('change', () => {
  if (soundToggle.checked) audio.unlock(); // a tap: the right moment to let the browser make sound
  audio.setMuted(!soundToggle.checked);
  try {
    localStorage.setItem('gtp.sound', soundToggle.checked ? '1' : '0');
  } catch {
    /* not remembered */
  }
  showSoundNote();
});
// A phone call or an alarm can stop the page's sound, and a browser may not have let it start. Any tap is a chance to
// let it run again.
document.addEventListener(
  'pointerdown',
  () => {
    if (soundToggle.checked && client.state === 'ready' && audio.contextState !== 'running' && audio.contextState !== 'none') audio.unlock();
  },
  { capture: true, passive: true },
);
/** One line about the sound, in words: off, why there is none, or what is playing. */
function soundNote(): string {
  const a = audio.stats;
  if (!soundToggle.checked) return t('Sound is off');
  if (a.state === 'unsupported') return a.reason;
  if (a.state !== 'playing' || !a.info) return client.state === 'ready' ? t('Waiting for sound') : '';
  if (audio.contextState !== 'running' && !document.hidden) return t('The browser is blocking the sound. Tap the screen once');
  const channels = a.info.channels === 1 ? t('Mono') : a.info.channels === 2 ? t('Stereo') : t('{count}-channel', { count: a.info.channels });
  return t('{rate} kHz {channels} · delay {delay} ms · dropouts {count}', { rate: (a.info.rate / 1000).toFixed(0), channels, delay: a.delayMs, count: a.underruns + a.concealed });
}
function showSoundNote(): void {
  $<HTMLElement>('soundNote').textContent = soundNote();
}
// The reason there is no sound is kept by the player: it says it again in the new language, and then the line is drawn again.
onLang(() => {
  audio.refreshLanguage();
  showSoundNote();
});

// A connection that is not locked is handed over when another of this person's clients asks for the console.
const lockToggle = $<HTMLInputElement>('lockToggle');
try {
  lockToggle.checked = localStorage.getItem('gtp.lock') === '1';
} catch {
  /* storage may be unavailable */
}
lockToggle.addEventListener('change', () => {
  try {
    localStorage.setItem('gtp.lock', lockToggle.checked ? '1' : '0');
  } catch {
    /* not remembered, that is all */
  }
  if (client.state === 'ready') client.sendJson({ type: 'lock', locked: lockToggle.checked });
});

// ---------------------------------------------------------------- how frames are paced on the screen
//
// 'smooth' holds frames back by the little it takes to keep an even pace when one arrives late; 'immediate' shows
// each frame as it arrives. ?playout=smooth | immediate | <milliseconds> (a fixed delay) is for comparing them.

const playoutSelect = $<HTMLSelectElement>('playoutMode');
function applyPlayout(value: string): void {
  const fixed = /^\d+(\.\d+)?$/.test(value) ? Number(value) : undefined;
  const choice = value === 'immediate' || value === 'balanced' ? value : 'smooth';
  if (fixed !== undefined) player.setPlayout({ mode: 'smooth', fixedDelayMs: fixed });
  else if (choice === 'immediate') player.setPlayout({ mode: 'immediate' });
  else player.setPlayout({ mode: 'smooth', maxDelayMs: choice === 'balanced' ? 50 : 100 });
  playoutSelect.value = choice;
}
{
  let saved = '';
  try {
    saved = localStorage.getItem('gtp.playout') ?? '';
  } catch {
    /* storage may be unavailable */
  }
  applyPlayout(params.get('playout') ?? (saved === 'immediate' || saved === 'balanced' ? saved : 'smooth'));
}
playoutSelect.addEventListener('change', () => {
  applyPlayout(playoutSelect.value);
  try {
    localStorage.setItem('gtp.playout', playoutSelect.value);
  } catch {
    /* not remembered, that is all */
  }
});

/** Hitches the viewer saw since connecting. */
let hitchesSeen = 0;
// ---------------------------------------------------------------- playing by touch (a phone)
const touchToggle = $<HTMLInputElement>('touchToggle');
const touch = mountTouch($<HTMLElement>('touchLayer'), {
  onDisconnect: () => client.disconnect(),
  onFullscreen: () => document.dispatchEvent(new CustomEvent('gtp:toggle-fullscreen')),
  sound: {
    isOn: () => soundToggle.checked,
    set: (on) => {
      soundToggle.checked = on;
      soundToggle.dispatchEvent(new Event('change'));
    },
    note: () => soundNote(),
  },
  onHide: () => {
    touchToggle.checked = false;
    touchToggle.dispatchEvent(new Event('change'));
  },
});
{
  let saved = '';
  try {
    saved = localStorage.getItem('gtp.touch') ?? '';
  } catch {
    /* storage may be unavailable */
  }
  touchToggle.checked = saved === '1' || (saved === '' && prefersTouch());
}
/** The touch controls are up exactly while they are wanted and there is a console's picture to play on. */
function applyTouch(): void {
  touch.show(touchToggle.checked && mode === 'console' && client.state === 'ready');
}
touchToggle.addEventListener('change', () => {
  try {
    localStorage.setItem('gtp.touch', touchToggle.checked ? '1' : '0');
  } catch {
    /* not remembered */
  }
  applyTouch();
});

// A hidden tab is not being watched: do not decode for it and do not count what the browser does to it as hitches.
document.addEventListener('visibilitychange', () => {
  player.setVisible(!document.hidden);
  audio.setVisible(!document.hidden);
  if (document.hidden) engine.releaseAll();
});
setInterval(() => {
  const sample = player.meter.take();
  // The sound is held back as much as the picture is, plus a little: they have to stay together.
  audio.setTargetDelayMs(player.playout.delayMs + 40);
  if (document.hidden) return;
  showSoundNote();
  if (mode !== 'console' || client.state !== 'ready') return;
  hitchesSeen += sample.hitches;
  const delay = player.playout.delayMs;
  touch.setStatus(t('Receiving {fps} fps · {kbps} kbps · display delay {delay} ms · screen hitches {count}', { fps: client.fpsIn, kbps: client.kbpsIn, delay: delay.toFixed(0), count: hitchesSeen }));
  $<HTMLElement>('cBuffer').textContent = player.playout.mode === 'immediate' ? t('0 ms (late frames up to {ms} ms)', { ms: player.playout.worstLateMs.toFixed(0) }) : `${delay.toFixed(0)} ms`;
  $<HTMLElement>('cHitch').textContent = t('{count}', { count: hitchesSeen });
  // The same numbers for the signal indicator and the charts over the picture (player-ui.ts).
  document.dispatchEvent(new CustomEvent('gtp:stats', { detail: { fps: client.fpsIn, kbps: client.kbpsIn, rttMs: client.rttMs, latencyMs: client.inputLatencyMs, delayMs: delay, hitches: sample.hitches, hitchesTotal: hitchesSeen } }));
  if (sample.shown === 0 && sample.underruns === 0) return;
  // The bridge keeps these next to its own measurements (GET /api/stream/stats), so a study sees both ends.
  client.sendJson({
    type: 'display', mode: player.playout.mode, delayMs: Math.round(delay * 10) / 10, intervalMs: Math.round(player.playout.intervalMs * 1000) / 1000,
    worstLateMs: Math.round(player.playout.worstLateMs * 10) / 10, waiting: player.waiting, rttMs: Math.round(client.rttMs), sound: audio.stats.state, ...sample,
  });
}, 1000);
$<HTMLButtonElement>('bridgeDisconnect').addEventListener('click', () => client.disconnect());

// ---------------------------------------------------------------- profiles: one per game, kept in this browser
//
// The profile in use for the console is remembered as it is changed (so a reload loses nothing), and can be saved
// under a name: one per game. The test beds use their own presets and do not touch either.

const STORE_PROFILES = 'gtp.profiles';
const STORE_WORKING = 'gtp.profile.working';

function readStore<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStore(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable: the profile then lives until the page is closed */
  }
}
/** Saved profiles by name. Anything that is not a valid profile any more is left out. */
function savedProfiles(): Record<string, Profile> {
  const out: Record<string, Profile> = {};
  for (const [name, raw] of Object.entries(readStore<Record<string, unknown>>(STORE_PROFILES, {}))) {
    const checked = validateProfile(raw);
    if (checked.ok) out[name] = checked.profile;
  }
  return out;
}
function workingProfile(): Profile | null {
  const checked = validateProfile(readStore<unknown>(STORE_WORKING, null));
  return checked.ok ? checked.profile : null;
}

const profilePick = $<HTMLSelectElement>('profilePick');
const profileName = $<HTMLInputElement>('profileName');
function renderProfilePick(): void {
  profilePick.textContent = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = t('Choose…');
  profilePick.append(first);
  const presets = document.createElement('optgroup');
  presets.label = t('Start from scratch');
  for (const p of PRESETS) {
    const o = document.createElement('option');
    o.value = `preset:${p.id}`;
    o.textContent = t(p.name);
    presets.append(o);
  }
  profilePick.append(presets);
  const names = Object.keys(savedProfiles()).sort((a, b) => a.localeCompare(b));
  if (names.length) {
    const mine = document.createElement('optgroup');
    mine.label = t('Saved profiles');
    for (const name of names) {
      const o = document.createElement('option');
      o.value = `saved:${name}`;
      o.textContent = name;
      mine.append(o);
    }
    profilePick.append(mine);
  }
}
/** Switch to another profile as a whole: nothing held or switched on carries over. */
function useProfile(next: Profile): void {
  applyProfile(next);
  engine.releaseAll();
  engine.clearLatched();
  syncControls();
}
profilePick.addEventListener('change', () => {
  const v = profilePick.value;
  profilePick.value = '';
  if (v.startsWith('preset:')) {
    const preset = PRESETS.find((p) => p.id === v.slice(7));
    if (!preset) return;
    useProfile(preset.make());
    message(() => t('Loaded the layout "{name}".', { name: t(preset.name) }), 'ok');
  } else if (v.startsWith('saved:')) {
    const saved = savedProfiles()[v.slice(6)];
    if (!saved) return;
    useProfile(saved);
    const savedName = v.slice(6);
    message(() => t('Loaded the profile "{name}".', { name: savedName }), 'ok');
  }
});
$<HTMLButtonElement>('profileSave').addEventListener('click', () => {
  const name = profileName.value.trim();
  if (!name) return message(() => t('Type a name to save under (usually the game name).'), 'error');
  profile.game.name = name;
  writeStore(STORE_PROFILES, { ...savedProfiles(), [name]: profile });
  applyProfile(profile);
  syncControls();
  renderProfilePick();
  message(() => t('Saved as "{name}". It is kept in this browser.', { name }), 'ok');
});
$<HTMLButtonElement>('profileDelete').addEventListener('click', () => {
  const name = profileName.value.trim();
  const all = savedProfiles();
  if (!(name in all)) return message(() => t('There is no saved profile called "{name}".', { name }), 'error');
  delete all[name];
  writeStore(STORE_PROFILES, all);
  renderProfilePick();
  message(() => t('Deleted the profile "{name}". The layout in use is unchanged.', { name }), 'ok');
});
renderProfilePick();
onLang(renderProfilePick);

// The key layout editor (Settings → Input mapping) and the layout shown next to the picture.
const keymap = mountKeymap($<HTMLElement>('keymap'), {
  getProfile: () => profile,
  setProfile: (next) => {
    applyProfile(next);
    syncControls();
  },
  say: (text, kind) => message(text, kind),
});
function renderLegend(): void {
  $<HTMLElement>('layoutName').textContent = `· ${profile.game.name}`;
  const list = $<HTMLElement>('layoutList');
  list.textContent = '';
  for (const item of describeLayout(profile)) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = item.label;
    const dd = document.createElement('dd');
    dd.textContent = item.keys;
    row.append(dt, dd);
    list.append(row);
  }
}
// The names of the keys and the buttons are words (describeLayout): a change of language draws them again.
onLang(renderLegend);
let refreshQueued = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
onProfileChanged = () => {
  profileName.value = profile.game.name;
  document.dispatchEvent(new CustomEvent('gtp:profile'));
  // A slider being dragged changes the profile many times a second: redraw once per frame, save once it settles.
  if (!refreshQueued) {
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      keymap.refresh();
      renderLegend();
    });
  }
  if (mode === 'console') {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeStore(STORE_WORKING, profile), 300);
  }
};
// On the console, start with the profile that was in use last time.
if (mode === 'console') {
  const last = workingProfile();
  if (last) applyProfile(last);
}
onProfileChanged();

client.onVideo = (header, payload) => player.push(header, payload);
client.onAudioInfo = (info) => void audio.start(info);
client.onAudio = (lost, payload) => audio.push(lost, payload);

// Measuring the game's response to the right stick from its picture (the panel is in the settings).
mountConsoleCalibration({
  canvas: view,
  setStickOverride: (stick) => {
    calibStick = stick;
    if (stick) engine.releaseAll();
  },
  onFrameDrawn: (listener) => {
    player.onFrame = () => listener();
  },
  ready: () => mode === 'console' && client.state === 'ready',
  profile: () => profile,
  changed: () => {
    applyProfile(profile);
    refreshJson();
    syncControls();
  },
});
player.onNeedKeyframe = () => client.requestKeyframe();
const paintLatency = (): void => {
  $<HTMLElement>('cLatency').textContent = client.inputLatencyMs > 0 ? t('{ms} ms (median)', { ms: client.inputLatencyMs.toFixed(0) }) : '-';
};
onLang(paintLatency);
client.onChange = () => {
  $<HTMLElement>('cStatus').textContent = `${client.state}${client.detail ? ` · ${client.detail}` : ''}`;
  $<HTMLElement>('cRate').textContent = client.state === 'ready' ? `${client.fpsIn} fps / ${client.kbpsIn} kbps` : '-';
  $<HTMLElement>('cRtt').textContent = client.rttMs > 0 ? `${client.rttMs.toFixed(1)} ms` : '-';
  paintLatency();
  document.dispatchEvent(new CustomEvent('gtp:link', { detail: { state: client.state, detail: client.detail, link: String(client.serverStats.link ?? '') } }));
  applyTouch();
};

$<HTMLSelectElement>('gameMode').addEventListener('change', (e) => setMode((e.target as HTMLSelectElement).value as Mode, true));

$<HTMLButtonElement>('applyJson').addEventListener('click', () => {
  const result = parseProfileText($<HTMLTextAreaElement>('profileJson').value);
  if (!result.ok) {
    message(result.errors.slice(0, 4).join(' / '), 'error');
    return;
  }
  applyProfile(result.profile);
  syncControls();
  message(() => t('Profile applied.'), 'ok');
});

$<HTMLButtonElement>('resetProfile').addEventListener('click', () => {
  applyProfile(presetProfile(mode));
  engine.releaseAll();
  engine.clearLatched();
  syncControls();
  message(() => t('Back to the default layout.'), 'ok');
});

$<HTMLButtonElement>('autoCalibrate').addEventListener('click', () => {
  const make: GameFactory = mode === 'fps' ? () => new FpsGame({ ...fps.settings }) : () => new TpsGame({ ...tps.settings });
  const m = measureCalibration(make);
  applyMeasuredCalibration(profile, m);
  applyProfile(profile);
  syncControls();
  const edge = m.horizontal.find((p) => p[0] > 0 && p[1] === 0)?.[0];
  const done = { edge: edge === undefined ? '0' : edge.toFixed(3), rate: m.fullStickRate.toFixed(0), ratio: m.verticalRateRatio.toFixed(2), aim: m.aimLookScale.toFixed(2), points: m.horizontal.length };
  message(
    () =>
      m.deadzoneShape === 'radial'
        ? t('Calibration done: dead zone edge {edge}, max {rate}°/s, vertical ratio {ratio}, round shape, aim scale {aim}, table of {points} points', done)
        : t('Calibration done: dead zone edge {edge}, max {rate}°/s, vertical ratio {ratio}, per-axis shape, aim scale {aim}, table of {points} points', done),
    'ok',
  );
  resetMeasure();
});

$<HTMLButtonElement>('resetMeasure').addEventListener('click', resetMeasure);
$<HTMLButtonElement>('resetGame').addEventListener('click', () => {
  active().reset();
  resetMeasure();
});
$<HTMLButtonElement>('clearLatch').addEventListener('click', () => engine.clearLatched());

// ---------------------------------------------------------------- input

const isLocked = (): boolean => document.pointerLockElement === view;
const isActive = (): boolean => isLocked() || document.activeElement === view;

async function lockPointer(): Promise<void> {
  view.focus();
  try {
    // Ask for raw, unaccelerated movement where the browser supports it.
    await (view as unknown as { requestPointerLock(o?: object): Promise<void> | void }).requestPointerLock({
      unadjustedMovement: true,
    });
    lockNote = N_('Locked (raw input granted)');
  } catch {
    try {
      await (view.requestPointerLock() as unknown);
      lockNote = N_('Locked (ordinary input: raw input not supported or refused)');
    } catch {
      lockNote = N_('Lock failed');
    }
  }
}

view.addEventListener('click', () => {
  if (!isLocked()) void lockPointer();
});

document.addEventListener('pointerlockchange', () => {
  rawGate.reset();
  if (!isLocked()) {
    engine.releaseAll();
    lockNote = N_('Released');
    // Esc means "stop sending my keys": without this the canvas would keep the keyboard, and the page's own shortcuts
    // (F for full screen, M for mute ...) would be eaten as game keys.
    if (document.activeElement === view) view.blur();
  }
});

/**
 * What the controls over the picture (player-ui.ts) need from here: the canvas, the mouse lock, the volume, the sound
 * as a stream for a clip. The rest of the input stays in this file.
 */
export const stage = {
  canvas: view,
  get locked(): boolean {
    return isLocked();
  },
  lock: (): Promise<void> => lockPointer(),
  unlock: (): void => document.exitPointerLock(),
  setVolume: (v: number): void => audio.setVolume(v),
  captureAudio: (): MediaStream | null => audio.captureStream() as MediaStream | null,
};

/**
 * The few mouse settings that are tried while playing (the panel and the keys in player-ui.ts). Everything goes through
 * the profile, so the settings page, the saved profile and these controls always show the same numbers.
 */
export const mouseFeel = {
  /** What the engine believes about how the game answers a stick (a measured table makes the three numbers a rough guide only). */
  game(): { innerDeadzone: number; maxTurnRateAtFullStick: number; responseCurve: number; measured: boolean } {
    const g = profile.inGame;
    return { innerDeadzone: g.innerDeadzone, maxTurnRateAtFullStick: g.maxTurnRateAtFullStick, responseCurve: g.responseCurve, measured: profile.calibration.horizontal !== null };
  },
  read(): Feel {
    const m = profile.mouse;
    return { degPerCount: m.degPerCount, smoothingMs: m.smoothingMs, smoothingFadeRate: m.smoothingFadeRate, carryMs: m.carryMs, curve: m.curve };
  },
  set(part: Partial<Feel>): void {
    const m = profile.mouse;
    const within = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
    if (part.degPerCount !== undefined) m.degPerCount = within(part.degPerCount, SENSITIVITY_MIN, SENSITIVITY_MAX);
    if (part.smoothingMs !== undefined) m.smoothingMs = within(part.smoothingMs, 0, 200);
    if (part.smoothingFadeRate !== undefined) m.smoothingFadeRate = within(part.smoothingFadeRate, 0, 2000);
    if (part.carryMs !== undefined) m.carryMs = within(part.carryMs, 0, 2000);
    if (part.curve !== undefined) m.curve = within(part.curve, 0.5, 3);
    applyProfile(profile);
    syncControls();
  },
};

window.addEventListener('blur', () => engine.releaseAll());

window.addEventListener('keydown', (e) => {
  if (calibStick) return;
  if (!isActive() || e.repeat) return;
  if (e.code === 'Escape') return; // let the browser release the pointer lock
  engine.keyDown(e.code);
  e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  if (!isActive()) return;
  engine.keyUp(e.code);
  e.preventDefault();
});

// The mouse reaches the page twice: at once as `pointerrawupdate` (secure pages in Chrome and its relatives), and about a
// frame later, summed, as `mousemove`. The first is up to a frame sooner, so it is used where it comes; see RawMouseGate.
const rawGate = new RawMouseGate();
window.addEventListener('pointerrawupdate', (e) => {
  const p = e as PointerEvent;
  if (p.pointerType !== 'mouse' || !isLocked()) return;
  rawGate.raw(performance.now());
  feedMouse(p.movementX, p.movementY);
});
document.addEventListener('mousemove', (e) => {
  if (isLocked() && rawGate.ordinary(performance.now())) feedMouse(e.movementX, e.movementY);
});

document.addEventListener('mousedown', (e) => {
  if (calibStick || !isLocked()) return;
  engine.mouseButton(e.button, true);
  e.preventDefault();
});

document.addEventListener('mouseup', (e) => {
  if (!isLocked()) return;
  engine.mouseButton(e.button, false);
  e.preventDefault();
});

document.addEventListener('contextmenu', (e) => {
  if (isLocked()) e.preventDefault();
});

document.addEventListener(
  'wheel',
  (e) => {
    if (calibStick || !isLocked()) return;
    engine.wheel(e.deltaY);
    e.preventDefault();
  },
  { passive: false },
);

// ---------------------------------------------------------------- pad drawing

const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function ring(cx: number, cy: number, r: number, dash: number[], color: string, width = 1): void {
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function stick(cx: number, cy: number, x: number, y: number, label: string, capped: boolean, withRings: boolean): void {
  const r = 100;
  ring(cx, cy, r, [], css('--line'), 2);
  if (withRings) {
    ring(cx, cy, r * active().settings.innerDeadzone, [4, 4], css('--muted'));
    if (profile.mouse.maxDeflection < 1) ring(cx, cy, r * profile.mouse.maxDeflection, [6, 3], css('--accent'), 2);
  }
  ctx.strokeStyle = css('--line');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.stroke();
  ctx.fillStyle = withRings && capped ? css('--warn') : css('--accent');
  ctx.beginPath();
  ctx.arc(cx + x * r, cy + y * r, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = css('--muted');
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, cx, cy + r + 22);
}

function bar(x: number, y: number, w: number, value: number, label: string): void {
  ctx.fillStyle = css('--line');
  ctx.fillRect(x, y, w, 14);
  ctx.fillStyle = css('--accent');
  ctx.fillRect(x, y, (w * value) / 255, 14);
  ctx.fillStyle = css('--muted');
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${label} ${value}`, x, y - 4);
}

function drawPad(): void {
  const diag = engine.diagnostics;
  ctx.clearRect(0, 0, padCanvas.width, padCanvas.height);

  bar(40, 28, 200, state.l2, t('L2 (right click)'));
  bar(520, 28, 200, state.r2, t('R2 (left click)'));
  stick(150, 190, state.leftX, state.leftY, t('Left stick (WASD)'), false, false);
  stick(610, 190, state.rightX, state.rightY, t('Right stick (mouse)'), diag.capped, true);

  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  BUTTON_NAMES.forEach((name, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = 290 + col * 52;
    const y = 90 + row * 36;
    const on = (state.buttons & BUTTON[name]) !== 0;
    ctx.fillStyle = on ? css('--accent') : css('--line');
    ctx.fillRect(x, y, 46, 26);
    ctx.fillStyle = on ? '#ffffff' : css('--muted');
    ctx.fillText(name.replace('dpad_', 'd-'), x + 23, y + 17);
  });
}

function updateReadout(): void {
  const diag = engine.diagnostics;
  const g = active();
  const limit = profile.mouse.maxTurnRate;
  const speed = Math.hypot(diag.rateX, diag.rateY);
  const turned = g.yawTotal - yawMark;
  const expected = profile.mouse.degPerCount;
  $<HTMLElement>('mCounts').textContent = `${measureCounts.toFixed(0)} counts`;
  $<HTMLElement>('mTurned').textContent = mode === 'console' ? t('(not measurable on the console)') : `${turned.toFixed(1)}°`;
  if (mode === 'console') {
    $<HTMLElement>('mRatio').textContent = '-';
    $<HTMLElement>('mExpected').textContent = `${expected.toFixed(4)}`;
  } else if (Math.abs(measureCounts) >= 20) {
    const ratio = turned / measureCounts;
    const error = (ratio / expected - 1) * 100;
    $<HTMLElement>('mRatio').textContent = ratio.toFixed(4);
    $<HTMLElement>('mExpected').textContent = `${expected.toFixed(4)} (${error >= 0 ? '+' : ''}${error.toFixed(1)}%)`;
  } else {
    $<HTMLElement>('mRatio').textContent = '-';
    $<HTMLElement>('mExpected').textContent = t('{value} (waiting for measurement)', { value: expected.toFixed(4) });
  }
  $<HTMLElement>('rRate').textContent = `${diag.rateX.toFixed(0)} / ${diag.rateY.toFixed(0)} °/s`;
  $<HTMLElement>('rUse').textContent = `${Math.min(999, (speed / limit) * 100).toFixed(0)}%`;
  $<HTMLElement>('rCap').innerHTML = diag.capped
    ? `<span class="badge on">${t('Yes')}</span>`
    : `<span class="badge off">${t('No')}</span>`;
  $<HTMLElement>('rStick').textContent = diag.stickMagnitude.toFixed(3);
  $<HTMLElement>('rLayers').textContent = ['default', ...engine.activeLayers].join(' + ');
  $<HTMLElement>('rGyro').textContent = [state.gyro.x, state.gyro.y, state.gyro.z].map((v) => v.toFixed(2)).join(' / ');
  if (mode === 'console') {
    $<HTMLElement>('rPos').textContent = '-';
    $<HTMLElement>('rState').textContent = client.state === 'ready' ? t('Console ({link})', { link: client.link }) : t('Not connected');
  } else if (mode === 'tps') {
    $<HTMLElement>('rPos').textContent = `${(tps.inVehicle ? tps.car.x : tps.x).toFixed(1)}, ${(tps.inVehicle ? tps.car.z : tps.z).toFixed(1)}`;
    $<HTMLElement>('rState').textContent = `${tps.movementName} · ${tps.speedKmh.toFixed(0)} km/h`;
  } else {
    $<HTMLElement>('rPos').textContent = `${fps.x.toFixed(1)}, ${fps.y.toFixed(1)}`;
    $<HTMLElement>('rState').textContent = fps.adsAmount > 0.5 ? t('Aiming') : '-';
  }
  $<HTMLElement>('rLock').textContent = t(lockNote);
}

function renderView(): void {
  if (mode === 'fps') renderGame(viewCtx, fps, view.width, view.height);
  else if (mode === 'tps') renderTps(viewCtx, tps, view.width, view.height);
  else if (client.state !== 'ready' || performance.now() - player.lastFrameAt > 1500) {
    // Nothing to show yet: a placeholder instead of the last test game frame.
    viewCtx.fillStyle = '#10141c';
    viewCtx.fillRect(0, 0, view.width, view.height);
    viewCtx.fillStyle = '#9aa5b8';
    viewCtx.font = '16px system-ui, sans-serif';
    viewCtx.textAlign = 'center';
    viewCtx.fillText(client.state === 'ready' ? t('Waiting for video…') : '', view.width / 2, view.height / 2);
  }
  // In console mode the video player draws each frame as it arrives.
}

// ---------------------------------------------------------------- loop

let last = performance.now();
let acc = 0;

// Live reload (dev-reload.ts) must not end a game in progress.
(window as { gtpBusy?: () => boolean }).gtpBusy = () => client.state === 'ready' || client.state === 'connecting';

// A real controller (DualSense and the like) joins the keyboard and mouse; see gamepad.ts.
const gamepads = new GamepadInput();
let padNow: PadSample | null = null;
{
  const chip = document.getElementById('padChip');
  const status = document.getElementById('padStatus');
  /** The controller that is shown now (null: none), kept so that the words can be put there again in another language. */
  let shown: string | null = null;
  const paint = (): void => {
    if (status) status.textContent = shown === null ? t('No controller connected. Connect a controller (DualSense etc.) by USB or Bluetooth and press any button.') : t('{name} connected: it can be used together with the keyboard and mouse.', { name: shown });
    if (!chip) return;
    chip.hidden = shown === null;
    if (shown !== null) chip.textContent = t('{name} connected', { name: shown });
  };
  gamepads.onChange = (name) => {
    shown = name;
    paint();
    toast(name === null ? t('The controller was disconnected') : t('{name} connected', { name }), name === null ? 'warn' : 'ok');
  };
  onLang(paint);
}

/** How often the input side has run (the page's own check that it does not wait for the drawing, see runE2e). */
export const inputLoop = { pumps: 0 };

/**
 * The input side: read the pad, step the mapping engine and send what it made. It runs on its own timer, NOT with the
 * drawing: a mouse is felt in the time between the hand moving and the console hearing of it, and tying that to the
 * 60 Hz frame meant it was sent in bursts of four ticks a frame apart (up to 16 ms of delay, uneven from one frame of the
 * game to the next). The timer is as fast as the browser allows (about 4 ms); the ticks it has to catch up on after a
 * stall are still taken one by one.
 */
function pump(): void {
  inputLoop.pumps++;
  const now = performance.now();
  padNow = gamepads.poll();
  if (calibStick && mode === 'console') {
    // The measurement holds the right stick; nothing else is sent, and what the engine would have done is not caught up on after.
    const s = emptyPadState();
    s.rightX = calibStick.x;
    s.rightY = calibStick.y;
    state = s;
    last = now;
    acc = 0;
    client.sendPad(s, false, now);
    return;
  }
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  const steps = Math.min(25, Math.floor(acc / TICK + 1e-9));
  if (touch.shown) {
    const look = touch.pad.takeLook();
    if (look.dx !== 0 || look.dy !== 0) feedMouse(look.dx, look.dy);
  }
  if (steps > 0) {
    trialMeter.tick(steps * TICK, meterDx, meterDy, profile.mouse.degPerCount, mode === 'console' && isLocked());
    meterDx = 0;
    meterDy = 0;
    engine.runFor(steps * TICK, TICK, (s) => {
      if (touch.shown) {
        // Fingers on the screen add to whatever a keyboard is doing: buttons and triggers join, the stick takes over.
        const t = touch.pad.output;
        s.buttons |= t.buttons;
        s.l2 = Math.max(s.l2, t.l2);
        s.r2 = Math.max(s.r2, t.r2);
        if (t.stickActive) {
          s.leftX = t.leftX;
          s.leftY = t.leftY;
        }
      }
      mergeGamepad(s, padNow);
      state = s;
      if (mode === 'console') client.sendPad(s, profile.mouse.target === 'gyro', now);
      else active().update(s, TICK);
    });
    acc = steps === 25 ? 0 : acc - steps * TICK;
  } else if (mode === 'console') {
    client.sendPad(state, profile.mouse.target === 'gyro', now);
  }
}

/** The drawing side: what is on the page, once per frame the browser shows. */
function frame(): void {
  renderView();
  // The pad drawing and the numbers belong to the lab; while that is not on the page they only take time from the picture
  // and from the main thread that the input and the video decoder share.
  if (padCanvas.offsetParent !== null) {
    drawPad();
    updateReadout();
  }
  requestAnimationFrame(frame);
}

setMode(mode, false);
requestAnimationFrame(frame);
setInterval(pump, 4);

// ---------------------------------------------------------------- demo and self test

/**
 * Scripted input for screenshots. It runs on SIMULATED time (tick by tick), not on timers, so the result
 * does not depend on how often the browser schedules frames.
 */
function runDemo(kind: string): void {
  lockNote = N_('Demo input (mouse not locked)');
  const total = kind === 'car' ? 3.6 : kind === 'tps' ? 3.0 : 2.8;
  const T = (s: number): number => Math.round(s / TICK);
  const ticks = T(total);
  for (let i = 0; i < ticks; i++) {
    const t = i * TICK;
    const at = (s: number): boolean => i === T(s);
    if (kind === 'fps') {
      if (at(0.2)) engine.keyDown('KeyW');
      if (at(1.5)) engine.keyUp('KeyW');
      if (i % 2 === 0 && t < 1.8) feedMouse(t < 0.9 ? 8 : 4, t < 0.9 ? 0 : 3);
      if (at(2.2)) engine.mouseButton(0, true);
      if (at(2.6)) engine.mouseButton(0, false);
    } else if (kind === 'tps') {
      if (at(0.2)) engine.keyDown('KeyW');
      if (at(0.3)) engine.keyDown('ShiftLeft');
      if (i % 2 === 0 && t > 0.4 && t < 1.4) feedMouse(6, 0);
      if (at(1.6)) {
        engine.keyUp('ShiftLeft');
        engine.keyUp('KeyW');
      }
      if (at(1.8)) engine.mouseButton(2, true);
      if (at(2.4)) engine.mouseButton(0, true);
      if (at(2.7)) engine.mouseButton(0, false);
    } else {
      // car: sprint to the car, get in with F, drive and steer.
      if (at(0.1)) {
        engine.keyDown('KeyW');
        engine.keyDown('ShiftLeft');
      }
      if (at(0.9)) {
        engine.keyUp('KeyW');
        engine.keyUp('ShiftLeft');
      }
      if (at(1.0)) engine.keyDown('KeyF');
      if (at(1.05)) engine.keyUp('KeyF');
      if (at(1.1)) engine.keyDown('KeyW');
      if (at(1.9)) engine.keyDown('KeyA');
      if (at(2.25)) engine.keyUp('KeyA');
      if (at(3.3)) engine.keyUp('KeyW');
    }
    state = engine.tick(TICK);
    active().update(state, TICK);
  }
}

if (params.has('demo')) {
  const value = params.get('demo');
  runDemo(value === 'car' || value === 'tps' || value === 'fps' ? value : mode);
}

if (params.has('selftest')) {
  const results: string[] = [];
  const check = (name: string, ok: boolean, detail = ''): void => {
    results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  };

  const drive = (e: MappingEngine, g: { update(p: VirtualPadState, dt: number): void }, dx: number, dy: number, seconds: number): void => {
    const ticks = Math.round(seconds / TICK);
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < ticks + 125; i++) {
      if (i < ticks) {
        const tx = Math.round(((i + 1) * dx) / ticks);
        const ty = Math.round(((i + 1) * dy) / ticks);
        e.mouseMove(tx - sx, ty - sy);
        sx = tx;
        sy = ty;
      }
      g.update(e.tick(TICK), TICK);
    }
  };
  const sample = (): number => {
    const colors = new Set<string>();
    for (let gx = 0; gx < 8; gx++) {
      for (let gy = 0; gy < 6; gy++) {
        const px = viewCtx.getImageData(30 + gx * 75, 30 + gy * 55, 1, 1).data;
        colors.add(`${px[0]},${px[1]},${px[2]}`);
      }
    }
    return colors.size;
  };

  // First-person game.
  const e1 = new MappingEngine(defaultProfile());
  const g1 = new FpsGame(defaultGameSettings());
  drive(e1, g1, 400, 0, 1);
  check('FPS: 400 counts turn the camera 20 degrees', Math.abs(g1.yawTotal - 20) < 0.5, `${g1.yawTotal.toFixed(2)}°`);
  const e2 = new MappingEngine(defaultProfile());
  const g2 = new FpsGame(defaultGameSettings());
  drive(e2, g2, 300, 300, 1);
  check('FPS: diagonal sweep keeps both angles', Math.abs(g2.yawTotal - 15) < 0.6 && Math.abs(g2.pitch + 15) < 0.6, `yaw ${g2.yawTotal.toFixed(2)}°, pitch ${g2.pitch.toFixed(2)}°`);
  const p3 = defaultProfile();
  const s3 = defaultGameSettings();
  s3.responseCurve = 1.6;
  applyMeasuredCalibration(p3, measureCalibration(s3));
  const e3 = new MappingEngine(p3);
  const g3 = new FpsGame(s3);
  drive(e3, g3, 400, 0, 1);
  check('FPS: calibration fixes a curved game', Math.abs(g3.yawTotal - 20) / 20 < 0.04, `${g3.yawTotal.toFixed(2)}°`);
  renderGame(viewCtx, new FpsGame(), view.width, view.height);
  check('FPS: canvas shows a rendered scene', sample() >= 5, `${sample()} distinct colors`);

  // GTA V style third-person game.
  const eT = new MappingEngine(gtaProfile());
  const gT = new TpsGame(defaultTpsSettings());
  drive(eT, gT, 400, 0, 1);
  check('TPS: 400 counts turn the camera 20 degrees', Math.abs(gT.yawTotal - 20) < 0.5, `${gT.yawTotal.toFixed(2)}°`);
  const eS = new MappingEngine(gtaProfile());
  const gS = new TpsGame(defaultTpsSettings());
  eS.keyDown('KeyW');
  eS.keyDown('ShiftLeft');
  for (let i = 0; i < 500; i++) gS.update(eS.tick(TICK), TICK);
  check('TPS: W + held Shift sprints (X auto-tapped)', gS.speed > 7, `${gS.speed.toFixed(2)} m/s`);
  const eR = new MappingEngine(gtaProfile());
  const gR = new TpsGame(defaultTpsSettings());
  eR.keyDown('KeyW');
  for (let i = 0; i < 500; i++) gR.update(eR.tick(TICK), TICK);
  check('TPS: W alone runs but does not sprint', Math.abs(gR.speed - 5.2) < 0.1, `${gR.speed.toFixed(2)} m/s`);
  const eV = new MappingEngine(gtaProfile());
  const gV = new TpsGame(defaultTpsSettings());
  gV.x = 46;
  gV.z = 41;
  eV.keyDown('KeyF');
  for (let i = 0; i < 25; i++) gV.update(eV.tick(TICK), TICK);
  eV.keyUp('KeyF');
  eV.keyDown('KeyW');
  for (let i = 0; i < 500; i++) gV.update(eV.tick(TICK), TICK);
  check('TPS: F gets in, then W is the gas pedal', gV.inVehicle && gV.car.speed > 12, `speed ${gV.car.speed.toFixed(1)} m/s, layers ${eV.activeLayers.join('+')}`);
  renderTps(viewCtx, new TpsGame(), view.width, view.height);
  check('TPS: canvas shows a rendered scene', sample() >= 6, `${sample()} distinct colors`);
  check('pointer lock API', 'requestPointerLock' in view);

  // Codec checks need real time (encoder and decoder run asynchronously), so they belong to the real-time
  // end-to-end run (`npm run e2e`), not to this synchronous self test.
  const pre = $<HTMLElement>('selftest');
  pre.hidden = false;
  pre.textContent = `${results.some((r) => r.startsWith('FAIL')) ? 'SELFTEST FAIL' : 'SELFTEST PASS'}\n${results.join('\n')}`;
}

// ---------------------------------------------------------------- codec checks and end-to-end run

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (!cond() && performance.now() < end) await sleep(20);
}

/** Real image and real H.264 data through the same player the console stream uses. */
async function codecChecks(check: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
  try {
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 36;
    const p = new VideoPlayer(cv);
    const oc = new OffscreenCanvas(64, 36);
    const o = oc.getContext('2d') as OffscreenCanvasRenderingContext2D;
    o.fillStyle = '#20c040';
    o.fillRect(0, 0, 64, 36);
    const png = new Uint8Array(await (await oc.convertToBlob({ type: 'image/png' })).arrayBuffer());
    p.push({ codec: CODEC.PNG, key: true, frameId: 1, inputSeq: 0, ptsMs: 0 }, png);
    await until(() => p.decoded >= 1, 3000);
    const px = (cv.getContext('2d') as CanvasRenderingContext2D).getImageData(5, 5, 1, 1).data;
    check('PNG frame decodes and draws', p.decoded === 1 && px[1]! > 150 && px[0]! < 90, `rgb ${px[0]},${px[1]},${px[2]}`);
  } catch (e) {
    check('PNG frame decodes and draws', false, String(e));
  }

  try {
    const w = 320;
    const h = 180;
    const chunks: { key: boolean; data: Uint8Array; ts: number }[] = [];
    let encError = '';
    const enc = new VideoEncoder({
      output: (c) => {
        const d = new Uint8Array(c.byteLength);
        c.copyTo(d);
        chunks.push({ key: c.type === 'key', data: d, ts: c.timestamp });
      },
      error: (e) => (encError = String(e)),
    });
    enc.configure({ codec: 'avc1.42001f', width: w, height: h, bitrate: 400_000, framerate: 30, avc: { format: 'annexb' }, latencyMode: 'realtime' });
    const oc = new OffscreenCanvas(w, h);
    const o = oc.getContext('2d') as OffscreenCanvasRenderingContext2D;
    for (let i = 0; i < 12; i++) {
      o.fillStyle = i < 6 ? '#d02020' : '#2030d0';
      o.fillRect(0, 0, w, h);
      const f = new VideoFrame(oc, { timestamp: i * 33333 });
      enc.encode(f, { keyFrame: i === 0 || i === 6 });
      f.close();
    }
    await enc.flush();
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const p = new VideoPlayer(cv);
    // Feed at roughly the pace a stream arrives. Pushing everything at once overruns the decoder queue,
    // which the player (correctly) answers by dropping frames and asking for a keyframe.
    for (const [i, c] of chunks.entries()) {
      p.push({ codec: CODEC.H264, key: c.key, frameId: i + 1, inputSeq: 0, ptsMs: c.ts / 1000 }, c.data);
      await sleep(15);
    }
    await until(() => p.decoded >= chunks.length, 4000);
    const px = (cv.getContext('2d') as CanvasRenderingContext2D).getImageData(10, 10, 1, 1).data;
    check(
      'H.264 from a real encoder decodes through the player (colour changes red to blue)',
      chunks.length >= 10 && p.decoded === chunks.length && px[2]! > px[0]! + 60,
      `${chunks.length} chunks, ${p.decoded} decoded, ${p.dropped} dropped, last pixel rgb ${px[0]},${px[1]},${px[2]}${encError ? `, encoder error ${encError}` : ''}${p.error ? `, player error ${p.error}` : ''}`,
    );
  } catch (e) {
    check('H.264 from a real encoder decodes through the player', false, String(e));
  }

  try {
    // Sound: a real Opus encoder makes a 440 Hz tone in 10 ms frames, as the console's frames are; they go through the
    // sound player (decode, schedule) and what reaches the sound card is measured: is it the tone, not silence or noise?
    const rate = 48000;
    const frameSize = 480;
    const frames: Uint8Array[] = [];
    let encError = '';
    const enc = new AudioEncoder({
      output: (c) => {
        const d = new Uint8Array(c.byteLength);
        c.copyTo(d);
        frames.push(d);
      },
      error: (e) => (encError = String(e)),
    });
    enc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 2, bitrate: 96_000, opus: { frameDuration: 10_000, application: 'lowdelay' } } as AudioEncoderConfig);
    const total = 60;
    for (let i = 0; i < total; i++) {
      const pcm = new Float32Array(frameSize * 2); // planar: left, then right
      for (let n = 0; n < frameSize; n++) {
        const v = 0.5 * Math.sin((2 * Math.PI * 440 * (i * frameSize + n)) / rate);
        pcm[n] = v;
        pcm[frameSize + n] = v;
      }
      const data = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: frameSize, numberOfChannels: 2, timestamp: i * 10_000, data: pcm });
      enc.encode(data);
      data.close();
    }
    await enc.flush();
    // A real audio context, wrapped to see each piece as it is handed to the sound card.
    const real = new AudioContext();
    const heard: Float32Array[] = [];
    const wrapped = {
      get currentTime() {
        return real.currentTime;
      },
      get state() {
        return real.state;
      },
      destination: real.destination,
      createBuffer: (c: number, l: number, r: number) => real.createBuffer(c, l, r),
      createGain: () => real.createGain(),
      createBufferSource: () => {
        const node = real.createBufferSource();
        const start = node.start.bind(node);
        node.start = (when?: number) => {
          if (node.buffer && node.buffer.length > 1) heard.push(Float32Array.from(node.buffer.getChannelData(0)));
          start(when);
        };
        return node;
      },
      resume: () => real.resume(),
      suspend: () => real.suspend(),
      close: () => real.close(),
    };
    const sound = new AudioPlayer({ createContext: () => wrapped as never });
    sound.unlock();
    await sound.start({ channels: 2, bits: 16, rate, frameSize });
    // At the pace a console sends them (10 ms a frame; a hair slower, so that nothing piles up and nothing is dropped,
    // which would break the wave and make the pitch measurement meaningless).
    for (const f of frames) {
      sound.push(false, f);
      await sleep(11);
    }
    await until(() => sound.stats.decoded >= frames.length || sound.stats.errors > 0, 3000);
    // The tone's strength (RMS of 0.5 sine is 0.354) and pitch (zero crossings in the pieces handed over).
    const flat = heard.flatMap((p) => [...p]);
    const rms = flat.length ? Math.sqrt(flat.reduce((s, x) => s + x * x, 0) / flat.length) : 0;
    let crossings = 0;
    for (let n = 1; n < flat.length; n++) if (flat[n - 1]! < 0 && flat[n]! >= 0) crossings++; // across the pieces' borders too
    const seconds = flat.length / rate;
    const hz = seconds > 0 ? crossings / seconds : 0;
    check(
      'Opus from a real encoder decodes through the sound player (a 440 Hz tone comes out, at the right strength)',
      frames.length >= total - 2 && sound.stats.decoded >= frames.length - 1 && sound.stats.errors === 0 && rms > 0.25 && rms < 0.45 && Math.abs(hz - 440) < 30,
      `${frames.length} frames, ${sound.stats.decoded} decoded, ${sound.stats.errors} errors, rms ${rms.toFixed(3)}, about ${hz.toFixed(0)} Hz${encError ? `, encoder error ${encError}` : ''}${sound.stats.reason ? `, ${sound.stats.reason}` : ''}`,
    );
    sound.destroy();
  } catch (e) {
    check('Opus from a real encoder decodes through the sound player', false, String(e));
  }
}

/** Real browser, real WebSocket, real bridge (driven by tools/e2e-browser.mjs). Reports back over the socket. */
async function runE2e(): Promise<void> {
  const lines: string[] = [];
  let pass = true;
  let frame = '';
  const check = (name: string, ok: boolean, detail = ''): void => {
    if (!ok) pass = false;
    lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  };
  try {
    setMode('console', false);
    client.connect(bridgeUrl.value, bridgeToken, consoleMac, chosenQuality(), false);
    await until(() => client.state === 'ready', 5000);
    check('connected and authenticated', client.state === 'ready', client.detail);

    engine.keyDown('KeyW'); // left stick up on the default profile
    engine.mouseButton(0, true); // R2
    for (let i = 0; i < 60; i++) {
      feedMouse(6, 2);
      await sleep(16);
    }
    await until(() => player.decoded >= 20, 4000);
    check('PNG video frames reach the canvas', player.decoded >= 20, `${player.decoded} decoded, ${player.dropped} dropped`);
    await until(() => client.inputLatencyMs > 0, 3000);
    check('input to picture latency measured', client.inputLatencyMs > 0 && client.inputLatencyMs < 500, `${client.inputLatencyMs.toFixed(0)} ms median`);
    await until(() => Number(client.serverStats.padsPerSecond) > 0, 3000);
    const last = client.serverStats.lastPad as { ly: number; r2: number; rx: number } | undefined;
    check('bridge saw W as stick up, left click as R2, mouse as right stick', !!last && last.ly < -30000 && last.r2 === 255 && last.rx !== 0, JSON.stringify(last));
    check('round trip time measured', client.rttMs > 0, `${client.rttMs.toFixed(1)} ms`);
    // Keep one frame the test double drew from the pad it received, so it can be looked at.
    frame = view.toDataURL('image/png');

    client.sendJson({ type: 'quality', preset: 'saver', fps: 15 });
    await sleep(2600);
    check('quality change takes effect (frame rate follows)', client.fpsIn >= 8 && client.fpsIn <= 20, `${client.fpsIn} fps received`);

    // Getting the PSN account id: the button stays off until the notice is accepted, then the pasted address is sent.
    const psnGo = $<HTMLButtonElement>('psnGo');
    check('the account id button is off until the notice is accepted', psnGo.disabled);
    $<HTMLInputElement>('psnAck').click();
    check('accepting the notice turns the button on', !psnGo.disabled);
    $<HTMLInputElement>('psnUrl').value = 'https://remoteplay.dl.playstation.net/remoteplay/redirect?code=E2ELoginCode-123&cid=x';
    psnGo.click();
    await until(() => (regMsg.textContent ?? '').includes('saved'), 12000); // generous: this is about the result, and a busy machine is slow
    check('the account id is fetched and saved through the page', (regMsg.textContent ?? '').includes('saved'), regMsg.textContent ?? '');
    check('the one-time login code is cleared from the page afterwards', $<HTMLInputElement>('psnUrl').value === '');

    // The registration form: fill it in like a person would and press the button (no account id typed: the saved one is used).
    $<HTMLInputElement>('regAddr').value = '192.168.1.50';
    $<HTMLInputElement>('regPin').value = '2468 0135';
    $<HTMLButtonElement>('regGo').click();
    await until(() => ($<HTMLElement>('regList').textContent ?? '').includes('E2E console'), 4000);
    check('registration form registers a console and lists it', ($<HTMLElement>('regList').textContent ?? '').includes('E2E console'), regMsg.textContent ?? '');
    check('the PIN is cleared from the page after the attempt', $<HTMLInputElement>('regPin').value === '');
    check('the registration key never reaches the page', !document.body.innerText.includes('00112233445566778899aabbccddeeff'));

    // The key layout editor: a row per pad control, a key added by pressing it, the press style changed with the select.
    const padRow = (label: string): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>('#keymap .keymap-row')].find((r) => r.querySelector('.keymap-pad')?.textContent === label);
    check('the key layout editor lists every pad control', document.querySelectorAll('#keymap .keymap-row').length >= 26, `${document.querySelectorAll('#keymap .keymap-row').length} rows`);
    check('the layout next to the picture names the keys', /Space/.test($<HTMLElement>('layoutList').textContent ?? '') && /Left click/.test($<HTMLElement>('layoutList').textContent ?? ''));
    padRow('□')?.querySelector<HTMLButtonElement>('.keymap-add')?.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', bubbles: true, cancelable: true }));
    await sleep(60);
    check('pressing a key after "+ Key" binds it to that button', profile.layers[0]!.bindings.KeyG === 'btn:box', String(profile.layers[0]!.bindings.KeyG));
    const how = [...(padRow('□')?.querySelectorAll<HTMLElement>('.keymap-binding') ?? [])].find((b) => b.querySelector('.keycap')?.textContent === 'G')?.querySelector<HTMLSelectElement>('select[aria-label="How the button is pressed"]');
    if (how) {
      how.value = 'tap';
      how.dispatchEvent(new Event('change'));
    }
    await sleep(60);
    check('the press style of a binding can be changed to a tap', profile.layers[0]!.bindings.KeyG === 'tap:box', String(profile.layers[0]!.bindings.KeyG));
    padRow('□')?.querySelector<HTMLButtonElement>('.keymap-add')?.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlLeft', bubbles: true, cancelable: true }));
    await sleep(60);
    check('a key the browser keeps for itself is refused with the reason', profile.layers[0]!.bindings.ControlLeft === undefined && /Ctrl/.test($<HTMLElement>('profileMsg').textContent ?? ''), $<HTMLElement>('profileMsg').textContent ?? '');
    // Saving under a name and getting it back.
    profileName.value = 'E2E game';
    $<HTMLButtonElement>('profileSave').click();
    useProfile(defaultProfile());
    check('a fresh layout no longer has the change', profile.layers[0]!.bindings.KeyG === undefined);
    profilePick.value = 'saved:E2E game';
    profilePick.dispatchEvent(new Event('change'));
    check('a saved profile comes back with its changes', profile.layers[0]!.bindings.KeyG === 'tap:box' && profile.game.name === 'E2E game', profile.game.name);
    useProfile(defaultProfile());
    // Switching profiles lets go of everything, as it should. The checks that follow expect W and the left button held.
    engine.keyDown('KeyW');
    engine.mouseButton(0, true);
    await sleep(200);

    // Playing by touch: the controls come up over the picture, and fingers reach the console side as pad input.
    engine.releaseAll();
    touchToggle.checked = true;
    touchToggle.dispatchEvent(new Event('change'));
    const layer = $<HTMLElement>('touchLayer');
    check('the touch controls come up while connected', !layer.hidden && document.body.classList.contains('touch-live') && layer.querySelectorAll('[data-c]').length === 18);
    const finger = (type: string, id: number, x: number, y: number): void => void layer.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const centre = (c: string): [number, number] => {
      const r = layer.querySelector<HTMLElement>(`[data-c="${c}"]`)!.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
    const seenPad = (): { buttons: number; ly: number; rx: number; r2: number } => (client.serverStats.lastPad ?? { buttons: 0, ly: 0, rx: 0, r2: 0 }) as { buttons: number; ly: number; rx: number; r2: number };
    finger('pointerdown', 21, ...centre('cross'));
    finger('pointerdown', 22, ...centre('r2'));
    finger('pointerdown', 23, innerWidth * 0.15, innerHeight * 0.75); // empty space on the left: the stick
    finger('pointermove', 23, innerWidth * 0.15, innerHeight * 0.75 - 70);
    await until(() => (seenPad().buttons & BUTTON.cross) !== 0 && seenPad().r2 === 255 && seenPad().ly < -30000, 2500);
    check('a finger on ✕ and on R2 and a thumb pushed up reach the console side', (seenPad().buttons & BUTTON.cross) !== 0 && seenPad().r2 === 255 && seenPad().ly < -30000, JSON.stringify(seenPad()));
    check('the pressed button is drawn as pressed and the stick is shown under the thumb', layer.querySelector('[data-c="cross"]')!.classList.contains('on') && !layer.querySelector<HTMLElement>('.tc-stick-base')!.hidden);
    let turned = 0;
    finger('pointerdown', 24, innerWidth * 0.6, innerHeight * 0.45); // empty space on the right: the camera
    for (let i = 1; i <= 20; i++) {
      finger('pointermove', 24, innerWidth * 0.6 + i * 6, innerHeight * 0.45);
      await sleep(16);
      turned = Math.max(turned, Math.abs(state.rightX));
    }
    check('dragging on the right turns the camera', turned > 0.05, `right stick up to ${turned.toFixed(2)}`);
    for (const id of [21, 22, 23, 24]) finger('pointerup', id, 0, 0);
    await until(() => seenPad().buttons === 0 && seenPad().r2 === 0 && Math.abs(seenPad().ly) < 2000, 2500);
    check('lifting the fingers lets go of everything', seenPad().buttons === 0 && seenPad().r2 === 0 && Math.abs(seenPad().ly) < 2000, JSON.stringify(seenPad()));
    touchToggle.checked = false;
    touchToggle.dispatchEvent(new Event('change'));
    check('turning the touch controls off puts the page back', layer.hidden && !document.body.classList.contains('touch-live'));

    // The controls over the picture and the rest of the interface (player-ui.ts, app.ts).
    const click = (id: string): void => $<HTMLButtonElement>(id).click();
    const toasts = (): string => document.getElementById('toasts')?.textContent ?? '';
    check('the bar over the picture is up while connected', !$<HTMLElement>('hud').hidden && $<HTMLElement>('ps5Stage').dataset.live === 'true');
    click('hudStats');
    await sleep(50);
    check('the stats button opens the connection panel', !$<HTMLElement>('statsPanel').hidden && $<HTMLElement>('hudStats').getAttribute('aria-pressed') === 'true');
    click('hudStats');
    // The mouse feel: a panel of its own on the left, the starting points and sliders change the profile the settings page shows.
    click('hudFeel');
    await sleep(50);
    check('the mouse feel button opens its panel, in the place of the others on the left', !$<HTMLElement>('feelPanel').hidden && $<HTMLElement>('statsPanel').hidden && $<HTMLElement>('hudFeel').getAttribute('aria-pressed') === 'true');
    const sensBefore = profile.mouse.degPerCount;
    const sharp = document.querySelector<HTMLButtonElement>('#feelPresets [data-preset="sharp"]');
    sharp?.click();
    check('"Crisp" takes away the smoothing', profile.mouse.smoothingMs === 0 && profile.mouse.smoothingFadeRate === 0 && profile.mouse.carryMs === 300 && sharp?.getAttribute('aria-pressed') === 'true', `${profile.mouse.smoothingMs} ${profile.mouse.carryMs}`);
    check('and the settings page shows the same numbers', $<HTMLInputElement>('smoothingMs').value === '0' && $<HTMLInputElement>('carryMs').value === '300');
    const qs = $<HTMLInputElement>('qSens');
    qs.value = '0.07';
    qs.dispatchEvent(new Event('input'));
    check('the sensitivity slider changes the profile (and its number)', profile.mouse.degPerCount === 0.07 && $<HTMLOutputElement>('q_sens').textContent === '0.070' && $<HTMLOutputElement>('o_degPerCount').textContent === '0.070', String(profile.mouse.degPerCount));
    document.querySelector<HTMLButtonElement>('#feelPresets [data-preset="balanced"]')?.click();
    check('"Balanced" fades the smoothing out with speed, and the settings page shows it', profile.mouse.smoothingMs === 12 && profile.mouse.smoothingFadeRate === 40 && $<HTMLInputElement>('smoothingFadeRate').value === '40' && $<HTMLInputElement>('qFade').value === '40');
    document.querySelector<HTMLButtonElement>('#feelPresets [data-preset="smooth"]')?.click();
    mouseFeel.set({ degPerCount: sensBefore });
    check('the feel can be put back as it was', profile.mouse.smoothingMs === 12 && profile.mouse.smoothingFadeRate === 0 && profile.mouse.carryMs === 300 && profile.mouse.degPerCount === sensBefore);
    const delayBtn = (v: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`#feelDelay [data-playout="${v}"]`)!;
    delayBtn('immediate').click();
    check('"Lowest delay" in the panel is the same choice as in the options', $<HTMLSelectElement>('playoutMode').value === 'immediate' && player.playout.mode === 'immediate' && delayBtn('immediate').getAttribute('aria-pressed') === 'true' && delayBtn('smooth').getAttribute('aria-pressed') === 'false');
    delayBtn('smooth').click();
    check('and back to smooth', $<HTMLSelectElement>('playoutMode').value === 'smooth' && player.playout.mode === 'smooth');
    await sleep(1200);
    check('the panel shows the delay in numbers', /Display \+\d+ ms/.test($<HTMLElement>('q_delay').textContent ?? ''), $<HTMLElement>('q_delay').textContent ?? '');
    // The measuring is started from the settings; its buttons and its words are repeated in the panel.
    const calStatus = $<HTMLElement>('consoleCalibrateStatus');
    const calWas = calStatus.textContent;
    calStatus.textContent = 'test words';
    await sleep(30);
    check('the words of the game measuring are repeated in the panel', $<HTMLElement>('feelCalStatus').textContent === 'test words', $<HTMLElement>('feelCalStatus').textContent ?? '');
    calStatus.textContent = calWas;
    const calApply = $<HTMLButtonElement>('consoleCalibrateApply');
    const applyWas = calApply.hidden;
    calApply.hidden = false;
    await sleep(30);
    check('and so is the button that applies the result', !$<HTMLButtonElement>('feelCalApply').hidden);
    calApply.hidden = applyWas;
    click('hudFeel');
    check('the panel closes with its button', $<HTMLElement>('feelPanel').hidden);

    // The study of the feel: candidates one after another, a score for each, kept here and on the server. Nothing in this page can lock
    // the mouse, so the time with it in the game's hands is given to the meter by hand.
    const knobsNow = (): string => describeKnobs({ smoothingMs: profile.mouse.smoothingMs, smoothingFadeRate: profile.mouse.smoothingFadeRate, carryMs: profile.mouse.carryMs, curve: profile.mouse.curve });
    const feelBefore = knobsNow();
    const sensStudy = profile.mouse.degPerCount;
    const playFor = (seconds: number): void => trialMeter.tick(seconds, 0, 0, profile.mouse.degPerCount, true);
    type Kept = Array<{ id: string; preset: string; score: number; flags: Record<string, number>; scene: string | null; feel: { degPerCount: number } }>;
    const keptNow = (): Kept => JSON.parse(localStorage.getItem('gtp.study.ratings') ?? '[]') as Kept;
    const sentNow = (): string[] => JSON.parse(localStorage.getItem('gtp.study.sent') ?? '[]') as string[];
    const stripEl = document.querySelector<HTMLElement>('.study-strip')!;
    const release = (...codes: string[]): void => codes.forEach((code) => window.dispatchEvent(new KeyboardEvent('keyup', { code })));
    localStorage.removeItem('gtp.study.ratings');
    const study = (await import('./study-ui.ts')).study;
    click('hudStudy');
    check('the study panel opens (and the feel panel is closed)', !$<HTMLElement>('studyPanel').hidden && $<HTMLElement>('feelPanel').hidden);
    check('it explains the way and has one Start button', !!document.getElementById('studyStart') && /Start locks/.test($<HTMLElement>('studyBody').textContent ?? ''));
    [...document.querySelectorAll<HTMLButtonElement>('#studyBody .study-chip')].find((b) => b.textContent === 'Gun aiming')?.click();
    click('studyStart');
    check('Start puts the first candidate in force and the panel away, and the strip over the picture shows its number but not its values', $<HTMLElement>('studyPanel').hidden && !stripEl.hidden && stripEl.textContent?.includes('#01') === true && knobsNow() === describeKnobs(ROUND_1.candidates[0]!.set) && !stripEl.textContent?.includes('Smoothing 6'), `${stripEl.hidden} ${stripEl.textContent} ${knobsNow()}`);
    study.key('Digit7');
    check('a score given before there has been time with the mouse is not kept yet', keptNow().length === 0 && /noted/.test(stripEl.textContent ?? ''), stripEl.textContent ?? '');
    playFor(9);
    await until(() => keptNow().length === 1, 3000);
    check('it is saved by itself once there has been, with the scene and the sensitivity, and the next candidate is in force', keptNow().length === 1 && keptNow()[0]!.preset === 'r1-01' && keptNow()[0]!.score === 7 && keptNow()[0]!.scene === 'aim' && keptNow()[0]!.feel.degPerCount === sensStudy && stripEl.textContent?.includes('#02') === true && knobsNow() === describeKnobs(ROUND_1.candidates[1]!.set), JSON.stringify(keptNow()));
    release('Digit7');
    study.key('KeyH');
    check('"H" marks stopping as off, and the strip shows it', document.querySelector('.ss-chip[data-on="true"]')?.textContent?.includes('Stopping') === true);
    playFor(9);
    study.key('Digit4');
    check('with the time there, one key scores and moves on at once, with the mark', keptNow().length === 2 && keptNow()[1]!.preset === 'r1-02' && keptNow()[1]!.score === 4 && keptNow()[1]!.flags.stop === -1 && stripEl.textContent?.includes('#03') === true, JSON.stringify(keptNow()));
    release('Digit4', 'KeyH');
    await until(() => sentNow().length === 2, 5000);
    check('both ratings have reached the server', sentNow().length === 2, JSON.stringify(sentNow()));
    study.key('BracketLeft');
    check('"[" takes back the last score: it is dropped and that candidate is back, with its values in force', keptNow().length === 1 && stripEl.textContent?.includes('#02') === true && knobsNow() === describeKnobs(ROUND_1.candidates[1]!.set), JSON.stringify(keptNow()));
    study.key('BracketLeft');
    check('a key that is held counts once (a second undo would take back the first rating too)', keptNow().length === 1 && stripEl.textContent?.includes('#02') === true);
    release('BracketLeft');
    playFor(9);
    study.key('Digit9');
    check('rating it again keeps a new rating without the old mark', keptNow().length === 2 && keptNow()[1]!.score === 9 && keptNow()[1]!.flags.stop === undefined && stripEl.textContent?.includes('#03') === true, JSON.stringify(keptNow()));
    release('Digit9');
    study.key('BracketRight');
    check('"]" skips the candidate', stripEl.textContent?.includes('#04') === true && keptNow().length === 2);
    release('BracketRight');
    study.key('BracketLeft');
    check('and "[" takes the skip back', stripEl.textContent?.includes('#03') === true && keptNow().length === 2);
    release('BracketLeft');
    await until(() => keptNow().length === 2 && keptNow().every((r) => sentNow().includes(r.id)) && sentNow().length === 2, 5000);
    check('what was scored and kept is what the server has, the score that was taken back included', keptNow().every((r) => sentNow().includes(r.id)) && sentNow().length === 2, JSON.stringify(sentNow()));
    click('hudStudy');
    check('the list shows what was scored', document.querySelectorAll('#studyBody .study-list li').length === 2);
    click('studyReport');
    await until(() => /Analysis of/.test($<HTMLElement>('studyReportText').textContent ?? ''), 8000);
    // Both tries had 9 s with the mouse, so both count.
    check('the analysis comes back from its worker, in the language of the page', /Analysis of 2 ratings/.test($<HTMLElement>('studyReportText').textContent ?? ''), $<HTMLElement>('studyReportText').textContent ?? '');
    click('studyReportClose');
    click('studyEnd');
    check('finishing puts the earlier values back, leaves the sensitivity, and takes the strip away', knobsNow() === feelBefore && profile.mouse.degPerCount === sensStudy && !document.getElementById('studyResume') && stripEl.hidden, knobsNow());
    click('hudStudy');
    check('the study panel closes with its button', $<HTMLElement>('studyPanel').hidden);
    // Start asked for the mouse, which gives the picture the keyboard; nothing locked it here (that is what lets go of it), so it is let go by hand.
    view.blur();
    const pumps0 = inputLoop.pumps;
    await sleep(500);
    check('the input runs on its own timer, faster than the 60 Hz drawing', inputLoop.pumps - pumps0 >= 40, `${inputLoop.pumps - pumps0} in 500 ms`);
    click('hudOpts');
    await sleep(50);
    check('the options move into the player while its panel is open (in reach in full screen)', $<HTMLElement>('optPanelSlot').contains($<HTMLElement>('qualityPreset')) && !$<HTMLElement>('optSlot').contains($<HTMLElement>('qualityPreset')));
    const bright = $<HTMLInputElement>('lookBrightness');
    bright.value = '120';
    bright.dispatchEvent(new Event('input'));
    check('the picture look reaches the picture (brightness 120)', view.style.filter.includes('brightness(120%)'), view.style.filter);
    click('lookReset');
    check('and goes back to nothing at all when reset', view.style.filter === 'none', view.style.filter);
    click('hudOpts');
    check('the options go back to their card when the panel closes', $<HTMLElement>('optSlot').contains($<HTMLElement>('qualityPreset')) && $<HTMLElement>('optPanel').hidden);
    click('hudShot');
    await until(() => toasts().includes('Screenshot'), 4000);
    check('a screenshot is made and said so', toasts().includes('Screenshot saved'), toasts());
    if (typeof MediaRecorder !== 'undefined' && typeof view.captureStream === 'function') {
      click('hudRecBtn');
      await sleep(1500);
      check('recording shows its mark while it runs', !$<HTMLElement>('hudRec').hidden && $<HTMLButtonElement>('hudRecBtn').getAttribute('aria-pressed') === 'true');
      click('hudRecBtn');
      await until(() => toasts().includes('Recording saved'), 6000);
      check('a clip is saved when the recording ends', toasts().includes('Recording saved') && $<HTMLElement>('hudRec').hidden, toasts());
    }
    const soundBefore = soundToggle.checked;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', bubbles: true, cancelable: true }));
    check('M mutes when the game does not have the mouse', soundToggle.checked !== soundBefore);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', bubbles: true, cancelable: true }));
    check('and unmutes', soundToggle.checked === soundBefore);
    click('hudFull');
    await sleep(400);
    // A headless browser has no person to have asked, so the real full screen may be refused: then the player covers the window.
    const covered = document.fullscreenElement !== null || document.body.classList.contains('stage-full');
    check('the full screen button puts the player over the whole screen', covered && $<HTMLButtonElement>('hudFull').getAttribute('aria-pressed') === 'true', document.fullscreenElement ? 'browser full screen' : 'covering the window');
    click('hudFull');
    await sleep(400);
    check('and the same button brings the page back', document.fullscreenElement === null && !document.body.classList.contains('stage-full') && $<HTMLButtonElement>('hudFull').getAttribute('aria-pressed') === 'false');
    click('themeBtn');
    const t1 = document.documentElement.dataset.theme;
    click('themeBtn');
    const t2 = document.documentElement.dataset.theme;
    click('themeBtn');
    check('the colour button goes light, dark, then back to the device', t1 === 'light' && t2 === 'dark' && document.documentElement.dataset.theme === undefined, `${t1} ${t2} ${document.documentElement.dataset.theme}`);
    // The language: English until Korean is chosen. The words in the page, the ones the code draws, and the ones that are drawn once
    // and kept all follow, and nothing the page said is without its Korean.
    const navLab = (): string => document.querySelector('.nav [data-view="lab"] span')?.textContent ?? '';
    clearMissing();
    check('the page is in English by default', getLang() === 'en' && document.documentElement.lang === 'en' && navLab() === 'Practice range', navLab());
    click('langBtn');
    check('the language button turns the page Korean: words, attributes and the language of the page', getLang() === 'ko' && document.documentElement.lang === 'ko' && navLab() === translate('ko', 'Practice range') && localStorage.getItem('gtp.lang') === 'ko' && $<HTMLElement>('hudStudy').title === translate('ko', 'Mouse feel study: try settings and score them (L)'), `${navLab()} ${$<HTMLElement>('hudStudy').title}`);
    check('the button now offers the other language', $<HTMLElement>('langBtn').textContent === 'English' && document.querySelector('[data-lang-choice="ko"]')?.getAttribute('aria-pressed') === 'true');
    for (const id of ['hudStats', 'hudKeys', 'hudFeel', 'hudOpts']) {
      click(id);
      await sleep(30);
      click(id);
    }
    click('hudStudy');
    check('the study panel is drawn in Korean', ($<HTMLElement>('studyBody').textContent ?? '').includes(translate('ko', 'Start')) && !/Start locks/.test($<HTMLElement>('studyBody').textContent ?? ''), $<HTMLElement>('studyBody').textContent ?? '');
    click('studyStart');
    await sleep(60);
    const stripKo = document.querySelector<HTMLElement>('.study-strip')!;
    check('and so is the strip over the picture while it runs', (stripKo.textContent ?? '').includes(translate('ko', 'Slow aim')) && /[\uAC00-\uD7A3]/.test(stripKo.textContent ?? ''), stripKo.textContent ?? '');
    click('hudStudy');
    click('studyEnd');
    click('hudStudy');
    view.blur();
    const shortcuts = $<HTMLDialogElement>('shortcutsDialog');
    shortcuts.showModal();
    check('the shortcuts are in Korean', (shortcuts.textContent ?? '').includes(translate('ko', 'Shortcuts')), shortcuts.textContent?.slice(0, 80) ?? '');
    shortcuts.close();
    check('nothing the page said had no Korean', missingKeys().length === 0, missingKeys().join(' | '));
    click('langBtn');
    check('and back: the button turns the page English again', getLang() === 'en' && document.documentElement.lang === 'en' && navLab() === 'Practice range' && $<HTMLElement>('langBtn').textContent === LANG_NAMES.ko && localStorage.getItem('gtp.lang') === 'en', navLab());
    engine.keyDown('KeyW');
    engine.mouseButton(0, true);
    await sleep(200);

    const codecLines: string[] = [];
    await codecChecks((name, ok, detail) => {
      if (!ok) pass = false;
      codecLines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    });
    lines.push(...codecLines);
  } catch (e) {
    check('run completed', false, String(e));
  }
  // The bridge accepts messages up to 64 KB, so only send the picture if it fits.
  client.sendJson({ type: 'e2e', pass, lines, frame: frame.length < 60000 ? frame : '' });
}

/**
 * Connect to the console, wait for decoded frames, and send a small picture of the canvas back to the bridge
 * (driven by tools/snap-console.mjs). For checking the real picture path in a real browser.
 *
 * It sends no input, unless asked with ?nudge=1: then it presses the d-pad down once and up once through the same
 * path a key press takes (ArrowDown and ArrowUp on the default profile), and takes a picture before, between and
 * after. One step down and one step back: enough to see the console react, and the selection ends where it began.
 */
async function runSnap(): Promise<void> {
  const lines: string[] = [];
  const frames: string[] = [];
  let pass = false;
  const small = document.createElement('canvas');
  small.width = 480;
  small.height = 270;
  const smallCtx = small.getContext('2d', { willReadFrequently: true })!;
  const shot = (): Uint8ClampedArray => {
    smallCtx.drawImage(view, 0, 0, small.width, small.height);
    frames.push(small.toDataURL('image/jpeg', 0.55));
    return smallCtx.getImageData(0, 0, small.width, small.height).data;
  };
  /** Share of pixels that differ clearly between two pictures, in percent. */
  const changed = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 48) n++;
    return (n / (a.length / 4)) * 100;
  };
  try {
    setMode('console', false);
    connectConsole();
    await until(() => client.state === 'ready' || client.state === 'closed', 25000);
    lines.push(`link state: ${client.state}${client.detail ? ` (${client.detail})` : ''}`);
    await until(() => player.decoded >= 45, 15000);
    lines.push(`frames decoded ${player.decoded}, dropped ${player.dropped}, received ${client.fpsIn} fps / ${client.kbpsIn} kbit/s`);
    lines.push(`canvas ${view.width}x${view.height}`);
    pass = player.decoded > 0;
    const before = shot();
    // ?latency=N: from an input to the picture changing, N times. A d-pad press down, then up, and so on, on a screen
    // where that moves a selection (a menu): the time until the first shown frame that differs from the one before
    // the press. It contains everything a person waits for except the display's own scan-out: the page's input loop,
    // the way to the console and back, the console itself, decoding and the playout delay.
    const tries = Number(params.get('latency') ?? 0);
    if (tries > 0 && pass) {
      const probe = document.createElement('canvas');
      probe.width = 96;
      probe.height = 54;
      const probeCtx = probe.getContext('2d', { willReadFrequently: true })!;
      const grab = (): Uint8ClampedArray => {
        probeCtx.drawImage(view, 0, 0, probe.width, probe.height);
        return probeCtx.getImageData(0, 0, probe.width, probe.height).data;
      };
      const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
      const times: number[] = [];
      let missed = 0;
      for (let i = 0; i < tries; i++) {
        await sleep(700 + Math.random() * 300); // let the picture settle, and do not always start at the same moment of a frame
        const base = grab();
        let noise = 0;
        for (let k = 0; k < 6; k++) {
          await nextFrame();
          noise = Math.max(noise, changed(base, grab()));
        }
        const code = i % 2 === 0 ? 'ArrowDown' : 'ArrowUp';
        const t0 = performance.now();
        engine.keyDown(code);
        setTimeout(() => engine.keyUp(code), 100);
        let t1 = 0;
        while (performance.now() - t0 < 2000) {
          await nextFrame();
          if (changed(base, grab()) > noise + 0.4) {
            t1 = performance.now();
            break;
          }
        }
        if (t1 > 0) times.push(t1 - t0);
        else missed++;
      }
      times.sort((a, b) => a - b);
      const at = (p: number): string => (times.length ? times[Math.min(times.length - 1, Math.floor(p * times.length))]!.toFixed(0) : '-');
      lines.push(`input to picture, ${times.length} of ${tries} presses seen: median ${at(0.5)} ms, fastest ${at(0)} ms, 90% within ${at(0.9)} ms, slowest ${at(0.999)} ms${missed ? ` (${missed} presses changed nothing: is this a screen where the d-pad moves something?)` : ''}`);
      lines.push(`  with playout '${player.playout.mode}', delay in use ${player.playout.delayMs.toFixed(0)} ms; the page's own round trip to the bridge ${client.rttMs.toFixed(0)} ms`);
    }
    // ?watch=N: keep watching for N seconds. The page reports what went on the screen to the bridge once a second.
    const watch = Number(params.get('watch') ?? 0);
    if (watch > 0 && pass) {
      await sleep(watch * 1000);
      lines.push(`watched ${watch} s with playout '${player.playout.mode}'${player.playoutOptions.fixedDelayMs !== undefined ? ' (fixed delay)' : ''}: delay in use ${player.playout.delayMs.toFixed(1)} ms, frame interval ${player.playout.intervalMs.toFixed(3)} ms, latest frame in the last minute ${player.playout.worstLateMs.toFixed(1)} ms late`);
      lines.push(`hitches seen on the screen: ${hitchesSeen}; frames decoded ${player.decoded}, dropped ${player.dropped}`);
    }
    if (params.has('nudge') && pass) {
      const tap = async (code: string): Promise<void> => {
        engine.keyDown(code);
        await sleep(120);
        engine.keyUp(code);
        await sleep(1200);
      };
      await sleep(600);
      const still = shot();
      frames.pop();
      await tap('ArrowDown');
      const moved = shot();
      await tap('ArrowUp');
      const back = shot();
      const noise = changed(before, still);
      const down = changed(still, moved);
      const returned = changed(still, back);
      lines.push(`picture change with no input: ${noise.toFixed(2)}% of pixels`);
      lines.push(`after d-pad down: ${down.toFixed(2)}% of pixels changed`);
      lines.push(`after d-pad up again: ${returned.toFixed(2)}% differ from the start`);
      const reacted = down > noise + 0.3 && returned < down / 2;
      lines.push(reacted ? 'ok   the console reacted to the input, and the selection went back' : 'FAIL no clear reaction to the input in the picture');
      pass = reacted;
    }
  } catch (e) {
    lines.push(`error: ${String(e)}`);
  }
  const fits = frames.reduce((n, f) => n + f.length, 0) < 56000;
  client.sendJson({ type: 'e2e', pass, lines, frames: fits ? frames : frames.slice(0, 1) });
}

// ?touchpreview=1 shows the touch controls without a console, for looking at the layout on a phone or in a small window.
if (params.has('touchpreview')) touch.show(true);
if (params.has('snap')) void runSnap();
/**
 * ?e2e=look: the measuring of a game's response to the right stick (calibrate-console.ts), driven through its panel
 * against a made-up game behind the bridge (tools/e2e-look.mjs). Reports what the panel found and what it put in the profile.
 */
async function runLookE2e(): Promise<void> {
  const lines: string[] = [];
  let pass = true;
  const check = (name: string, ok: boolean, detail = ''): void => {
    if (!ok) pass = false;
    lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  };
  const win = window as unknown as { __lastCalibration?: unknown };
  const text = (id: string): string => $<HTMLElement>(id).textContent ?? '';
  let result: unknown = null;
  let applied: unknown = null;
  try {
    setMode('console', false);
    client.connect(bridgeUrl.value, bridgeToken, consoleMac, chosenQuality(), false);
    await until(() => client.state === 'ready', 5000);
    await until(() => player.decoded >= 20, 8000);
    check('connected, and the picture arrives', client.state === 'ready' && player.decoded >= 20, `${player.decoded} frames`);
    $<HTMLButtonElement>('consoleCalibrate').click();
    check('the panel started the measurement', $<HTMLButtonElement>('consoleCalibrate').disabled && !$<HTMLButtonElement>('consoleCalibrateStop').hidden);
    await until(() => win.__lastCalibration !== undefined || (!$<HTMLButtonElement>('consoleCalibrate').disabled && text('consoleCalibrateStatus') !== ''), 150000);
    result = win.__lastCalibration ?? null;
    check('the measurement finished', result !== null, text('consoleCalibrateStatus'));
    check('the panel shows the result and a picture of the table', text('consoleCalibrateResult').includes('dead zone') && $<HTMLElement>('consoleCalibratePlot').innerHTML.includes('<polyline'));
    check('the pad is the keyboard\'s and mouse\'s again afterwards', !$<HTMLButtonElement>('consoleCalibrate').disabled && $<HTMLButtonElement>('consoleCalibrateStop').hidden);
    const before = JSON.stringify(profile.calibration);
    $<HTMLButtonElement>('consoleCalibrateApply').click();
    applied = { calibration: profile.calibration, inGame: profile.inGame };
    check('"apply" puts the table in the profile', profile.calibration.horizontal !== null && JSON.stringify(profile.calibration) !== before);
    const valid = validateProfile(JSON.parse(JSON.stringify(profile)));
    check('and the profile still passes its own validation', valid.ok, valid.ok ? '' : valid.errors.join('; '));
  } catch (e) {
    check('no error', false, String(e));
  }
  client.sendJson({ type: 'e2e', pass, lines, result, applied, status: text('consoleCalibrateStatus') });
}

if (params.get('e2e') === 'look') void runLookE2e();
else if (params.has('e2e')) void runE2e();
if (params.has('autoconnect') && mode === 'console') connectConsole();

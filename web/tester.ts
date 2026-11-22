// SPDX-License-Identifier: AGPL-3.0-only
//
// Test bed page: real keyboard and mouse -> MappingEngine -> virtual pad -> a pad-only game
// (a small FPS, or a GTA V style third-person game). The games never see a keyboard or a mouse.
// Everything runs on a fixed 250 Hz clock.

import { MappingEngine } from '../src/engine/engine.ts';
import { defaultProfile, gtaProfile, parseProfileText, PRESETS, validateProfile, type Profile } from '../src/engine/profile.ts';
import { BUTTON, BUTTON_NAMES, type VirtualPadState } from '../src/engine/types.ts';
import { FpsGame, defaultGameSettings } from '../src/testbed/fps.ts';
import { applyMeasuredCalibration, measureCalibration, type GameFactory } from '../src/testbed/measure.ts';
import { renderGame } from '../src/testbed/render.ts';
import { TpsGame, defaultTpsSettings } from '../src/testbed/tps.ts';
import { renderTps } from '../src/testbed/tpsrender.ts';
import { CODEC } from '../src/bridge/protocol.ts';
import { QUALITY_PRESETS, megabytesPerHour, type QualityPreset } from '../src/bridge/quality.ts';
import { BridgeClient } from './bridge-client.ts';
import { describeLayout, mountKeymap } from './keymap.ts';
import { mountTouch, prefersTouch } from './touch.ts';
import { AudioPlayer } from './audio-player.ts';
import { VideoPlayer } from './video-player.ts';

const TICK = 0.004;
type Mode = 'fps' | 'tps' | 'console';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const view = $<HTMLCanvasElement>('game');
const viewCtx = view.getContext('2d') as CanvasRenderingContext2D;
const padCanvas = $<HTMLCanvasElement>('pad');
const ctx = padCanvas.getContext('2d') as CanvasRenderingContext2D;
const params = new URLSearchParams(location.search);

const modeParam = params.get('mode');
// The console is the main thing; the test games live in the "연습장" view and are chosen with ?mode=fps or ?mode=tps.
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
let lockNote = '해제됨';

// Rotation measurement: mouse counts fed since the mark vs. degrees the game actually turned.
let measureCounts = 0;
let yawMark = 0;

function resetMeasure(): void {
  measureCounts = 0;
  yawMark = active().yawTotal;
}

function feedMouse(dx: number, dy: number): void {
  engine.mouseMove(dx, dy);
  measureCounts += dx;
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

function message(text: string, kind: '' | 'error' | 'ok'): void {
  const el = $<HTMLElement>('profileMsg');
  el.textContent = text;
  el.className = `msg ${kind}`;
}

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
    message(
      mode === 'tps'
        ? 'GTA V 스타일 프로필을 불러왔습니다 (Shift = X 자동 연타, F = 탑승 + 차량 조작 전환).'
        : '1인칭 FPS 기본 프로필을 불러왔습니다.',
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
  $<HTMLElement>('qualityNote').textContent = `${q.width}×${q.height} ${q.fps}fps ${q.bitrateKbps}kbps ≈ ${megabytesPerHour(q.bitrateKbps).toFixed(0)}MB/시간`;
};
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
const say = (text: string, kind: 'ok' | 'err' | '' = ''): void => {
  regMsg.textContent = text;
  regMsg.dataset.kind = kind;
};
const REG_HINT: Record<string, string> = {
  'account-id-needed': '처음 한 번은 PSN 계정 ID가 필요합니다.',
  rejected: '콘솔이 거부했습니다. 코드가 틀렸거나 바뀌었는지, 계정 ID가 맞는지 확인하세요. 기기 연결 화면의 코드를 다시 확인하고 새로 입력해 보세요.',
  refused: '콘솔이 연결을 거절했습니다. 콘솔의 기기 연결 화면을 연 채로 다시 시도하세요.',
  timeout: '콘솔이 응답하지 않습니다. 켜져 있는지, 기기 연결 화면이 열려 있는지, 같은 네트워크인지 확인하세요.',
  'not-found': '그 주소에서 콘솔이 응답하지 않습니다.',
};

/** Why a call to the bridge's /api/ did not work, in words that say what to do. `null` means no answer at all. */
export function whyNoApi(r: { status: number; data: Record<string, any> } | null): string {
  if (!r) return `이 주소(${location.host})의 서버에 연결하지 못했습니다. 브리지가 켜져 있는지 확인하세요.`;
  if (r.status === 404) return `이 주소(${location.host})는 브리지가 아니라 파일만 내보내는 다른 서버로 보입니다. 터미널에서 npm run dev 를 실행하고, 그 화면에 찍힌 주소로 여세요.`;
  if (r.status === 401) return '브리지가 토큰을 요구합니다. 브리지가 출력한 주소(#token=…)로 여세요.';
  if (r.status === 403 || r.status === 421) return '브리지가 이 주소로 온 접속을 거부했습니다. 브리지가 출력한 주소(보통 http://127.0.0.1:포트/)로 여세요.';
  return `브리지가 오류를 돌려줬습니다 (HTTP ${r.status}${r.data.message ? `: ${r.data.message}` : ''}).`;
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
    li.textContent = `${c.nickname || '(이름 없음)'} · ${c.target} · ${c.host} · ${c.mac}  `;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '삭제';
    del.addEventListener('click', () => void api('DELETE', `/api/consoles/${encodeURIComponent(c.mac)}`).then(refreshRegistered));
    li.append(del);
    list.append(li);
  }
  if (consoles.length === 0) {
    const li = document.createElement('li');
    li.textContent = '아직 없습니다.';
    list.append(li);
  }
  $<HTMLElement>('regAccountNote').textContent = r.data.accountIdSaved ? '(저장된 값을 사용합니다. 바꾸려면 새로 입력)' : '(숫자 또는 Base64. 처음 한 번만 필요)';
  document.dispatchEvent(new CustomEvent('gtp:consoles'));
}

$<HTMLButtonElement>('regScan').addEventListener('click', async () => {
  say('찾는 중…');
  const r = await api('GET', '/api/discover').catch(() => null);
  const select = $<HTMLSelectElement>('regHost');
  select.textContent = '';
  if (!r || !r.ok) return say(`콘솔을 찾지 못했습니다. ${whyNoApi(r)}`, 'err');
  const hosts = (r.data.hosts ?? []) as Array<{ address: string; name: string; type: string; state: string; registered: boolean }>;
  for (const h of hosts) {
    const o = document.createElement('option');
    o.value = h.address;
    o.textContent = `${h.name || h.type} (${h.address}) · ${h.state === 'ready' ? '켜짐' : '대기 중'} · ${h.registered ? '등록됨' : '미등록'}`;
    select.append(o);
  }
  if (hosts.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '(찾지 못함)';
    select.append(o);
    return say('콘솔이 응답하지 않습니다. 콘솔이 켜져 있고 같은 네트워크인지 확인하고, IP 주소를 직접 입력해도 됩니다.', 'err');
  }
  $<HTMLInputElement>('regAddr').value = hosts[0]!.address;
  say(hosts.some((h) => h.state !== 'ready') ? '대기 모드인 콘솔이 있습니다. 등록하려면 콘솔을 켜세요.' : `${hosts.length}대 찾았습니다.`, 'ok');
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
  'acknowledge-needed': '안내를 확인하고 체크해야 합니다.',
  'invalid-input': '붙여넣은 값이 맞지 않습니다. 로그인 후 “redirect”라고 뜬 페이지의 주소창 주소 전체를 복사하세요.',
  'login-rejected': 'Sony가 로그인 코드를 받아들이지 않았습니다. 코드는 한 번만 쓸 수 있고 금방 만료됩니다. 다시 로그인해서 새 주소를 붙여넣으세요.',
  network: 'Sony에 연결하지 못했습니다. 인터넷 연결을 확인하세요.',
  'too-many': '시도가 너무 많습니다. 1분 뒤에 다시 하세요.',
};
$<HTMLButtonElement>('psnGo').addEventListener('click', async () => {
  const urlInput = $<HTMLInputElement>('psnUrl');
  const button = $<HTMLButtonElement>('psnGo');
  if (!urlInput.value.trim()) return say('로그인 후 나온 페이지의 주소를 붙여넣으세요.', 'err');
  const pasted = urlInput.value;
  urlInput.value = ''; // the one-time code leaves the page the moment it is sent, not after the answer
  button.disabled = true;
  say('Sony에서 계정 ID를 가져오는 중…');
  try {
    const r = await api('POST', '/api/psn/account-id', { redirectUrl: pasted, acknowledge: $<HTMLInputElement>('psnAck').checked });
    if (r.ok) {
      say(`계정 ID를 가져와 저장했습니다 (끝 4자리 ${String(r.data.hint ?? '')}). 이제 코드만 입력하고 등록하세요.`, 'ok');
      await refreshRegistered();
    } else {
      say(`${PSN_HINT[String(r.data.error ?? '')] ?? '가져오지 못했습니다.'}${r.data.message ? ` (${r.data.message})` : ''}`, 'err');
    }
  } catch {
    say('브리지에 연결하지 못했습니다.', 'err');
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
  if (!address) return say('콘솔 IP 주소를 입력하거나 “콘솔 찾기”를 누르세요.', 'err');
  if (!/^\d{8}$/.test(pin)) return say('코드는 콘솔에 표시된 8자리 숫자입니다.', 'err');
  const body: Record<string, string> = { host: address, pin };
  pinInput.value = ''; // a PIN is single use: off the page as soon as it is sent
  if (accountInput.value.trim()) body.accountId = accountInput.value.trim();
  const button = $<HTMLButtonElement>('regGo');
  button.disabled = true;
  say('등록 중… 콘솔의 기기 연결 화면을 닫지 마세요.');
  try {
    const r = await api('POST', '/api/register', body);
    if (r.ok) {
      say(`등록했습니다: ${r.data.console?.nickname || address}`, 'ok');
      accountInput.value = '';
      await refreshRegistered();
    } else {
      const code = String(r.data.error ?? '');
      say(`${REG_HINT[code] ?? '등록하지 못했습니다.'}${r.data.message ? ` (${r.data.message})` : ''}`, 'err');
    }
  } catch {
    say('브리지에 연결하지 못했습니다.', 'err');
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
  if (!soundToggle.checked) return '꺼짐';
  if (a.state === 'unsupported') return a.reason;
  if (a.state !== 'playing' || !a.info) return client.state === 'ready' ? '소리를 기다리는 중' : '';
  if (audio.contextState !== 'running' && !document.hidden) return '브라우저가 소리를 막고 있습니다. 화면을 한 번 탭하세요';
  const channels = a.info.channels === 1 ? '모노' : a.info.channels === 2 ? '스테레오' : `${a.info.channels}채널`;
  return `${(a.info.rate / 1000).toFixed(0)} kHz ${channels} · 지연 ${a.delayMs} ms · 끊김 ${a.underruns + a.concealed}회`;
}
function showSoundNote(): void {
  $<HTMLElement>('soundNote').textContent = soundNote();
}

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
  touch.setStatus(`수신 ${client.fpsIn} fps · ${client.kbpsIn} kbps · 표시 지연 ${delay.toFixed(0)} ms · 화면 끊김 ${hitchesSeen}회`);
  $<HTMLElement>('cBuffer').textContent = player.playout.mode === 'immediate' ? `0 ms (늦은 프레임 최대 ${player.playout.worstLateMs.toFixed(0)} ms)` : `${delay.toFixed(0)} ms`;
  $<HTMLElement>('cHitch').textContent = `${hitchesSeen}회`;
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
  first.textContent = '고르세요…';
  profilePick.append(first);
  const presets = document.createElement('optgroup');
  presets.label = '처음부터 시작';
  for (const p of PRESETS) {
    const o = document.createElement('option');
    o.value = `preset:${p.id}`;
    o.textContent = p.name;
    presets.append(o);
  }
  profilePick.append(presets);
  const names = Object.keys(savedProfiles()).sort((a, b) => a.localeCompare(b));
  if (names.length) {
    const mine = document.createElement('optgroup');
    mine.label = '저장해 둔 프로필';
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
    message(`"${preset.name}" 배치를 불러왔습니다.`, 'ok');
  } else if (v.startsWith('saved:')) {
    const saved = savedProfiles()[v.slice(6)];
    if (!saved) return;
    useProfile(saved);
    message(`"${v.slice(6)}" 프로필을 불러왔습니다.`, 'ok');
  }
});
$<HTMLButtonElement>('profileSave').addEventListener('click', () => {
  const name = profileName.value.trim();
  if (!name) return message('저장할 이름을 적어 주세요 (보통 게임 이름).', 'error');
  profile.game.name = name;
  writeStore(STORE_PROFILES, { ...savedProfiles(), [name]: profile });
  applyProfile(profile);
  syncControls();
  renderProfilePick();
  message(`"${name}"(으)로 저장했습니다. 이 브라우저에 보관됩니다.`, 'ok');
});
$<HTMLButtonElement>('profileDelete').addEventListener('click', () => {
  const name = profileName.value.trim();
  const all = savedProfiles();
  if (!(name in all)) return message(`"${name}"(이)라는 저장된 프로필이 없습니다.`, 'error');
  delete all[name];
  writeStore(STORE_PROFILES, all);
  renderProfilePick();
  message(`"${name}" 프로필을 지웠습니다. 지금 쓰고 있는 배치는 그대로입니다.`, 'ok');
});
renderProfilePick();

// The key layout editor (설정 → 입력 매핑) and the layout shown next to the picture.
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
let refreshQueued = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
onProfileChanged = () => {
  profileName.value = profile.game.name;
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
player.onNeedKeyframe = () => client.requestKeyframe();
client.onChange = () => {
  $<HTMLElement>('cStatus').textContent = `${client.state}${client.detail ? ` · ${client.detail}` : ''}`;
  $<HTMLElement>('cRate').textContent = client.state === 'ready' ? `${client.fpsIn} fps / ${client.kbpsIn} kbps` : '-';
  $<HTMLElement>('cRtt').textContent = client.rttMs > 0 ? `${client.rttMs.toFixed(1)} ms` : '-';
  $<HTMLElement>('cLatency').textContent = client.inputLatencyMs > 0 ? `${client.inputLatencyMs.toFixed(0)} ms (중앙값)` : '-';
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
  message('프로필을 적용했습니다.', 'ok');
});

$<HTMLButtonElement>('resetProfile').addEventListener('click', () => {
  applyProfile(presetProfile(mode));
  engine.releaseAll();
  engine.clearLatched();
  syncControls();
  message('기본 배치로 되돌렸습니다.', 'ok');
});

$<HTMLButtonElement>('autoCalibrate').addEventListener('click', () => {
  const make: GameFactory = mode === 'fps' ? () => new FpsGame({ ...fps.settings }) : () => new TpsGame({ ...tps.settings });
  const m = measureCalibration(make);
  applyMeasuredCalibration(profile, m);
  applyProfile(profile);
  syncControls();
  const edge = m.horizontal.find((p) => p[0] > 0 && p[1] === 0)?.[0];
  message(
    `보정 완료: 데드존 끝 ${edge === undefined ? '0' : edge.toFixed(3)}, 최대 ${m.fullStickRate.toFixed(0)}°/s, ` +
      `세로 비율 ${m.verticalRateRatio.toFixed(2)}, 모양 ${m.deadzoneShape === 'radial' ? '원형' : '축별'}, ` +
      `조준 배율 ${m.aimLookScale.toFixed(2)}, 표 ${m.horizontal.length}점`,
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
    lockNote = '잠김 (원시 입력 요청 성공)';
  } catch {
    try {
      await (view.requestPointerLock() as unknown);
      lockNote = '잠김 (일반 입력: 원시 입력 미지원 또는 거부)';
    } catch {
      lockNote = '잠금 실패';
    }
  }
}

view.addEventListener('click', () => {
  if (!isLocked()) void lockPointer();
});

document.addEventListener('pointerlockchange', () => {
  if (!isLocked()) {
    engine.releaseAll();
    lockNote = '해제됨';
  }
});

window.addEventListener('blur', () => engine.releaseAll());

window.addEventListener('keydown', (e) => {
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

document.addEventListener('mousemove', (e) => {
  if (isLocked()) feedMouse(e.movementX, e.movementY);
});

document.addEventListener('mousedown', (e) => {
  if (!isLocked()) return;
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
    if (!isLocked()) return;
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

  bar(40, 28, 200, state.l2, 'L2 (우클릭)');
  bar(520, 28, 200, state.r2, 'R2 (좌클릭)');
  stick(150, 190, state.leftX, state.leftY, '왼쪽 스틱 (WASD)', false, false);
  stick(610, 190, state.rightX, state.rightY, '오른쪽 스틱 (마우스)', diag.capped, true);

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
  $<HTMLElement>('mTurned').textContent = mode === 'console' ? '(콘솔에서는 측정 불가)' : `${turned.toFixed(1)}°`;
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
    $<HTMLElement>('mExpected').textContent = `${expected.toFixed(4)} (측정 대기)`;
  }
  $<HTMLElement>('rRate').textContent = `${diag.rateX.toFixed(0)} / ${diag.rateY.toFixed(0)} °/s`;
  $<HTMLElement>('rUse').textContent = `${Math.min(999, (speed / limit) * 100).toFixed(0)}%`;
  $<HTMLElement>('rCap').innerHTML = diag.capped
    ? '<span class="badge on">예</span>'
    : '<span class="badge off">아니오</span>';
  $<HTMLElement>('rStick').textContent = diag.stickMagnitude.toFixed(3);
  $<HTMLElement>('rLayers').textContent = ['default', ...engine.activeLayers].join(' + ');
  $<HTMLElement>('rGyro').textContent = [state.gyro.x, state.gyro.y, state.gyro.z].map((v) => v.toFixed(2)).join(' / ');
  if (mode === 'console') {
    $<HTMLElement>('rPos').textContent = '-';
    $<HTMLElement>('rState').textContent = client.state === 'ready' ? `콘솔 (${client.link})` : '연결 안 됨';
  } else if (mode === 'tps') {
    $<HTMLElement>('rPos').textContent = `${(tps.inVehicle ? tps.car.x : tps.x).toFixed(1)}, ${(tps.inVehicle ? tps.car.z : tps.z).toFixed(1)}`;
    $<HTMLElement>('rState').textContent = `${tps.movementName} · ${tps.speedKmh.toFixed(0)} km/h`;
  } else {
    $<HTMLElement>('rPos').textContent = `${fps.x.toFixed(1)}, ${fps.y.toFixed(1)}`;
    $<HTMLElement>('rState').textContent = fps.adsAmount > 0.5 ? '조준' : '-';
  }
  $<HTMLElement>('rLock').textContent = lockNote;
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
    viewCtx.fillText(client.state === 'ready' ? '영상 대기 중…' : '', view.width / 2, view.height / 2);
  }
  // In console mode the video player draws each frame as it arrives.
}

// ---------------------------------------------------------------- loop

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  const steps = Math.min(25, Math.floor(acc / TICK + 1e-9));
  if (touch.shown) {
    const look = touch.pad.takeLook();
    if (look.dx !== 0 || look.dy !== 0) feedMouse(look.dx, look.dy);
  }
  if (steps > 0) {
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
      state = s;
      if (mode === 'console') client.sendPad(s, profile.mouse.target === 'gyro', now);
      else active().update(s, TICK);
    });
    acc = steps === 25 ? 0 : acc - steps * TICK;
  } else if (mode === 'console') {
    client.sendPad(state, profile.mouse.target === 'gyro', now);
  }
  renderView();
  drawPad();
  updateReadout();
  requestAnimationFrame(frame);
}

setMode(mode, false);
requestAnimationFrame(frame);

// ---------------------------------------------------------------- demo and self test

/**
 * Scripted input for screenshots. It runs on SIMULATED time (tick by tick), not on timers, so the result
 * does not depend on how often the browser schedules frames.
 */
function runDemo(kind: string): void {
  lockNote = '데모 입력 (마우스 잠금 아님)';
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
    await until(() => (regMsg.textContent ?? '').includes('저장했습니다'), 12000); // generous: this is about the result, and a busy machine is slow
    check('the account id is fetched and saved through the page', (regMsg.textContent ?? '').includes('저장했습니다'), regMsg.textContent ?? '');
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
    check('the layout next to the picture names the keys', /Space/.test($<HTMLElement>('layoutList').textContent ?? '') && /좌클릭/.test($<HTMLElement>('layoutList').textContent ?? ''));
    padRow('□')?.querySelector<HTMLButtonElement>('.keymap-add')?.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', bubbles: true, cancelable: true }));
    await sleep(60);
    check('pressing a key after "+ 키" binds it to that button', profile.layers[0]!.bindings.KeyG === 'btn:box', String(profile.layers[0]!.bindings.KeyG));
    const how = [...(padRow('□')?.querySelectorAll<HTMLElement>('.keymap-binding') ?? [])].find((b) => b.querySelector('.keycap')?.textContent === 'G')?.querySelector<HTMLSelectElement>('select[aria-label="버튼을 어떻게 누를지"]');
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
if (params.has('e2e')) void runE2e();
if (params.has('autoconnect') && mode === 'console') connectConsole();

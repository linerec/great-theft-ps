// SPDX-License-Identifier: AGPL-3.0-only
//
// Test bed page: real keyboard and mouse -> MappingEngine -> virtual pad -> a pad-only game
// (a small FPS, or a GTA V style third-person game). The games never see a keyboard or a mouse.
// Everything runs on a fixed 250 Hz clock.

import { MappingEngine } from '../src/engine/engine.ts';
import { defaultProfile, gtaProfile, parseProfileText, type Profile } from '../src/engine/profile.ts';
import { BUTTON, BUTTON_NAMES, type VirtualPadState } from '../src/engine/types.ts';
import { FpsGame, defaultGameSettings } from '../src/testbed/fps.ts';
import { applyMeasuredCalibration, measureCalibration, type GameFactory } from '../src/testbed/measure.ts';
import { renderGame } from '../src/testbed/render.ts';
import { TpsGame, defaultTpsSettings } from '../src/testbed/tps.ts';
import { renderTps } from '../src/testbed/tpsrender.ts';
import { CODEC } from '../src/bridge/protocol.ts';
import { QUALITY_PRESETS, megabytesPerHour, type QualityPreset } from '../src/bridge/quality.ts';
import { BridgeClient } from './bridge-client.ts';
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
let mode: Mode = modeParam === 'tps' || modeParam === 'console' ? modeParam : 'fps';
const fps = new FpsGame(defaultGameSettings());
const tps = new TpsGame(defaultTpsSettings());
/** The test game the readouts refer to. In console mode there is no game, so this is only a placeholder. */
const active = (): FpsGame | TpsGame => (mode === 'tps' ? tps : fps);
const presetProfile = (m: Mode): Profile => (m === 'tps' ? gtaProfile() : defaultProfile());

const client = new BridgeClient();
const player = new VideoPlayer(document.getElementById('game') as HTMLCanvasElement);

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
  pf('maxDeflection', () => profile.mouse.maxDeflection, (v) => (profile.mouse.maxDeflection = v), 2),
  pf('verticalScale', () => profile.mouse.verticalScale, (v) => (profile.mouse.verticalScale = v), 2),
  pf('innerDeadzone', () => profile.inGame.innerDeadzone, (v) => (profile.inGame.innerDeadzone = v), 2),
  pf('maxTurnRateAtFullStick', () => profile.inGame.maxTurnRateAtFullStick, (v) => (profile.inGame.maxTurnRateAtFullStick = v), 0),
  pf('responseCurve', () => profile.inGame.responseCurve, (v) => (profile.inGame.responseCurve = v), 2),
  pf('verticalRateRatio', () => profile.inGame.verticalRateRatio, (v) => (profile.inGame.verticalRateRatio = v), 2),
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

function applyProfile(next: Profile): void {
  profile = next;
  engine.setProfile(profile);
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

function setMode(next: Mode, loadPreset: boolean): void {
  mode = next;
  $<HTMLElement>('fpsSettings').hidden = mode !== 'fps';
  $<HTMLElement>('tpsSettings').hidden = mode !== 'tps';
  $<HTMLElement>('consolePanel').hidden = mode !== 'console';
  $<HTMLElement>('hintFps').hidden = mode !== 'fps';
  $<HTMLElement>('hintTps').hidden = mode !== 'tps';
  $<HTMLElement>('hintConsole').hidden = mode !== 'console';
  $<HTMLButtonElement>('autoCalibrate').disabled = mode === 'console';
  if (mode !== 'console' && client.state !== 'idle') client.disconnect();
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
{
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromHash) {
    bridgeToken = fromHash;
    history.replaceState(null, '', location.pathname + location.search);
  }
}

const qualityNote = (): void => {
  const q = QUALITY_PRESETS[$<HTMLSelectElement>('qualityPreset').value as QualityPreset];
  $<HTMLElement>('qualityNote').textContent = `${q.width}×${q.height} ${q.fps}fps ${q.bitrateKbps}kbps ≈ ${megabytesPerHour(q.bitrateKbps).toFixed(0)}MB/시간`;
};
$<HTMLSelectElement>('qualityPreset').addEventListener('change', () => {
  qualityNote();
  if (client.state === 'ready') client.sendJson({ type: 'quality', preset: $<HTMLSelectElement>('qualityPreset').value });
});
qualityNote();

$<HTMLButtonElement>('bridgeConnect').addEventListener('click', () => {
  player.close();
  client.connect(bridgeUrl.value, bridgeToken);
});
$<HTMLButtonElement>('bridgeDisconnect').addEventListener('click', () => client.disconnect());
$<HTMLSelectElement>('consoleProfile').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v === 'fps' || v === 'tps') {
    applyProfile(presetProfile(v));
    engine.releaseAll();
    engine.clearLatched();
    syncControls();
  }
});

client.onVideo = (header, payload) => player.push(header, payload);
player.onNeedKeyframe = () => client.requestKeyframe();
client.onChange = () => {
  $<HTMLElement>('cStatus').textContent = `${client.state}${client.detail ? ` · ${client.detail}` : ''}`;
  $<HTMLElement>('cRate').textContent = client.state === 'ready' ? `${client.fpsIn} fps / ${client.kbpsIn} kbps` : '-';
  $<HTMLElement>('cRtt').textContent = client.rttMs > 0 ? `${client.rttMs.toFixed(1)} ms` : '-';
  $<HTMLElement>('cLatency').textContent = client.inputLatencyMs > 0 ? `${client.inputLatencyMs.toFixed(0)} ms (중앙값)` : '-';
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
  engine.clearLatched();
  syncControls();
  message('이 게임의 기본 프로필로 되돌렸습니다.', 'ok');
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
    viewCtx.fillText(client.state === 'ready' ? '영상 대기 중…' : '오른쪽 패널에서 브리지에 연결하세요', view.width / 2, view.height / 2);
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
  if (steps > 0) {
    engine.runFor(steps * TICK, TICK, (s) => {
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
    client.connect(bridgeUrl.value, bridgeToken);
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
    // Keep one frame the simulated console drew from the pad it received, so it can be looked at.
    frame = view.toDataURL('image/png');

    client.sendJson({ type: 'quality', preset: 'saver', fps: 15 });
    await sleep(2600);
    check('quality change takes effect (frame rate follows)', client.fpsIn >= 8 && client.fpsIn <= 20, `${client.fpsIn} fps received`);

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

if (params.has('e2e')) void runE2e();
if (params.has('autoconnect') && mode === 'console') client.connect(bridgeUrl.value, bridgeToken);

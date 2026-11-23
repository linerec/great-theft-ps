// SPDX-License-Identifier: AGPL-3.0-only
//
// Measuring a console game's stick-to-camera response from its picture, in the page. This project's own.
//
// The measuring itself is src/engine/lookcalibrate.ts (tested against a made-up game). Here are the parts that need a
// browser: small grey copies of the picture each time the player draws a frame, the stick being held through the page's
// own pad output, and the panel that starts it, shows how it goes and applies the result to the profile.
//
// Safety: while it runs the page sends only the right stick; keyboard, mouse and touch are ignored. Whatever ends the
// run (done, stopped, an error, a hidden tab, the connection ending) lets go of the stick before anything else.

import { calibrateLook, CalibrationError, type CalibrationProgress, type CalibrationResult, type CalibrationWarning, type LookIo } from '../src/engine/lookcalibrate.ts';
import type { Gray, TimedFrame } from '../src/engine/lookmeasure.ts';
import type { Profile } from '../src/engine/profile.ts';

/** The size the measurement works at. */
export const FRAME_W = 256;
export const FRAME_H = 144;

/** Small grey copies of what is on a canvas. */
export class FrameGrabber {
  #small: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #source: HTMLCanvasElement;

  constructor(source: HTMLCanvasElement) {
    this.#source = source;
    this.#small = document.createElement('canvas');
    this.#small.width = FRAME_W;
    this.#small.height = FRAME_H;
    this.#ctx = this.#small.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  }

  grab(): Gray {
    this.#ctx.drawImage(this.#source, 0, 0, FRAME_W, FRAME_H);
    const rgba = this.#ctx.getImageData(0, 0, FRAME_W, FRAME_H).data;
    const grey = new Uint8Array(FRAME_W * FRAME_H);
    for (let i = 0, j = 0; i < grey.length; i++, j += 4) grey[i] = (rgba[j]! * 77 + rgba[j + 1]! * 150 + rgba[j + 2]! * 29) >> 8;
    return { w: FRAME_W, h: FRAME_H, data: grey };
  }
}

export interface PageIoDeps {
  grabber: FrameGrabber;
  /** Hold the right stick at (x, y); (0, 0) lets go. */
  setStick(x: number, y: number): void;
  /** Be called each time the picture has a new frame; returns the way to stop being called. */
  onFrame(callback: () => void): () => void;
  /** Throws when the run must end: stopped, hidden tab, connection gone. */
  check(): void;
}

/** The stick and the frames, through the page. Times are the page's own clock, in ms. */
export class PageLookIo implements LookIo {
  #d: PageIoDeps;

  constructor(deps: PageIoDeps) {
    this.#d = deps;
  }

  #collect(ms: number, stop?: (frames: TimedFrame[]) => boolean): Promise<TimedFrame[]> {
    return new Promise((resolve, reject) => {
      const frames: TimedFrame[] = [];
      const t0 = performance.now();
      let lastFrameAt = t0;
      let done = false;
      const end = (error?: Error): void => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        clearInterval(watch);
        if (error) reject(error);
        else resolve(frames);
      };
      const off = this.#d.onFrame(() => {
        const now = performance.now();
        lastFrameAt = now;
        frames.push({ t: now - t0, img: this.#d.grabber.grab() });
        if (stop?.(frames)) end();
      });
      const timer = setTimeout(() => end(), ms);
      // Every so often: has the run to end (stopped, tab hidden, connection gone), or has the video stopped coming?
      const watch = setInterval(() => {
        try {
          this.#d.check();
        } catch (e) {
          return end(e as Error);
        }
        if (performance.now() - lastFrameAt > 2000) end(new CalibrationError('no-video', 'no frames for 2 seconds'));
      }, 100);
    });
  }

  async hold(x: number, y: number, ms: number, stop?: (frames: TimedFrame[]) => boolean): Promise<TimedFrame[]> {
    this.#d.check();
    this.#d.setStick(x, y);
    return this.#collect(ms, stop);
  }

  async rest(ms: number): Promise<TimedFrame[]> {
    this.#d.check();
    this.#d.setStick(0, 0);
    return this.#collect(ms);
  }
}

// ------------------------------------------------------------------------------------------------ the profile

/** Store a measurement in a mapping profile (the aim layer and the deadzone shape are left as they are). */
export function applyConsoleCalibration(profile: Profile, r: CalibrationResult): void {
  profile.calibration.horizontal = r.table;
  profile.calibration.vertical = null;
  if (r.verticalRateRatio !== null) profile.inGame.verticalRateRatio = r.verticalRateRatio;
  profile.inGame.innerDeadzone = Math.min(0.6, Math.round(r.innerDeadzone * 100) / 100);
  profile.inGame.maxTurnRateAtFullStick = Math.min(5000, Math.max(10, Math.round(r.fullStickRate)));
}

// ------------------------------------------------------------------------------------------------ words

const WARNINGS: Record<CalibrationWarning['code'], string> = {
  'scale-assumed': '카메라가 한 바퀴 도는 것을 확인하지 못해 화면 시야각을 가정해 각도를 계산했습니다 (표의 모양은 맞지만 절대 각도는 약간 어긋날 수 있습니다).',
  'latency-assumed': '스틱이 화면에 나타나기까지의 지연을 확인하지 못했습니다.',
  'low-support': '일부 단계는 화면이 불분명해 측정하지 못했습니다.',
  'direction-mixed': '스틱을 밀어도 카메라가 도는 방향이 일정하지 않았습니다. 움직이는 물체가 많은 장면일 수 있습니다.',
  'pitch-missing': '위아래 비율을 측정하지 못해 기존 값을 그대로 둡니다.',
};

const ERRORS: Record<string, string> = {
  'no-video': '영상이 들어오지 않습니다. 연결 상태를 확인하세요.',
  'no-texture': '화면에 따라갈 만한 무늬가 부족합니다 (메뉴, 로딩 화면, 단색 배경). 풍경이 보이는 게임 장면에서 다시 하세요.',
  'no-motion': '스틱을 움직여도 화면이 돌아가지 않았습니다. 메뉴나 컷신이 아니라 카메라가 자유롭게 도는 플레이 장면인지 확인하세요.',
  aborted: '중지했습니다.',
  failed: '측정에 실패했습니다.',
};

const PHASES: Record<CalibrationProgress['phase'], string> = {
  prepare: '화면 확인',
  turn: '한 바퀴 돌려 각도 재는 중',
  yaw: '가로 반응 측정',
  pitch: '세로 반응 측정',
  build: '표 만드는 중',
};

export function progressText(p: CalibrationProgress): string {
  return `${PHASES[p.phase]}${p.stick !== undefined ? ` (스틱 ${p.stick.toFixed(2)})` : ''} · ${p.step}/${p.steps}`;
}

export function resultText(r: CalibrationResult): string {
  const lines = [
    `스틱이 움직이기 시작하는 값(데드존) ${r.innerDeadzone.toFixed(2)} · 최대 편향에서 ${Math.round(r.fullStickRate)}°/s · 세로/가로 ${r.verticalRateRatio === null ? '측정 못 함' : r.verticalRateRatio.toFixed(2)}`,
    `화면에 나타나기까지 지연 ${r.latencyMs} ms · 각도 기준: ${r.scaleSource === 'turn' ? '카메라 한 바퀴 실측' : '시야각 가정'}`,
    ...r.warnings.map((w) => `주의: ${WARNINGS[w.code]}`),
  ];
  return lines.join('\n');
}

/** The table as a small line drawing, for the panel. */
export function plotSvg(r: CalibrationResult): string {
  const W = 220;
  const H = 110;
  const top = Math.max(1, r.fullStickRate);
  const pts = r.table.map(([s, v]) => `${(10 + s * (W - 20)).toFixed(1)},${(H - 12 - (v / top) * (H - 24)).toFixed(1)}`).join(' ');
  const dots = r.levels
    .filter((l) => l.ok)
    .map((l) => `<circle cx="${(10 + l.stick * (W - 20)).toFixed(1)}" cy="${(H - 12 - (l.degPerSec / top) * (H - 24)).toFixed(1)}" r="2" fill="currentColor" opacity=".55"/>`)
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="스틱 값에 따른 회전 속도"><rect x="10" y="12" width="${W - 20}" height="${H - 24}" fill="none" stroke="currentColor" opacity=".25"/><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6"/>${dots}<text x="10" y="${H - 1}" font-size="9" fill="currentColor" opacity=".7">스틱 0</text><text x="${W - 30}" y="${H - 1}" font-size="9" fill="currentColor" opacity=".7">1.0</text><text x="12" y="10" font-size="9" fill="currentColor" opacity=".7">${Math.round(top)}°/s</text></svg>`;
}

// ------------------------------------------------------------------------------------------------ the panel

export interface PanelDeps {
  canvas: HTMLCanvasElement;
  /** Set (x, y) to hold the right stick through the page's pad output; null gives the pad back to the keyboard and mouse. */
  setStickOverride(stick: { x: number; y: number } | null): void;
  /** The picture was drawn: call `listener` each time the player has put a new frame on the canvas. */
  onFrameDrawn(listener: () => void): void;
  ready(): boolean;
  profile(): Profile;
  /** The profile was changed: show it, keep it. */
  changed(): void;
}

/** Wire the panel in the page (ids: consoleCalibrate, consoleCalibrateStop, consoleCalibrateStatus, consoleCalibrateResult, consoleCalibratePlot, consoleCalibrateApply). */
export function mountConsoleCalibration(d: PanelDeps): { running(): boolean } {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const start = $<HTMLButtonElement>('consoleCalibrate');
  const stop = $<HTMLButtonElement>('consoleCalibrateStop');
  const status = $<HTMLElement>('consoleCalibrateStatus');
  const resultBox = $<HTMLElement>('consoleCalibrateResult');
  const plot = $<HTMLElement>('consoleCalibratePlot');
  const apply = $<HTMLButtonElement>('consoleCalibrateApply');
  const grabber = new FrameGrabber(d.canvas);
  let running = false;
  let stopped = false;
  let last: CalibrationResult | null = null;
  let callback: (() => void) | null = null;
  d.onFrameDrawn(() => callback?.());

  const io = new PageLookIo({
    grabber,
    setStick: (x, y) => d.setStickOverride({ x, y }),
    onFrame: (cb) => {
      callback = cb;
      return () => {
        if (callback === cb) callback = null;
      };
    },
    check: () => {
      if (stopped) throw new CalibrationError('aborted', 'stopped');
      if (document.hidden) throw new CalibrationError('aborted', 'the tab was hidden');
      if (!d.ready()) throw new CalibrationError('aborted', 'the connection ended');
    },
  });

  const show = (text: string): void => void (status.textContent = text);

  start.addEventListener('click', async () => {
    if (running) return;
    if (!d.ready()) return show('먼저 PS5에 연결하고 게임 화면이 보이는 상태에서 시작하세요.');
    running = true;
    stopped = false;
    last = null;
    start.disabled = true;
    stop.hidden = false;
    apply.hidden = true;
    resultBox.textContent = '';
    plot.innerHTML = '';
    try {
      const r = await calibrateLook(io, {
        onProgress: (p) => show(progressText(p)),
        aborted: () => stopped || document.hidden || !d.ready(),
      });
      last = r;
      console.info('[gtp-calibration]', JSON.stringify(r));
      (window as unknown as { __lastCalibration?: CalibrationResult }).__lastCalibration = r;
      show('측정이 끝났습니다. 아래 결과를 확인하고 "프로필에 적용"을 누르세요.');
      resultBox.textContent = resultText(r);
      plot.innerHTML = plotSvg(r);
      apply.hidden = false;
    } catch (e) {
      const code = e instanceof CalibrationError ? e.code : 'failed';
      console.warn('[gtp-calibration] failed', e);
      const base = ERRORS[code] ?? ERRORS.failed!;
      show(code === 'failed' ? `${base} (${(e as Error).message})` : base);
    } finally {
      // Whatever happened, the stick is let go first, then the pad goes back to the keyboard and mouse.
      d.setStickOverride({ x: 0, y: 0 });
      d.setStickOverride(null);
      running = false;
      start.disabled = false;
      stop.hidden = true;
    }
  });

  stop.addEventListener('click', () => {
    stopped = true;
    d.setStickOverride({ x: 0, y: 0 });
  });

  apply.addEventListener('click', () => {
    if (!last) return;
    applyConsoleCalibration(d.profile(), last);
    d.changed();
    apply.hidden = true;
    show('프로필에 적용했습니다. 마우스 감도(카운트당 °)는 그대로이니 느낌에 맞게 조절하세요.');
  });

  return { running: () => running };
}

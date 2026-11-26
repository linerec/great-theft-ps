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
import { N_, onLang, t } from '../src/i18n/index.ts';

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

// The tables hold sentences to be shown through t() when they are drawn (the language can change while the page is open).
const WARNINGS: Record<CalibrationWarning['code'], string> = {
  'scale-assumed': N_('Could not confirm that the camera turns a full circle, so the angles were worked out from an assumed field of view (the shape of the table is right, but the absolute angles may be slightly off).'),
  'latency-assumed': N_('Could not determine the delay before the stick shows on screen.'),
  'low-support': N_('Some steps could not be measured because the picture was unclear.'),
  'direction-mixed': N_('The camera did not turn in a consistent direction when the stick was pushed. The scene may have many moving objects.'),
  'pitch-missing': N_('Could not measure the vertical ratio, so the existing value is left as it is.'),
};

const ERRORS: Record<string, string> = {
  'no-video': N_('No video is coming in. Check the connection.'),
  'no-texture': N_('There is not enough pattern on screen to follow (menu, loading screen, plain background). Try again in a game scene with scenery in view.'),
  'no-motion': N_('The picture did not turn when the stick moved. Make sure you are in a play scene where the camera turns freely, not a menu or a cutscene.'),
  aborted: N_('Stopped.'),
  failed: N_('The measurement failed.'),
};

const PHASES: Record<CalibrationProgress['phase'], string> = {
  prepare: N_('Checking the picture'),
  turn: N_('Turning a full circle to measure the angle'),
  yaw: N_('Measuring horizontal response'),
  pitch: N_('Measuring vertical response'),
  build: N_('Building the table'),
};

export function progressText(p: CalibrationProgress): string {
  const phase = t(PHASES[p.phase]);
  return p.stick !== undefined
    ? t('{phase} (stick {stick}) · {step}/{steps}', { phase, stick: p.stick.toFixed(2), step: p.step, steps: p.steps })
    : t('{phase} · {step}/{steps}', { phase, step: p.step, steps: p.steps });
}

export function resultText(r: CalibrationResult): string {
  const lines = [
    t('Value where the stick starts to register (dead zone) {deadzone} · {rate}°/s at full push · vertical/horizontal {ratio}', {
      deadzone: r.innerDeadzone.toFixed(2),
      rate: Math.round(r.fullStickRate),
      ratio: r.verticalRateRatio === null ? t('not measured') : r.verticalRateRatio.toFixed(2),
    }),
    r.scaleSource === 'turn'
      ? t('Delay before it shows on screen {latency} ms · angle basis: measured from a full camera turn', { latency: r.latencyMs })
      : t('Delay before it shows on screen {latency} ms · angle basis: assumed field of view', { latency: r.latencyMs }),
    ...r.warnings.map((w) => t('Note: {warning}', { warning: t(WARNINGS[w.code]) })),
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
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${t('Turn speed by stick value')}"><rect x="10" y="12" width="${W - 20}" height="${H - 24}" fill="none" stroke="currentColor" opacity=".25"/><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6"/>${dots}<text x="10" y="${H - 1}" font-size="9" fill="currentColor" opacity=".7">${t('Stick 0')}</text><text x="${W - 30}" y="${H - 1}" font-size="9" fill="currentColor" opacity=".7">1.0</text><text x="12" y="10" font-size="9" fill="currentColor" opacity=".7">${Math.round(top)}°/s</text></svg>`;
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

  // What the status says is kept as a way of saying it, so that it can be said again when the language changes.
  let said: () => string = () => '';
  const show = (text: () => string): void => {
    said = text;
    status.textContent = text();
  };
  onLang(() => {
    status.textContent = said();
    if (last) {
      resultBox.textContent = resultText(last);
      plot.innerHTML = plotSvg(last);
    }
  });

  start.addEventListener('click', async () => {
    if (running) return;
    if (!d.ready()) return show(() => t('First connect to your PS5 and start with the game on screen.'));
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
        onProgress: (p) => show(() => progressText(p)),
        aborted: () => stopped || document.hidden || !d.ready(),
      });
      last = r;
      console.info('[gtp-calibration]', JSON.stringify(r));
      (window as unknown as { __lastCalibration?: CalibrationResult }).__lastCalibration = r;
      show(() => t('Measurement finished. Check the result below and press "Apply to profile".'));
      resultBox.textContent = resultText(r);
      plot.innerHTML = plotSvg(r);
      apply.hidden = false;
    } catch (e) {
      const code = e instanceof CalibrationError ? e.code : 'failed';
      console.warn('[gtp-calibration] failed', e);
      const base = ERRORS[code] ?? ERRORS.failed!;
      const detail = (e as Error).message;
      show(() => (code === 'failed' ? t('The measurement failed. ({message})', { message: detail }) : t(base)));
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
    show(() => t('Applied to the profile. Mouse sensitivity (° per count) is unchanged, so adjust it to taste.'));
  });

  return { running: () => running };
}

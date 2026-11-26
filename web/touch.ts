// SPDX-License-Identifier: AGPL-3.0-only
//
// The pad on a touch screen: draws the controls over the picture and follows the fingers. What the fingers mean is
// decided in src/engine/touchpad.ts; this file is the part that needs a browser.
//
// Built for a phone held sideways. The picture fills the screen and the controls lie over it:
//   left    L2 L1 at the top, the d-pad under them, the left stick wherever the thumb lands below that, L3
//   right   R2 R1 at the top, the four face buttons at the bottom, R3; dragging anywhere else turns the camera
//   top     CREATE, the touchpad button, OPTIONS, PS, and a menu
// Nothing here depends on the phone's make: pointer events, CSS that keeps clear of the notch and the home bar,
// no zooming or scrolling while playing, and the screen kept awake where the browser can do that.

import { TouchPad, type TouchControl } from '../src/engine/touchpad.ts';
import { onLang, t } from '../src/i18n/index.ts';

interface ControlSpec {
  c: TouchControl;
  label: string;
  cls: string;
}

const CONTROLS: ControlSpec[] = [
  { c: 'l2', label: 'L2', cls: 'tc-shoulder tc-l2' },
  { c: 'l1', label: 'L1', cls: 'tc-shoulder tc-l1' },
  { c: 'r2', label: 'R2', cls: 'tc-shoulder tc-r2' },
  { c: 'r1', label: 'R1', cls: 'tc-shoulder tc-r1' },
  { c: 'dpad_up', label: '▲', cls: 'tc-dpad tc-du' },
  { c: 'dpad_down', label: '▼', cls: 'tc-dpad tc-dd' },
  { c: 'dpad_left', label: '◀', cls: 'tc-dpad tc-dl' },
  { c: 'dpad_right', label: '▶', cls: 'tc-dpad tc-dr' },
  { c: 'pyramid', label: '△', cls: 'tc-face tc-fu' },
  { c: 'cross', label: '✕', cls: 'tc-face tc-fd' },
  { c: 'box', label: '□', cls: 'tc-face tc-fl' },
  { c: 'moon', label: '○', cls: 'tc-face tc-fr' },
  { c: 'l3', label: 'L3', cls: 'tc-small tc-l3' },
  { c: 'r3', label: 'R3', cls: 'tc-small tc-r3' },
  { c: 'share', label: 'CREATE', cls: 'tc-pill tc-create' },
  { c: 'touchpad', label: '▭', cls: 'tc-pill tc-touchpad' },
  { c: 'options', label: 'OPTIONS', cls: 'tc-pill tc-options' },
  { c: 'ps', label: 'PS', cls: 'tc-pill tc-ps' },
];

export interface TouchUi {
  pad: TouchPad;
  /** Show or hide the controls (and everything that goes with playing by touch). */
  show(on: boolean): void;
  readonly shown: boolean;
  /** A line of text in the menu (state, delay, hitches). */
  setStatus(text: string): void;
}

export interface TouchHost {
  /** Called when the person asks to disconnect from the menu. */
  onDisconnect(): void;
  /** Called when the person turns the touch controls off from the menu. */
  onHide(): void;
  /** Full screen on or off, from the menu (left out: no such button). */
  onFullscreen?: () => void;
  /** The sound: whether it is on, a way to switch it, and a line saying how it is doing. Left out, the menu has no sound button. */
  sound?: { isOn(): boolean; set(on: boolean): void; note(): string };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
};

function stored(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export function mountTouch(layer: HTMLElement, host: TouchHost): TouchUi {
  const pad = new TouchPad({ stickRadius: 60, lookScale: stored('gtp.touch.look', 4) });
  let shown = false;

  const buttons = new Map<TouchControl, HTMLElement>();
  for (const spec of CONTROLS) {
    const b = el('div', `tc ${spec.cls}`, spec.label);
    b.dataset.c = spec.c;
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', spec.c);
    buttons.set(spec.c, b);
    layer.append(b);
  }
  const base = el('div', 'tc-stick-base');
  const knob = el('div', 'tc-stick-knob');
  base.hidden = true;
  base.append(knob);
  layer.append(base);

  // The menu: the few things needed while playing with no other page element in reach.
  const menuButton = el('button', 'tc-menu', '⋯');
  menuButton.type = 'button';
  const panel = el('div', 'tc-panel');
  panel.hidden = true;
  const status = el('p', 'tc-status');
  const lookRow = el('div', 'tc-row');
  const lookLabel = el('span', '', '');
  const slower = el('button', 'btn small');
  const faster = el('button', 'btn small');
  slower.type = faster.type = 'button';
  const showLook = (): void => void (lookLabel.textContent = t('Look sensitivity {value}', { value: pad.options.lookScale.toFixed(1) }));
  const setLook = (v: number): void => {
    pad.options.lookScale = Math.min(12, Math.max(1, Math.round(v * 2) / 2));
    try {
      localStorage.setItem('gtp.touch.look', String(pad.options.lookScale));
    } catch {
      /* not remembered */
    }
    showLook();
  };
  slower.addEventListener('click', () => setLook(pad.options.lookScale - 0.5));
  faster.addEventListener('click', () => setLook(pad.options.lookScale + 0.5));
  lookRow.append(slower, lookLabel, faster);
  const soundRow = el('div', 'tc-row');
  const soundButton = el('button', 'btn small', '');
  const soundNote = el('span', 'tc-tip', '');
  soundButton.type = 'button';
  const showSound = (): void => {
    if (!host.sound) return;
    soundButton.textContent = host.sound.isOn() ? t('Turn sound off') : t('Turn sound on');
    soundNote.textContent = host.sound.note();
  };
  soundButton.addEventListener('click', () => {
    host.sound?.set(!host.sound.isOn());
    showSound();
  });
  if (host.sound) soundRow.append(soundButton, soundNote);
  const actions = el('div', 'tc-row');
  const disconnect = el('button', 'btn small');
  const hide = el('button', 'btn small');
  const close = el('button', 'btn small ghost');
  const full = el('button', 'btn small');
  disconnect.type = hide.type = close.type = full.type = 'button';
  full.addEventListener('click', () => {
    panel.hidden = true;
    host.onFullscreen?.();
  });
  disconnect.addEventListener('click', () => {
    panel.hidden = true;
    host.onDisconnect();
  });
  hide.addEventListener('click', () => {
    panel.hidden = true;
    host.onHide();
  });
  close.addEventListener('click', () => (panel.hidden = true));
  actions.append(disconnect, ...(host.onFullscreen ? [full] : []), hide, close);
  const tip = el('p', 'tc-tip');
  panel.append(...(host.sound ? [status, lookRow, soundRow, actions, tip] : [status, lookRow, actions, tip]));
  menuButton.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    showLook();
    showSound();
  });
  layer.append(menuButton, panel);

  // The words of the menu are put in here, and again whenever the language changes (the menu is built once). What changes
  // while it is open (the sensitivity, the sound button) is drawn only when it is open, as it is when it is opened.
  const paintWords = (): void => {
    menuButton.setAttribute('aria-label', t('Menu'));
    slower.textContent = t('Look slower');
    faster.textContent = t('Look faster');
    disconnect.textContent = t('Disconnect');
    hide.textContent = t('Turn off touch pad');
    close.textContent = t('Close');
    full.textContent = t('Full screen');
    tip.textContent = t('Empty left side = left stick; drag on the empty right side to look around. For full screen, in Safari use Share → "Add to Home Screen".');
    if (!panel.hidden) {
      showLook();
      showSound();
    }
  };
  paintWords();
  onLang(paintWords);

  const controlAt = (x: number, y: number): TouchControl | null => {
    const hit = document.elementFromPoint(x, y);
    const c = hit instanceof HTMLElement ? hit.closest<HTMLElement>('[data-c]')?.dataset.c : undefined;
    return (c as TouchControl | undefined) ?? null;
  };

  const redraw = (): void => {
    const pressed = new Set(pad.pressed);
    for (const [c, b] of buttons) b.classList.toggle('on', pressed.has(c));
    const s = pad.stick;
    base.hidden = !s;
    if (s) {
      const box = layer.getBoundingClientRect();
      base.style.left = `${s.cx - box.left}px`;
      base.style.top = `${s.cy - box.top}px`;
      const dx = s.x - s.cx;
      const dy = s.y - s.cy;
      const far = Math.hypot(dx, dy);
      const k = far > pad.options.stickRadius ? pad.options.stickRadius / far : 1;
      knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    }
  };

  const ours = (e: PointerEvent): boolean => !(e.target instanceof Element && e.target.closest('.tc-menu, .tc-panel'));
  layer.addEventListener('pointerdown', (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    panel.hidden = true;
    try {
      layer.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    const c = controlAt(e.clientX, e.clientY);
    pad.down(e.pointerId, e.clientX, e.clientY, layer.clientWidth, c);
    if (c) navigator.vibrate?.(8); // a small tick where the phone can do it (not on iPhone)
    redraw();
  });
  layer.addEventListener('pointermove', (e) => {
    if (!pad.active) return;
    e.preventDefault();
    // A phone can deliver several positions in one event; the last one is where the finger is.
    pad.move(e.pointerId, e.clientX, e.clientY, controlAt(e.clientX, e.clientY));
    redraw();
  });
  const lift = (e: PointerEvent): void => {
    pad.up(e.pointerId);
    redraw();
  };
  layer.addEventListener('pointerup', lift);
  layer.addEventListener('pointercancel', lift);
  layer.addEventListener('lostpointercapture', lift);
  // No zooming, no text selection, no long-press menu while playing.
  for (const type of ['gesturestart', 'gesturechange', 'contextmenu', 'dblclick', 'selectstart'] as const) {
    layer.addEventListener(type, (e) => e.preventDefault());
  }
  layer.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  // Keep the screen on while the controls are up. Not every browser can; then the phone's own setting decides.
  let wake: { release(): Promise<void> } | null = null;
  const keepAwake = async (): Promise<void> => {
    try {
      const lock = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (shown && lock && document.visibilityState === 'visible') wake = await lock.request('screen');
    } catch {
      /* refused (low power mode, or not supported): nothing to do about it here */
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void keepAwake();
    else pad.releaseAll();
  });

  return {
    pad,
    get shown() {
      return shown;
    },
    show(on: boolean): void {
      if (on === shown) return;
      shown = on;
      layer.hidden = !on;
      document.body.classList.toggle('touch-live', on);
      if (on) void keepAwake();
      else {
        pad.releaseAll();
        panel.hidden = true;
        redraw();
        void wake?.release().catch(() => {});
        wake = null;
      }
    },
    setStatus(text: string): void {
      status.textContent = text;
    },
  };
}

/** Does this device look like one that is used by touch? */
export function prefersTouch(): boolean {
  try {
    return matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

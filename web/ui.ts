// SPDX-License-Identifier: AGPL-3.0-only
//
// Small things every part of the page uses: short messages that fade by themselves (toasts), settings kept in this
// browser, the light/dark choice, and a way to close a pop-up by clicking away from it.

// ------------------------------------------------------------------ settings kept in this browser

/** A saved text, or the fallback when there is none or the browser will not say (private windows, blocked storage). */
export function saved(key: string, fallback = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered: the page works the same until it is closed */
  }
}

// ------------------------------------------------------------------ toasts

export type ToastKind = 'info' | 'ok' | 'warn' | 'err';

/** Where toasts go: the page's own place, or, in full screen, inside the full-screen element (only that is shown then). */
function toastBox(): HTMLElement | null {
  const full = (document.fullscreenElement ?? (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement) as HTMLElement | null;
  if (full && full !== document.documentElement) {
    let box = full.querySelector<HTMLElement>(':scope > .toasts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts in-player';
      box.setAttribute('role', 'status');
      full.append(box);
    }
    return box;
  }
  return document.getElementById('toasts');
}

/**
 * A short message at the bottom of the page: for what happened (a screenshot was saved, a controller was found, five
 * minutes are left), not for what must be answered. It stays `ms` milliseconds, longer for warnings.
 */
export function toast(text: string, kind: ToastKind = 'info', ms = kind === 'warn' || kind === 'err' ? 6000 : 3200): void {
  const box = toastBox();
  if (!box) return;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  box.append(t);
  // Never more than four at once: the oldest goes.
  while (box.children.length > 4) box.firstElementChild?.remove();
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 260);
  }, ms);
}

// ------------------------------------------------------------------ light and dark

export type Theme = 'auto' | 'light' | 'dark';
const THEMES: Theme[] = ['auto', 'light', 'dark'];
export const THEME_TEXT: Record<Theme, string> = { auto: '기기 설정 따라가기', light: '밝게', dark: '어둡게' };

export const currentTheme = (): Theme => {
  const v = saved('gtp.theme');
  return (THEMES as string[]).includes(v) ? (v as Theme) : 'auto';
};

/** "auto" leaves the choice to the device (the style sheet's media query); the other two pin it. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;
  // The browser's own bar and the page behind an iPhone's notch take the colour of the page.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && bg) meta.content = bg;
  document.dispatchEvent(new CustomEvent('gtp:theme', { detail: theme }));
}

export function setTheme(theme: Theme): void {
  save('gtp.theme', theme);
  applyTheme(theme);
}

// ------------------------------------------------------------------ pop-ups

/**
 * Close `panel` when the page is clicked anywhere else or Esc is pressed. `opener` is the button that opens it (a click on
 * it is not "elsewhere"). Returns a function that removes the listeners.
 */
export function dismissOnOutside(panel: HTMLElement, opener: HTMLElement, close: () => void): () => void {
  const onDown = (e: Event): void => {
    const t = e.target as Node;
    if (panel.contains(t) || opener.contains(t)) return;
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey);
  return () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
  };
}

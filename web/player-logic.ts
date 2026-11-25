// SPDX-License-Identifier: AGPL-3.0-only
//
// The decisions of the player's interface, apart from the drawing, so that they can be tested without a browser:
// when the controls over the picture hide, how good the connection is, what a screenshot is called, which clip format
// the browser can make, how the picture is adjusted, and when the time left is worth a warning.

// ------------------------------------------------------------------ the controls over the picture

/**
 * Whether the bar over the picture is showing. It shows while the person is doing something (moving the mouse, pressing a
 * key, touching), or has the pointer on it, or has a panel of it open; it hides after `idleMs` of quiet. While the mouse is
 * captured by the game (pointer lock) it is always hidden: the person is playing, and Esc brings it back at once.
 */
export class HudVisibility {
  live = false;
  locked = false;
  panelOpen = false;
  hovering = false;
  readonly idleMs: number;
  #lastActivity = Number.NEGATIVE_INFINITY;

  constructor(idleMs = 2800) {
    this.idleMs = idleMs;
  }

  /** Something the person did. */
  poke(now: number): void {
    this.#lastActivity = now;
  }

  setLocked(locked: boolean, now: number): void {
    if (this.locked && !locked) this.poke(now); // let go of the mouse: the controls are what they want next
    this.locked = locked;
  }

  setLive(live: boolean, now: number): void {
    if (live && !this.live) this.poke(now);
    this.live = live;
  }

  visible(now: number): boolean {
    if (!this.live || this.locked) return false;
    if (this.panelOpen || this.hovering) return true;
    return now - this.#lastActivity < this.idleMs;
  }
}

// ------------------------------------------------------------------ how good is the connection

export type LinkQuality = 'great' | 'good' | 'fair' | 'poor' | 'none';

export interface LinkSample {
  /** Frames received in the last second. */
  fps: number;
  /** What the quality preset asks for (0: not known). */
  wantFps: number;
  /** Round trip to the bridge. 0: not measured yet. */
  rttMs: number;
  /** Frames that were late enough to look like a stutter, in the last ten seconds. */
  hitchesLast10s: number;
}

/** A word for the signal indicator. It judges what the person feels (smoothness, delay), not the line's name. */
export function rateConnection(s: LinkSample): LinkQuality {
  if (s.fps <= 0) return 'none';
  const ratio = s.wantFps > 0 ? s.fps / s.wantFps : 1;
  if (ratio < 0.5 || s.rttMs > 150 || s.hitchesLast10s >= 6) return 'poor';
  if (ratio < 0.8 || s.rttMs > 80 || s.hitchesLast10s >= 3) return 'fair';
  if (s.rttMs > 40 || s.hitchesLast10s >= 1) return 'good';
  return 'great';
}

export const QUALITY_TEXT: Record<LinkQuality, string> = { great: '매우 좋음', good: '좋음', fair: '보통', poor: '나쁨', none: '신호 없음' };
/** Bars lit (of four) for each rating. */
export const QUALITY_BARS: Record<LinkQuality, number> = { great: 4, good: 3, fair: 2, poor: 1, none: 0 };

/** The last `size` numbers, oldest first: what a small chart draws. */
export class Series {
  readonly size: number;
  #values: number[] = [];
  constructor(size = 60) {
    this.size = size;
  }
  push(v: number): void {
    this.#values.push(v);
    if (this.#values.length > this.size) this.#values.shift();
  }
  get values(): readonly number[] {
    return this.#values;
  }
  /** The sum of the last `n` values. */
  sumLast(n: number): number {
    let sum = 0;
    for (const v of this.#values.slice(-n)) sum += v;
    return sum;
  }
  get last(): number {
    return this.#values[this.#values.length - 1] ?? 0;
  }
  get max(): number {
    return this.#values.length ? Math.max(...this.#values) : 0;
  }
  clear(): void {
    this.#values = [];
  }
}

// ------------------------------------------------------------------ clock, names, formats

/** "5" -> "0:05", "754" -> "12:34", "3723" -> "1:02:03". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** The file name of a screenshot or clip: gtp-20261124-193005.png (the person's own clock). */
export function captureName(when: Date, ext: string): string {
  return `gtp-${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}-${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}.${ext}`;
}

const CLIP_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];

/** The first clip format the browser can record, with the file extension it takes. Null: this browser cannot record. */
export function pickClipFormat(supported: (type: string) => boolean): { type: string; ext: 'webm' | 'mp4' } | null {
  for (const type of CLIP_TYPES) if (supported(type)) return { type, ext: type.startsWith('video/mp4') ? 'mp4' : 'webm' };
  return null;
}

/** A clip is kept in memory until it is saved, so it has a length it cannot go beyond. */
export const MAX_CLIP_SECONDS = 300;

// ------------------------------------------------------------------ the picture

export type Fit = 'contain' | 'cover' | 'fill';
export interface PictureLook {
  fit: Fit;
  /** Percent: 100 is the picture as it comes. */
  brightness: number;
  contrast: number;
  saturation: number;
}
export const DEFAULT_LOOK: PictureLook = { fit: 'contain', brightness: 100, contrast: 100, saturation: 100 };

/** A number held in range; anything that is not a number (null would count as 0) goes back to the default. */
const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** What a saved look says, made safe: anything odd goes back to the default. */
export function readLook(raw: unknown): PictureLook {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const fit: Fit = o.fit === 'cover' || o.fit === 'fill' ? o.fit : 'contain';
  return {
    fit,
    brightness: clamp(o.brightness, 50, 150, 100),
    contrast: clamp(o.contrast, 50, 150, 100),
    saturation: clamp(o.saturation, 0, 200, 100),
  };
}

/** The CSS filter for a look: "none" when nothing is changed, so the browser does no extra work for it. */
export function lookFilter(l: PictureLook): string {
  if (l.brightness === 100 && l.contrast === 100 && l.saturation === 100) return 'none';
  return `brightness(${l.brightness}%) contrast(${l.contrast}%) saturate(${l.saturation}%)`;
}

// ------------------------------------------------------------------ the time left today

/**
 * Which of the warning points (seconds left) were passed between two readings. Counting down from 400 s to 290 s passes
 * 300; a reading that goes up (a new day, more minutes given) passes none and lets the points be used again.
 */
export function warningsCrossed(before: number, after: number, points: readonly number[] = [300, 60]): number[] {
  if (after >= before) return [];
  return points.filter((p) => before > p && after <= p);
}

/**
 * The time left now, from what the bridge last said (`remaining` seconds, heard at `heardAt`). It is counted down only while
 * a stream is running: the bridge counts a day's minutes from the moment the picture starts, so a page that is only open
 * has used none. Null: no limit.
 */
export function timeLeft(s: { remaining: number | null; heardAt: number; now: number; streaming: boolean }): number | null {
  if (s.remaining === null) return null;
  return s.streaming ? Math.max(0, s.remaining - (s.now - s.heardAt) / 1000) : s.remaining;
}

/** The line a warning says. */
export function warningText(seconds: number): string {
  if (seconds <= 60) return '1분 남았습니다. 곧 연결이 끝납니다.';
  return `오늘 남은 시간이 ${Math.round(seconds / 60)}분입니다.`;
}

/** What a closed connection's reason is called for the person (the page's own words are English codes). */
export function describeClosed(detail: string): string {
  if (detail === '' || detail === 'disconnected') return '연결을 끊었습니다.';
  if (detail === 'connection failed') return '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.';
  if (detail === 'another client is connected') return '다른 기기가 이 PS5를 쓰고 있습니다.';
  return detail;
}

/** A name's first letter for the round badge: a letter, a Hangul syllable or a digit, upper-cased. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : '?';
}

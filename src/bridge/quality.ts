// SPDX-License-Identifier: AGPL-3.0-only
//
// Video quality requests. Presets are starting points built from the console-side profile fields that the
// reference client exposes (resolution, frame rate, bitrate, codec). Anything outside the console's own
// presets (for example 640x360 at 1000 kbps, below its 360p preset of 2000 kbps) is UNVERIFIED against a
// real console: it may be refused or rounded. A browser needs H.264 (HEVC decoding is not available everywhere).

export type QualityPreset = 'saver' | 'balanced' | 'low-latency' | 'quality';

export interface QualityRequest {
  preset: QualityPreset | 'custom';
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  codec: 'h264' | 'hevc';
}

export const QUALITY_PRESETS: Record<QualityPreset, QualityRequest> = {
  saver: { preset: 'saver', width: 640, height: 360, fps: 30, bitrateKbps: 1000, codec: 'h264' },
  balanced: { preset: 'balanced', width: 960, height: 540, fps: 30, bitrateKbps: 4000, codec: 'h264' },
  'low-latency': { preset: 'low-latency', width: 1280, height: 720, fps: 60, bitrateKbps: 8000, codec: 'h264' },
  quality: { preset: 'quality', width: 1920, height: 1080, fps: 60, bitrateKbps: 15000, codec: 'h264' },
};

export const DEFAULT_QUALITY: QualityRequest = QUALITY_PRESETS.balanced;

/** Validate an untrusted quality message. Missing fields fall back to the named preset (or balanced). */
export function parseQuality(input: unknown): QualityRequest | null {
  if (typeof input !== 'object' || input === null) return null;
  const m = input as Record<string, unknown>;
  const presetName = typeof m.preset === 'string' ? m.preset : 'balanced';
  const base = Object.hasOwn(QUALITY_PRESETS, presetName) ? QUALITY_PRESETS[presetName as QualityPreset] : null;
  if (!base) return null;
  const pick = (key: string, lo: number, hi: number, def: number): number | null => {
    const v = m[key];
    if (v === undefined) return def;
    return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
  };
  const width = pick('width', 320, 1920, base.width);
  const height = pick('height', 180, 1080, base.height);
  const fps = pick('fps', 15, 60, base.fps);
  const bitrateKbps = pick('bitrateKbps', 200, 30000, base.bitrateKbps);
  const codec = m.codec === undefined ? base.codec : m.codec === 'h264' || m.codec === 'hevc' ? m.codec : null;
  if (width === null || height === null || fps === null || bitrateKbps === null || codec === null) return null;
  const custom = ['width', 'height', 'fps', 'bitrateKbps', 'codec'].some((k) => m[k] !== undefined);
  return { preset: custom ? 'custom' : base.preset, width, height, fps, bitrateKbps, codec };
}

/** Data used per hour at a bitrate, in megabytes. */
export function megabytesPerHour(kbps: number): number {
  return (kbps * 3600) / 8 / 1000;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// Wire format between the browser client and the bridge. Shared by both sides (plain TypeScript, no Node APIs).
//
// Binary messages (little endian) start with a type byte. Control messages are JSON text frames.
//
//   PAD   (client -> bridge)  1 + u32 seq + u16 buttons + u8 l2 + u8 r2 + 4 x i16 sticks + u8 flags [+ 10 x f32 motion]
//   PING  (client -> bridge)  1 + f64 client time
//   VIDEO (bridge -> client)  1 + u8 codec + u8 flags + u32 frameId + u32 inputSeq + f64 ptsMs + payload
//   PONG  (bridge -> client)  1 + f64 client time + f64 bridge time

import { emptyPadState, type VirtualPadState } from '../engine/types.ts';

export const MSG = { PAD: 0x01, PING: 0x02, VIDEO: 0x10, AUDIO: 0x11, PONG: 0x12 } as const;
export const CODEC = { H264: 1, HEVC: 2, PNG: 3 } as const;

const PAD_BASE = 18;
const PAD_MOTION = 40;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const q16 = (v: number): number => Math.round(clamp(v, -1, 1) * 32767);

export function encodePad(seq: number, s: VirtualPadState, withMotion: boolean): Uint8Array {
  const out = new Uint8Array(PAD_BASE + (withMotion ? PAD_MOTION : 0));
  const v = new DataView(out.buffer);
  out[0] = MSG.PAD;
  v.setUint32(1, seq >>> 0, true);
  v.setUint16(5, s.buttons & 0xffff, true);
  out[7] = clamp(Math.round(s.l2), 0, 255);
  out[8] = clamp(Math.round(s.r2), 0, 255);
  v.setInt16(9, q16(s.leftX), true);
  v.setInt16(11, q16(s.leftY), true);
  v.setInt16(13, q16(s.rightX), true);
  v.setInt16(15, q16(s.rightY), true);
  out[17] = withMotion ? 1 : 0;
  if (withMotion) {
    const m = [s.gyro.x, s.gyro.y, s.gyro.z, s.accel.x, s.accel.y, s.accel.z, s.orient.x, s.orient.y, s.orient.z, s.orient.w];
    m.forEach((x, i) => v.setFloat32(PAD_BASE + i * 4, Number.isFinite(x) ? x : 0, true));
  }
  return out;
}

export function decodePad(buf: Uint8Array): { seq: number; state: VirtualPadState } | null {
  if (buf[0] !== MSG.PAD || (buf.length !== PAD_BASE && buf.length !== PAD_BASE + PAD_MOTION)) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const withMotion = (buf[17]! & 1) === 1;
  if (withMotion !== (buf.length === PAD_BASE + PAD_MOTION)) return null;
  const state = emptyPadState();
  state.buttons = v.getUint16(5, true);
  state.l2 = buf[7]!;
  state.r2 = buf[8]!;
  state.leftX = v.getInt16(9, true) / 32767;
  state.leftY = v.getInt16(11, true) / 32767;
  state.rightX = v.getInt16(13, true) / 32767;
  state.rightY = v.getInt16(15, true) / 32767;
  if (withMotion) {
    const f = (i: number): number => v.getFloat32(PAD_BASE + i * 4, true);
    const finite = (x: number): number => (Number.isFinite(x) ? x : 0);
    state.gyro = { x: finite(f(0)), y: finite(f(1)), z: finite(f(2)) };
    state.accel = { x: finite(f(3)), y: finite(f(4)), z: finite(f(5)) };
    state.orient = { x: finite(f(6)), y: finite(f(7)), z: finite(f(8)), w: finite(f(9)) };
  }
  return { seq: v.getUint32(1, true), state };
}

/** True when the state is the released pad (nothing pressed, sticks centred). */
export function isNeutral(s: VirtualPadState): boolean {
  return s.buttons === 0 && s.l2 === 0 && s.r2 === 0 && Math.abs(s.leftX) < 0.0001 && Math.abs(s.leftY) < 0.0001 && Math.abs(s.rightX) < 0.0001 && Math.abs(s.rightY) < 0.0001;
}

export interface VideoHeader {
  codec: number;
  key: boolean;
  frameId: number;
  /** Highest PAD sequence the source had applied when this frame was produced. 0 = unknown. */
  inputSeq: number;
  ptsMs: number;
}

const VIDEO_HEADER = 19;

export function encodeVideo(h: VideoHeader, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(VIDEO_HEADER + payload.length);
  const v = new DataView(out.buffer);
  out[0] = MSG.VIDEO;
  out[1] = h.codec;
  out[2] = h.key ? 1 : 0;
  v.setUint32(3, h.frameId >>> 0, true);
  v.setUint32(7, h.inputSeq >>> 0, true);
  v.setFloat64(11, h.ptsMs, true);
  out.set(payload, VIDEO_HEADER);
  return out;
}

export function decodeVideo(buf: Uint8Array): { header: VideoHeader; payload: Uint8Array } | null {
  if (buf[0] !== MSG.VIDEO || buf.length < VIDEO_HEADER) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    header: { codec: buf[1]!, key: (buf[2]! & 1) === 1, frameId: v.getUint32(3, true), inputSeq: v.getUint32(7, true), ptsMs: v.getFloat64(11, true) },
    payload: buf.subarray(VIDEO_HEADER),
  };
}

export function encodePing(clientTime: number): Uint8Array {
  const out = new Uint8Array(9);
  out[0] = MSG.PING;
  new DataView(out.buffer).setFloat64(1, clientTime, true);
  return out;
}

export function decodePing(buf: Uint8Array): number | null {
  return buf[0] === MSG.PING && buf.length === 9 ? new DataView(buf.buffer, buf.byteOffset, 9).getFloat64(1, true) : null;
}

export function encodePong(clientTime: number, bridgeTime: number): Uint8Array {
  const out = new Uint8Array(17);
  out[0] = MSG.PONG;
  const v = new DataView(out.buffer);
  v.setFloat64(1, clientTime, true);
  v.setFloat64(9, bridgeTime, true);
  return out;
}

export function decodePong(buf: Uint8Array): { clientTime: number; bridgeTime: number } | null {
  if (buf[0] !== MSG.PONG || buf.length !== 17) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, 17);
  return { clientTime: v.getFloat64(1, true), bridgeTime: v.getFloat64(9, true) };
}

// ------------------------------------------------------------------ control messages (JSON text frames)

export type ClientControl =
  | { type: 'hello'; token?: string; client: string }
  | { type: 'quality'; preset?: string; width?: number; height?: number; fps?: number; bitrateKbps?: number; codec?: string }
  | { type: 'keyframe' }
  | { type: 'bye' };

export type ServerControl =
  | { type: 'ready'; link: string; quality: unknown }
  | { type: 'status'; state: string; detail?: string }
  | { type: 'stats'; [key: string]: unknown }
  | { type: 'error'; code: string; message: string };

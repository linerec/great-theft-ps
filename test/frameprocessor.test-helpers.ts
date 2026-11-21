// SPDX-License-Identifier: AGPL-3.0-only
//
// Test helpers shared by test/frameprocessor.test.ts and test/videoreceiver.test.ts: cutting a frame into the units a
// console would send (as the frame processor of chiaki-ng, lib/src/frameprocessor.c at commit 43728af, expects them)
// and adding FEC units with this port's own encoder.
//
// STATUS: written for this port. The unit layout is what the reference's receiving code implies, not something
// recorded from a console.

import type { TakionAvPacket } from '../src/console/av-packet.ts';
import { fecEncode } from '../src/console/fec.ts';

/** A small deterministic generator (xorshift32), so that failures can be reproduced. */
export function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

export function randomBytes(rnd: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rnd() & 0xff;
  return out;
}

export function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rnd() % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function makePacket(p: Partial<TakionAvPacket> & { data: Uint8Array }): TakionAvPacket {
  return {
    packetIndex: 0, frameIndex: 0, usesNaluInfoStructs: false, isVideo: true, isHaptics: false, unitIndex: 0,
    unitsInFrameTotal: 1, unitsInFrameFec: 0, codec: 0, wordAt0x18: 0, adaptiveStreamIndex: 0, byteAt0x2c: 0, keyPos: 0n,
    ...p,
  };
}

export interface PacketizeOptions {
  frameIndex: number;
  /** Size of a unit slot: 2 bytes of header plus payload. */
  unitSize: number;
  fecUnits: number;
  adaptiveStreamIndex?: number;
  /** Payload bytes of each source unit, to cut the frame unevenly. Default: full units, the last one shorter. */
  chunkSizes?: number[];
  /** What to put in unitsInFrameFec, when it should differ from the number of FEC units made (for a frame without FEC). */
  announcedFecUnits?: number;
}

/**
 * Cuts a frame into source units and adds FEC units: one packet per unit, source units first. Each source unit is a
 * slot of `unitSize` bytes: 2 bytes big endian saying how much padding the slot has at its end, the payload, zeros.
 * The packet of a source unit leaves the padding out; FEC units are computed over whole slots and sent whole.
 */
export function packetizeFrame(frame: Uint8Array, opts: PacketizeOptions): TakionAvPacket[] {
  const payloadMax = opts.unitSize - 2;
  let chunkSizes = opts.chunkSizes;
  if (!chunkSizes) {
    chunkSizes = [];
    for (let left = frame.length; left > 0; left -= payloadMax) chunkSizes.push(Math.min(left, payloadMax));
    if (chunkSizes.length === 0) chunkSizes.push(0);
  }
  if (chunkSizes.reduce((a, b) => a + b, 0) !== frame.length) throw new Error('chunk sizes do not add up to the frame');

  const k = chunkSizes.length;
  const m = opts.fecUnits;
  const slots = new Uint8Array((k + m) * opts.unitSize);
  const paddings: number[] = [];
  let pos = 0;
  for (let i = 0; i < k; i++) {
    const size = chunkSizes[i]!;
    if (size > payloadMax) throw new Error('chunk larger than a unit');
    const padding = payloadMax - size;
    paddings.push(padding);
    slots[i * opts.unitSize] = padding >> 8;
    slots[i * opts.unitSize + 1] = padding & 0xff;
    slots.set(frame.subarray(pos, pos + size), i * opts.unitSize + 2);
    pos += size;
  }
  if (m > 0 && fecEncode(slots, opts.unitSize, opts.unitSize, k, m) !== 'success') throw new Error('FEC encoding failed');

  const packets: TakionAvPacket[] = [];
  for (let i = 0; i < k + m; i++) {
    const end = i < k ? (i + 1) * opts.unitSize - paddings[i]! : (i + 1) * opts.unitSize;
    packets.push(makePacket({
      packetIndex: i,
      frameIndex: opts.frameIndex,
      unitIndex: i,
      unitsInFrameTotal: k + (opts.announcedFecUnits ?? m),
      unitsInFrameFec: opts.announcedFecUnits ?? m,
      adaptiveStreamIndex: opts.adaptiveStreamIndex ?? 0,
      data: slots.slice(i * opts.unitSize, end),
    }));
  }
  return packets;
}

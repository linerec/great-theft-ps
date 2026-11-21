// SPDX-License-Identifier: AGPL-3.0-only
//
// One audio or video packet as the transport hands it to the receivers. Shared by the Takion transport (which parses
// it off the wire) and the video and audio receivers (which assemble frames from it).
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/include/chiaki/takion.h, ChiakiTakionAVPacket
// (commit 43728af). Field names follow the reference, in camelCase.

export interface TakionAvPacket {
  packetIndex: number; // 16 bit sequence number
  frameIndex: number; // 16 bit sequence number
  usesNaluInfoStructs: boolean;
  isVideo: boolean;
  isHaptics: boolean;
  unitIndex: number; // 16 bit sequence number
  /** Source units plus FEC units. */
  unitsInFrameTotal: number;
  unitsInFrameFec: number;
  codec: number;
  wordAt0x18: number;
  adaptiveStreamIndex: number;
  byteAt0x2c: number;
  keyPos: bigint;
  /** The payload. A view into the datagram: copy it if it must outlive the callback. */
  data: Uint8Array;
}

/** For audio packets the three counts are packed into unitsInFrameFec. */
export const avAudioUnitSize = (p: TakionAvPacket): number => p.unitsInFrameFec >> 8;
export const avAudioSourceUnitsCount = (p: TakionAvPacket): number => p.unitsInFrameFec & 0xf;
export const avAudioFecUnitsCount = (p: TakionAvPacket): number => (p.unitsInFrameFec >> 4) & 0xf;

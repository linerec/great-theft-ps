// SPDX-License-Identifier: AGPL-3.0-only
//
// From audio packets to a steady series of Opus frames. Port of the audio receiver of chiaki-ng, with the audio header.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/audioreceiver.c and
// lib/include/chiaki/audioreceiver.h, lib/include/chiaki/audio.h and lib/src/audio.c (commit 43728af); the dispatch of
// audio and haptics packets is stream_connection_takion_av() in lib/src/streamconnection.c. See NOTICE.md.
//
// What arrives: an audio AV packet carries `source units` Opus frames in a row (frame numbers frameIndex, +1, ...) and
// `fec units`, which are copies of the frames just BEFORE them (frameIndex - fec ... frameIndex - 1), so that a packet
// lost on its own is made good by the one after it. Every unit has the same size. Packets can arrive out of order and
// twice. The receiver keeps up to 8 frames in a small jitter buffer, starts delivering once 3 are in, and hands the
// frames out in order. A frame that never came is announced as `null` once enough later frames are waiting, so that the
// decoder can conceal the gap instead of the sound stopping.
//
// Differences to the reference:
//  - the packets of the haptics channel (the controller's vibration, sent the same way) are dropped, because nothing in
//    this project plays them. The reference sends them to a second receiver of its own;
//  - inside one packet the copies of older frames are taken BEFORE the packet's own frames (see avPacket). The reference
//    takes its own frames first, so a frame missing just before them is given up before the copy of it is looked at.
//
// What the reference's rule means in practice: once delivery has started, a gap is announced as soon as ANY later frame
// is waiting while fewer than 3 are (which is nearly always). A frame that arrives after its successor is therefore too
// late and is dropped. Only the very first frames, before delivery starts, are put in order by waiting.
//
// STATUS: checked against tests written from the same reading of the C source (test/audioreceiver.test.ts). The reference
// has no test of its own for it. NOT yet run against a real console.

import type { TakionAvPacket } from './av-packet.ts';
import { avAudioFecUnitsCount, avAudioSourceUnitsCount, avAudioUnitSize } from './av-packet.ts';
import type { PacketStats } from './packetstats.ts';
import { seqNum16Gt, seqNum16Lt } from './seqnum.ts';

export const AUDIO_HEADER_SIZE = 0xe;
/** Frames that must be waiting before delivery starts. */
export const AUDIO_JITTER_PREFILL = 3;
/** The most frames kept waiting. */
export const AUDIO_JITTER_BUFFER_SIZE = 8;
/** The codec number of audio AV packets (Opus). */
const AUDIO_CODEC = 5;

export interface AudioHeader {
  channels: number;
  bits: number;
  /** Samples per second. */
  rate: number;
  /** Samples per channel in one Opus frame. */
  frameSize: number;
  unknown: number;
}

/** chiaki_audio_header_load(): channels, bits, then rate, frame size and one more number as 32 bit big endian. */
export function parseAudioHeader(bytes: Uint8Array): AudioHeader {
  if (bytes.length !== AUDIO_HEADER_SIZE) throw new Error(`an audio header is ${AUDIO_HEADER_SIZE} bytes, not ${bytes.length}`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { channels: bytes[0]!, bits: bytes[1]!, rate: v.getUint32(2, false), frameSize: v.getUint32(6, false), unknown: v.getUint32(10, false) };
}

export interface AudioReceiverOptions {
  /** Counts the packets for the congestion report the console gets (the reference does this for audio too). */
  packetStats?: Pick<PacketStats, 'pushSeq'>;
  /** The stream's audio header, when the stream info arrives. */
  onHeader?: (header: AudioHeader) => void;
  /** The next Opus frame in order, or null when a frame is missing and the decoder should conceal it. */
  onFrame: (frame: Uint8Array | null) => void;
  log?: (line: string) => void;
}

interface Slot {
  frameIndex: number;
  buf: Uint8Array;
}

export class AudioReceiver {
  #o: AudioReceiverOptions;
  #slots: Array<Slot | null> = new Array(AUDIO_JITTER_BUFFER_SIZE).fill(null);
  #count = 0;
  #next = 0;
  #nextValid = false;
  #started = false;
  /** Whether the frame numbers have definitely not wrapped yet (they start near 0). */
  #startup = true;

  constructor(options: AudioReceiverOptions) {
    this.#o = options;
  }

  /** How many frames wait for their turn. */
  get buffered(): number {
    return this.#count;
  }

  /** The stream info arrived: a new stream starts, whatever was waiting is forgotten. */
  streamInfo(header: AudioHeader): void {
    this.#reset();
    this.#o.onHeader?.(header);
  }

  #reset(): void {
    this.#next = 0;
    this.#nextValid = false;
    this.#started = false;
    this.#startup = true;
    this.#slots.fill(null);
    this.#count = 0;
  }

  /** chiaki_audio_receiver_av_packet(). */
  avPacket(packet: TakionAvPacket): void {
    if (packet.isHaptics) return; // see the header: not played here
    const log = this.#o.log ?? (() => {});
    if (packet.codec !== AUDIO_CODEC) return log('Received an audio packet with an unknown codec');
    const sourceUnits = avAudioSourceUnitsCount(packet);
    const fecUnits = avAudioFecUnitsCount(packet);
    const unitSize = avAudioUnitSize(packet);
    if (packet.data.length === 0) return log('An audio packet is empty');
    if (fecUnits + sourceUnits !== packet.unitsInFrameTotal) return log('Source units and FEC units do not add up to the units in an audio packet');
    if (packet.data.length !== unitSize * packet.unitsInFrameTotal) return log(`An audio packet has ${packet.data.length} bytes, not ${unitSize * packet.unitsInFrameTotal}`);

    if (packet.frameIndex > 1 << 15) this.#startup = false;
    const unitAt = (i: number): Uint8Array => packet.data.subarray(unitSize * i, unitSize * (i + 1));
    // The copies are the OLDER frames, so they go in first, then the packet's own frames: in the order of the frame
    // numbers. (The reference takes its own frames first. By the time the copies come, a gap just before them has been
    // given up already, and the copy is too late: the copies would never make anything good.)
    for (let f = 0; f < fecUnits; f++) {
      if (this.#startup && packet.frameIndex + f < fecUnits + 1) continue; // copies of frames from before the start
      this.#frame((packet.frameIndex - fecUnits + f) & 0xffff, unitAt(sourceUnits + f));
    }
    for (let i = 0; i < sourceUnits; i++) this.#frame((packet.frameIndex + i) & 0xffff, unitAt(i));
    this.#o.packetStats?.pushSeq(packet.frameIndex);
  }

  /** chiaki_audio_receiver_frame(): keep the frame, then hand out every frame that is next in line. */
  #frame(frameIndex: number, unit: Uint8Array | null): void {
    let buf = unit;
    for (;;) {
      if (buf) {
        if (this.#nextValid && seqNum16Lt(frameIndex, this.#next)) return; // too late, its turn has passed
        if (!this.#store(frameIndex, buf)) return;
        buf = null;
      }

      if (!this.#started && this.#count >= AUDIO_JITTER_PREFILL) {
        const oldest = this.#oldest();
        if (oldest >= 0) {
          this.#next = this.#slots[oldest]!.frameIndex;
          this.#nextValid = true;
          this.#started = true;
        }
      }

      let deliver: { frame: Uint8Array | null } | null = null;
      if (this.#started && this.#nextValid) {
        const slot = this.#find(this.#next);
        if (slot >= 0) {
          deliver = { frame: this.#slots[slot]!.buf };
          this.#slots[slot] = null;
          this.#count--;
          this.#next = (this.#next + 1) & 0xffff;
        } else if (this.#count > 0) {
          // The frame whose turn it is did not come. If later ones are waiting, say so once, so that the sound goes on.
          const oldest = this.#oldest();
          const newest = this.#newest();
          const newerWaiting = oldest >= 0 && seqNum16Gt(this.#slots[oldest]!.frameIndex, this.#next);
          let canConceal = false;
          if (newerWaiting && newest >= 0) {
            if (this.#count >= AUDIO_JITTER_PREFILL) {
              const requiredLookahead = (this.#next + AUDIO_JITTER_PREFILL) & 0xffff;
              canConceal = seqNum16Gt(this.#slots[newest]!.frameIndex, (requiredLookahead - 1) & 0xffff);
            } else canConceal = true;
          }
          if (canConceal) {
            deliver = { frame: null };
            this.#next = (this.#next + 1) & 0xffff;
          }
        }
      }
      if (!deliver) return;
      this.#o.onFrame(deliver.frame);
    }
  }

  #find(frameIndex: number): number {
    for (let i = 0; i < AUDIO_JITTER_BUFFER_SIZE; i++) if (this.#slots[i]?.frameIndex === frameIndex) return i;
    return -1;
  }

  #oldest(): number {
    let best = -1;
    for (let i = 0; i < AUDIO_JITTER_BUFFER_SIZE; i++) {
      const s = this.#slots[i];
      if (s && (best < 0 || seqNum16Lt(s.frameIndex, this.#slots[best]!.frameIndex))) best = i;
    }
    return best;
  }

  #newest(): number {
    let best = -1;
    for (let i = 0; i < AUDIO_JITTER_BUFFER_SIZE; i++) {
      const s = this.#slots[i];
      if (s && (best < 0 || seqNum16Gt(s.frameIndex, this.#slots[best]!.frameIndex))) best = i;
    }
    return best;
  }

  /** Keep a copy (the unit is a view into the datagram). False for a frame already kept, or one that does not fit. */
  #store(frameIndex: number, buf: Uint8Array): boolean {
    if (this.#find(frameIndex) >= 0) return false;
    let free = this.#slots.indexOf(null);
    if (free < 0) {
      // Full: the newest frame makes room, but only for an older one. A newer one than everything waiting is dropped.
      const newest = this.#newest();
      if (newest < 0 || !seqNum16Lt(frameIndex, this.#slots[newest]!.frameIndex)) return false;
      this.#slots[newest] = null;
      this.#count--;
      free = newest;
    }
    this.#slots[free] = { frameIndex, buf: Uint8Array.from(buf) };
    this.#count++;
    return true;
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// Putting one frame together from its units. The console cuts a frame into source units and adds FEC units; each
// arrives in its own packet. This collects them, rebuilds missing source units from the FEC units where enough
// arrived, and hands out the frame's bytes.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/frameprocessor.c and
// lib/include/chiaki/frameprocessor.h, and CHIAKI_VIDEO_BUFFER_PADDING_SIZE from lib/include/chiaki/video.h
// (commit 43728af).
//
// The unit format, as the reference reads it:
//   - Every unit of a frame is one slot of `bufSizePerUnit` bytes. FEC is computed over whole slots.
//   - A source unit starts with a 2 byte big endian number: how many bytes of padding its slot has at the end. The
//     packet carries the slot without that padding, so the slot size is the packet's size plus that number. The
//     frame's bytes are what is left: everything after those 2 bytes, up to the padding. (At this commit the frame
//     processor does nothing else per unit; in particular it does not look at `usesNaluInfoStructs`.)
//   - A FEC unit is a whole slot. A source unit rebuilt from FEC units is a whole slot too, and its first 2 bytes say
//     how much of it is padding.
//   - The first packet of a frame that arrives decides the slot size and the unit counts for the whole frame.
//
// Differences to the C code, all in situations a console does not produce:
//   - Where C would read or write outside its buffers after allocFrame() has failed half way (a packet announcing
//     more than 512 units), the unit is refused or the FEC step fails instead.
//   - malloc failures and the size_t overflow check have no counterpart here, so the reference's CHIAKI_ERR_MEMORY
//     and CHIAKI_ERR_OVERFLOW are not among the answers.
// Kept as in the reference: a frame of more than 256 units cannot use FEC at all (the field has 256 elements, the
// coding matrix cannot be made, and a single lost unit loses the frame); a frame of more than 512 units is refused.
//
// STATUS: the reference has no test for this file. Checked by tests written for this port (test/frameprocessor.test.ts)
// with frames cut into units and FEC units made by this port's own encoder; that encoder agrees byte for byte with
// the FEC units in the reference's vectors (test/fec.test.ts). The unit format itself is taken from reading the C code;
// it has not been checked against packets from a real console.

import type { TakionAvPacket } from './av-packet.ts';
import { fecDecode } from './fec.ts';
import type { PacketStats } from './packetstats.ts';

/** CHIAKI_VIDEO_BUFFER_PADDING_SIZE: spare bytes behind the frame buffer (the reference keeps them for FFmpeg). */
export const VIDEO_BUFFER_PADDING_SIZE = 64;

const UNIT_SLOTS_MAX = 512;

/** ChiakiStreamStats: frames and bytes that came out of a frame processor since the last reset. */
export class StreamStats {
  frames = 0;
  bytes = 0;

  /** chiaki_stream_stats_reset. */
  reset(): void {
    this.frames = 0;
    this.bytes = 0;
  }

  /** chiaki_stream_stats_frame. */
  frame(size: number): void {
    this.frames++;
    this.bytes += size;
  }

  /** chiaki_stream_stats_bitrate: bits per second at the given frame rate (integer division, as in C). */
  bitrate(framerate: number): number {
    if (this.frames === 0) return 0;
    return Math.floor((this.bytes * 8 * framerate) / this.frames);
  }
}

/** ChiakiFrameProcessorFlushResult. */
export const FRAME_PROCESSOR_FLUSH_RESULT = {
  /** All source units were there. */
  SUCCESS: 0,
  /** Source units were missing and were rebuilt from FEC units. */
  FEC_SUCCESS: 1,
  /** Source units were missing and too few units arrived to rebuild them. The frame handed out has holes. */
  FEC_FAILED: 2,
  /** Nothing to flush: no frame was allocated. */
  FAILED: 3,
} as const;
export type FrameProcessorFlushResult = (typeof FRAME_PROCESSOR_FLUSH_RESULT)[keyof typeof FRAME_PROCESSOR_FLUSH_RESULT];

/** The reference's error codes for allocFrame() and putUnit(): CHIAKI_ERR_SUCCESS, _INVALID_DATA, _BUF_TOO_SMALL. */
export type FrameProcessorError = 'success' | 'invalid-data' | 'buf-too-small';

export interface FrameProcessorFlush {
  result: FrameProcessorFlushResult;
  /**
   * The frame's bytes: a view into the frame processor's own buffer (empty for FAILED). It is only good until the
   * next call to this frame processor; copy it to keep it.
   */
  frame: Uint8Array;
  frameSize: number;
}

const EMPTY = new Uint8Array(0);

/** ChiakiFrameProcessor. */
export class FrameProcessor {
  log: ((line: string) => void) | null;
  frameBuf: Uint8Array | null = null;
  frameBufSize = 0;
  bufSizePerUnit = 0;
  bufStridePerUnit = 0;
  unitsSourceExpected = 0;
  unitsFecExpected = 0;
  unitsSourceReceived = 0;
  unitsFecReceived = 0;
  /** One entry per unit: the size of the data received for it, 0 while it is missing (ChiakiFrameUnit.data_size). */
  unitSlots: Uint32Array | null = null;
  unitSlotsSize = 0;
  /** whether we have already flushed the current frame, i.e. are only interested in stats, not data. */
  flushed = true;
  streamStats = new StreamStats();

  /** chiaki_frame_processor_init. */
  constructor(log?: (line: string) => void) {
    this.log = log ?? null;
  }

  #log(line: string): void {
    this.log?.(line);
  }

  /**
   * chiaki_frame_processor_alloc_frame: starts a new frame, sized from the first packet of it that arrived. On an
   * error the state is left changed as far as the reference had got, which is what the next putUnit() then meets.
   */
  allocFrame(packet: TakionAvPacket): FrameProcessorError {
    if (packet.unitsInFrameTotal < packet.unitsInFrameFec) {
      this.#log('Packet has units_in_frame_total < units_in_frame_fec');
      return 'invalid-data';
    }

    this.flushed = false;
    this.unitsSourceExpected = packet.unitsInFrameTotal - packet.unitsInFrameFec;
    this.unitsFecExpected = packet.unitsInFrameFec;
    if (this.unitsFecExpected < 1) this.unitsFecExpected = 1;

    this.bufSizePerUnit = packet.data.length;
    if (packet.isVideo && packet.unitIndex < this.unitsSourceExpected) {
      if (packet.data.length < 2) {
        this.#log('Packet too small to read buf size extension');
        return 'buf-too-small';
      }
      this.bufSizePerUnit += (packet.data[0]! << 8) | packet.data[1]!;
    }
    this.bufStridePerUnit = Math.floor((this.bufSizePerUnit + 0xf) / 0x10) * 0x10;

    if (this.bufSizePerUnit === 0) {
      this.#log("Frame Processor doesn't handle empty units");
      return 'buf-too-small';
    }

    this.unitsSourceReceived = 0;
    this.unitsFecReceived = 0;

    const unitSlotsSizeRequired = this.unitsSourceExpected + this.unitsFecExpected;
    if (unitSlotsSizeRequired > UNIT_SLOTS_MAX) {
      this.#log(`Packet suggests more than ${UNIT_SLOTS_MAX} unit slots`);
      return 'invalid-data';
    }
    if (unitSlotsSizeRequired !== this.unitSlotsSize || this.unitSlots === null) {
      this.unitSlots = new Uint32Array(unitSlotsSizeRequired);
      this.unitSlotsSize = unitSlotsSizeRequired;
    }
    this.unitSlots.fill(0);

    const frameBufSizeRequired = this.unitSlotsSize * this.bufStridePerUnit;
    if (this.frameBufSize < frameBufSizeRequired || this.frameBuf === null) {
      this.frameBuf = new Uint8Array(frameBufSizeRequired + VIDEO_BUFFER_PADDING_SIZE);
      this.frameBufSize = frameBufSizeRequired;
    }
    this.frameBuf.fill(0, 0, frameBufSizeRequired + VIDEO_BUFFER_PADDING_SIZE);

    return 'success';
  }

  /** chiaki_frame_processor_put_unit: stores one unit of the current frame. A unit that is already there is refused. */
  putUnit(packet: TakionAvPacket): FrameProcessorError {
    if (packet.unitIndex >= packet.unitsInFrameTotal) {
      this.#log("Packet's unit index is outside frame unit count");
      return 'invalid-data';
    }

    if (packet.unitIndex >= this.unitSlotsSize || this.unitSlots === null) {
      this.#log("Packet's unit index is too high");
      return 'invalid-data';
    }

    const dataSize = packet.data.length;
    if (!dataSize) {
      this.#log('Unit is empty');
      return 'invalid-data';
    }

    if (dataSize > this.bufSizePerUnit) {
      this.#log('Unit is bigger than pre-calculated size!');
      return 'invalid-data';
    }

    if (this.unitSlots[packet.unitIndex]) {
      this.#log('Received duplicate unit');
      return 'invalid-data';
    }

    if (!this.flushed) {
      const offset = packet.unitIndex * this.bufStridePerUnit;
      if (this.frameBuf === null || offset + dataSize > this.frameBuf.length) {
        // Only after a failed allocFrame(). C writes outside its buffer here.
        this.#log('Unit does not fit the frame buffer');
        return 'invalid-data';
      }
      this.frameBuf.set(packet.data, offset);
    }
    this.unitSlots[packet.unitIndex] = dataSize;

    if (packet.unitIndex < this.unitsSourceExpected) this.unitsSourceReceived++;
    else this.unitsFecReceived++;

    return 'success';
  }

  /** chiaki_frame_processor_report_packet_stats: adds this frame's received and missing units to the statistics. */
  reportPacketStats(packetStats: PacketStats): void {
    const received = this.unitsSourceReceived + this.unitsFecReceived;
    const expected = this.unitsSourceExpected + this.unitsFecExpected;
    packetStats.pushGeneration(received, expected - received);
  }

  /** chiaki_frame_processor_fec. True when the missing source units were rebuilt. */
  #fec(): boolean {
    this.#log(
      `Frame Processor received ${this.unitsSourceReceived}+${this.unitsFecReceived} / ${this.unitsSourceExpected}+${this.unitsFecExpected} units, attempting FEC`,
    );

    const total = this.unitsSourceExpected + this.unitsFecExpected;
    const erasuresCount = total - (this.unitsSourceReceived + this.unitsFecReceived);
    const slots = this.unitSlots;
    const frameBuf = this.frameBuf;
    if (
      erasuresCount < 0 || slots === null || frameBuf === null || this.unitSlotsSize < total
      || frameBuf.length < total * this.bufStridePerUnit
    ) {
      // Only after a failed allocFrame(). C fails to allocate or reads outside its buffers here.
      this.#log('FEC failed');
      return false;
    }
    const erasures = new Array<number>(erasuresCount).fill(0); // calloc

    let erasureIndex = 0;
    for (let i = 0; i < total; i++) {
      if (!slots[i]) {
        if (erasureIndex >= erasuresCount) {
          // should never happen by design, but too scary not to check
          this.#log('FEC failed');
          return false;
        }
        erasures[erasureIndex++] = i;
      }
    }

    const err = fecDecode(frameBuf, this.bufSizePerUnit, this.bufStridePerUnit, this.unitsSourceExpected, this.unitsFecExpected, erasures);

    if (err !== 'success') {
      this.#log('FEC failed');
      return false;
    }
    this.#log('FEC successful');

    // restore unit sizes
    for (let i = 0; i < this.unitsSourceExpected; i++) {
      const bufPtr = this.bufStridePerUnit * i;
      const padding = (frameBuf[bufPtr]! << 8) | frameBuf[bufPtr + 1]!;
      if (padding >= this.bufSizePerUnit) {
        this.#log(`Padding in unit (0x${padding.toString(16)}) is larger or equals to the whole unit size (0x${this.bufSizePerUnit.toString(16)})`);
        continue;
      }
      slots[i] = this.bufSizePerUnit - padding;
    }
    return true;
  }

  /**
   * chiaki_frame_processor_flush: rebuilds missing source units if it has to and can, then moves the payloads of the
   * source units together at the start of the buffer. With FEC_FAILED the missing units are simply left out.
   */
  flush(): FrameProcessorFlush {
    if (this.unitsSourceExpected === 0 || this.flushed) return { result: FRAME_PROCESSOR_FLUSH_RESULT.FAILED, frame: EMPTY, frameSize: 0 };

    let result: FrameProcessorFlushResult = FRAME_PROCESSOR_FLUSH_RESULT.SUCCESS;
    if (this.unitsSourceReceived < this.unitsSourceExpected) {
      result = this.#fec() ? FRAME_PROCESSOR_FLUSH_RESULT.FEC_SUCCESS : FRAME_PROCESSOR_FLUSH_RESULT.FEC_FAILED;
    }

    const frameBuf = this.frameBuf;
    const slots = this.unitSlots;
    let cur = 0;
    if (frameBuf !== null && slots !== null) {
      for (let i = 0; i < this.unitsSourceExpected; i++) {
        const dataSize = slots[i] ?? 0;
        if (!dataSize) {
          this.#log(`Missing unit 0x${i.toString(16)}`);
          continue;
        }
        if (dataSize < 2) {
          this.#log('Saved unit has size < 2');
          continue;
        }
        const partSize = dataSize - 2;
        const bufPtr = i * this.bufStridePerUnit;
        frameBuf.copyWithin(cur, bufPtr + 2, bufPtr + 2 + partSize); // memmove
        cur += partSize;
      }
    }

    this.streamStats.frame(cur);

    return { result, frame: frameBuf === null ? EMPTY : frameBuf.subarray(0, cur), frameSize: cur };
  }

  /** chiaki_frame_processor_flush_possible: as many units arrived as the frame has source units. */
  flushPossible(): boolean {
    return this.unitsSourceReceived + this.unitsFecReceived >= this.unitsSourceExpected;
  }
}

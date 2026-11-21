// SPDX-License-Identifier: AGPL-3.0-only
//
// Counting received and lost packets, for the congestion control reports sent to the console. Two kinds of counting
// feed one pair of numbers: "generations" (a video frame: so many units expected, so many arrived) and sequence
// numbers (audio: the highest number seen against how many arrived).
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/packetstats.c and
// lib/include/chiaki/packetstats.h (commit 43728af). The mutex of the reference is not needed here (one thread).
//
// The counters are uint64_t in C and are BigInt here, because one of the reference's sums relies on wrapping:
//   - get() takes `seq_max - seq_min` as a 64 bit number. Both are 16 bit sequence numbers, and when the sequence
//     number has wrapped around since the last reset (max < min) the difference is negative, which as uint64_t is a
//     number near 2^64. The comment in the reference says "overflow on purpose", but the result is a huge loss count
//     for that one reading, not the 16 bit difference. Kept as it is; whoever reports the numbers clamps them (the
//     reference's congestion control does, see congestioncontrol.c).
//
// STATUS: the reference has no test for this file. Checked only by tests written for this port
// (test/frameprocessor.test.ts), against values worked out by hand from the C code. Not run against a real console.

import { seqNum16Gt, type SeqNum16 } from './seqnum.ts';

const u64 = (v: bigint): bigint => BigInt.asUintN(64, v);

/** ChiakiPacketStats. */
export class PacketStats {
  // For generations of packets, i.e. where we know the number of expected packets per generation
  genReceived = 0n;
  genLost = 0n;

  // For sequential packets, i.e. where packets are identified by a sequence number
  /** sequence number that was max at the last reset */
  seqMin: SeqNum16 = 0;
  /** currently maximal sequence number */
  seqMax: SeqNum16 = 0;
  /** total received packets since the last reset */
  seqReceived = 0n;

  /** chiaki_packet_stats_reset. */
  reset(): void {
    this.genReceived = 0n;
    this.genLost = 0n;
    this.seqMin = this.seqMax;
    this.seqReceived = 0n;
  }

  /** chiaki_packet_stats_push_generation: one frame's worth of units. Both numbers are taken as uint64_t. */
  pushGeneration(received: bigint | number, lost: bigint | number): void {
    this.genReceived = u64(this.genReceived + BigInt(received));
    this.genLost = u64(this.genLost + BigInt(lost));
  }

  /** chiaki_packet_stats_push_seq: one packet with a 16 bit sequence number. */
  pushSeq(seqNum: SeqNum16): void {
    this.seqReceived = u64(this.seqReceived + 1n);
    if (seqNum16Gt(seqNum, this.seqMax)) this.seqMax = seqNum & 0xffff;
  }

  /** chiaki_packet_stats_get: the totals since the last reset, as uint64_t values; optionally resets. */
  get(reset: boolean): { received: bigint; lost: bigint } {
    // gen
    let received = this.genReceived;
    let lost = this.genLost;

    // seq
    const seqDiff = u64(BigInt(this.seqMax - this.seqMin)); // a number near 2^64 when max < min, see the header
    const seqLost = this.seqReceived > seqDiff ? seqDiff : seqDiff - this.seqReceived;
    received = u64(received + this.seqReceived);
    lost = u64(lost + seqLost);

    if (reset) this.reset();
    return { received, lost };
  }
}

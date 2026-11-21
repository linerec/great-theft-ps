// SPDX-License-Identifier: AGPL-3.0-only
//
// Comparing sequence numbers that wrap around (RFC 1982 serial number arithmetic), 16 and 32 bits wide.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/include/chiaki/seqnum.h (commit 43728af). The
// two comparisons are transcribed from the CHIAKI_DEFINE_SEQNUM macro: the difference is taken in a wider signed type,
// and at exactly half the number space neither "less" nor "greater" holds.
//
// STATUS: checked against the reference implementation's own tests (test/seqnum.c, ported to test/seqnum.test.ts).

/** ChiakiSeqNum16 and ChiakiSeqNum32 are plain numbers here: 0..0xffff and 0..0xffffffff. */
export type SeqNum16 = number;
export type SeqNum32 = number;

const HALF_16 = 0x8000;
const HALF_32 = 0x80000000;

/** chiaki_seq_num_16_lt: a comes before b. Arguments are reduced to 16 bits, as the C parameter type does. */
export function seqNum16Lt(a: SeqNum16, b: SeqNum16): boolean {
  a &= 0xffff;
  b &= 0xffff;
  if (a === b) return false;
  const d = b - a;
  return (a < b && d < HALF_16) || (a > b && -d > HALF_16);
}

/** chiaki_seq_num_16_gt: a comes after b. */
export function seqNum16Gt(a: SeqNum16, b: SeqNum16): boolean {
  a &= 0xffff;
  b &= 0xffff;
  if (a === b) return false;
  const d = b - a;
  return (a < b && d > HALF_16) || (a > b && -d < HALF_16);
}

/** chiaki_seq_num_32_lt: a comes before b. Arguments are reduced to 32 bits. */
export function seqNum32Lt(a: SeqNum32, b: SeqNum32): boolean {
  a >>>= 0;
  b >>>= 0;
  if (a === b) return false;
  const d = b - a; // exact: both are below 2^32, far inside the range of a double
  return (a < b && d < HALF_32) || (a > b && -d > HALF_32);
}

/** chiaki_seq_num_32_gt: a comes after b. */
export function seqNum32Gt(a: SeqNum32, b: SeqNum32): boolean {
  a >>>= 0;
  b >>>= 0;
  if (a === b) return false;
  const d = b - a;
  return (a < b && d > HALF_32) || (a > b && -d < HALF_32);
}

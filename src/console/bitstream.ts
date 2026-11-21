// SPDX-License-Identifier: AGPL-3.0-only
//
// Just enough H.264 / H.265 parsing to follow reference frames: one value from the sequence parameter set, and from
// the first slice of a frame its type (I or P) and which earlier frame it refers to. For H.265 a slice can also be
// rewritten in place to refer to another earlier frame, which is how the receiver survives a lost frame.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/bitstream.c and
// lib/include/chiaki/bitstream.h (commit 43728af), and from the bit reader it includes, lib/src/vl_rbsp.h, which
// comes from Mesa and carries this notice:
//
//   Copyright 2013 Advanced Micro Devices, Inc.
//   All Rights Reserved.
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sub license, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to
//   the following conditions:
//
//   The above copyright notice and this permission notice (including the
//   next paragraph) shall be included in all copies or substantial portions
//   of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
//   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
//   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT.
//   IN NO EVENT SHALL THE COPYRIGHT HOLDER(S) OR AUTHOR(S) BE LIABLE FOR
//   ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
//   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
//   SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
//   Authors: Christian König <christian.koenig@amd.com>
//
// The bit reader is ported function by function (vl_vlc_* and vl_rbsp_*), with its 64 bit buffer as a BigInt, because
// the results depend on its exact bookkeeping: how many bits are loaded, where emulation prevention bytes (00 00 03)
// are removed, and where the reader thinks the data ends. Things that are not obvious and are kept as they are:
//   - vl_vlc_init() sets bytes_left to the whole size, so "bits left" is too large by that much until a NAL unit has
//     been limited. All such counts are unsigned 32 bit numbers in C and wrap; they wrap here too.
//   - The C reader loads single bytes until its pointer is 4 byte aligned. The buffers the reference parses come from
//     malloc, so offset 0 of the array is taken as aligned here.
//   - slice_set_reference_frame_h265() finds the flag to change by counting back from the reader's position in the
//     data. That is off when an emulation prevention byte was removed in between or the NAL unit was cut short; the
//     port counts the same way.
//
// Where C behaviour is undefined or does not end, the port does this instead:
//   - Shift counts outside 0..63 are reduced modulo 64, as x86-64 and AArch64 do.
//   - `~0L << n` in vl_vlc_limit() is read as a 64 bit mask (as on Linux and macOS); cutting to zero bits clears the buffer.
//   - Reading past the end gives zero bits, as a build without assertions does. But where such a build would never
//     leave a loop (an Exp-Golomb code that has no 1 bit left, a NAL header read past the end) or would loop a few
//     billion times, the port stops and the function returns false. A build with assertions would abort there.
//   - Changing the flag when the reader has no bit loaded (the slice ends before the flag) returns false and writes nothing.
//
// STATUS: checked against all vectors of chiaki-ng's test/bitstream.c (test/bitstream.test.ts). Not run against a
// real console.

/** ChiakiCodec, as the strings the rest of this port uses (see VideoCodec in ctrl.ts). Everything but 'h264' is H.265. */
export type BitstreamCodec = 'h264' | 'h265' | 'h265-hdr';

/** ChiakiBitstreamSliceType. */
export const BITSTREAM_SLICE = { UNKNOWN: 0, I: 1, P: 2 } as const;
export type BitstreamSliceType = (typeof BITSTREAM_SLICE)[keyof typeof BITSTREAM_SLICE];

/** ChiakiBitstream. In C the two parameter set structs share their memory (a union); here they are separate. */
export interface Bitstream {
  codec: BitstreamCodec;
  log: ((line: string) => void) | null;
  h264: { sps: { log2MaxFrameNumMinus4: number } };
  h265: { sps: { log2MaxPicOrderCntLsbMinus4: number } };
}

/**
 * ChiakiBitstreamSlice. `referenceFrame` counts back from the frame before this one: 0 is the previous frame.
 * For H.265, 0xff means that the slice names no reference frame. An I slice of H.264 leaves it untouched.
 */
export interface BitstreamSlice {
  sliceType: BitstreamSliceType;
  referenceFrame: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// vl_vlc: the bit buffer

const MASK64 = 0xffff_ffff_ffff_ffffn;
const shl64 = (x: bigint, n: number): bigint => (x << BigInt(n & 63)) & MASK64;
const shr64 = (x: bigint, n: number): bigint => x >> BigInt(n & 63);

/** Thrown where the C code would not come back (see the header). Caught by the four entry points. */
class BitstreamOverrun extends Error {}

/** struct vl_vlc. `data` and `end` are offsets into `input` (pointers in C). */
interface VlVlc {
  buffer: bigint; // uint64_t: the next bits, starting at the top
  invalidBits: number; // signed: 32 minus the number of loaded bits
  data: number;
  end: number;
  input: Uint8Array;
  size: number;
  bytesLeft: number;
}

/** align the data pointer to the next dword */
function vlVlcAlignDataPtr(vlc: VlVlc): void {
  while (vlc.data !== vlc.end && (vlc.data & 3) !== 0) {
    vlc.buffer |= shl64(BigInt(vlc.input[vlc.data]!), 24 + vlc.invalidBits);
    ++vlc.data;
    vlc.invalidBits -= 8;
  }
}

/** fill the bit buffer, so that at least 32 bits are valid */
function vlVlcFillbits(vlc: VlVlc): void {
  // as long as the buffer needs to be filled
  while (vlc.invalidBits > 0) {
    const bytesLeft = vlc.end - vlc.data;

    // if this input is depleted
    if (bytesLeft === 0) return;

    if (bytesLeft >= 4) {
      // enough bytes in buffer, read in a whole dword
      const d = vlc.input;
      const p = vlc.data;
      const value = ((d[p]! << 24) | (d[p + 1]! << 16) | (d[p + 2]! << 8) | d[p + 3]!) >>> 0;
      vlc.buffer |= shl64(BigInt(value), vlc.invalidBits);
      vlc.data += 4;
      vlc.invalidBits -= 32;

      // buffer is now definitely filled up avoid the loop test
      break;
    } else {
      while (vlc.data < vlc.end) {
        // not enough bytes left in buffer, read single bytes
        vlc.buffer |= shl64(BigInt(vlc.input[vlc.data]!), 24 + vlc.invalidBits);
        ++vlc.data;
        vlc.invalidBits -= 8;
      }
    }
  }
}

/** initialize vlc structure and start reading from first input buffer */
function vlVlcInit(input: Uint8Array, size: number): VlVlc {
  const vlc: VlVlc = { buffer: 0n, invalidBits: 32, data: 0, end: size, input, size, bytesLeft: size };
  vlVlcAlignDataPtr(vlc);
  vlVlcFillbits(vlc);
  return vlc;
}

/** number of bits still valid in bit buffer (unsigned in C: wraps when more bits were taken than were loaded) */
function vlVlcValidBits(vlc: VlVlc): number {
  return (32 - vlc.invalidBits) >>> 0;
}

/** number of bits left over all input buffers (unsigned in C) */
function vlVlcBitsLeft(vlc: VlVlc): number {
  const bytesLeft = vlc.end - vlc.data + vlc.bytesLeft;
  return (bytesLeft * 8 + (32 - vlc.invalidBits)) >>> 0;
}

/** get num_bits from bit buffer without removing them (the result is an unsigned 32 bit number in C) */
function vlVlcPeekbits(vlc: VlVlc, numBits: number): number {
  return Number(shr64(vlc.buffer, 64 - numBits) & 0xffff_ffffn);
}

/** remove num_bits from bit buffer */
function vlVlcEatbits(vlc: VlVlc, numBits: number): void {
  vlc.buffer = shl64(vlc.buffer, numBits);
  vlc.invalidBits += numBits;
}

/** get num_bits from bit buffer with removing them */
function vlVlcGetUimsbf(vlc: VlVlc, numBits: number): number {
  const value = vlVlcPeekbits(vlc, numBits);
  vlVlcEatbits(vlc, numBits);
  return value;
}

const NUM_BITS_UNLIMITED = 0xffff_ffff; // ~0u

/** fast forward search for a specific byte value */
function vlVlcSearchByte(vlc: VlVlc, numBits: number, value: number): boolean {
  // deplete the bit buffer
  while (vlVlcValidBits(vlc) > 0) {
    if (vlVlcPeekbits(vlc, 8) === value) {
      vlVlcFillbits(vlc);
      return true;
    }

    vlVlcEatbits(vlc, 8);

    if (numBits !== NUM_BITS_UNLIMITED) {
      numBits -= 8;
      if (numBits === 0) return false;
    }
  }

  // deplete the byte buffers
  for (;;) {
    // if this input is depleted
    if (vlc.data === vlc.end) return false;

    if (vlc.input[vlc.data] === value) {
      vlVlcAlignDataPtr(vlc);
      vlVlcFillbits(vlc);
      return true;
    }

    ++vlc.data;
    if (numBits !== NUM_BITS_UNLIMITED) {
      numBits -= 8;
      if (numBits === 0) {
        vlVlcAlignDataPtr(vlc);
        return false;
      }
    }
  }
}

/** remove num_bits bits starting at pos from the bitbuffer */
function vlVlcRemovebits(vlc: VlVlc, pos: number, numBits: number): void {
  const lo = shl64(vlc.buffer & shr64(MASK64, pos + numBits), numBits);
  const hi = vlc.buffer & shl64(MASK64, 64 - pos);
  vlc.buffer = lo | hi;
  vlc.invalidBits += numBits;
}

/** limit the number of bits left for fetching */
function vlVlcLimit(vlc: VlVlc, bitsLeft: number): void {
  vlVlcFillbits(vlc);
  if (bitsLeft < vlVlcValidBits(vlc)) {
    vlc.invalidBits = 32 - bitsLeft;
    vlc.buffer = bitsLeft === 0 ? 0n : vlc.buffer & shl64(MASK64, vlc.invalidBits + 32);
    vlc.end = vlc.data;
    vlc.bytesLeft = 0;
  } else {
    vlc.bytesLeft = Math.floor(((bitsLeft - vlVlcValidBits(vlc)) >>> 0) / 8);
    if (vlc.bytesLeft < vlc.end - vlc.data) {
      vlc.end = vlc.data + vlc.bytesLeft;
      vlc.bytesLeft = 0;
    } else {
      vlc.bytesLeft -= vlc.end - vlc.data;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// vl_rbsp: reading a NAL unit's payload, with the emulation prevention bytes taken out

/** struct vl_rbsp */
interface VlRbsp {
  nal: VlVlc;
  escaped: number;
  removed: number;
}

/**
 * Initialize the RBSP object. `nal` is left at the next start code (or at the end of the data); the returned reader
 * starts where `nal` was and ends there.
 */
function vlRbspInit(nal: VlVlc, numBits: number): VlRbsp {
  // More bits taken than were ever loaded: the loops below would not end in C (see the header).
  if (nal.invalidBits > 32) throw new BitstreamOverrun();

  const bitsLeft = vlVlcBitsLeft(nal);

  // copy the position
  const rbsp: VlRbsp = { nal: { ...nal }, escaped: 0, removed: 0 };

  // search for the end of the NAL unit
  while (vlVlcSearchByte(nal, numBits, 0x00)) {
    if (vlVlcPeekbits(nal, 24) === 0x000001 || vlVlcPeekbits(nal, 32) === 0x00000001) {
      vlVlcLimit(rbsp.nal, (bitsLeft - vlVlcBitsLeft(nal)) >>> 0);
      break;
    }
    vlVlcEatbits(nal, 8);
  }

  let valid = vlVlcValidBits(rbsp.nal);
  // search for the emulation prevention three byte
  for (let i = 24; i <= valid; i += 8) {
    if ((vlVlcPeekbits(rbsp.nal, i) & 0xffffff) === 0x3) {
      vlVlcRemovebits(rbsp.nal, i - 8, 8);
      i += 8;
    }
  }

  valid = vlVlcValidBits(rbsp.nal);

  rbsp.escaped = valid >= 16 ? 16 : valid >= 8 ? 8 : 0;
  return rbsp;
}

/** Make at least 16 more bits available */
function vlRbspFillbits(rbsp: VlRbsp): void {
  let valid = vlVlcValidBits(rbsp.nal);

  // abort if we still have enough bits
  if (valid >= 32) return;

  vlVlcFillbits(rbsp.nal);

  // abort if we have less than 24 bits left in this nal
  if (vlVlcBitsLeft(rbsp.nal) < 24) return;

  // handle the already escaped bits (unsigned in C: may wrap, and wraps back in the loop start below)
  valid = (valid - rbsp.escaped) >>> 0;

  // search for the emulation prevention three byte
  rbsp.escaped = 16;
  let bits = vlVlcValidBits(rbsp.nal);
  for (let i = (valid + 24) >>> 0; i <= bits; i = (i + 8) >>> 0) {
    if ((vlVlcPeekbits(rbsp.nal, i) & 0xffffff) === 0x3) {
      vlVlcRemovebits(rbsp.nal, (i - 8) >>> 0, 8);
      rbsp.escaped = (bits - i) >>> 0;
      if (bits < 8) throw new BitstreamOverrun(); // the count would wrap and the loop run on for 2^32 bits
      bits -= 8;
      rbsp.removed += 8;
      i = (i + 8) >>> 0;
    }
  }
}

/** Return an unsigned integer from the first n bits */
function vlRbspU(rbsp: VlRbsp, n: number): number {
  if (n === 0) return 0;

  vlRbspFillbits(rbsp);
  if (n > 16) vlRbspFillbits(rbsp);
  return vlVlcGetUimsbf(rbsp.nal, n);
}

/** Return an unsigned exponential Golomb encoded integer */
function vlRbspUe(rbsp: VlRbsp): number {
  let bits = 0;

  vlRbspFillbits(rbsp);
  while (!vlVlcGetUimsbf(rbsp.nal, 1)) {
    // Nothing is loaded inside this loop, so without a 1 bit in the buffer it would never end in C.
    if (rbsp.nal.buffer === 0n) throw new BitstreamOverrun();
    ++bits;
  }

  return (((1 << bits) - 1) + vlRbspU(rbsp, bits)) >>> 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// bitstream.c

function skipStartcode(vlc: VlVlc): boolean {
  vlVlcFillbits(vlc);
  for (let i = 0; i < 64 && vlVlcBitsLeft(vlc) >= 32; i++) {
    if (vlVlcPeekbits(vlc, 32) === 1) break;
    vlVlcEatbits(vlc, 8);
    vlVlcFillbits(vlc);
  }
  if (vlVlcPeekbits(vlc, 32) !== 1) return false;
  vlVlcEatbits(vlc, 32);
  vlVlcFillbits(vlc);
  return true;
}

function warn(bitstream: Bitstream, line: string): void {
  bitstream.log?.(line);
}

const H264_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function headerH264(bitstream: Bitstream, data: Uint8Array, size: number): boolean {
  const vlc = vlVlcInit(data, size);
  if (!skipStartcode(vlc)) {
    warn(bitstream, 'parse_sps_h264: No startcode found');
    return false;
  }

  vlVlcEatbits(vlc, 1); // forbidden_zero_bit
  vlVlcEatbits(vlc, 2); // nal_ref_idc
  const nalUnitType = vlVlcGetUimsbf(vlc, 5);

  if (nalUnitType !== 7) {
    warn(bitstream, `parse_sps_h264: Unexpected NAL unit type ${nalUnitType}`);
    return false;
  }

  const rbsp = vlRbspInit(vlc, NUM_BITS_UNLIMITED);

  const profileIdc = vlRbspU(rbsp, 8);

  vlRbspU(rbsp, 6); // constraint_set_flags
  vlRbspU(rbsp, 2); // reserved_zero_2bits
  vlRbspU(rbsp, 8); // level_idc

  vlRbspUe(rbsp); // seq_parameter_set_id

  if (H264_HIGH_PROFILES.has(profileIdc)) {
    if (vlRbspUe(rbsp) === 3) vlRbspU(rbsp, 1); // chroma_format_idc, separate_colour_plane_flag

    vlRbspUe(rbsp); // bit_depth_luma_minus8
    vlRbspUe(rbsp); // bit_depth_chroma_minus8
    vlRbspU(rbsp, 1); // qpprime_y_zero_transform_bypass_flag

    if (vlRbspU(rbsp, 1)) return false; // seq_scaling_matrix_present_flag
  }

  bitstream.h264.sps.log2MaxFrameNumMinus4 = vlRbspUe(rbsp);
  if (bitstream.h264.sps.log2MaxFrameNumMinus4 > 12) {
    warn(bitstream, `parse_sps_h264: Unexpected log2_max_frame_num_minus4 value ${bitstream.h264.sps.log2MaxFrameNumMinus4}`);
    return false;
  }

  return true;
}

function headerH265(bitstream: Bitstream, data: Uint8Array, size: number): boolean {
  const vlc = vlVlcInit(data, size);
  for (;;) {
    // sps_start:
    if (!skipStartcode(vlc)) {
      warn(bitstream, 'parse_sps_h265: No startcode found');
      return false;
    }

    vlVlcEatbits(vlc, 1); // forbidden_zero_bit
    const nalUnitType = vlVlcGetUimsbf(vlc, 6);
    vlVlcEatbits(vlc, 6); // nuh_layer_id
    vlVlcEatbits(vlc, 3); // nuh_temporal_id_plus1

    if (nalUnitType === 32) continue; // VPS: goto sps_start

    if (nalUnitType !== 33) {
      warn(bitstream, `parse_sps_h265: Unexpected NAL unit type ${nalUnitType}`);
      return false;
    }
    break;
  }

  const rbsp = vlRbspInit(vlc, NUM_BITS_UNLIMITED);

  vlRbspU(rbsp, 4); // sps_video_parameter_set_id
  vlRbspU(rbsp, 3); // sps_max_sub_layers_minus1
  vlRbspU(rbsp, 1); // sps_temporal_id_nesting_flag

  vlRbspU(rbsp, 2); // general_profile_space
  vlRbspU(rbsp, 1); // general_tier_flag
  vlRbspU(rbsp, 5); // general_profile_idc
  vlRbspU(rbsp, 32); // general_profile_compatibility_flag[0-31]
  vlRbspU(rbsp, 1); // general_progressive_source_flag
  vlRbspU(rbsp, 1); // general_interlaced_source_flag
  vlRbspU(rbsp, 1); // general_non_packed_constraint_flag
  vlRbspU(rbsp, 1); // general_frame_only_constraint_flag
  vlRbspU(rbsp, 32);
  vlRbspU(rbsp, 11); // general_reserved_zero_43bits
  vlRbspU(rbsp, 1); // general_inbld_flag / general_reserved_zero_bit
  vlRbspU(rbsp, 8); // general_level_idc

  vlRbspUe(rbsp); // sps_seq_parameter_set_id
  if (vlRbspUe(rbsp) === 3) vlRbspU(rbsp, 1); // chroma_format_idc, separate_colour_plane_flag

  vlRbspUe(rbsp); // pic_width_in_luma_samples
  vlRbspUe(rbsp); // pic_height_in_luma_samples

  if (vlRbspU(rbsp, 1)) {
    // conformance_window_flag
    vlRbspUe(rbsp); // conf_win_left_offset
    vlRbspUe(rbsp); // conf_win_right_offset
    vlRbspUe(rbsp); // conf_win_top_offset
    vlRbspUe(rbsp); // conf_win_bottom_offset
  }

  vlRbspUe(rbsp); // bit_depth_luma_minus8
  vlRbspUe(rbsp); // bit_depth_chroma_minus8

  bitstream.h265.sps.log2MaxPicOrderCntLsbMinus4 = vlRbspUe(rbsp);
  if (bitstream.h265.sps.log2MaxPicOrderCntLsbMinus4 > 12) {
    warn(bitstream, `parse_sps_h265: Unexpected log2_max_pic_order_cnt_lsb_minus4 value ${bitstream.h265.sps.log2MaxPicOrderCntLsbMinus4}`);
    return false;
  }

  return true;
}

function sliceH264(bitstream: Bitstream, data: Uint8Array, size: number, slice: BitstreamSlice): boolean {
  const vlc = vlVlcInit(data, size);
  if (!skipStartcode(vlc)) {
    warn(bitstream, 'parse_slice_h264: No startcode found');
    return false;
  }

  vlVlcEatbits(vlc, 1); // forbidden_zero_bit
  vlVlcEatbits(vlc, 2); // nal_ref_idc
  const nalUnitType = vlVlcGetUimsbf(vlc, 5);

  if (nalUnitType !== 1 && nalUnitType !== 5) {
    warn(bitstream, `parse_slice_h264: Unexpected NAL unit type ${nalUnitType}`);
    return false;
  }

  const rbsp = vlRbspInit(vlc, NUM_BITS_UNLIMITED);
  vlRbspUe(rbsp); // first_mb_in_slice

  switch (vlRbspUe(rbsp)) {
    case 0:
    case 5:
      slice.sliceType = BITSTREAM_SLICE.P;
      break;
    case 2:
    case 7:
      slice.sliceType = BITSTREAM_SLICE.I;
      break;
    default:
      slice.sliceType = BITSTREAM_SLICE.UNKNOWN;
      break;
  }

  if (nalUnitType === 1) {
    slice.referenceFrame = 0;
    vlRbspUe(rbsp); // pic_parameter_set_id
    vlRbspU(rbsp, bitstream.h264.sps.log2MaxFrameNumMinus4 + 4); // frame_num
    // The reference reads two flags here, both named num_ref_idx_active_override_flag.
    if (vlRbspU(rbsp, 1)) {
      if (vlRbspU(rbsp, 1)) vlRbspUe(rbsp); // num_ref_idx_l0_active_minus1
    }
    if (vlRbspU(rbsp, 1)) {
      // ref_pic_list_modification_flag_l0
      let i = 0;
      let modificationOfPicNumsIdc = vlRbspUe(rbsp);
      while (i++ < 3) {
        if (modificationOfPicNumsIdc === 0) slice.referenceFrame = vlRbspUe(rbsp); // abs_diff_pic_num_minus1
        else if (modificationOfPicNumsIdc < 3) vlRbspUe(rbsp); // abs_diff_pic_num_minus1 or long_term_pic_num
        else if (modificationOfPicNumsIdc === 3) return true;
        else break;
        modificationOfPicNumsIdc = vlRbspUe(rbsp);
      }
      warn(bitstream, 'parse_slice_h264: Failed to parse ref_pic_list_modification');
      return false;
    }
  }

  return true;
}

function sliceH265(bitstream: Bitstream, data: Uint8Array, size: number, slice: BitstreamSlice): boolean {
  const vlc = vlVlcInit(data, size);

  if (!skipStartcode(vlc)) {
    warn(bitstream, 'parse_slice_h265: No startcode found');
    return false;
  }

  vlVlcEatbits(vlc, 1); // forbidden_zero_bit
  const nalUnitType = vlVlcGetUimsbf(vlc, 6);
  vlVlcEatbits(vlc, 6); // nuh_layer_id
  vlVlcEatbits(vlc, 3); // nuh_temporal_id_plus1

  if (nalUnitType !== 1 && nalUnitType !== 20) {
    warn(bitstream, `parse_slice_h265: Unexpected NAL unit type ${nalUnitType}`);
    return false;
  }

  const rbsp = vlRbspInit(vlc, NUM_BITS_UNLIMITED);
  const firstSliceSegmentInPicFlag = vlRbspU(rbsp, 1);
  if (nalUnitType === 20) vlRbspU(rbsp, 1); // no_output_of_prior_pics_flag

  vlRbspUe(rbsp); // slice_pic_parameter_set_id
  if (!firstSliceSegmentInPicFlag) vlRbspUe(rbsp); // slice_segment_address

  switch (vlRbspUe(rbsp)) {
    case 1:
      slice.sliceType = BITSTREAM_SLICE.P;
      break;
    case 2:
      slice.sliceType = BITSTREAM_SLICE.I;
      break;
    default:
      slice.sliceType = BITSTREAM_SLICE.UNKNOWN;
      break;
  }

  if (nalUnitType === 1) {
    slice.referenceFrame = 0xff;
    vlRbspU(rbsp, bitstream.h265.sps.log2MaxPicOrderCntLsbMinus4 + 4); // slice_pic_order_cnt_lsb
    if (!vlRbspU(rbsp, 1)) {
      // short_term_ref_pic_set_sps_flag
      const numNegativePics = vlRbspUe(rbsp);
      if (numNegativePics > 16) {
        warn(bitstream, `parse_slice_h265: Unexpected num_negative_pics ${numNegativePics}`);
        return false;
      }
      vlRbspUe(rbsp); // num_positive_pics
      for (let i = 0; i < numNegativePics; i++) {
        vlRbspUe(rbsp); // delta_poc_s0_minus1[i]
        if (vlRbspU(rbsp, 1)) {
          // used_by_curr_pic_s0_flag[i]
          slice.referenceFrame = i;
          break;
        }
      }
    }
    if (slice.referenceFrame === 0xff) warn(bitstream, 'parse_slice_h265: No ref frame found');
  }

  return true;
}

function sliceSetReferenceFrameH265(bitstream: Bitstream, data: Uint8Array, size: number, referenceFrame: number): boolean {
  const vlc = vlVlcInit(data, size);
  if (!skipStartcode(vlc)) {
    warn(bitstream, 'slice_set_reference_frame_h265: No startcode found');
    return false;
  }

  vlVlcEatbits(vlc, 1); // forbidden_zero_bit
  const nalUnitType = vlVlcGetUimsbf(vlc, 6);
  vlVlcEatbits(vlc, 6); // nuh_layer_id
  vlVlcEatbits(vlc, 3); // nuh_temporal_id_plus1

  if (nalUnitType !== 1) {
    warn(bitstream, `slice_set_reference_frame_h265: Unexpected NAL unit type ${nalUnitType}`);
    return false;
  }

  const rbsp = vlRbspInit(vlc, NUM_BITS_UNLIMITED);
  const firstSliceSegmentInPicFlag = vlRbspU(rbsp, 1);

  vlRbspUe(rbsp); // slice_pic_parameter_set_id
  if (!firstSliceSegmentInPicFlag) vlRbspUe(rbsp); // slice_segment_address

  if (vlRbspUe(rbsp) !== 1) {
    warn(bitstream, 'slice_set_reference_frame_h265: Not P slice');
    return false;
  }

  vlRbspU(rbsp, bitstream.h265.sps.log2MaxPicOrderCntLsbMinus4 + 4); // slice_pic_order_cnt_lsb
  if (!vlRbspU(rbsp, 1)) {
    // short_term_ref_pic_set_sps_flag
    const numNegativePics = vlRbspUe(rbsp);
    if (numNegativePics > 16) {
      warn(bitstream, `slice_set_reference_frame_h265: Unexpected num_negative_pics ${numNegativePics}`);
      return false;
    }
    vlRbspUe(rbsp); // num_positive_pics
    for (let i = 0; i < numNegativePics; i++) {
      vlRbspUe(rbsp); // delta_poc_s0_minus1[i]

      // The next bit of the reader is used_by_curr_pic_s0_flag[i]. The reference changes it in the data itself: it
      // takes the 8 bytes before the reader's data pointer as one big endian number and sets or clears the bit that
      // is as far from its end as the reader has bits loaded.
      const d = rbsp.nal.data;
      const shift = 31 - rbsp.nal.invalidBits; // 64 - 1 - (64 - (32 - invalid_bits))
      if (d < 8 || shift < 0 || shift > 63) {
        warn(bitstream, 'slice_set_reference_frame_h265: Flag is not in the data');
        return false;
      }
      const bitIndex = d * 8 - 1 - shift; // counted from the first bit of the data
      const byte = bitIndex >> 3;
      const mask = 0x80 >> (bitIndex & 7);
      if (i === referenceFrame) data[byte] = data[byte]! | mask; // set 1
      else data[byte] = data[byte]! & ~mask; // set 0
      if (i === referenceFrame) return true;
      vlRbspU(rbsp, 1); // used_by_curr_pic_s0_flag[i]
    }
  }

  return false;
}

/** chiaki_bitstream_init. `log` receives the reference's warnings (none of them contains stream data). */
export function bitstreamInit(codec: BitstreamCodec, log?: (line: string) => void): Bitstream {
  return { codec, log: log ?? null, h264: { sps: { log2MaxFrameNumMinus4: 0 } }, h265: { sps: { log2MaxPicOrderCntLsbMinus4: 0 } } };
}

function guarded(bitstream: Bitstream, what: string, parse: () => boolean): boolean {
  try {
    return parse();
  } catch (e) {
    if (!(e instanceof BitstreamOverrun)) throw e;
    warn(bitstream, `${what}: Data ends inside the header`);
    return false;
  }
}

/**
 * chiaki_bitstream_header: reads the stream header of a video profile (H.264: SPS first; H.265: VPS units are
 * skipped, then the SPS) and keeps the one value the slice parser needs. False when it cannot be read.
 */
export function bitstreamHeader(bitstream: Bitstream, data: Uint8Array): boolean {
  bitstream.h264.sps.log2MaxFrameNumMinus4 = 0;
  bitstream.h265.sps.log2MaxPicOrderCntLsbMinus4 = 0;
  if (bitstream.codec === 'h264') return guarded(bitstream, 'parse_sps_h264', () => headerH264(bitstream, data, data.length));
  return guarded(bitstream, 'parse_sps_h265', () => headerH265(bitstream, data, data.length));
}

/**
 * chiaki_bitstream_slice: reads the first slice header of a frame into `slice`. The frame has to begin with a start
 * code (00 00 00 01, searched for in the first 64 bytes) followed by a slice NAL unit (H.264: type 1 or 5; H.265: type
 * 1 or 20). False when it cannot be read; `slice` may then be partly written, as in C.
 */
export function bitstreamSlice(bitstream: Bitstream, data: Uint8Array, slice: BitstreamSlice): boolean {
  if (bitstream.codec === 'h264') return guarded(bitstream, 'parse_slice_h264', () => sliceH264(bitstream, data, data.length, slice));
  return guarded(bitstream, 'parse_slice_h265', () => sliceH265(bitstream, data, data.length, slice));
}

/**
 * chiaki_bitstream_slice_set_reference_frame: rewrites the P slice at the start of `data` IN PLACE so that it refers
 * to `referenceFrame` (same counting as BitstreamSlice.referenceFrame). H.265 only; always false for H.264. False when
 * the slice does not list that many earlier frames. Flags before the wanted one are cleared even when it fails.
 */
export function bitstreamSliceSetReferenceFrame(bitstream: Bitstream, data: Uint8Array, referenceFrame: number): boolean {
  if (bitstream.codec === 'h264') return false;
  return guarded(bitstream, 'slice_set_reference_frame_h265', () => sliceSetReferenceFrameH265(bitstream, data, data.length, referenceFrame));
}

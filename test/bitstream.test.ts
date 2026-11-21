// SPDX-License-Identifier: AGPL-3.0-only
//
// H.264 / H.265 header and slice parsing. The first group is chiaki-ng's own test, test/bitstream.c (commit 43728af),
// vector for vector: stream headers and slices, with the values the reference expects. The rest are tests written
// for this port: headers and slices built bit by bit here, and inputs that are cut short.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BITSTREAM_SLICE, bitstreamHeader, bitstreamInit, bitstreamSlice, bitstreamSliceSetReferenceFrame, type BitstreamSlice,
} from '../src/console/bitstream.ts';

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'));

/** memset(&slice, -1, sizeof(slice)) of the reference test: values no parse can produce by accident. */
const blankSlice = (): BitstreamSlice => ({ sliceType: -1 as unknown as BitstreamSlice['sliceType'], referenceFrame: 0xffffffff });

// --- vectors of test/bitstream.c ---

const H264_HEADER = hex(`
  00 00 00 01 67 4d 40 32 91 8a 01 e0 08 9f 97 01
  6a 02 02 02 80 00 03 e9 00 01 d4 c0 44 d0 f1 f1
  50 00 00 00 01 68 ee 3c 80`);
const H264_SLICE_I = hex(`
  00 00 00 01 65 88 80 82 1f 00 49 ee 03 29 ff f8
  7f 88 46 44 77 17 e7 6d b3 ad 38 19 74 5a f1 51`);
const H264_SLICE_P = hex(`
  00 00 00 01 41 9a 04 44 3f 41 5b f4 65 b4 3e 1a
  d3 a0 28 1f 83 63 0e c2 fc 9d 7a c7 c4 7d f9 18`);
const H264_SLICE_P_REF_5 = hex(`
  00 00 00 01 41 9b fd 98 89 df 00 03 24 60 47 1a
  90 10 b3 2c 4e 45 fc ff 45 24 8c 79 ec 12 e5 9b`);

const H265_HEADER = hex(`
  00 00 00 01 40 01 0c 01 ff ff 01 60 00 00 03 00
  b0 00 00 03 00 00 03 00 96 0a c0 90 00 00 00 01
  42 01 01 01 60 00 00 03 00 b0 00 00 03 00 00 03
  00 96 a0 03 c0 80 11 07 cb c2 b9 24 29 52 70 16
  a0 20 20 20 80 00 07 d2 00 01 d4 c0 20 e5 a1 e3
  d0 00 00 00 01 44 01 c0 f3 c0 4c 90`);
const H265_SLICE_I = hex(`
  00 00 00 01 28 01 ac 25 cf 83 ff 23 54 ab 5c f5
  7a 06 7c 3f 31 9b e6 10 57 e8 0e cf dd da db 3f`);
const H265_SLICE_P = hex(`
  00 00 00 01 02 01 d0 97 61 28 23 2d 8b 80 6f fd
  2f 2b 11 d4 55 04 90 18 49 e5 bc c4 97 bc 3d eb`);
const H265_SLICE_P_REF_5 = hex(`
  00 00 00 01 02 01 d7 85 6a ae a6 11 80 95 80 0a
  ec 5e df 39 86 e6 d9 07 49 17 e2 62 57 14 d7 08`);
const H265_SLICE_P_ISSUE_213 = hex('00 00 00 01 02 01 d2 0b ea 60 86 82 3d 00 00 03');
const H265_SLICE_P_SET_REF = hex(`
  00 00 00 01 02 01 d2 85 7a aa a6 08 60 13 55 17
  6b 71 72 f9 6e d4 f2 66 78 0c 12 e7 79 f0 bc c9`);

describe('bitstream: chiaki-ng test vectors (test/bitstream.c)', () => {
  it('bitstream_parse_h264: header, I slice, P slice, P slice referring 6 frames back', () => {
    const bs = bitstreamInit('h264');
    bs.h264.sps.log2MaxFrameNumMinus4 = 0xffffffff;
    assert.ok(bitstreamHeader(bs, H264_HEADER));
    assert.equal(bs.h264.sps.log2MaxFrameNumMinus4, 3);

    let slice = blankSlice();
    assert.ok(bitstreamSlice(bs, H264_SLICE_I, slice));
    assert.equal(slice.sliceType, BITSTREAM_SLICE.I);

    slice = blankSlice();
    assert.ok(bitstreamSlice(bs, H264_SLICE_P, slice));
    assert.equal(slice.sliceType, BITSTREAM_SLICE.P);
    assert.equal(slice.referenceFrame, 0);

    slice = blankSlice();
    assert.ok(bitstreamSlice(bs, H264_SLICE_P_REF_5, slice));
    assert.equal(slice.sliceType, BITSTREAM_SLICE.P);
    assert.equal(slice.referenceFrame, 5);
  });

  it('bitstream_parse_h265: header, I slice, P slice, P slice referring 6 frames back', () => {
    const bs = bitstreamInit('h265');
    bs.h265.sps.log2MaxPicOrderCntLsbMinus4 = 0xffffffff;
    assert.ok(bitstreamHeader(bs, H265_HEADER));
    assert.equal(bs.h265.sps.log2MaxPicOrderCntLsbMinus4, 0);

    let slice = blankSlice();
    assert.ok(bitstreamSlice(bs, H265_SLICE_I, slice));
    assert.equal(slice.sliceType, BITSTREAM_SLICE.I);

    slice = blankSlice();
    assert.ok(bitstreamSlice(bs, H265_SLICE_P, slice));
    assert.equal(slice.sliceType, BITSTREAM_SLICE.P);
    assert.equal(slice.referenceFrame, 0);

    slice = blankSlice();
    assert.ok(bitstreamSlice(bs, H265_SLICE_P_REF_5, slice));
    assert.equal(slice.sliceType, BITSTREAM_SLICE.P);
    assert.equal(slice.referenceFrame, 5);
  });

  it('bitstream_issue_213: a slice that ends in 00 00 03', () => {
    const bs = bitstreamInit('h265');
    assert.ok(bitstreamHeader(bs, H265_HEADER));

    const slice = blankSlice();
    assert.ok(bitstreamSlice(bs, H265_SLICE_P_ISSUE_213, slice));
    assert.equal(slice.sliceType, BITSTREAM_SLICE.P);
    assert.equal(slice.referenceFrame, 0);
  });

  it('bitstream_set_ref_h265: point a P slice at each of its 9 reference frames in turn', () => {
    const bs = bitstreamInit('h265');
    bs.h265.sps.log2MaxPicOrderCntLsbMinus4 = 0xffffffff;
    assert.ok(bitstreamHeader(bs, H265_HEADER));
    assert.equal(bs.h265.sps.log2MaxPicOrderCntLsbMinus4, 0);

    const sliceP = Uint8Array.from(H265_SLICE_P_SET_REF);
    let slice = blankSlice();
    assert.ok(bitstreamSlice(bs, sliceP, slice));
    assert.equal(slice.sliceType, BITSTREAM_SLICE.P);
    assert.equal(slice.referenceFrame, 0);

    for (let i = 0; i < 9; i++) {
      assert.ok(bitstreamSliceSetReferenceFrame(bs, sliceP, i), `set ${i}`);
      slice = blankSlice();
      assert.ok(bitstreamSlice(bs, sliceP, slice));
      assert.equal(slice.sliceType, BITSTREAM_SLICE.P);
      assert.equal(slice.referenceFrame, i);
    }
    // Slice have 9 reference frames
    assert.ok(!bitstreamSliceSetReferenceFrame(bs, sliceP, 10));
  });
});

// --- tests written for this port ---

/** Writes bits, most significant first, and the Exp-Golomb codes of H.264 / H.265. */
class BitWriter {
  bits: number[] = [];
  u(n: number, value: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }
  ue(value: number): this {
    const v = value + 1;
    const len = Math.floor(Math.log2(v)) + 1;
    return this.u(len - 1, 0).u(len, v);
  }
  /** The payload bytes: a stop bit, zero bits up to the byte boundary, then emulation prevention as an encoder adds it. */
  rbsp(): number[] {
    const bits = [...this.bits, 1];
    while (bits.length % 8) bits.push(0);
    const raw: number[] = [];
    for (let i = 0; i < bits.length; i += 8) raw.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
    const out: number[] = [];
    let zeros = 0;
    for (const b of raw) {
      if (zeros >= 2 && b <= 3) {
        out.push(3);
        zeros = 0;
      }
      out.push(b);
      zeros = b === 0 ? zeros + 1 : 0;
    }
    return out;
  }
}

const START = [0, 0, 0, 1];
const nal = (header: number[], w: BitWriter, tail: number[] = []): Uint8Array => Uint8Array.from([...START, ...header, ...w.rbsp(), ...tail]);

function h264Sps(profileIdc: number, log2MaxFrameNumMinus4: number, opts: { scalingMatrix?: boolean; chroma?: number } = {}): Uint8Array {
  const w = new BitWriter().u(8, profileIdc).u(6, 0).u(2, 0).u(8, 40).ue(0);
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    w.ue(opts.chroma ?? 1);
    if ((opts.chroma ?? 1) === 3) w.u(1, 0);
    w.ue(0).ue(0).u(1, 0).u(1, opts.scalingMatrix ? 1 : 0);
  }
  w.ue(log2MaxFrameNumMinus4).ue(0).ue(4);
  return nal([0x67], w, [...START, 0x68, 0xee, 0x3c, 0x80]);
}

function h265Sps(log2MaxPocLsbMinus4: number, opts: { withVps?: boolean; conformanceWindow?: boolean; chroma?: number } = {}): Uint8Array {
  const w = new BitWriter().u(4, 0).u(3, 0).u(1, 1); // vps id, max sub layers, nesting
  w.u(2, 0).u(1, 0).u(5, 1).u(32, 0x60000000).u(1, 1).u(1, 0).u(1, 0).u(1, 1).u(32, 0).u(11, 0).u(1, 0).u(8, 120); // profile_tier_level
  w.ue(0).ue(opts.chroma ?? 1);
  if ((opts.chroma ?? 1) === 3) w.u(1, 0);
  w.ue(1920).ue(1080);
  if (opts.conformanceWindow) w.u(1, 1).ue(0).ue(0).ue(0).ue(4);
  else w.u(1, 0);
  w.ue(0).ue(0).ue(log2MaxPocLsbMinus4).u(1, 1).ue(3);
  const sps = nal([0x42, 0x01], w);
  const vps = [...START, 0x40, 0x01, 0x0c, 0x01, 0xff, 0xff, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0x90];
  return Uint8Array.from([...(opts.withVps === false ? [] : vps), ...sps, ...START, 0x44, 0x01, 0xc0]);
}

/** An H.265 P slice (NAL type 1) whose header lists `used.length` earlier frames with the given used flags. */
function h265SliceP(log2MaxPocLsbMinus4: number, poc: number, used: number[], opts: { firstSlice?: boolean; deltaPoc?: number[] } = {}): Uint8Array {
  const w = new BitWriter().u(1, opts.firstSlice === false ? 0 : 1).ue(0);
  if (opts.firstSlice === false) w.ue(7);
  w.ue(1).u(log2MaxPocLsbMinus4 + 4, poc).u(1, 0).ue(used.length).ue(0);
  used.forEach((flag, i) => w.ue(opts.deltaPoc?.[i] ?? 0).u(1, flag));
  w.u(24, 0xabcdef).u(24, 0x123456).u(24, 0x789abc); // something after the header
  return nal([0x02, 0x01], w);
}

function h264SliceP(log2MaxFrameNumMinus4: number, frameNum: number, modifications: Array<[number, number]> | null): Uint8Array {
  const w = new BitWriter().ue(0).ue(5).ue(0).u(log2MaxFrameNumMinus4 + 4, frameNum).u(1, 0);
  if (modifications === null) w.u(1, 0);
  else {
    w.u(1, 1);
    for (const [idc, value] of modifications) w.ue(idc).ue(value);
    w.ue(3);
  }
  w.u(24, 0xabcdef).u(24, 0x123456);
  return nal([0x41], w);
}

describe('bitstream: headers built here', () => {
  it('H.264: reads log2_max_frame_num_minus4 for baseline, main and high profiles', () => {
    for (const profile of [66, 77, 100, 110, 244]) {
      for (const value of [0, 1, 4, 7, 12]) {
        const bs = bitstreamInit('h264');
        assert.ok(bitstreamHeader(bs, h264Sps(profile, value)), `profile ${profile} value ${value}`);
        assert.equal(bs.h264.sps.log2MaxFrameNumMinus4, value);
      }
    }
    const bs = bitstreamInit('h264');
    assert.ok(bitstreamHeader(bs, h264Sps(244, 5, { chroma: 3 })), 'chroma_format_idc 3 has one more flag');
    assert.equal(bs.h264.sps.log2MaxFrameNumMinus4, 5);
  });

  it('H.264: refuses a scaling matrix, a value above 12, a header that does not start with an SPS, and no start code', () => {
    const lines: string[] = [];
    const bs = bitstreamInit('h264', (l) => lines.push(l));
    assert.equal(bitstreamHeader(bs, h264Sps(100, 3, { scalingMatrix: true })), false);
    assert.equal(bitstreamHeader(bs, h264Sps(77, 13)), false);
    assert.equal(bitstreamHeader(bs, Uint8Array.from([...START, 0x68, 0xee, 0x3c, 0x80])), false);
    assert.equal(bitstreamHeader(bs, Uint8Array.from([0x67, 0x4d, 0x40, 0x32, 0x91, 0x8a, 0x01, 0xe0])), false);
    assert.equal(bitstreamHeader(bs, new Uint8Array(0)), false);
    assert.deepEqual(lines, [
      'parse_sps_h264: Unexpected log2_max_frame_num_minus4 value 13',
      'parse_sps_h264: Unexpected NAL unit type 8',
      'parse_sps_h264: No startcode found',
      'parse_sps_h264: No startcode found',
    ]);
  });

  it('H.265: reads log2_max_pic_order_cnt_lsb_minus4 behind the profile block, with and without a VPS in front', () => {
    for (const value of [0, 1, 4, 8, 12]) {
      for (const opts of [{}, { withVps: false }, { conformanceWindow: true }, { chroma: 3 }]) {
        const bs = bitstreamInit('h265');
        assert.ok(bitstreamHeader(bs, h265Sps(value, opts)), `value ${value} ${JSON.stringify(opts)}`);
        assert.equal(bs.h265.sps.log2MaxPicOrderCntLsbMinus4, value);
      }
    }
    const hdr = bitstreamInit('h265-hdr');
    assert.ok(bitstreamHeader(hdr, h265Sps(6)), 'the HDR codec is parsed as H.265');
    assert.equal(hdr.h265.sps.log2MaxPicOrderCntLsbMinus4, 6);
  });

  it('H.265: refuses a value above 12 and a header whose first unit after the VPS is not an SPS', () => {
    const bs = bitstreamInit('h265');
    assert.equal(bitstreamHeader(bs, h265Sps(13)), false);
    assert.equal(bitstreamHeader(bs, Uint8Array.from([...START, 0x44, 0x01, 0xc0, 0xf3])), false);
    assert.equal(bitstreamHeader(bs, H264_HEADER), false);
  });

  it('a header that failed leaves the value at zero', () => {
    const bs = bitstreamInit('h264');
    assert.ok(bitstreamHeader(bs, h264Sps(77, 9)));
    assert.equal(bitstreamHeader(bs, new Uint8Array(4)), false);
    assert.equal(bs.h264.sps.log2MaxFrameNumMinus4, 0);
  });
});

describe('bitstream: slices built here', () => {
  it('H.264 P slices: reference frame from the list modification, for every frame number width', () => {
    for (const log2 of [0, 3, 12]) {
      const bs = bitstreamInit('h264');
      assert.ok(bitstreamHeader(bs, h264Sps(77, log2)));
      for (const [mods, expected] of [[null, 0], [[[0, 0]], 0], [[[0, 5]], 5], [[[0, 14]], 14], [[[1, 2]], 0], [[[2, 9]], 0]] as Array<[Array<[number, number]> | null, number]>) {
        const slice = blankSlice();
        assert.ok(bitstreamSlice(bs, h264SliceP(log2, 5, mods), slice), `log2 ${log2} mods ${JSON.stringify(mods)}`);
        assert.equal(slice.sliceType, BITSTREAM_SLICE.P);
        assert.equal(slice.referenceFrame, expected);
      }
    }
  });

  it('H.264: an I slice leaves the reference frame untouched; other slice types are "unknown"', () => {
    const bs = bitstreamInit('h264');
    assert.ok(bitstreamHeader(bs, H264_HEADER));
    const slice = blankSlice();
    assert.ok(bitstreamSlice(bs, H264_SLICE_I, slice));
    assert.equal(slice.referenceFrame, 0xffffffff);

    const b = blankSlice();
    assert.ok(bitstreamSlice(bs, nal([0x41], new BitWriter().ue(0).ue(1).ue(0).u(7, 1).u(1, 0).u(1, 0).u(16, 0xffff)), b)); // slice_type 1 = B
    assert.equal(b.sliceType, BITSTREAM_SLICE.UNKNOWN);
  });

  it('H.264: more than three list modifications, or an unknown one, fails as in the reference', () => {
    const bs = bitstreamInit('h264');
    assert.ok(bitstreamHeader(bs, H264_HEADER));
    assert.equal(bitstreamSlice(bs, h264SliceP(3, 1, [[0, 1], [0, 2], [0, 3]]), blankSlice()), false);
    assert.equal(bitstreamSlice(bs, h264SliceP(3, 1, [[4, 1]]), blankSlice()), false);
    assert.equal(bitstreamSlice(bs, h264SliceP(3, 1, [[0, 1], [0, 2]]), blankSlice()), true);
  });

  it('H.265 P slices: the first used reference frame, 0xff when none is used', () => {
    for (const log2 of [0, 4, 12]) {
      const bs = bitstreamInit('h265');
      assert.ok(bitstreamHeader(bs, h265Sps(log2)));
      for (const [used, expected] of [[[1], 0], [[0, 1], 1], [[0, 0, 0, 1, 1], 3], [[0, 0, 0], 0xff], [[], 0xff], [new Array(15).fill(0).concat(1), 15]] as Array<[number[], number]>) {
        for (const firstSlice of [true, false]) {
          const slice = blankSlice();
          assert.ok(bitstreamSlice(bs, h265SliceP(log2, 3, used, { firstSlice }), slice), `log2 ${log2} used ${used.join('')}`);
          assert.equal(slice.sliceType, BITSTREAM_SLICE.P);
          assert.equal(slice.referenceFrame, expected);
        }
      }
      assert.equal(bitstreamSlice(bs, h265SliceP(log2, 3, new Array(17).fill(0)), blankSlice()), false, 'more than 16 reference frames');
    }
  });

  it('H.265: changing the reference frame changes only that flag and the flags before it', () => {
    for (const log2 of [0, 4, 12]) {
      const bs = bitstreamInit('h265');
      assert.ok(bitstreamHeader(bs, h265Sps(log2)));
      // delta_poc values of different lengths move the flags to every bit position
      for (const deltaPoc of [[0, 0, 0, 0, 0, 0], [1, 0, 2, 0, 5, 0], [3, 9, 0, 1, 0, 30], [200, 0, 0, 70, 1, 2]]) {
        for (let target = 0; target < 6; target++) {
          const original = h265SliceP(log2, 9, [1, 1, 0, 1, 0, 1], { deltaPoc });
          const data = Uint8Array.from(original);
          assert.ok(bitstreamSliceSetReferenceFrame(bs, data, target));
          const expected = h265SliceP(log2, 9, [1, 1, 0, 1, 0, 1].map((flag, i) => (i < target ? 0 : i === target ? 1 : flag)), { deltaPoc });
          assert.deepEqual(data, expected, `log2 ${log2} deltaPoc ${deltaPoc.join(',')} target ${target}`);
          const slice = blankSlice();
          assert.ok(bitstreamSlice(bs, data, slice));
          assert.equal(slice.referenceFrame, target);
        }
        const data = h265SliceP(log2, 9, [1, 1, 0, 1, 0, 1], { deltaPoc });
        assert.equal(bitstreamSliceSetReferenceFrame(bs, data, 6), false, 'only 6 reference frames');
        assert.deepEqual(data, h265SliceP(log2, 9, [0, 0, 0, 0, 0, 0], { deltaPoc }), 'all flags cleared on the way');
      }
    }
  });

  it('H.265: refuses to change an I slice; H.264 slices cannot be changed at all', () => {
    const h265 = bitstreamInit('h265');
    assert.ok(bitstreamHeader(h265, H265_HEADER));
    const i = Uint8Array.from(H265_SLICE_I);
    assert.equal(bitstreamSliceSetReferenceFrame(h265, i, 0), false);
    assert.deepEqual(i, H265_SLICE_I);

    const h264 = bitstreamInit('h264');
    assert.ok(bitstreamHeader(h264, H264_HEADER));
    const p = Uint8Array.from(H264_SLICE_P);
    assert.equal(bitstreamSliceSetReferenceFrame(h264, p, 1), false);
    assert.deepEqual(p, H264_SLICE_P);
  });

  it('a frame has to start with a start code and a slice: anything else is refused', () => {
    const lines: string[] = [];
    const bs = bitstreamInit('h264', (l) => lines.push(l));
    assert.ok(bitstreamHeader(bs, H264_HEADER));
    assert.equal(bitstreamSlice(bs, H264_HEADER, blankSlice()), false, 'an SPS is not a slice');
    assert.equal(bitstreamSlice(bs, H264_SLICE_P.subarray(4), blankSlice()), false, 'no start code');
    assert.equal(bitstreamSlice(bs, Uint8Array.from([0, 0, 1, 0x41, 0x9a, 0x04, 0x44, 0x3f]), blankSlice()), false, 'a three byte start code is not found');
    assert.deepEqual(lines, ['parse_slice_h264: Unexpected NAL unit type 7', 'parse_slice_h264: No startcode found', 'parse_slice_h264: No startcode found']);

    // the start code may sit up to 64 bytes into the data
    const padded = new Uint8Array(64 + H264_SLICE_P.length).fill(0xff);
    padded.set(H264_SLICE_P, 64);
    const slice = blankSlice();
    assert.ok(bitstreamSlice(bs, padded, slice));
    assert.equal(slice.sliceType, BITSTREAM_SLICE.P);
    const tooFar = new Uint8Array(65 + H264_SLICE_P.length).fill(0xff);
    tooFar.set(H264_SLICE_P, 65);
    assert.equal(bitstreamSlice(bs, tooFar, blankSlice()), false);
  });

  it('only the first slice of a frame is read: what follows the next start code does not matter', () => {
    const bs = bitstreamInit('h265');
    assert.ok(bitstreamHeader(bs, H265_HEADER));
    const two = Uint8Array.from([...H265_SLICE_P_REF_5.subarray(0, 12), ...START, ...H265_SLICE_I.subarray(4)]);
    const slice = blankSlice();
    assert.ok(bitstreamSlice(bs, two, slice));
    assert.equal(slice.sliceType, BITSTREAM_SLICE.P);
    assert.equal(slice.referenceFrame, 5);
  });
});

describe('bitstream: input that is cut short or random', () => {
  const vectors: Array<['h264' | 'h265', Uint8Array, Uint8Array]> = [
    ['h264', H264_HEADER, H264_SLICE_I], ['h264', H264_HEADER, H264_SLICE_P], ['h264', H264_HEADER, H264_SLICE_P_REF_5],
    ['h265', H265_HEADER, H265_SLICE_I], ['h265', H265_HEADER, H265_SLICE_P], ['h265', H265_HEADER, H265_SLICE_P_REF_5],
    ['h265', H265_HEADER, H265_SLICE_P_ISSUE_213], ['h265', H265_HEADER, H265_SLICE_P_SET_REF],
  ];

  it('every prefix of every vector comes back with an answer (the C code can loop forever on some of them)', () => {
    for (const [codec, header, sliceData] of vectors) {
      const bs = bitstreamInit(codec);
      for (let n = 0; n <= header.length; n++) assert.equal(typeof bitstreamHeader(bs, header.slice(0, n)), 'boolean');
      assert.ok(bitstreamHeader(bs, header));
      for (let n = 0; n <= sliceData.length; n++) {
        assert.equal(typeof bitstreamSlice(bs, sliceData.slice(0, n), blankSlice()), 'boolean');
        for (let ref = 0; ref < 17; ref++) assert.equal(typeof bitstreamSliceSetReferenceFrame(bs, sliceData.slice(0, n), ref), 'boolean');
      }
    }
  });

  it('a slice header that ends before its last field is refused, not read as zeros', () => {
    const bs = bitstreamInit('h265');
    assert.ok(bitstreamHeader(bs, H265_HEADER));
    assert.equal(bitstreamSlice(bs, H265_SLICE_P.subarray(0, 6), blankSlice()), false, 'nothing after the NAL header');
    assert.equal(bitstreamSlice(bs, H265_SLICE_P.subarray(0, 5), blankSlice()), false, 'half a NAL header');
    assert.equal(bitstreamSlice(bs, START.length === 4 ? Uint8Array.from(START) : new Uint8Array(0), blankSlice()), false, 'only a start code');
  });

  it('random bytes behind a slice NAL header always come back with an answer, and the same one each time', () => {
    let s = 0x1234abcd;
    const rnd = (): number => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s;
    };
    for (const [codec, header, nalHeader] of [['h264', H264_HEADER, [0x41]], ['h264', H264_HEADER, [0x65]], ['h265', H265_HEADER, [0x02, 0x01]], ['h265', H265_HEADER, [0x28, 0x01]]] as Array<['h264' | 'h265', Uint8Array, number[]]>) {
      const bs = bitstreamInit(codec);
      assert.ok(bitstreamHeader(bs, header));
      for (let round = 0; round < 3000; round++) {
        const len = rnd() % 40;
        // many zeros, so that 00 00 03 and start codes turn up often
        const body = Array.from({ length: len }, () => (rnd() % 3 === 0 ? rnd() & 0xff : [0, 0, 0, 1, 3][rnd() % 5]!));
        const data = Uint8Array.from([...START, ...nalHeader, ...body]);
        const a = blankSlice();
        const b = blankSlice();
        const ra = bitstreamSlice(bs, data, a);
        const rb = bitstreamSlice(bs, Uint8Array.from(data), b);
        assert.equal(ra, rb);
        assert.deepEqual(a, b);
        const changed = Uint8Array.from(data);
        const ok = bitstreamSliceSetReferenceFrame(bs, changed, rnd() % 17);
        assert.equal(typeof ok, 'boolean');
        assert.equal(changed.length, data.length);
        if (codec === 'h264') assert.deepEqual(changed, data);
      }
    }
  });
});

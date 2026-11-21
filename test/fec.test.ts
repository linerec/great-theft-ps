// SPDX-License-Identifier: AGPL-3.0-only
//
// Forward error correction. The first group is chiaki-ng's own test (test/fec.c with test/fec_test_cases.inl, commit
// 43728af): 64 frame buffers with their FEC units, some units overwritten, and the decoder has to give the source
// units back. These vectors are what pins the field arithmetic and the coding matrix of fec-gf256.ts to the Jerasure
// library the reference uses. The second group uses the same vectors the other way round (encoding the source units
// and comparing with the FEC units of the vector), which the reference's test does not do. The rest are tests written
// for this port; they can only show that encoder and decoder agree with each other.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cauchyOriginalCodingMatrix, gfDivide, gfMultiply, GF256_PRIMITIVE_POLYNOMIAL, jerasureInvertMatrix,
} from '../src/console/fec-gf256.ts';
import { fecDecode, fecEncode, FEC_WORDSIZE } from '../src/console/fec.ts';
import { FEC_TEST_CASES } from './fec.test-vectors.ts';

/** A small deterministic generator (xorshift32), so that failures can be reproduced. */
function prng(seed: number): () => number {
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

describe('FEC decode: chiaki-ng test vectors (test/fec.c, test/fec_test_cases.inl)', () => {
  it('has all 64 vectors', () => {
    assert.equal(FEC_TEST_CASES.length, 64);
  });

  for (const [id, tc] of FEC_TEST_CASES.entries()) {
    it(`case ${id}: k=${tc.k} m=${tc.m} unit=${tc.unitSize} erased=[${tc.erasures.join(',')}]`, () => {
      // test_fec_case() of test/fec.c, step by step
      const ref = Buffer.from(tc.frameBufferB64, 'base64');
      assert.equal(ref.length, tc.unitSize * (tc.k + tc.m));

      const stride = Math.floor((tc.unitSize + 0xf) / 0x10) * 0x10;
      const frameBuffer = new Uint8Array(stride * (tc.k + tc.m));
      for (let i = 0; i < tc.k + tc.m; i++) frameBuffer.set(ref.subarray(i * tc.unitSize, (i + 1) * tc.unitSize), i * stride);

      // write garbage over erasures
      for (const e of tc.erasures) {
        assert.ok(e < tc.k + tc.m);
        frameBuffer.fill(0x42, stride * e, stride * e + tc.unitSize);
      }

      assert.equal(fecDecode(frameBuffer, tc.unitSize, stride, tc.k, tc.m, tc.erasures), 'success');

      for (let i = 0; i < tc.k; i++) {
        assert.deepEqual(
          Buffer.from(frameBuffer.subarray(i * stride, i * stride + tc.unitSize)),
          ref.subarray(i * tc.unitSize, (i + 1) * tc.unitSize),
          `source unit ${i}`,
        );
      }
    });
  }
});

describe('FEC with the same vectors, beyond what the reference test checks', () => {
  // In the vectors, the slots of the FEC units that the test erases do not hold the frame's FEC data (none of the 63
  // agrees with the encoder), so only the FEC units a vector keeps can be compared: 68 units in all.
  const encoded = (tc: (typeof FEC_TEST_CASES)[number]): Uint8Array => {
    const ref = Buffer.from(tc.frameBufferB64, 'base64');
    const frameBuffer = new Uint8Array(ref.length);
    frameBuffer.set(ref.subarray(0, tc.k * tc.unitSize));
    assert.equal(fecEncode(frameBuffer, tc.unitSize, tc.unitSize, tc.k, tc.m), 'success');
    return frameBuffer;
  };

  it('encoding the source units of every vector gives the FEC units the vector keeps, byte for byte (68 units)', () => {
    let compared = 0;
    for (const [id, tc] of FEC_TEST_CASES.entries()) {
      const ref = Buffer.from(tc.frameBufferB64, 'base64');
      const frameBuffer = encoded(tc);
      for (let j = tc.k; j < tc.k + tc.m; j++) {
        if (tc.erasures.includes(j)) continue;
        assert.ok(
          Buffer.from(frameBuffer.subarray(j * tc.unitSize, (j + 1) * tc.unitSize)).equals(ref.subarray(j * tc.unitSize, (j + 1) * tc.unitSize)),
          `case ${id}, FEC unit ${j}`,
        );
        compared++;
      }
    }
    assert.equal(compared, 68);
  });

  it('every way of losing one unit (or two, where there are two FEC units) of a vector is recovered', () => {
    // The truth is the vector's source units with the FEC units of the encoder (equal to the vector's where it has them).
    for (const [id, tc] of FEC_TEST_CASES.entries()) {
      const ref = encoded(tc);
      const n = tc.k + tc.m;
      const patterns: number[][] = [];
      for (let a = 0; a < n; a++) {
        patterns.push([a]);
        if (tc.m >= 2) for (let b = a + 1; b < n; b++) patterns.push([a, b]);
      }
      for (const erasures of patterns) {
        const frameBuffer = Uint8Array.from(ref);
        for (const e of erasures) frameBuffer.fill(0x42, tc.unitSize * e, tc.unitSize * (e + 1));
        assert.equal(fecDecode(frameBuffer, tc.unitSize, tc.unitSize, tc.k, tc.m, erasures), 'success');
        assert.ok(Buffer.from(frameBuffer).equals(Buffer.from(ref)), `case ${id}, erased ${erasures.join(',')}`);
      }
    }
  });
});

describe('GF(2^8) arithmetic and the coding matrix', () => {
  it('uses the polynomial 0x11d and bytes as symbols', () => {
    assert.equal(GF256_PRIMITIVE_POLYNOMIAL, 0x11d);
    assert.equal(FEC_WORDSIZE, 8);
    assert.equal(gfMultiply(2, 0x80), 0x1d); // x * x^7 = x^8 = x^4 + x^3 + x^2 + 1
    assert.equal(gfMultiply(0x80, 0x80), 0x13); // x^14 reduced
    assert.equal(gfMultiply(3, 7), 9); // (x + 1)(x^2 + x + 1) = x^3 + 1, no reduction
  });

  it('multiplication agrees with shift-and-reduce for every pair', () => {
    const slow = (a: number, b: number): number => {
      let r = 0;
      while (b) {
        if (b & 1) r ^= a;
        a <<= 1;
        if (a & 0x100) a ^= 0x11d;
        b >>= 1;
      }
      return r;
    };
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) assert.equal(gfMultiply(a, b), slow(a, b));
  });

  it('division undoes multiplication; zero cases answer as the library does', () => {
    for (let a = 0; a < 256; a++) for (let b = 1; b < 256; b++) assert.equal(gfDivide(gfMultiply(a, b), b), a);
    assert.equal(gfDivide(0, 5), 0);
    assert.equal(gfDivide(0, 0), 0);
    assert.equal(gfDivide(5, 0), -1);
  });

  it('the matrix is the Cauchy matrix 1 / (i xor (m + j))', () => {
    const k = 5, m = 3;
    const matrix = cauchyOriginalCodingMatrix(k, m)!;
    assert.equal(matrix.length, k * m);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < k; j++) assert.equal(gfMultiply(matrix[i * k + j]!, i ^ (m + j)), 1);
    }
    assert.deepEqual(Array.from(cauchyOriginalCodingMatrix(2, 1)!), [1, 0x8e]); // 1/1 and 1/2
    assert.equal(cauchyOriginalCodingMatrix(200, 57), null);
    assert.notEqual(cauchyOriginalCodingMatrix(200, 56), null);
  });

  it('matrix inversion: inverse times matrix is the identity; a singular matrix is refused', () => {
    const rnd = prng(7);
    const n = 6;
    let mat: Int32Array;
    let inv: Int32Array;
    do {
      mat = Int32Array.from({ length: n * n }, () => rnd() & 0xff);
      inv = new Int32Array(n * n);
    } while (jerasureInvertMatrix(Int32Array.from(mat), inv, n) < 0);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        let sum = 0;
        for (let x = 0; x < n; x++) sum ^= gfMultiply(inv[r * n + x]!, mat[x * n + c]!);
        assert.equal(sum, r === c ? 1 : 0);
      }
    }
    assert.equal(jerasureInvertMatrix(Int32Array.from([1, 2, 1, 2]), new Int32Array(4), 2), -1);
  });
});

describe('FEC: tests written for this port', () => {
  const build = (k: number, m: number, unitSize: number, stride: number, seed: number): { frame: Uint8Array; units: Uint8Array[] } => {
    const rnd = prng(seed);
    const packed = new Uint8Array((k + m) * unitSize);
    for (let i = 0; i < k * unitSize; i++) packed[i] = rnd() & 0xff;
    assert.equal(fecEncode(packed, unitSize, unitSize, k, m), 'success');
    const units: Uint8Array[] = [];
    const frame = new Uint8Array((k + m) * stride);
    for (let i = 0; i < k + m; i++) {
      units.push(packed.slice(i * unitSize, (i + 1) * unitSize));
      frame.set(units[i]!, i * stride);
    }
    return { frame, units };
  };

  it('encode, lose units, decode: every size from 1+1 to 12+8 with as many losses as there are FEC units', () => {
    const rnd = prng(99);
    for (let k = 1; k <= 12; k++) {
      for (let m = 1; m <= 8; m++) {
        const unitSize = 37;
        const stride = 48;
        const { frame, units } = build(k, m, unitSize, stride, k * 100 + m);
        const erasures = new Set<number>();
        while (erasures.size < m) erasures.add(rnd() % (k + m));
        for (const e of erasures) frame.fill(0xee, e * stride, e * stride + unitSize);
        assert.equal(fecDecode(frame, unitSize, stride, k, m, [...erasures]), 'success');
        for (let i = 0; i < k + m; i++) assert.deepEqual(frame.subarray(i * stride, i * stride + unitSize), units[i], `k=${k} m=${m} unit ${i}`);
      }
    }
  });

  it('leaves the bytes between the units (the stride padding) alone', () => {
    const { frame } = build(4, 2, 10, 16, 5);
    for (let i = 0; i < 6; i++) frame.fill(0xaa, i * 16 + 10, (i + 1) * 16);
    frame.fill(0, 16, 26);
    assert.equal(fecDecode(frame, 10, 16, 4, 2, [1]), 'success');
    for (let i = 0; i < 6; i++) assert.deepEqual(Array.from(frame.subarray(i * 16 + 10, (i + 1) * 16)), [0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
  });

  it('one more loss than there are FEC units fails', () => {
    const { frame } = build(5, 2, 20, 32, 11);
    assert.equal(fecDecode(frame, 20, 32, 5, 2, [0, 3, 6]), 'fec-failed');
    assert.equal(fecDecode(frame, 20, 32, 5, 2, [0, 1, 2]), 'fec-failed');
    // naming a unit twice counts once
    assert.equal(fecDecode(frame, 20, 32, 5, 2, [0, 0, 3]), 'success');
  });

  it('nothing erased is a success that changes nothing', () => {
    const { frame } = build(3, 2, 20, 32, 12);
    const before = Uint8Array.from(frame);
    assert.equal(fecDecode(frame, 20, 32, 3, 2, []), 'success');
    assert.deepEqual(frame, before);
  });

  it('answers as the reference for a stride smaller than the unit and for more than 256 units', () => {
    assert.equal(fecDecode(new Uint8Array(1000), 20, 16, 3, 2, [0]), 'invalid-data');
    assert.equal(fecEncode(new Uint8Array(1000), 20, 16, 3, 2), 'invalid-data');
    assert.equal(fecDecode(new Uint8Array(300), 1, 1, 250, 7, [0]), 'memory');
    assert.equal(fecEncode(new Uint8Array(300), 1, 1, 250, 7), 'memory');
    assert.equal(fecEncode(new Uint8Array(256), 1, 1, 250, 6), 'success');
  });

  it('refuses what would be out of bounds memory access in C', () => {
    assert.throws(() => fecDecode(new Uint8Array(100), 20, 32, 3, 2, [5]), RangeError);
    assert.throws(() => fecDecode(new Uint8Array(100), 20, 32, 3, 2, [-1]), RangeError);
    assert.throws(() => fecDecode(new Uint8Array(100), 20, 32, 3, 2, [0]), RangeError, 'buffer too short');
    assert.throws(() => fecEncode(new Uint8Array(99), 20, 20, 3, 2), RangeError);
  });

  it('encode writes the FEC units at k * unitSize even when the stride is larger (as the reference does)', () => {
    const k = 2, m = 1, unitSize = 4, stride = 8;
    const frame = new Uint8Array(24);
    frame.set([1, 2, 3, 4], 0);
    frame.set([5, 6, 7, 8], stride);
    assert.equal(fecEncode(frame, unitSize, stride, k, m), 'success');
    const packed = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0]);
    assert.equal(fecEncode(packed, unitSize, unitSize, k, m), 'success');
    // the FEC unit lands on top of the second source unit's slot (offset 8), not at 2 * stride
    assert.deepEqual(frame.subarray(8, 12), packed.subarray(8, 12));
    assert.deepEqual(Array.from(frame.subarray(16, 24)), [0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

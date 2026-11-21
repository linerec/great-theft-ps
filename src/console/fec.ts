// SPDX-License-Identifier: AGPL-3.0-only
//
// Forward error correction for one frame: the console sends k source units and m FEC units, and any k of them are
// enough to rebuild the frame. Reed-Solomon erasure coding over GF(2^8) with a Cauchy coding matrix.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/fec.c and lib/include/chiaki/fec.h
// (commit 43728af). The reference calls the Jerasure library; the parts it calls are in fec-gf256.ts (see the notices
// there: Jerasure and GF-Complete, both under a revised BSD licence).
//
// The frame buffer holds the units one after another, `stride` bytes apart, of which the first `unitSize` bytes count:
// units 0..k-1 are the source units, units k..k+m-1 the FEC units.
//
// Differences to the C function, which has no way to notice them: an erasure index outside 0..k+m-1 and a frame buffer
// that is too short for the units are refused with a RangeError (in C both are out of bounds memory access).
//
// STATUS: checked against all 64 vectors of chiaki-ng's test/fec.c (test/fec.test.ts). Not run against a real console.

import { cauchyOriginalCodingMatrix, jerasureMatrixDecode, jerasureMatrixEncode } from './fec-gf256.ts';

/** CHIAKI_FEC_WORDSIZE: symbols are bytes. */
export const FEC_WORDSIZE = 8;

/**
 * The reference's error codes for these two functions: CHIAKI_ERR_SUCCESS, CHIAKI_ERR_INVALID_DATA (stride smaller than
 * the unit), CHIAKI_ERR_MEMORY (no coding matrix: more than 256 units) and CHIAKI_ERR_FEC_FAILED (too many erasures).
 */
export type FecResult = 'success' | 'invalid-data' | 'memory' | 'fec-failed';

function checkCounts(unitSize: number, stride: number, k: number, m: number): void {
  for (const [name, v] of [['unitSize', unitSize], ['stride', stride], ['k', k], ['m', m]] as const) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
  }
}

/** create_matrix(): the coding matrix the console uses. Null when k + m is more than 256. */
export function fecCreateMatrix(k: number, m: number): Int32Array | null {
  return cauchyOriginalCodingMatrix(k, m);
}

/**
 * chiaki_fec_decode: rebuilds the erased units in place. `erasures` lists the indices of the units that are missing
 * (source units and FEC units alike). Erased FEC units are computed again too, as Jerasure does.
 */
export function fecDecode(frameBuf: Uint8Array, unitSize: number, stride: number, k: number, m: number, erasures: ArrayLike<number>): FecResult {
  checkCounts(unitSize, stride, k, m);
  if (stride < unitSize) return 'invalid-data';
  const matrix = fecCreateMatrix(k, m);
  if (!matrix) return 'memory';

  for (let i = 0; i < erasures.length; i++) {
    const e = erasures[i]!;
    if (!Number.isInteger(e) || e < 0 || e >= k + m) throw new RangeError(`erasure index ${e} is outside the ${k + m} units of the frame`);
  }
  if (k + m > 0 && frameBuf.length < stride * (k + m - 1) + unitSize) throw new RangeError('frame buffer is too short for the units');

  const dataPtrs: Uint8Array[] = [];
  const codingPtrs: Uint8Array[] = [];
  for (let i = 0; i < k + m; i++) {
    const bufPtr = frameBuf.subarray(stride * i, stride * i + unitSize);
    if (i < k) dataPtrs.push(bufPtr);
    else codingPtrs.push(bufPtr);
  }

  const res = jerasureMatrixDecode(k, m, matrix, erasures, dataPtrs, codingPtrs, unitSize);
  return res < 0 ? 'fec-failed' : 'success';
}

/**
 * chiaki_fec_encode: computes the m FEC units of the k source units.
 *
 * As in the reference, the source units are read `stride` bytes apart, but the FEC units are written right behind
 * each other at k * unitSize, NOT at k * stride. The two layouts only agree when stride equals unitSize. (The
 * reference never calls this function itself.)
 */
export function fecEncode(frameBuf: Uint8Array, unitSize: number, stride: number, k: number, m: number): FecResult {
  checkCounts(unitSize, stride, k, m);
  if (stride < unitSize) return 'invalid-data';
  const matrix = fecCreateMatrix(k, m);
  if (!matrix) return 'memory';

  const needed = Math.max(k > 0 ? stride * (k - 1) + unitSize : 0, (k + m) * unitSize);
  if (frameBuf.length < needed) throw new RangeError('frame buffer is too short for the units');

  const dataPtrs: Uint8Array[] = [];
  const codingPtrs: Uint8Array[] = [];
  for (let i = 0; i < m; i++) codingPtrs.push(new Uint8Array(unitSize));
  for (let i = 0; i < k; i++) dataPtrs.push(frameBuf.subarray(stride * i, stride * i + unitSize));

  jerasureMatrixEncode(k, m, matrix, dataPtrs, codingPtrs, unitSize);

  for (let i = 0; i < m; i++) frameBuf.set(codingPtrs[i]!, k * unitSize + i * unitSize);
  return 'success';
}

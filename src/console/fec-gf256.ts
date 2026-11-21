// SPDX-License-Identifier: AGPL-3.0-only
//
// Arithmetic in GF(2^8) and the matrix form of Reed-Solomon erasure coding that the reference gets from two native
// libraries: Jerasure and GF-Complete. There is no native library here, so the few functions the reference calls are
// written out in TypeScript, so that they produce the same bytes.
//
// Derived from (as called by chiaki-ng lib/src/fec.c and lib/src/common.c, commit 43728af):
//   - Jerasure 2.0 (https://github.com/streetpea/jerasure, a fork of the library by James S. Plank and Kevin M. Greenan):
//       src/cauchy.c    cauchy_original_coding_matrix()
//       src/jerasure.c  jerasure_matrix_encode(), jerasure_matrix_decode(), jerasure_matrix_dotprod(),
//                       jerasure_make_decoding_matrix(), jerasure_invert_matrix(), jerasure_erasures_to_erased()
//       src/galois.c    galois_single_multiply(), galois_single_divide(), galois_w08_region_multiply(), galois_region_xor()
//     Copyright (c) 2013, James S. Plank and Kevin Greenan. All rights reserved. Revised (3-clause) BSD licence.
//   - GF-Complete 1.0 (https://github.com/streetpea/gf-complete, a fork of the library by James S. Plank and others):
//       src/gf_w8.c     the default field for w = 8: polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
//     Copyright (c) 2013, James S. Plank, Ethan L. Miller, Kevin M. Greenan, Benjamin A. Arnold, John A. Burnum,
//     Adam W. Disney, Allen C. McBride. All rights reserved. Revised (3-clause) BSD licence.
//   Both licences ask that the copyright notice, the list of conditions and the disclaimer stay with redistributed
//   source, and that the names of the University of Tennessee and of the contributors are not used to promote derived
//   work. The software is provided by the copyright holders "as is", without warranty of any kind.
//
// How the text was obtained, and what is therefore still open: the two libraries are git submodules of chiaki-ng
// (third-party/jerasure, third-party/gf-complete) and were NOT checked out in the copy this port was made from.
//   - The functions below follow the published Jerasure 2.0 algorithms from knowledge of that source, not from a file
//     that was open while writing. What pins them to the real thing is the test vectors, not a reading of the source.
//   - The copyright lines above are likewise written from knowledge of the two licence files, not copied from them.
//     The licence files themselves are not reproduced in this project yet: they have to be taken from the two
//     repositories (and the lines above checked against them) and added to NOTICE.md.
//
// What is left out: Jerasure can treat the first coding row specially when it is all ones (row_k_ones). fec.c always
// passes 0 for it, so only that case is written. Word sizes other than 8 are not written either.
//
// STATUS: checked against all 64 vectors of chiaki-ng's test/fec.c (frame buffers with their FEC units): decoding the
// erased source units gives the bytes of the vector, and encoding the source units gives, byte for byte, each of the
// 68 FEC units that the vectors keep (test/fec.test.ts). Not run against a real console.

/** The field polynomial of GF-Complete's default field for w = 8. */
export const GF256_PRIMITIVE_POLYNOMIAL = 0x11d;

const GF_EXP = new Uint8Array(510); // 2^i, twice in a row so that a sum of two logarithms needs no modulo
const GF_LOG = new Uint8Array(256);
/** GF_MUL[(a << 8) | b] = a * b in the field. 64 KiB, built once. */
const GF_MUL = new Uint8Array(256 * 256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_EXP[i + 255] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF256_PRIMITIVE_POLYNOMIAL;
  }
  for (let a = 1; a < 256; a++) {
    const la = GF_LOG[a]!;
    for (let b = 1; b < 256; b++) GF_MUL[(a << 8) | b] = GF_EXP[la + GF_LOG[b]!]!;
  }
}

/** galois_single_multiply(a, b, 8). */
export function gfMultiply(a: number, b: number): number {
  return GF_MUL[((a & 0xff) << 8) | (b & 0xff)]!;
}

/** galois_single_divide(a, b, 8): 0 for a zero numerator, -1 for a division by zero, as the library answers. */
export function gfDivide(a: number, b: number): number {
  a &= 0xff;
  b &= 0xff;
  if (a === 0) return 0;
  if (b === 0) return -1;
  return GF_EXP[GF_LOG[a]! + 255 - GF_LOG[b]!]!;
}

/**
 * galois_w08_region_multiply(src, c, size, dst, add): dst = c * src, or dst ^= c * src when `add` is set.
 */
export function gfRegionMultiply(src: Uint8Array, c: number, size: number, dst: Uint8Array, add: boolean): void {
  const row = (c & 0xff) << 8;
  if (add) {
    for (let i = 0; i < size; i++) dst[i] = dst[i]! ^ GF_MUL[row | src[i]!]!;
  } else {
    for (let i = 0; i < size; i++) dst[i] = GF_MUL[row | src[i]!]!;
  }
}

/** galois_region_xor(src, dst, size): dst ^= src. */
export function gfRegionXor(src: Uint8Array, dst: Uint8Array, size: number): void {
  for (let i = 0; i < size; i++) dst[i] = dst[i]! ^ src[i]!;
}

/**
 * cauchy_original_coding_matrix(k, m, 8): m rows of k coefficients, row after row. Element (i, j) is 1 / (i XOR (m + j)).
 * Null when k + m does not fit the field (more than 256 units), as the library answers.
 */
export function cauchyOriginalCodingMatrix(k: number, m: number): Int32Array | null {
  if (k + m > 256) return null;
  const matrix = new Int32Array(k * m);
  let index = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < k; j++) {
      matrix[index] = gfDivide(1, i ^ (m + j));
      index++;
    }
  }
  return matrix;
}

/**
 * jerasure_matrix_dotprod(k, 8, matrix_row, src_ids, dest_id, data_ptrs, coding_ptrs, size): one destination unit as
 * the sum of k source units, each multiplied by its coefficient. `rowOffset` is where the row starts in `matrix`.
 * Without `srcIds` the sources are the data units 0..k-1. Coefficients of 1 are copied or xor-ed first, the others
 * multiplied after, as in the library; a row of zeros leaves the destination as it was.
 */
export function jerasureMatrixDotprod(
  k: number, matrix: Int32Array, rowOffset: number, srcIds: Int32Array | null, destId: number,
  dataPtrs: Uint8Array[], codingPtrs: Uint8Array[], size: number,
): void {
  let init = false;
  const dptr = destId < k ? dataPtrs[destId]! : codingPtrs[destId - k]!;
  const source = (i: number): Uint8Array => {
    if (srcIds === null) return dataPtrs[i]!;
    const id = srcIds[i]!;
    return id < k ? dataPtrs[id]! : codingPtrs[id - k]!;
  };

  // First copy or xor any data that does not need to be multiplied by a factor
  for (let i = 0; i < k; i++) {
    if (matrix[rowOffset + i] === 1) {
      const sptr = source(i);
      if (!init) {
        dptr.set(sptr.subarray(0, size));
        init = true;
      } else {
        gfRegionXor(sptr, dptr, size);
      }
    }
  }

  // Now do the data that needs to be multiplied by a factor
  for (let i = 0; i < k; i++) {
    const factor = matrix[rowOffset + i]!;
    if (factor !== 0 && factor !== 1) {
      gfRegionMultiply(source(i), factor, size, dptr, init);
      init = true;
    }
  }
}

/** jerasure_matrix_encode(k, m, 8, matrix, data_ptrs, coding_ptrs, size): fills the m coding units. */
export function jerasureMatrixEncode(k: number, m: number, matrix: Int32Array, dataPtrs: Uint8Array[], codingPtrs: Uint8Array[], size: number): void {
  for (let i = 0; i < m; i++) jerasureMatrixDotprod(k, matrix, i * k, null, k + i, dataPtrs, codingPtrs, size);
}

/**
 * jerasure_erasures_to_erased(k, m, erasures): one flag per unit. Null when fewer than k units are left, which is the
 * library's way of saying that the data cannot be recovered.
 */
export function jerasureErasuresToErased(k: number, m: number, erasures: ArrayLike<number>): Uint8Array | null {
  const td = k + m;
  const erased = new Uint8Array(td);
  let nonErased = td;
  for (let i = 0; i < erasures.length; i++) {
    const e = erasures[i]!;
    if (erased[e] === 0) {
      erased[e] = 1;
      nonErased--;
      if (nonErased < k) return null;
    }
  }
  return erased;
}

/**
 * jerasure_invert_matrix(mat, inv, rows, 8): Gauss-Jordan elimination in the field. `mat` is destroyed. Returns -1
 * when the matrix cannot be inverted.
 */
export function jerasureInvertMatrix(mat: Int32Array, inv: Int32Array, rows: number): number {
  const cols = rows;

  let k = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      inv[k] = i === j ? 1 : 0;
      k++;
    }
  }

  // First -- convert into upper triangular
  for (let i = 0; i < cols; i++) {
    const rowStart = cols * i;

    // Swap rows if we have a zero i,i element. If we can't swap, then the matrix was not invertible
    if (mat[rowStart + i] === 0) {
      let j = i + 1;
      while (j < rows && mat[cols * j + i] === 0) j++;
      if (j === rows) return -1;
      const rs2 = j * cols;
      for (k = 0; k < cols; k++) {
        let tmp = mat[rowStart + k]!;
        mat[rowStart + k] = mat[rs2 + k]!;
        mat[rs2 + k] = tmp;
        tmp = inv[rowStart + k]!;
        inv[rowStart + k] = inv[rs2 + k]!;
        inv[rs2 + k] = tmp;
      }
    }

    // Multiply the row by 1/element i,i
    const pivot = mat[rowStart + i]!;
    if (pivot !== 1) {
      const inverse = gfDivide(1, pivot);
      for (let j = 0; j < cols; j++) {
        mat[rowStart + j] = gfMultiply(mat[rowStart + j]!, inverse);
        inv[rowStart + j] = gfMultiply(inv[rowStart + j]!, inverse);
      }
    }

    // Now for each j>i, add A_ji*Ai to Aj
    k = rowStart + i;
    for (let j = i + 1; j !== cols; j++) {
      k += cols;
      const factor = mat[k]!;
      if (factor !== 0) {
        const rs2 = cols * j;
        if (factor === 1) {
          for (let x = 0; x < cols; x++) {
            mat[rs2 + x] = mat[rs2 + x]! ^ mat[rowStart + x]!;
            inv[rs2 + x] = inv[rs2 + x]! ^ inv[rowStart + x]!;
          }
        } else {
          for (let x = 0; x < cols; x++) {
            mat[rs2 + x] = mat[rs2 + x]! ^ gfMultiply(factor, mat[rowStart + x]!);
            inv[rs2 + x] = inv[rs2 + x]! ^ gfMultiply(factor, inv[rowStart + x]!);
          }
        }
      }
    }
  }

  // Now the matrix is upper triangular. Start at the top and multiply down
  for (let i = rows - 1; i >= 0; i--) {
    const rowStart = i * cols;
    for (let j = 0; j < i; j++) {
      const rs2 = j * cols;
      const factor = mat[rs2 + i]!;
      if (factor !== 0) {
        mat[rs2 + i] = 0;
        for (k = 0; k < cols; k++) inv[rs2 + k] = inv[rs2 + k]! ^ gfMultiply(factor, inv[rowStart + k]!);
      }
    }
  }
  return 0;
}

/**
 * jerasure_make_decoding_matrix(k, m, 8, matrix, erased, decoding_matrix, dm_ids): takes the first k units that are
 * still there (`dmIds`), writes down how each of them is made from the data units (an identity row for a data unit,
 * its coding row for a coding unit) and inverts that. Row i of the result makes data unit i from those k units.
 */
export function jerasureMakeDecodingMatrix(k: number, m: number, matrix: Int32Array, erased: Uint8Array, decodingMatrix: Int32Array, dmIds: Int32Array): number {
  void m;
  let j = 0;
  for (let i = 0; j < k; i++) {
    if (erased[i] === 0) {
      dmIds[j] = i;
      j++;
    }
  }

  const tmpmat = new Int32Array(k * k);
  for (let i = 0; i < k; i++) {
    const id = dmIds[i]!;
    if (id < k) {
      for (j = 0; j < k; j++) tmpmat[i * k + j] = 0;
      tmpmat[i * k + id] = 1;
    } else {
      for (j = 0; j < k; j++) tmpmat[i * k + j] = matrix[(id - k) * k + j]!;
    }
  }

  return jerasureInvertMatrix(tmpmat, decodingMatrix, k);
}

/**
 * jerasure_matrix_decode(k, m, 8, matrix, row_k_ones = 0, erasures, data_ptrs, coding_ptrs, size): rebuilds the erased
 * data units from the units that are left, then encodes the erased coding units again. Returns 0, or -1 when more
 * than m units are erased.
 *
 * Every erasure index must be below k + m (the library does not check either; the caller here does).
 */
export function jerasureMatrixDecode(
  k: number, m: number, matrix: Int32Array, erasures: ArrayLike<number>, dataPtrs: Uint8Array[], codingPtrs: Uint8Array[], size: number,
): number {
  const erased = jerasureErasuresToErased(k, m, erasures);
  if (erased === null) return -1;

  // Find the number of data drives failed
  let edd = 0;
  for (let i = 0; i < k; i++) {
    if (erased[i]) edd++;
  }

  let dmIds: Int32Array | null = null;
  let decodingMatrix: Int32Array | null = null;
  if (edd > 0) {
    dmIds = new Int32Array(k);
    decodingMatrix = new Int32Array(k * k);
    if (jerasureMakeDecodingMatrix(k, m, matrix, erased, decodingMatrix, dmIds) < 0) return -1;
  }

  // Decode the data drives
  for (let i = 0; edd > 0 && i < k; i++) {
    if (erased[i]) {
      jerasureMatrixDotprod(k, decodingMatrix!, i * k, dmIds, i, dataPtrs, codingPtrs, size);
      edd--;
    }
  }

  // Finally, re-encode any erased coding devices
  for (let i = 0; i < m; i++) {
    if (erased[k + i]) jerasureMatrixDotprod(k, matrix, i * k, null, i + k, dataPtrs, codingPtrs, size);
  }

  return 0;
}

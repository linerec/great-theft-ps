// SPDX-License-Identifier: AGPL-3.0-only
//
// Helpers for H.264 in Annex B form (start-code separated NAL units), as a console stream delivers it.

/** NAL unit types we care about. */
export const NAL = { SPS: 7, PPS: 8, IDR: 5 } as const;

/** Offsets of the first byte after each start code (00 00 01 or 00 00 00 01). */
export function nalStarts(data: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) out.push(i + 3);
      else if (data[i + 2] === 0 && data[i + 3] === 1) out.push(i + 4);
    }
  }
  return out;
}

/** True if the access unit contains an IDR slice (a decodable keyframe). */
export function hasIdr(data: Uint8Array): boolean {
  return nalStarts(data).some((s) => (data[s]! & 0x1f) === NAL.IDR);
}

/**
 * The WebCodecs codec string ("avc1.PPCCLL") taken from the first SPS in the data, or null if there is none.
 * PP = profile_idc, CC = constraint flags, LL = level_idc, the three bytes right after the SPS NAL header.
 */
export function findSpsCodec(data: Uint8Array): string | null {
  for (const s of nalStarts(data)) {
    if ((data[s]! & 0x1f) === NAL.SPS && s + 3 < data.length) {
      const hex = (n: number): string => n.toString(16).padStart(2, '0');
      return `avc1.${hex(data[s + 1]!)}${hex(data[s + 2]!)}${hex(data[s + 3]!)}`;
    }
  }
  return null;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The small key schedule and cipher Remote Play uses for the registration exchange.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/rpcrypt.c and
// lib/include/chiaki/rpcrypt.h (commit 43728af). Names such as "ambassador", "bright" and "aeropause" are the
// reference implementation's. See NOTICE.md.
//
// What is ported: everything registration needs (initial keys from a PIN, the cipher, the IV). The session keys
// (keys_a / keys_b) are not ported yet; they belong to Phase 1 session setup.
//
// STATUS: checked against the reference implementation's own test vectors (test/regist.test.ts). Not yet run against
// a real console.

import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';

import type { ConsoleTarget } from './discovery.ts';
import { RP_KEYS_0_PS4, RP_KEYS_0_PS5, RP_KEYS_1_PS4, RP_KEYS_1_PS5, RP_KEYS_A_PS4, RP_KEYS_A_PS5, RP_KEYS_B_PS4, RP_KEYS_B_PS5 } from './rp-tables.ts';

export const KEY_SIZE = 16;

/** The state the reference calls ChiakiRPCrypt: the key (`bright`) and the IV seed (`ambassador`). */
export interface RpCrypt {
  target: ConsoleTarget;
  ambassador: Uint8Array;
  bright: Uint8Array;
}

/** Targets this module can handle. The "unknown" ones are refused because their keys cannot be chosen. */
export type KnownTarget = 'ps4-8' | 'ps4-9' | 'ps4-10' | 'ps5-1';

export const isKnownTarget = (t: ConsoleTarget): t is KnownTarget => t === 'ps4-8' || t === 'ps4-9' || t === 'ps4-10' || t === 'ps5-1';
export const isPs5Target = (t: ConsoleTarget): boolean => t === 'ps5-1' || t === 'ps5-unknown';
/** PS4 system software before 10 uses an older, simpler scheme. */
export const isPreTen = (t: ConsoleTarget): boolean => t === 'ps4-8' || t === 'ps4-9';

const ECHO_B = Uint8Array.from([0xe1, 0xec, 0x9c, 0x3a, 0xdd, 0xbd, 0x08, 0x85, 0xfc, 0x0e, 0x1d, 0x78, 0x90, 0x32, 0xc0, 0x04]);
const ECHO_A = Uint8Array.from([0x01, 0x49, 0x87, 0x9b, 0x65, 0x39, 0x8b, 0x39, 0x4b, 0x3a, 0x8d, 0x48, 0xc3, 0x0a, 0xef, 0x51]);
const REGIST_AES_KEY_PS4_PRE10 = Uint8Array.from([0x3f, 0x1c, 0xc4, 0xb6, 0xdc, 0xbb, 0x3e, 0xcc, 0x50, 0xba, 0xed, 0xef, 0x97, 0x34, 0xc7, 0xc9]);
const HMAC_KEY_PS5 = Uint8Array.from([0x46, 0x46, 0x87, 0xb3, 0x49, 0xca, 0x8c, 0xe8, 0x59, 0xc5, 0x27, 0x0f, 0x5d, 0x7a, 0x69, 0xd6]);
const HMAC_KEY_PS4 = Uint8Array.from([0x20, 0xd6, 0x6f, 0x59, 0x04, 0xea, 0x7c, 0x14, 0xe5, 0x57, 0xff, 0xc5, 0x2e, 0x48, 0x8a, 0xc8]);
const HMAC_KEY_PS4_PRE10 = Uint8Array.from([0xac, 0x07, 0x88, 0x83, 0xc8, 0x3a, 0x1f, 0xe8, 0x11, 0x46, 0x3a, 0xf3, 0x9e, 0xe3, 0xe3, 0x77]);

function hmacKey(target: ConsoleTarget): Uint8Array {
  if (target === 'ps5-1') return HMAC_KEY_PS5;
  if (isPreTen(target)) return HMAC_KEY_PS4_PRE10;
  return HMAC_KEY_PS4;
}

const need16 = (name: string, b: Uint8Array): void => {
  if (b.length !== KEY_SIZE) throw new RangeError(`${name} must be ${KEY_SIZE} bytes, got ${b.length}`);
};

/** PS4 before system software 10: the AES key is a fixed value with the PIN mixed into its first four bytes. */
export function initRegistPs4Pre10(ambassador: Uint8Array, pin: number): RpCrypt {
  need16('ambassador', ambassador);
  const bright = Uint8Array.from(REGIST_AES_KEY_PS4_PRE10);
  bright[0]! ^= (pin >>> 24) & 0xff;
  bright[1]! ^= (pin >>> 16) & 0xff;
  bright[2]! ^= (pin >>> 8) & 0xff;
  bright[3]! ^= pin & 0xff;
  return { target: 'ps4-9', ambassador: Uint8Array.from(ambassador), bright };
}

/** PS4 10 and later, and PS5: the AES key is one column of a table, with the PIN mixed into its last four bytes. */
export function initRegist(target: ConsoleTarget, ambassador: Uint8Array, key0Off: number, pin: number): RpCrypt {
  need16('ambassador', ambassador);
  if (!isKnownTarget(target) || isPreTen(target)) throw new RangeError(`initRegist does not apply to ${target}`);
  if (!Number.isInteger(key0Off) || key0Off < 0 || key0Off >= 0x20) throw new RangeError('key0Off must be 0..31');
  const table = isPs5Target(target) ? RP_KEYS_0_PS5 : RP_KEYS_0_PS4;
  const bright = new Uint8Array(KEY_SIZE);
  for (let i = 0; i < KEY_SIZE; i++) bright[i] = table[i * 0x20 + key0Off]!;
  bright[0xc]! ^= (pin >>> 24) & 0xff;
  bright[0xd]! ^= (pin >>> 16) & 0xff;
  bright[0xe]! ^= (pin >>> 8) & 0xff;
  bright[0xf]! ^= pin & 0xff;
  return { target, ambassador: Uint8Array.from(ambassador), bright };
}

/** The value the console needs to derive the ambassador again (PS4 before 10). */
export function aeropausePs4Pre10(ambassador: Uint8Array): Uint8Array {
  need16('ambassador', ambassador);
  const out = new Uint8Array(KEY_SIZE);
  for (let i = 0; i < KEY_SIZE; i++) out[i] = (((ambassador[i]! - i - 0x29) & 0xff) ^ ECHO_B[i]!) & 0xff;
  return out;
}

/** The value the console needs to derive the ambassador again (PS4 10 and later, PS5). */
export function aeropause(target: ConsoleTarget, key1Off: number, ambassador: Uint8Array): Uint8Array {
  need16('ambassador', ambassador);
  if (!isKnownTarget(target) || isPreTen(target)) throw new RangeError(`aeropause does not apply to ${target}`);
  if (!Number.isInteger(key1Off) || key1Off < 0 || key1Off >= 0x20) throw new RangeError('key1Off must be 0..31');
  const table = isPs5Target(target) ? RP_KEYS_1_PS5 : RP_KEYS_1_PS4;
  const wurzelbert = isPs5Target(target) ? 0xd3 /* -0x2d */ : 0x29;
  const out = new Uint8Array(KEY_SIZE);
  for (let i = 0; i < KEY_SIZE; i++) out[i] = (((ambassador[i]! ^ table[i * 0x20 + key1Off]!) + wurzelbert + i) & 0xff);
  return out;
}

/** Session keys for PS4 before 10 (used here only as a second set of test vectors for the cipher). */
export function brightAmbassadorPs4Pre10(nonce: Uint8Array, morning: Uint8Array): { bright: Uint8Array; ambassador: Uint8Array } {
  need16('nonce', nonce);
  need16('morning', morning);
  const ambassador = new Uint8Array(KEY_SIZE);
  const bright = new Uint8Array(KEY_SIZE);
  for (let i = 0; i < KEY_SIZE; i++) {
    ambassador[i] = (((nonce[i]! - i - 0x27) & 0xff) ^ ECHO_A[i]!) & 0xff;
    bright[i] = ((((morning[i]! - i + 0x34) & 0xff) ^ ECHO_B[i]!) ^ nonce[i]!) & 0xff;
  }
  return { bright, ambassador };
}

export function initAuthPs4Pre10(nonce: Uint8Array, morning: Uint8Array): RpCrypt {
  const { bright, ambassador } = brightAmbassadorPs4Pre10(nonce, morning);
  return { target: 'ps4-9', ambassador, bright };
}

/**
 * Session keys for PS4 10 and later and PS5, from the console's nonce and the key it handed out at registration
 * (`morning`, the reference's name for RP-Key). Port of bright_ambassador() in rpcrypt.c.
 */
export function brightAmbassador(target: ConsoleTarget, nonce: Uint8Array, morning: Uint8Array): { bright: Uint8Array; ambassador: Uint8Array } {
  need16('nonce', nonce);
  need16('morning', morning);
  if (!isKnownTarget(target) || isPreTen(target)) throw new RangeError(`brightAmbassador does not apply to ${target}`);
  const ps5 = isPs5Target(target);
  const keysA = ps5 ? RP_KEYS_A_PS5 : RP_KEYS_A_PS4;
  const keysB = ps5 ? RP_KEYS_B_PS5 : RP_KEYS_B_PS4;
  const ambassador = new Uint8Array(KEY_SIZE);
  const bright = new Uint8Array(KEY_SIZE);
  const rowA = (nonce[0]! >> 3) * 0x70;
  for (let i = 0; i < KEY_SIZE; i++) {
    let v = nonce[i]!;
    if (ps5) v = (v - 0x2d - i) & 0xff;
    else v = (v + 0x36 + i) & 0xff;
    ambassador[i] = (v ^ keysA[rowA + i]!) & 0xff;
  }
  const rowB = (nonce[7]! >> 3) * 0x70;
  for (let i = 0; i < KEY_SIZE; i++) {
    if (ps5) {
      let v = (morning[i]! + 0x18 + i) & 0xff;
      v ^= nonce[i]!;
      v ^= keysB[rowB + i]!;
      bright[i] = v & 0xff;
    } else {
      let v = (keysB[rowB + i]! ^ morning[i]!) & 0xff;
      v = (v + 0x21 + i) & 0xff;
      v ^= nonce[i]!;
      bright[i] = v & 0xff;
    }
  }
  return { bright, ambassador };
}

/** The cipher state for the control connection, once the console has answered the session request. */
export function initAuth(target: ConsoleTarget, nonce: Uint8Array, morning: Uint8Array): RpCrypt {
  if (!isKnownTarget(target)) throw new RangeError(`initAuth does not apply to ${target}`);
  if (isPreTen(target)) return initAuthPs4Pre10(nonce, morning);
  const { bright, ambassador } = brightAmbassador(target, nonce, morning);
  return { target, ambassador, bright };
}

/** IV for a message: the first 16 bytes of HMAC-SHA256(key by target, ambassador || counter as 8 bytes big endian). */
export function generateIv(rp: RpCrypt, counter: bigint | number): Buffer {
  const buf = Buffer.alloc(KEY_SIZE + 8);
  buf.set(rp.ambassador, 0);
  buf.writeBigUInt64BE(BigInt(counter), KEY_SIZE);
  return createHmac('sha256', hmacKey(rp.target)).update(buf).digest().subarray(0, KEY_SIZE);
}

/** AES-128 in CFB-128 mode, no padding. The same length comes out as went in. */
export function encrypt(rp: RpCrypt, counter: bigint | number, data: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-128-cfb', rp.bright, generateIv(rp, counter));
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function decrypt(rp: RpCrypt, counter: bigint | number, data: Uint8Array): Buffer {
  const decipher = createDecipheriv('aes-128-cfb', rp.bright, generateIv(rp, counter));
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

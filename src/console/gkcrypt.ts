// SPDX-License-Identifier: AGPL-3.0-only
//
// The stream cipher and packet authentication of the Takion stream ("GKCrypt"), and the bookkeeping that turns the
// 32 bit key position found in packets into the full 64 bit one (ChiakiKeyState).
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/gkcrypt.c and lib/include/chiaki/gkcrypt.h
// (commit 43728af). The derivations, the counter arithmetic and the order of steps are transcribed from there.
//
// How it works. Both ends derive, from the handshake key and the ECDH secret, one key and one IV per direction
// (`index` 2 is the client's sending direction, 3 the console's). Data is XORed with a key stream: AES-128 in ECB mode
// over the IV plus a block counter, the IV being treated as a little endian number. The position in that stream (the
// key position) travels with every packet. Packets are authenticated with a 4 byte GMAC (AES-128-GCM over the packet as
// additional data, no plaintext) whose key is replaced every 45000 key positions.
//
// What is NOT ported: the ring buffer of pre-generated key stream and the thread that fills it (key_buf_*). It is an
// optimisation whose output is byte for byte the same as generating on demand, so getKeyStream() simply generates.
//
// STATUS: checked against the reference implementation's own test vectors (test/gkcrypt.c and test/keystate.c, ported
// to test/gkcrypt.test.ts). NOT run against a real console. Secrets: nothing here logs keys, IVs or key stream.

import { createCipheriv, createHash, createHmac } from 'node:crypto';

import { seqNum32Gt, seqNum32Lt } from './seqnum.ts';

export const GKCRYPT_BLOCK_SIZE = 0x10;
export const GKCRYPT_KEY_BUF_BLOCKS_DEFAULT = 0x40; // kept for reference only: the key buffer is not ported
export const GKCRYPT_GMAC_SIZE = 4;
export const GKCRYPT_GMAC_KEY_REFRESH_KEY_POS = 45000;
export const GKCRYPT_GMAC_KEY_REFRESH_IV_OFFSET = 44910;

export const HANDSHAKE_KEY_SIZE = 0x10;
export const ECDH_SECRET_SIZE = 32;

const U64 = (1n << 64n) - 1n;
const BLOCK = BigInt(GKCRYPT_BLOCK_SIZE);

/**
 * counter_add(): `base` (16 bytes, little endian) plus `v` (64 bits), written to out[outOffset .. outOffset + 16).
 * The carry is dropped after the 16th byte, as in the reference.
 */
function counterAdd(out: Uint8Array, outOffset: number, base: Uint8Array, v: bigint): void {
  let i = 0;
  do {
    const r = (BigInt(base[i]!) + v) & U64; // `uint64_t r = base[i] + v`
    out[outOffset + i] = Number(r & 0xffn);
    v = r >> 8n;
    i++;
  } while (i < GKCRYPT_BLOCK_SIZE && v);
  for (; i < GKCRYPT_BLOCK_SIZE; i++) out[outOffset + i] = base[i]!;
}

/**
 * chiaki_gkcrypt_gen_gmac_key(): the GMAC key number `index`, from a base key and the IV.
 * SHA-256 over (key base || IV + index * 44910), the two halves of the digest XORed together.
 */
export function genGmacKey(index: bigint, keyBase: Uint8Array, iv: Uint8Array): Buffer {
  if (keyBase.length !== GKCRYPT_BLOCK_SIZE || iv.length !== GKCRYPT_BLOCK_SIZE) throw new RangeError('the key base and the IV must be 16 bytes each');
  const data = Buffer.alloc(0x20);
  data.set(keyBase, 0);
  counterAdd(data, 0x10, iv, (index * BigInt(GKCRYPT_GMAC_KEY_REFRESH_IV_OFFSET)) & U64);
  const md = createHash('sha256').update(data).digest();
  const out = Buffer.alloc(GKCRYPT_BLOCK_SIZE);
  for (let i = 0; i < GKCRYPT_BLOCK_SIZE; i++) out[i] = md[i]! ^ md[i + 0x10]!;
  return out;
}

/** The fields of ChiakiGKCrypt that matter. Used by tests that, like the reference's, fill the state in directly. */
export interface GKCryptState {
  index: number;
  iv: Uint8Array;
  keyBase: Uint8Array;
  keyGmacBase: Uint8Array;
  keyGmacCurrent: Uint8Array;
  keyGmacIndexCurrent: bigint;
}

/** ChiakiGKCrypt: the cipher state of one direction of a stream. Secrets: keep in memory only, never log. */
export class GKCrypt {
  readonly index: number;
  readonly iv: Buffer;
  /** The key of the key stream. */
  readonly keyBase: Buffer;
  /** GMAC key number 0; the later ones are derived from it. */
  readonly keyGmacBase: Buffer;
  /** The GMAC key in use; replaced when a packet with a later key position comes by. */
  readonly keyGmacCurrent: Buffer;
  keyGmacIndexCurrent: bigint;
  private ecb: ReturnType<typeof createCipheriv> | null;

  /**
   * chiaki_gkcrypt_init() / chiaki_gkcrypt_new().
   * @param index 2 for what this client sends, 3 for what the console sends (the reference's stream connection).
   * @param handshakeKey 16 bytes.
   * @param ecdhSecret 32 bytes.
   */
  constructor(index: number, handshakeKey: Uint8Array, ecdhSecret: Uint8Array) {
    if (!Number.isInteger(index) || index < 0 || index > 0xff) throw new RangeError('index must be 0..255');
    if (handshakeKey.length !== HANDSHAKE_KEY_SIZE) throw new RangeError(`the handshake key must be ${HANDSHAKE_KEY_SIZE} bytes`);
    if (ecdhSecret.length !== ECDH_SECRET_SIZE) throw new RangeError(`the ECDH secret must be ${ECDH_SECRET_SIZE} bytes`);
    this.index = index;

    // gkcrypt_gen_key_iv(): HMAC-SHA256 keyed with the ECDH secret over 01 <index> 00 <handshake key> 01 00.
    const data = Buffer.alloc(3 + HANDSHAKE_KEY_SIZE + 2);
    data[0] = 1;
    data[1] = index;
    data[2] = 0;
    data.set(handshakeKey, 3);
    data[3 + HANDSHAKE_KEY_SIZE + 0] = 1;
    data[3 + HANDSHAKE_KEY_SIZE + 1] = 0;
    const hmac = createHmac('sha256', ecdhSecret).update(data).digest();
    this.keyBase = Buffer.from(hmac.subarray(0, GKCRYPT_BLOCK_SIZE));
    this.iv = Buffer.from(hmac.subarray(GKCRYPT_BLOCK_SIZE, GKCRYPT_BLOCK_SIZE * 2));

    this.keyGmacBase = genGmacKey(0n, this.keyBase, this.iv);
    this.keyGmacIndexCurrent = 0n;
    this.keyGmacCurrent = Buffer.from(this.keyGmacBase);
    this.ecb = null;
  }

  /**
   * A state with the given fields and zeroes for the rest, the way the reference's tests memset the struct and then
   * set key_gmac_current and iv. Not for normal use.
   */
  static fromState(state: Partial<GKCryptState>): GKCrypt {
    const g = new GKCrypt(state.index ?? 0, Buffer.alloc(HANDSHAKE_KEY_SIZE), Buffer.alloc(ECDH_SECRET_SIZE));
    const put = (dst: Buffer, src: Uint8Array | undefined): void => {
      dst.fill(0);
      if (src === undefined) return;
      if (src.length !== GKCRYPT_BLOCK_SIZE) throw new RangeError('keys and the IV must be 16 bytes each');
      dst.set(src);
    };
    put(g.iv, state.iv);
    put(g.keyBase, state.keyBase);
    put(g.keyGmacBase, state.keyGmacBase);
    put(g.keyGmacCurrent, state.keyGmacCurrent);
    g.keyGmacIndexCurrent = state.keyGmacIndexCurrent ?? 0n;
    return g;
  }

  /** chiaki_gkcrypt_gen_new_gmac_key(): make GMAC key number `index` the current one. */
  genNewGmacKey(index: bigint): void {
    if (index <= 0n) throw new RangeError('index must be greater than 0');
    this.keyGmacCurrent.set(genGmacKey(index, this.keyGmacBase, this.iv));
    this.keyGmacIndexCurrent = index;
  }

  /** chiaki_gkcrypt_gen_tmp_gmac_key(): GMAC key number `index`, without changing the current one. */
  genTmpGmacKey(index: bigint): Buffer {
    if (index) return genGmacKey(index, this.keyGmacBase, this.iv);
    return Buffer.from(this.keyGmacBase);
  }

  /**
   * chiaki_gkcrypt_gen_key_stream(): `size` bytes of key stream starting at `keyPos`. Both must be multiples of 16.
   */
  genKeyStream(keyPos: bigint, size: number): Buffer {
    if (keyPos < 0n || keyPos % BLOCK !== 0n) throw new RangeError('keyPos must be a multiple of 16');
    if (!Number.isInteger(size) || size < 0 || size % GKCRYPT_BLOCK_SIZE !== 0) throw new RangeError('size must be a multiple of 16');
    if (size === 0) return Buffer.alloc(0);

    // One counter block per 16 bytes: IV + (keyPos / 16), IV + (keyPos / 16) + 1, ... as little endian numbers.
    const buf = Buffer.allocUnsafe(size);
    counterAdd(buf, 0, this.iv, (keyPos / BLOCK) & U64);
    for (let off = GKCRYPT_BLOCK_SIZE; off < size; off += GKCRYPT_BLOCK_SIZE) {
      buf.copyWithin(off, off - GKCRYPT_BLOCK_SIZE, off);
      for (let i = 0; i < GKCRYPT_BLOCK_SIZE; i++) {
        const v = (buf[off + i]! + 1) & 0xff;
        buf[off + i] = v;
        if (v !== 0) break;
      }
    }

    // ECB has no state between blocks, so one cipher object serves every call (final() is never called).
    if (!this.ecb) {
      this.ecb = createCipheriv('aes-128-ecb', this.keyBase, null);
      this.ecb.setAutoPadding(false);
    }
    const out = this.ecb.update(buf);
    if (out.length !== size) throw new Error('the cipher returned an unexpected amount of key stream');
    return out;
  }

  /** chiaki_gkcrypt_get_key_stream(). Without the key buffer this is the same as genKeyStream(). */
  getKeyStream(keyPos: bigint, size: number): Buffer {
    return this.genKeyStream(keyPos, size);
  }

  /**
   * chiaki_gkcrypt_decrypt(): XOR `buf` in place with the key stream at `keyPos` (any position, any length).
   * For AV packets the reference passes the packet's key position plus 16.
   */
  decrypt(keyPos: bigint, buf: Uint8Array): void {
    if (keyPos < 0n) throw new RangeError('keyPos must not be negative');
    const paddingPre = Number(keyPos % BLOCK);
    const fullSize = Math.floor((paddingPre + buf.length + GKCRYPT_BLOCK_SIZE - 1) / GKCRYPT_BLOCK_SIZE) * GKCRYPT_BLOCK_SIZE;
    const keyStream = this.getKeyStream(keyPos - BigInt(paddingPre), fullSize);
    for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! ^ keyStream[paddingPre + i]!;
  }

  /** chiaki_gkcrypt_encrypt(): the same operation as decrypt(). */
  encrypt(keyPos: bigint, buf: Uint8Array): void {
    this.decrypt(keyPos, buf);
  }

  /**
   * chiaki_gkcrypt_gmac(): the 4 byte authentication tag of `buf` at `keyPos`.
   * A key position beyond the current GMAC key's range moves this state on to the newer key (as the reference does);
   * an older one uses a temporary key.
   */
  gmac(keyPos: bigint, buf: Uint8Array): Buffer {
    if (keyPos < 0n) throw new RangeError('keyPos must not be negative');
    const iv = Buffer.alloc(GKCRYPT_BLOCK_SIZE);
    counterAdd(iv, 0, this.iv, (keyPos / BLOCK) & U64);

    let gmacKey: Uint8Array = this.keyGmacCurrent;
    const keyIndex = (keyPos > 0n ? keyPos - 1n : 0n) / BigInt(GKCRYPT_GMAC_KEY_REFRESH_KEY_POS);
    if (keyIndex > this.keyGmacIndexCurrent) this.genNewGmacKey(keyIndex); // updates keyGmacCurrent in place
    else if (keyIndex < this.keyGmacIndexCurrent) gmacKey = this.genTmpGmacKey(keyIndex);

    const gcm = createCipheriv('aes-128-gcm', gmacKey, iv);
    gcm.setAAD(buf);
    gcm.final();
    return Buffer.from(gcm.getAuthTag().subarray(0, GKCRYPT_GMAC_SIZE));
  }
}

/**
 * ChiakiKeyState: packets carry only the low 32 bits of the key position; this keeps the last full position to work out
 * the high 32 bits of the next one.
 */
export class KeyState {
  prev: bigint;

  /** chiaki_key_state_init() */
  constructor() {
    this.prev = 0n;
  }

  /**
   * chiaki_key_state_request_pos(): the full key position for the low 32 bits found in a packet.
   * @param commit remember this position. Only do that for an authenticated packet, or use commit() afterwards.
   */
  requestPos(low: number, commit: boolean): bigint {
    low >>>= 0;
    const prevLow = Number(this.prev & 0xffffffffn);
    let high = Number((this.prev >> 32n) & 0xffffffffn);
    if (seqNum32Gt(low, prevLow) && low < prevLow) high = (high + 1) >>> 0;
    else if (seqNum32Lt(low, prevLow) && low > prevLow && high) high--;
    const res = (BigInt(high) << 32n) | BigInt(low);
    if (commit) this.prev = res;
    return res;
  }

  /** chiaki_key_state_commit(): remember a position that turned out to be authentic. */
  commit(prev: bigint): void {
    this.prev = prev;
  }
}

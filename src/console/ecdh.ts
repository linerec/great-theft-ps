// SPDX-License-Identifier: AGPL-3.0-only
//
// The key exchange of the stream connection: both sides send a public key on the curve secp256k1 together with a
// signature of it, and derive a shared secret from which the stream ciphers are keyed.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/ecdh.c and lib/include/chiaki/ecdh.h
// (commit 43728af), the OpenSSL branch. The buffer sizes are those of lib/src/streamconnection.c and
// CHIAKI_HANDSHAKE_KEY_SIZE of lib/include/chiaki/session.h. See NOTICE.md.
//
// - The public key travels as an uncompressed point: 0x04, X, Y, 65 bytes.
// - Its signature is HMAC-SHA256 over those 65 bytes, keyed with the 16 byte handshake key (the random key the client
//   also puts into the launch spec).
// - The secret is the X coordinate of the shared point, 32 bytes.
//
// One deliberate difference: the reference takes the console's signature in chiaki_ecdh_derive_secret() and never looks
// at it. Here it is checked first, assuming the console signs the same way the client does. That assumption holds for
// the one exchange the reference publishes as a test vector (test/gkcrypt.c: the remote signature there is exactly
// HMAC-SHA256(handshake key, remote public key)); it is not known to hold for every console. `verifySignature: false`
// gives the reference's behaviour. Also stricter than the reference: an injected public key must belong to the
// injected private key.
//
// STATUS: checked against the reference's own vector for this exchange (test/gkcrypt.c test_ecdh, ported in
// test/ecdh.test.ts): public key, signature and secret match byte for byte. It has NOT been run against a real console.
// Secrets: the private key, the handshake key and the derived secret are never logged here, and no error carries them.

import { createECDH, createHmac, timingSafeEqual, type ECDH } from 'node:crypto';

/** NID_secp256k1. */
export const ECDH_CURVE = 'secp256k1';
/** CHIAKI_ECDH_SECRET_SIZE. */
export const ECDH_SECRET_SIZE = 32;
/** CHIAKI_HANDSHAKE_KEY_SIZE. */
export const HANDSHAKE_KEY_SIZE = 0x10;
/** An uncompressed secp256k1 point. */
export const ECDH_PUBLIC_KEY_SIZE = 65;
/** The buffer the reference reserves for the public key before putting it into the message (`ecdh_pub_key[128]`). */
export const ECDH_PUBLIC_KEY_BUF_SIZE = 128;
/** HMAC-SHA256, and the size of the reference's `ecdh_sig[32]`. */
export const ECDH_SIG_SIZE = 32;

export type EcdhErrorCode = 'invalid-input' | 'invalid-key' | 'bad-signature';

export class EcdhError extends Error {
  code: EcdhErrorCode;
  constructor(code: EcdhErrorCode, message: string) {
    super(message);
    this.name = 'EcdhError';
    this.code = code;
  }
}

export interface EcdhOptions {
  /**
   * The private key as a big endian number (chiaki_ecdh_set_local_key). For tests; leave it out to generate a key pair,
   * which is what chiaki_ecdh_init() does.
   */
  privateKey?: Uint8Array;
  /** Only together with `privateKey`: the public key that is expected to belong to it. A mismatch is refused. */
  publicKey?: Uint8Array;
}

export interface EcdhLocalPubKey {
  /** ECDH_PUBLIC_KEY_SIZE bytes. */
  publicKey: Buffer;
  /** ECDH_SIG_SIZE bytes. */
  signature: Buffer;
}

export interface EcdhDeriveOptions {
  /** Default true. False skips the check of the remote signature, as the reference does. */
  verifySignature?: boolean;
}

const sign = (handshakeKey: Uint8Array, publicKey: Uint8Array): Buffer => createHmac('sha256', handshakeKey).update(publicKey).digest();

function needHandshakeKey(handshakeKey: Uint8Array): void {
  if (!(handshakeKey instanceof Uint8Array) || handshakeKey.length !== HANDSHAKE_KEY_SIZE) {
    throw new EcdhError('invalid-input', `the handshake key must be ${HANDSHAKE_KEY_SIZE} bytes`);
  }
}

/** ChiakiECDH: the local key pair. */
export class Ecdh {
  #ecdh: ECDH;

  /** chiaki_ecdh_init(), and chiaki_ecdh_set_local_key() when a private key is given. */
  constructor(options: EcdhOptions = {}) {
    this.#ecdh = createECDH(ECDH_CURVE);
    if (options.privateKey === undefined) {
      if (options.publicKey !== undefined) throw new EcdhError('invalid-input', 'a public key can only be given together with its private key');
      this.#ecdh.generateKeys();
      return;
    }
    try {
      this.#ecdh.setPrivateKey(options.privateKey); // also works out the public key
    } catch {
      throw new EcdhError('invalid-key', `the private key is not valid for ${ECDH_CURVE}`);
    }
    if (options.publicKey !== undefined) {
      const derived = this.#ecdh.getPublicKey();
      if (options.publicKey.length !== derived.length || !timingSafeEqual(derived, options.publicKey)) {
        throw new EcdhError('invalid-key', 'the public key does not belong to the private key');
      }
    }
  }

  /**
   * chiaki_ecdh_get_local_pub_key(): the local public key and its signature, to be sent to the console.
   * @param handshakeKey HANDSHAKE_KEY_SIZE bytes
   */
  getLocalPubKey(handshakeKey: Uint8Array): EcdhLocalPubKey {
    needHandshakeKey(handshakeKey);
    const publicKey = this.#ecdh.getPublicKey(); // uncompressed
    return { publicKey, signature: sign(handshakeKey, publicKey) };
  }

  /**
   * chiaki_ecdh_derive_secret(): the shared secret from the console's public key, after checking its signature.
   * @returns ECDH_SECRET_SIZE bytes. Treat it as a secret.
   * @throws EcdhError 'bad-signature' when the signature does not fit the key and the handshake key, 'invalid-key'
   * when the public key is not a point on the curve.
   */
  deriveSecret(remoteKey: Uint8Array, handshakeKey: Uint8Array, remoteSig: Uint8Array, options: EcdhDeriveOptions = {}): Buffer {
    needHandshakeKey(handshakeKey);
    if (!(remoteKey instanceof Uint8Array) || remoteKey.length === 0) throw new EcdhError('invalid-input', 'the remote public key is missing');
    if (options.verifySignature !== false) {
      const expected = sign(handshakeKey, remoteKey);
      if (!(remoteSig instanceof Uint8Array) || remoteSig.length !== expected.length || !timingSafeEqual(expected, remoteSig)) {
        throw new EcdhError('bad-signature', 'the signature of the remote public key does not match');
      }
    }
    let secret: Buffer;
    try {
      secret = this.#ecdh.computeSecret(remoteKey);
    } catch {
      throw new EcdhError('invalid-key', `the remote public key is not a valid point on ${ECDH_CURVE}`);
    }
    if (secret.length !== ECDH_SECRET_SIZE) throw new EcdhError('invalid-key', 'the derived secret has an unexpected size');
    return secret;
  }
}

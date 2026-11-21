// SPDX-License-Identifier: AGPL-3.0-only
//
// The key exchange. The first group is chiaki-ng's own vector for it (test/gkcrypt.c, test_ecdh, commit 43728af): a
// published test fixture of the reference, not key material of any console of this project. It pins the curve, the
// public key encoding, the signature and the secret to the reference. Everything else uses obviously made up keys and
// can only show that the pieces agree with each other.
//
// STATUS: checked against the reference's vector and against node:crypto. Never run against a real console.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  Ecdh, ECDH_CURVE, ECDH_PUBLIC_KEY_BUF_SIZE, ECDH_PUBLIC_KEY_SIZE, ECDH_SECRET_SIZE, ECDH_SIG_SIZE, EcdhError, HANDSHAKE_KEY_SIZE,
} from '../src/console/ecdh.ts';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');

const isEcdhError = (code: string) => (err: unknown): boolean => err instanceof EcdhError && err.code === code;

describe('ecdh: chiaki-ng test vector (test/gkcrypt.c, test_ecdh)', () => {
  const handshakeKey = hex('fc 5d 4b a0 3a 35 3a bb 6a 7f ac 79 1b 17 bb 34');
  const localPrivateKey = hex('16 e7 5d cb da 98 55 fb 6b ef dd 8a a5 f1 6e 7f 46 fd e1 d2 27 97 03 60 18 72 d8 4b 15 38 d9 00');
  const localPublicKey = hex(`
    04 f4 0a f1 35 a4 88 94 36 ce e5 2b 5c 73 a3 3e c5 ad 0b e0 95 2f 57 f4 f0 ed 0c 80 b0 be da 7c a6
    43 78 93 93 a5 94 7e 9f aa 3f 67 95 c9 aa 09 a9 63 25 df e8 50 bf c3 f1 db 62 a5 0a bf b0 ff f7`);
  const localPublicKeySig = hex('99 b5 cb b5 37 18 0b fc 55 da 43 7f 44 76 a8 17 c9 37 fe 56 1b 8a be 0c 41 12 ab 71 f5 a6 8d 29');
  const remotePublicKey = hex(`
    04 df ef 08 bb a8 56 f2 b4 4b 8a 0e 4f 44 20 3f 8e 49 3f ee d4 3c e9 3a fe 5c 64 67 77 20 15 7c 59
    10 15 67 94 ae 5f 02 4a ad 0c ce fa 14 15 0a ab ee 08 0b 14 12 76 ea 3e c0 d5 65 f4 68 77 a3 ca`);
  const remotePublicKeySig = hex('13 c5 89 e2 3b 72 85 24 a9 9f 96 80 03 a1 81 30 59 68 f1 bb b6 4d c4 a7 6c ce f6 79 4c eb 2d 98');
  const secret = hex('b8 1c 61 46 e7 49 73 8c 96 30 ca 13 ff 71 e5 9b 3b f9 41 98 d4 67 a5 a2 bc 78 04 92 81 43 ec 1d');

  it('exports the public key and its signature', () => {
    const ecdh = new Ecdh({ privateKey: localPrivateKey, publicKey: localPublicKey });
    const { publicKey, signature } = ecdh.getLocalPubKey(handshakeKey);
    assert.equal(publicKey.length, localPublicKey.length);
    assert.deepEqual(publicKey, localPublicKey);
    assert.equal(signature.length, localPublicKeySig.length);
    assert.deepEqual(signature, localPublicKeySig);
  });

  it('works out the public key from the private key alone', () => {
    assert.deepEqual(new Ecdh({ privateKey: localPrivateKey }).getLocalPubKey(handshakeKey).publicKey, localPublicKey);
  });

  it('derives the secret', () => {
    const ecdh = new Ecdh({ privateKey: localPrivateKey, publicKey: localPublicKey });
    const result = ecdh.deriveSecret(remotePublicKey, handshakeKey, remotePublicKeySig);
    assert.equal(ECDH_SECRET_SIZE, secret.length);
    assert.deepEqual(result, secret);
  });

  it("the vector's remote signature is HMAC-SHA256(handshake key, remote public key), which is what the check assumes", () => {
    assert.deepEqual(createHmac('sha256', handshakeKey).update(remotePublicKey).digest(), remotePublicKeySig);
  });

  it('derives the same secret without the check, as the reference does (it ignores the signature)', () => {
    const ecdh = new Ecdh({ privateKey: localPrivateKey });
    assert.deepEqual(ecdh.deriveSecret(remotePublicKey, handshakeKey, new Uint8Array(0), { verifySignature: false }), secret);
  });
});

describe('ecdh: two parties (made up keys)', () => {
  const handshakeKey = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const otherHandshakeKey = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
  const fakePrivateA = Buffer.alloc(32, 0x11);
  const fakePrivateB = Buffer.alloc(32, 0x22);

  it('derive the same secret from generated key pairs', () => {
    const client = new Ecdh();
    const consoleSide = new Ecdh();
    const fromClient = client.getLocalPubKey(handshakeKey);
    const fromConsole = consoleSide.getLocalPubKey(handshakeKey);
    const a = client.deriveSecret(fromConsole.publicKey, handshakeKey, fromConsole.signature);
    const b = consoleSide.deriveSecret(fromClient.publicKey, handshakeKey, fromClient.signature);
    assert.deepEqual(a, b);
    assert.equal(a.length, ECDH_SECRET_SIZE);
    assert.notDeepEqual(fromClient.publicKey, fromConsole.publicKey);
  });

  it('derive the same secret from injected private keys, the same one every time', () => {
    const run = (): Buffer => {
      const a = new Ecdh({ privateKey: fakePrivateA });
      const b = new Ecdh({ privateKey: fakePrivateB });
      const pa = a.getLocalPubKey(handshakeKey);
      const pb = b.getLocalPubKey(handshakeKey);
      const sa = a.deriveSecret(pb.publicKey, handshakeKey, pb.signature);
      const sb = b.deriveSecret(pa.publicKey, handshakeKey, pa.signature);
      assert.deepEqual(sa, sb);
      return Buffer.concat([pa.publicKey, pa.signature, pb.publicKey, pb.signature, sa]);
    };
    assert.deepEqual(run(), run());
  });

  it('generates a different key pair each time when none is injected', () => {
    assert.notDeepEqual(new Ecdh().getLocalPubKey(handshakeKey).publicKey, new Ecdh().getLocalPubKey(handshakeKey).publicKey);
  });

  it('the exported sizes are those of the reference', () => {
    const ecdh = new Ecdh({ privateKey: fakePrivateA });
    const { publicKey, signature } = ecdh.getLocalPubKey(handshakeKey);
    assert.equal(ECDH_CURVE, 'secp256k1');
    assert.equal(HANDSHAKE_KEY_SIZE, 16); // CHIAKI_HANDSHAKE_KEY_SIZE
    assert.equal(ECDH_SECRET_SIZE, 32); // CHIAKI_ECDH_SECRET_SIZE
    assert.equal(publicKey.length, ECDH_PUBLIC_KEY_SIZE);
    assert.equal(publicKey.length, 65);
    assert.equal(publicKey[0], 0x04, 'uncompressed point');
    assert.ok(publicKey.length <= ECDH_PUBLIC_KEY_BUF_SIZE, 'fits the reference buffer ecdh_pub_key[128]');
    assert.equal(ECDH_PUBLIC_KEY_BUF_SIZE, 128);
    assert.equal(signature.length, ECDH_SIG_SIZE);
    assert.equal(signature.length, 32, 'exactly the reference buffer ecdh_sig[32]');
    const other = new Ecdh({ privateKey: fakePrivateB }).getLocalPubKey(handshakeKey);
    assert.equal(ecdh.deriveSecret(other.publicKey, handshakeKey, other.signature).length, ECDH_SECRET_SIZE);
  });

  it('the signature is HMAC-SHA256 of the public key under the handshake key', () => {
    const { publicKey, signature } = new Ecdh({ privateKey: fakePrivateA }).getLocalPubKey(handshakeKey);
    assert.deepEqual(signature, createHmac('sha256', handshakeKey).update(publicKey).digest());
    assert.notDeepEqual(new Ecdh({ privateKey: fakePrivateA }).getLocalPubKey(otherHandshakeKey).signature, signature);
  });

  it('refuses a wrong signature', () => {
    const client = new Ecdh({ privateKey: fakePrivateA });
    const remote = new Ecdh({ privateKey: fakePrivateB }).getLocalPubKey(handshakeKey);

    for (let bit = 0; bit < 8; bit++) {
      const flipped = Buffer.from(remote.signature);
      flipped[bit * 4]! ^= 1 << bit;
      assert.throws(() => client.deriveSecret(remote.publicKey, handshakeKey, flipped), isEcdhError('bad-signature'));
    }
    assert.throws(() => client.deriveSecret(remote.publicKey, handshakeKey, remote.signature.subarray(0, 31)), isEcdhError('bad-signature'));
    assert.throws(() => client.deriveSecret(remote.publicKey, handshakeKey, Buffer.concat([remote.signature, Buffer.alloc(1)])), isEcdhError('bad-signature'));
    assert.throws(() => client.deriveSecret(remote.publicKey, handshakeKey, new Uint8Array(0)), isEcdhError('bad-signature'));
    assert.throws(() => client.deriveSecret(remote.publicKey, handshakeKey, Buffer.alloc(32)), isEcdhError('bad-signature'));
    // a signature that belongs to another key
    const third = new Ecdh().getLocalPubKey(handshakeKey);
    assert.throws(() => client.deriveSecret(remote.publicKey, handshakeKey, third.signature), isEcdhError('bad-signature'));
    // the right one still works afterwards
    assert.equal(client.deriveSecret(remote.publicKey, handshakeKey, remote.signature).length, ECDH_SECRET_SIZE);
  });

  it('refuses a public key that was changed after signing', () => {
    const client = new Ecdh({ privateKey: fakePrivateA });
    const remote = new Ecdh({ privateKey: fakePrivateB }).getLocalPubKey(handshakeKey);
    const swapped = new Ecdh().getLocalPubKey(handshakeKey).publicKey; // a valid point, but not the signed one
    assert.throws(() => client.deriveSecret(swapped, handshakeKey, remote.signature), isEcdhError('bad-signature'));
  });

  it('refuses a wrong handshake key', () => {
    const client = new Ecdh({ privateKey: fakePrivateA });
    const remote = new Ecdh({ privateKey: fakePrivateB }).getLocalPubKey(handshakeKey);
    assert.throws(() => client.deriveSecret(remote.publicKey, otherHandshakeKey, remote.signature), isEcdhError('bad-signature'));
    const oneBitOff = Buffer.from(handshakeKey);
    oneBitOff[15]! ^= 0x01;
    assert.throws(() => client.deriveSecret(remote.publicKey, oneBitOff, remote.signature), isEcdhError('bad-signature'));
  });

  it('refuses a handshake key of the wrong size', () => {
    const client = new Ecdh({ privateKey: fakePrivateA });
    const remote = new Ecdh({ privateKey: fakePrivateB }).getLocalPubKey(handshakeKey);
    for (const size of [0, 15, 17, 32]) {
      assert.throws(() => client.getLocalPubKey(Buffer.alloc(size, 1)), isEcdhError('invalid-input'), `size ${size}`);
      assert.throws(() => client.deriveSecret(remote.publicKey, Buffer.alloc(size, 1), remote.signature), isEcdhError('invalid-input'), `size ${size}`);
    }
  });

  it('refuses a remote public key that is not a point on the curve, even with a fitting signature', () => {
    const client = new Ecdh({ privateKey: fakePrivateA });
    const sign = (key: Uint8Array): Buffer => createHmac('sha256', handshakeKey).update(key).digest();
    const notOnCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x01)]);
    assert.throws(() => client.deriveSecret(notOnCurve, handshakeKey, sign(notOnCurve)), isEcdhError('invalid-key'));
    const tooShort = Buffer.from([0x04, 0x01, 0x02]);
    assert.throws(() => client.deriveSecret(tooShort, handshakeKey, sign(tooShort)), isEcdhError('invalid-key'));
    assert.throws(() => client.deriveSecret(new Uint8Array(0), handshakeKey, sign(new Uint8Array(0))), isEcdhError('invalid-input'));
    assert.throws(() => client.deriveSecret(notOnCurve, handshakeKey, new Uint8Array(0), { verifySignature: false }), isEcdhError('invalid-key'));
  });

  it('refuses an unusable injected key pair', () => {
    assert.throws(() => new Ecdh({ privateKey: Buffer.alloc(32) }), isEcdhError('invalid-key'), 'zero is not a private key');
    assert.throws(() => new Ecdh({ privateKey: Buffer.alloc(32, 0xff) }), isEcdhError('invalid-key'), 'above the group order');
    const publicOfB = new Ecdh({ privateKey: fakePrivateB }).getLocalPubKey(handshakeKey).publicKey;
    assert.throws(() => new Ecdh({ privateKey: fakePrivateA, publicKey: publicOfB }), isEcdhError('invalid-key'));
    assert.throws(() => new Ecdh({ publicKey: publicOfB }), isEcdhError('invalid-input'));
  });

  it('never puts key material into an error', () => {
    const client = new Ecdh({ privateKey: fakePrivateA });
    const remote = new Ecdh({ privateKey: fakePrivateB }).getLocalPubKey(handshakeKey);
    const secrets = [fakePrivateA, handshakeKey, otherHandshakeKey, client.deriveSecret(remote.publicKey, handshakeKey, remote.signature)]
      .flatMap((b) => [b.toString('hex'), b.toString('base64')]);
    const errors: unknown[] = [];
    const collect = (fn: () => unknown): void => {
      try {
        fn();
      } catch (err) {
        errors.push(err);
      }
    };
    collect(() => client.deriveSecret(remote.publicKey, otherHandshakeKey, remote.signature));
    collect(() => client.deriveSecret(remote.publicKey, handshakeKey, Buffer.alloc(32)));
    collect(() => client.deriveSecret(Buffer.alloc(65, 4), handshakeKey, Buffer.alloc(32), { verifySignature: false }));
    collect(() => new Ecdh({ privateKey: Buffer.alloc(32) }));
    assert.equal(errors.length, 4);
    for (const err of errors) {
      const text = `${String(err)} ${JSON.stringify(err)} ${(err as Error).stack ?? ''}`;
      for (const s of secrets) assert.ok(!text.includes(s));
    }
  });
});

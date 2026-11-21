// SPDX-License-Identifier: AGPL-3.0-only
//
// GKCrypt (key stream, GMAC, GMAC key regeneration) and the key state. Every vector here is copied from chiaki-ng's own
// tests (test/gkcrypt.c and test/keystate.c, commit 43728af): the byte arrays were extracted from the C source by a
// script, not retyped. The names in VECTORS are the reference's.
//
// The reference's /ecdh test exercises lib/src/ecdh.c, which is not ported yet. Its vector is checked here with
// node:crypto directly: it pins the curve (secp256k1), the uncompressed public key form and that the signature is
// HMAC-SHA256 keyed with the handshake key, which is what an ecdh.ts will have to do.
//
// STATUS: all of the reference's vectors pass. The last group is self-consistency only. Nothing here involves a console.

import assert from 'node:assert/strict';
import { createECDH, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { genGmacKey, GKCrypt, GKCRYPT_GMAC_KEY_REFRESH_KEY_POS, KeyState } from '../src/console/gkcrypt.ts';

const hex = (s: string): Buffer => Buffer.from(s, 'hex');

const VECTORS = {
  test_ecdh: {
    handshake_key: 'fc5d4ba03a353abb6a7fac791b17bb34',
    local_private_key: '16e75dcbda9855fb6befdd8aa5f16e7f46fde1d2279703601872d84b1538d900',
    local_public_key:
      '04f40af135a4889436cee52b5c73a33ec5ad0be0952f57f4f0ed0c80b0beda7ca643789393a5947e9faa3f6795c9aa09a96325df' +
      'e850bfc3f1db62a50abfb0fff7',
    local_public_key_sig: '99b5cbb537180bfc55da437f4476a817c937fe561b8abe0c4112ab71f5a68d29',
    remote_public_key:
      '04dfef08bba856f2b44b8a0e4f44203f8e493feed43ce93afe5c64677720157c5910156794ae5f024aad0ccefa14150aabee080b' +
      '141276ea3ec0d565f46877a3ca',
    remote_public_key_sig: '13c589e23b728524a99f968003a181305968f1bbb64dc4a76ccef6794ceb2d98',
    secret: 'b81c6146e749738c9630ca13ff71e59b3bf94198d467a5a2bc7804928143ec1d',
  },
  test_key_stream: {
    handshake_key: '83cf931a6aa769a6c4485d19c15ccc52',
    ecdh_secret: '73c8d549c4d9db502ec044ea33648c6ac9f36c41b6a0504fe093defb619b0973',
    gkcrypt_key: '08816fa2e5558961d5a286d90eec5b8c',
    gkcrypt_iv: '2ae1bb3d84dc9aa9c352a4cf3ffb8b72',
    key_stream: '0f6d89855ba786745ba1fe5c81196cd554c41ccaf6e934a4892698b06212b31a',
    key_stream_high: '14319ff8be0817a4fc28490b1e5f7b7efae914dec6dfe75dd69c753f9462d52c',
  },
  test_endecrypt: {
    handshake_key: '14f1e6946c5dcea8b7aa4850f64d21ac',
    ecdh_secret: '0ceb7709834d7afc50b8468cc63c1e7c4e4a88934280c128e61ee9d41b8c6936',
    gkcrypt_key: '277aa51dacd15f0e5412face0dc4636a',
    gkcrypt_iv: 'ef2040c2153c0266321f42bbf450344d',
    clear_data: '4e619f945d4b8ebd2a154d036acd49569cc75ce3e700179a38d9695345f90cb58c05650f70',
    enc_data: '23f48dd8aaf9589bb1944fad2b8daa8d2588faf8b6d417f45f78ecf54e3720b0768107679a',
    enc_data_high: '2b9ee983274408b117f537a0d9c2c6059578b278fd178c52f4179dee3f62e63001614cf4a1',
  },
  test_gmac: {
    gkcrypt_key: 'b64b1e653fbba7ab80b31e5a324decc0',
    gkcrypt_iv: '7cc8d0199edfd8c3b50f32ee36336a5a',
    buf:
      '0300180019000250210500000000000069a000f9f89824da560b74ec6815d31f8543aad3cdb8502e90a4b085f3be9a4797c1ab5f' +
      'a5fd625c261a54367230c32be02c5a8607f5dc1255b48e175be47f965586f0fb45e2f8e87d5f3a8bb0646c54f68c4ea412a3267f' +
      '225b1998bad4ad9f5f63af1f978c1749a33071d2b0492c75a289da50fd9b0841982d8c0b9279ae602383ef5cdace71082d0b1762' +
      '5648c5e20f221ddcccc282a68eec1e040c08aaa2806c4fd36fc19b769a58aa2556eff2fd77f0324e83e23025a55af1dfc875a2b6' +
      '2bfdacbc6309a1cc2bf546ef49838f0bc147ac5a002eec1cd00a66b5ee9eadc9642dcb980f43a6e14ce79f2dab9401d7528419',
    gmac_expected: '6f811097',
    gmac_expected_high: '4a309810',
  },
  test_gen_gmac_key: {
    key_initial: 'beeba0f03d05707d3ac73cd732b94801',
    iv: 'e87187e763e0df463dc2024a2cd29c45',
    key_result: 'e3db92d9ddd36899aefd9b15e1a6878b',
  },
  test_gmac_split: {
    gkcrypt_key: '35958187ebcb63549000d7d5bdf4c5f4',
    gkcrypt_iv: 'b8defca448f04c3fd5940e1c046463b1',
    buf:
      '02001e00090020080103000000000000adf0024e002c6f3b6c2e4a279c503484ea37c776ab92304361c71dcbc43594cc44e2fa89' +
      '86475ec201394c9f67b36e354497f428e25112daf52c431c49462c53e3e97661872b7ae32fbb9f4d668a31bc649d060d4add4221' +
      '733c9721845365537af4577761ae0c7a4290fc6bbb386e52b6e5260fd22af15650dd65149ee3b570675547cd8ec1baf672b1b411' +
      '1b25d43d19b5f5dd2fefd6d1afb4dc93e53cc3a464b3add3fc238486f7f910df156e0c6e439a633bb53805f94a684afb95949d31' +
      'fd843143850d8ebb66ca4d3b0a75e5ebded5f88285b2ccdb709ea9e2b0ac760128ea1039b7477882c9a42416c3e51602469207db' +
      '3ab0d0ddc015dc05c761e57d82d04c1744b4fa28d894c1f4d0b3506a2581987b4967a219b241e5d2df9a4fc960ffb291e85f7767' +
      'ffc0a17657eb6134578075db03c553f5b3a861df0fb6e6c439a0cde9a632b8ba469c431649659d7187f337e5e0c6df5e4cc5209b' +
      '16ed132d63792bd0514400448c7c2cc68220caca1f7fea71b7845b8c945b92b6efbe5f083d05b2fbcb5a01d416718d9ef58dae80' +
      '4090feef5da474f3e34a9a678ba6b55918614f425f2b7439a8305d8df1ad254f41ca27da07754946d781aa2761569c294090220a' +
      'cd3a7bb48596078013123f2527a0f626bdd1b095bd26ba49a6810731d3e125daab71b9651d13ab825295b362a64848b8d8552698' +
      'a1c957661cacb1c75ffa44c6d819018d411fc70f891def349a68778c',
    gmac_expected: 'd66a07b7',
    gmac_expected_high: 'f017953c',
  },
  test_gmac_multiple_of_key_refresh: {
    handshake_key: '7058375091ead1377158ecb30bea2387',
    ecdh_secret: '3c3af0ecd6331bb16d244f4819de063dc70eac9570ac249286a724d07a375552',
    data:
      '0311a411a5000250210500000000006b1de00083f1c47971e4677cccb792078bba8a08d662f5075d4a2014b3e70e5c77fd6d60a3' +
      'c548a9c061f984f63762acbc1f5de44090547137ab337eaaa5f4c40903f4b6a12f022753c6a5b19c8fb469d65c7f795f1447cca8' +
      '8b37f7776d01f45b59ca96730a20f37ad1d27ffeb666f4db10aff307ee498aa1a573d823830e0c0c3a49dcd80cc8e4b6f23c6d25' +
      '6a7da01c3a8e0f3f2547118967c4f9acc7e29374c6fbdd4857ae53e2f4178062f309d8d47a466b08769c2981914e57af70b63278' +
      '989e85f2e36915afd432540fd4a2fcf536dc0645f406a3382102fdf05175eab1f68e3935fd7574adbc3efbee7d0f2d76befdee',
    gmac_expected: '20cca5f1',
  },
} as const;

const KEY_POS_HIGH = (1n << 32n) + 0x420n;

describe('gkcrypt: chiaki-ng test vectors (test/gkcrypt.c)', () => {
  it('/ecdh (with node:crypto, ecdh.c is not ported): public key, its signature and the shared secret', () => {
    const v = VECTORS.test_ecdh;
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(hex(v.local_private_key));
    const publicKey = ecdh.getPublicKey();
    assert.deepEqual(publicKey, hex(v.local_public_key));
    assert.deepEqual(createHmac('sha256', hex(v.handshake_key)).update(publicKey).digest(), hex(v.local_public_key_sig));
    assert.deepEqual(ecdh.computeSecret(hex(v.remote_public_key)), hex(v.secret));
    // The reference passes the console's signature to chiaki_ecdh_derive_secret() but does not check it there. The
    // vector shows it is made the same way as the local one.
    assert.deepEqual(createHmac('sha256', hex(v.handshake_key)).update(hex(v.remote_public_key)).digest(), hex(v.remote_public_key_sig));
  });

  it('/key_stream: key and IV from the handshake key and the ECDH secret, key stream low and beyond 32 bits', () => {
    const v = VECTORS.test_key_stream;
    const gkcrypt = new GKCrypt(42, hex(v.handshake_key), hex(v.ecdh_secret));
    assert.deepEqual(gkcrypt.keyBase, hex(v.gkcrypt_key));
    assert.deepEqual(gkcrypt.iv, hex(v.gkcrypt_iv));
    assert.deepEqual(gkcrypt.genKeyStream(0x30n, 0x20), hex(v.key_stream));
    assert.deepEqual(gkcrypt.genKeyStream(KEY_POS_HIGH, 0x20), hex(v.key_stream_high));
  });

  it('/en_decrypt: 0x25 bytes at an unaligned position, low and beyond 32 bits, both directions', () => {
    const v = VECTORS.test_endecrypt;
    const gkcrypt = new GKCrypt(42, hex(v.handshake_key), hex(v.ecdh_secret));
    assert.deepEqual(gkcrypt.keyBase, hex(v.gkcrypt_key));
    assert.deepEqual(gkcrypt.iv, hex(v.gkcrypt_iv));
    gkcrypt.genKeyStream(0x30n, 0x20); // the reference generates this first; the result is not used

    let buf = hex(v.clear_data);
    assert.equal(buf.length, 0x25);
    gkcrypt.encrypt(0x11n, buf);
    assert.deepEqual(buf, hex(v.enc_data));

    buf = hex(v.clear_data);
    gkcrypt.decrypt(0x11n, buf);
    assert.deepEqual(buf, hex(v.enc_data));

    buf = hex(v.clear_data);
    gkcrypt.encrypt(KEY_POS_HIGH, buf);
    assert.deepEqual(buf, hex(v.enc_data_high));

    buf = hex(v.clear_data);
    gkcrypt.decrypt(KEY_POS_HIGH, buf);
    assert.deepEqual(buf, hex(v.enc_data_high));
  });

  it('/gmac: with the current key, and with a key position that needs a later key', () => {
    const v = VECTORS.test_gmac;
    // The reference zeroes the struct and sets only key_gmac_current and iv, so key_gmac_base is all zero.
    let gkcrypt = GKCrypt.fromState({ keyGmacCurrent: hex(v.gkcrypt_key), iv: hex(v.gkcrypt_iv) });
    assert.deepEqual(gkcrypt.gmac(0x69a0n, hex(v.buf)), hex(v.gmac_expected));
    assert.equal(gkcrypt.keyGmacIndexCurrent, 0n);

    gkcrypt = GKCrypt.fromState({ keyGmacCurrent: hex(v.gkcrypt_key), iv: hex(v.gkcrypt_iv) });
    assert.deepEqual(gkcrypt.gmac(KEY_POS_HIGH, hex(v.buf)), hex(v.gmac_expected_high));
    assert.equal(gkcrypt.keyGmacIndexCurrent, (KEY_POS_HIGH - 1n) / 45000n, 'the state moved on to the later key');
  });

  it('/gen_gmac_key: key number 1 from a base key and the IV', () => {
    const v = VECTORS.test_gen_gmac_key;
    assert.deepEqual(genGmacKey(1n, hex(v.key_initial), hex(v.iv)), hex(v.key_result));
  });

  it('/gmac_split: a longer packet', () => {
    const v = VECTORS.test_gmac_split;
    let gkcrypt = GKCrypt.fromState({ keyGmacCurrent: hex(v.gkcrypt_key), iv: hex(v.gkcrypt_iv) });
    assert.deepEqual(gkcrypt.gmac(0xadf0n, hex(v.buf)), hex(v.gmac_expected));

    gkcrypt = GKCrypt.fromState({ keyGmacCurrent: hex(v.gkcrypt_key), iv: hex(v.gkcrypt_iv) });
    assert.deepEqual(gkcrypt.gmac(KEY_POS_HIGH, hex(v.buf)), hex(v.gmac_expected_high));
  });

  it('/gmac_multiple_of_key_refresh: a key position that is an exact multiple of the refresh interval', () => {
    const v = VECTORS.test_gmac_multiple_of_key_refresh;
    const keyPos = 0x6b1de0n;
    assert.equal(keyPos % BigInt(GKCRYPT_GMAC_KEY_REFRESH_KEY_POS), 0n);
    const gkcrypt = new GKCrypt(3, hex(v.handshake_key), hex(v.ecdh_secret));
    assert.deepEqual(gkcrypt.gmac(keyPos, hex(v.data)), hex(v.gmac_expected));
    assert.equal(gkcrypt.keyGmacIndexCurrent, keyPos / 45000n - 1n, 'position n * 45000 still belongs to key n - 1');
  });
});

describe('key state: chiaki-ng tests (test/keystate.c)', () => {
  it('/key_state: committed positions carry the high 32 bits forward and back', () => {
    const state = new KeyState();
    assert.equal(state.requestPos(0, true), 0n);
    assert.equal(state.requestPos(0x1337, true), 0x1337n);
    assert.equal(state.requestPos(0xffff0000, true), 0xffff0000n);
    assert.equal(state.requestPos(0x1337, true), 0x100001337n);
    assert.equal(state.requestPos(0xffff1337, true), 0xffff1337n);
    assert.equal(state.requestPos(0x50000000, true), 0x150000000n);
    assert.equal(state.requestPos(0xb0000000, true), 0x1b0000000n);
    assert.equal(state.requestPos(0x00000000, true), 0x200000000n);
  });

  it('/key_state_nocommit: without commit nothing is remembered', () => {
    const state = new KeyState();
    assert.equal(state.requestPos(0, false), 0n);
    assert.equal(state.requestPos(0x1337, false), 0x1337n);
    assert.equal(state.requestPos(0xffff0000, false), 0xffff0000n);
    assert.equal(state.requestPos(0x1337, false), 0x1337n);
    assert.equal(state.requestPos(0xffff1337, false), 0xffff1337n);
    assert.equal(state.requestPos(0x50000000, false), 0x50000000n);
    assert.equal(state.requestPos(0xb0000000, false), 0xb0000000n);
    assert.equal(state.requestPos(0x00000000, false), 0n);
  });
});

describe('gkcrypt: self-consistency (not reference vectors)', () => {
  const v = VECTORS.test_endecrypt;
  const make = (): GKCrypt => new GKCrypt(2, hex(v.handshake_key), hex(v.ecdh_secret));

  it('the key stream is the same whether it is generated in one piece or block by block, and across the 32 bit edge', () => {
    const gkcrypt = make();
    for (const start of [0n, 0x30n, (1n << 32n) - 0x40n, (1n << 40n) + 0x10n]) {
      const whole = gkcrypt.genKeyStream(start, 0x100);
      for (let off = 0; off < 0x100; off += 0x10) {
        assert.deepEqual(gkcrypt.genKeyStream(start + BigInt(off), 0x10), whole.subarray(off, off + 0x10), `block at ${start} + ${off}`);
      }
      assert.deepEqual(gkcrypt.getKeyStream(start, 0x100), whole);
    }
    assert.equal(gkcrypt.genKeyStream(0n, 0).length, 0);
    assert.throws(() => gkcrypt.genKeyStream(1n, 0x10), RangeError);
    assert.throws(() => gkcrypt.genKeyStream(0n, 0x11), RangeError);
  });

  it('decrypt undoes encrypt at any position and length, and pieces line up with the whole', () => {
    const gkcrypt = make();
    const clear = Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 7 + 3) & 0xff));
    for (const pos of [0n, 1n, 0xfn, 0x10n, 0x11n, 44999n, (1n << 32n) - 5n]) {
      const buf = Buffer.from(clear);
      gkcrypt.encrypt(pos, buf);
      assert.notDeepEqual(buf, clear);
      const pieces = Buffer.from(clear);
      gkcrypt.encrypt(pos, pieces.subarray(0, 33));
      gkcrypt.encrypt(pos + 33n, pieces.subarray(33));
      assert.deepEqual(pieces, buf, `in two pieces at ${pos}`);
      gkcrypt.decrypt(pos, buf);
      assert.deepEqual(buf, clear);
    }
    const empty = Buffer.alloc(0);
    gkcrypt.encrypt(5n, empty);
    assert.equal(empty.length, 0);
  });

  it('the two directions of one session have different keys', () => {
    const local = new GKCrypt(2, hex(v.handshake_key), hex(v.ecdh_secret));
    const remote = new GKCrypt(3, hex(v.handshake_key), hex(v.ecdh_secret));
    assert.notDeepEqual(local.keyBase, remote.keyBase);
    assert.notDeepEqual(local.iv, remote.iv);
    assert.notDeepEqual(local.gmac(0n, Buffer.from('abc')), remote.gmac(0n, Buffer.from('abc')));
  });

  it('the GMAC key changes after position 45000 and an older position still verifies afterwards', () => {
    const a = make();
    const b = make();
    const data = Buffer.from('some packet');
    assert.deepEqual(a.keyGmacCurrent, a.keyGmacBase);
    const early = a.gmac(45000n, data); // (45000 - 1) / 45000 = 0: still the first key
    assert.equal(a.keyGmacIndexCurrent, 0n);
    const late = a.gmac(45001n, data);
    assert.equal(a.keyGmacIndexCurrent, 1n);
    assert.deepEqual(a.keyGmacCurrent, genGmacKey(1n, a.keyGmacBase, a.iv));
    assert.deepEqual(a.genTmpGmacKey(0n), a.keyGmacBase);
    assert.deepEqual(a.genTmpGmacKey(1n), a.keyGmacCurrent);

    // The other end, asked in the opposite order, agrees; and going back does not move the current key.
    assert.deepEqual(b.gmac(45001n, data), late);
    assert.deepEqual(b.gmac(45000n, data), early);
    assert.equal(b.keyGmacIndexCurrent, 1n);
    assert.notDeepEqual(early, a.gmac(45000n, Buffer.from('some packeT')));
    assert.throws(() => a.genNewGmacKey(0n), RangeError);
  });

  it('refuses keys of the wrong size', () => {
    assert.throws(() => new GKCrypt(2, Buffer.alloc(15), Buffer.alloc(32)), RangeError);
    assert.throws(() => new GKCrypt(2, Buffer.alloc(16), Buffer.alloc(31)), RangeError);
    assert.throws(() => new GKCrypt(256, Buffer.alloc(16), Buffer.alloc(32)), RangeError);
    assert.throws(() => genGmacKey(1n, Buffer.alloc(8), Buffer.alloc(16)), RangeError);
  });

  it('key state: commit() sets what requestPos() compares against', () => {
    const state = new KeyState();
    state.commit(0x1fffffff0n);
    assert.equal(state.requestPos(0x10, false), 0x200000010n, 'wrapped forward');
    assert.equal(state.requestPos(0xffffff00, false), 0x1ffffff00n, 'slightly behind, same high part');
    assert.equal(state.prev, 0x1fffffff0n);
  });
});

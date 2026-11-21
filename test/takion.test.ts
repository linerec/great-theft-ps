// SPDX-License-Identifier: AGPL-3.0-only
//
// The Takion transport.
//
// Group 1 is chiaki-ng's own test file (test/takion.c, commit 43728af), test for test: the AV packet parser, a real
// captured video frame (test/takion.fixture.ts) that must parse and decrypt to known bytes, the send buffer, the
// congestion packet with its MAC, and "sending after a receive error". The byte arrays were extracted from the C source
// by a script, not retyped.
// Groups 2 and 3 pin the packet layouts and the send buffer's timing as this port reads them from takion.c.
// Group 4 runs the connection against a simulated console on 127.0.0.1 written with the same codecs. That shows that
// the two directions of this port agree with each other and with the layouts above; it cannot show that a real console
// agrees. Nothing here talks to anything but 127.0.0.1.
//
// STATUS: the reference's vectors pass. NOT run against a real console.

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { describe, it } from 'node:test';

import type { TakionAvPacket } from '../src/console/av-packet.ts';
import { avAudioFecUnitsCount, avAudioSourceUnitsCount, avAudioUnitSize } from '../src/console/av-packet.ts';
import { GKCrypt, KeyState } from '../src/console/gkcrypt.ts';
import { seqNum32Lt } from '../src/console/seqnum.ts';
import {
  DISABLE_AUDIO_VIDEO, FEEDBACK_STATE_BUF_SIZE_V12, FEEDBACK_STATE_BUF_SIZE_V9, Takion, TAKION_A_RWND, TAKION_CHUNK_TYPE, TAKION_CONGESTION_PACKET_SIZE,
  TAKION_MESSAGE_DATA_TYPE, TAKION_PACKET_TYPE, TakionError, takionFeedbackPacketCrypt, takionFormatCongestion, takionFormatCookie, takionFormatCookieAck,
  takionFormatData, takionFormatDataAck, takionFormatDataCont, takionFormatFeedbackHistory, takionFormatFeedbackState, takionFormatInit, takionFormatInitAck,
  takionFormatMessage, takionPacketMac, takionPacketTypeKeyPosOffset, takionPacketTypeMacOffset, takionParseDataAckPayload, takionParseDataPayload,
  takionParseInitAckPayload, takionParseInitPayload, takionParseMessage, takionV12AvPacketParse, takionV7AvPacketFormatHeader, takionV7AvPacketParse,
  takionV9AvPacketParse, takionWriteMessageHeader,
  type TakionConnectInfo, type TakionEvents,
} from '../src/console/takion.ts';
import { decodeTakionMessage, encodeTakionMessage, TAKION_PAYLOAD_TYPE } from '../src/console/takion-proto.ts';
import {
  TAKION_DATA_RESEND_TIMEOUT_MS, TAKION_DATA_RESEND_TRIES_MAX, TAKION_SEND_BUFFER_SIZE, TakionSendBuffer, TakionSendBufferError,
} from '../src/console/takionsendbuffer.ts';
import { REAL_VIDEO_CRYPT_INDEX, REAL_VIDEO_ECDH_SECRET, REAL_VIDEO_HANDSHAKE_KEY, REAL_VIDEO_PACKETS } from './takion.fixture.ts';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

const takionCode = (code: string) => (e: unknown): boolean => e instanceof TakionError && e.code === code;

const VECTORS = {
  test_av_packet_parse: {
    packet:
      '02002d000500c01c0103000000000000e41003670029f32f98f699828378db2943a9e588f2110420e62096e906ee0d27a1838288' +
      'e62149027574325bf6e9dc93ea31880d2b4b34f9ec1b26ccbbbb81f2d92d8ea1b9e2b3cab27da331f042b7b61e8f6da27046fd7e' +
      '9b6085b0ed4f20b50171a9aa186b2a90f3a78436fd6d148368a39b3ac8d43a31a09b61dea7ed46b4a3df3f448fad6409fc7ae724' +
      'f0d242d3575a7600c5e093a9f5325deef79d',
  },
  test_takion_format_congestion: {
    handshake_key: '54654c345cac56b8eae6152ade1ce2e8',
    ecdh_secret: '0034f821c7d9dea9e911ca5ad67d11ce4f02b1ce1ee7c38d5439fa64e3dbd80d',
    buf_expected: '050042001a000a00000000000001e5',
    buf_expected_mac: '050042001a000a648a7c74000001e5',
  },
} as const;

// ====================================================================================================================
// 1. chiaki-ng's tests (test/takion.c)
// ====================================================================================================================

describe('takion: chiaki-ng tests (test/takion.c)', () => {
  it('/av_packet_parse: a version 9 video packet', () => {
    const packet = hex(VECTORS.test_av_packet_parse.packet);
    const keyState = new KeyState();

    const avPacket = takionV9AvPacketParse(keyState, packet);

    assert.ok(avPacket.isVideo);
    assert.equal(avPacket.packetIndex, 45);
    assert.equal(avPacket.frameIndex, 5);
    assert.equal(avPacket.unitIndex, 6);
    assert.equal(avPacket.unitsInFrameTotal, 8);
    assert.equal(avPacket.unitsInFrameFec, 1);
    assert.equal(avPacket.codec, 3);
    assert.equal(avPacket.adaptiveStreamIndex, 0);

    // munit_assert_ptr_equal(av_packet.data, packet + 0x15): the payload is a view into the packet at that offset
    assert.equal(avPacket.data.buffer, packet.buffer);
    assert.equal(avPacket.data.byteOffset, packet.byteOffset + 0x15);
    assert.equal(avPacket.data.length, 0x99);

    // not asserted by the reference (commented out there), but read off the same bytes: 0xe410 at 0xe, 0x0367 at 0x12
    assert.equal(avPacket.keyPos, 0xe410n);
    assert.equal(avPacket.wordAt0x18, 0x367);
    assert.equal(avPacket.usesNaluInfoStructs, false);
    assert.equal(avPacket.isHaptics, false);
  });

  it('/av_packet_parse_real_video: 24 captured packets parse, and decrypt to the expected bytes', () => {
    assert.equal(REAL_VIDEO_PACKETS.length, 24);
    const gkcrypt = new GKCrypt(REAL_VIDEO_CRYPT_INDEX, hex(REAL_VIDEO_HANDSHAKE_KEY), hex(REAL_VIDEO_ECDH_SECRET));
    const keyState = new KeyState();

    REAL_VIDEO_PACKETS.forEach(([packetB64, naluB64], i) => {
      const packet = Buffer.from(packetB64, 'base64');
      const nalu = Buffer.from(naluB64, 'base64');

      const avPacket = takionV9AvPacketParse(keyState, packet);
      assert.ok(avPacket.isVideo, `packet ${i} is video`);
      assert.equal(avPacket.data.length, nalu.length, `packet ${i}: payload size`);
      gkcrypt.decrypt(avPacket.keyPos + 16n, avPacket.data);
      assert.ok(Buffer.from(avPacket.data).equals(nalu), `packet ${i}: decrypted payload`);
      assert.equal(avPacket.packetIndex, i, 'the capture is in order');
    });
  });

  it('beyond the reference test, same data: the MACs of those captured packets verify', () => {
    // The reference's test does not look at the MACs, but they are in the capture: every one of them is the GMAC this
    // port computes with the console's cipher at the packet's key position. This is the only check of MAC
    // verification against bytes that came from a real console.
    const gkcrypt = new GKCrypt(REAL_VIDEO_CRYPT_INDEX, hex(REAL_VIDEO_HANDSHAKE_KEY), hex(REAL_VIDEO_ECDH_SECRET));
    const keyState = new KeyState();
    REAL_VIDEO_PACKETS.forEach(([packetB64], i) => {
      const packet = Buffer.from(packetB64, 'base64');
      const received = Buffer.from(packet);
      const { keyPos } = takionV9AvPacketParse(keyState, packet);
      const { mac, macOld } = takionPacketMac(gkcrypt, packet, keyPos);
      assert.deepEqual(mac, macOld, `packet ${i}: MAC`);
      assert.deepEqual(packet, received, 'the packet is left as it was received');

      const tampered = Buffer.from(received);
      tampered[tampered.length - 1]! ^= 1;
      const bad = takionPacketMac(gkcrypt, tampered, keyPos);
      assert.notDeepEqual(bad.mac, bad.macOld, `packet ${i}: a changed payload does not verify`);
    });
  });

  it('/send_buffer: random sequence numbers, overflow, and acknowledgements that cover everything up to a number', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      // a small deterministic generator in place of munit_rand_*
      let state = seed * 0x9e3779b9;
      const rand32 = (): number => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (t ^ (t >>> 14)) >>> 0;
      };
      const randRange = (min: number, max: number): number => min + (rand32() % (max - min + 1)); // inclusive, like munit

      const numsCount = 0x30;
      const sendBuffer = new TakionSendBuffer(null, numsCount);

      // random_seqnums(): unique
      const numsExpected: number[] = [];
      while (numsExpected.length < numsCount + 1) {
        const seqnum = rand32();
        if (!numsExpected.includes(seqnum)) numsExpected.push(seqnum);
      }

      for (let i = 0; i < numsCount; i++) sendBuffer.push(numsExpected[i]!, Buffer.alloc(8));

      assert.throws(
        () => sendBuffer.push(numsExpected[numsCount]!, Buffer.alloc(8)),
        (e: unknown) => e instanceof TakionSendBufferError && e.code === 'overflow',
      );

      let cur = numsExpected.slice(0, numsCount);
      let rounds = 0;
      while (cur.length > 0) {
        assert.ok(++rounds < 10000, 'terminates');
        const ackNum = (cur[cur.length - 1]! + randRange(-1, 1) * randRange(1, 32)) >>> 0;
        const acked = sendBuffer.ack(ackNum);
        // seqnums_ack(): simulate the ack of ackNum
        const gone = cur.filter((n) => n === ackNum || seqNum32Lt(n, ackNum));
        cur = cur.filter((n) => !(n === ackNum || seqNum32Lt(n, ackNum)));
        // check_send_buffer_contents()
        const contents = sendBuffer.packets.map((p) => p.seqNum);
        assert.equal(contents.length, cur.length);
        for (const n of cur) assert.ok(contents.includes(n));
        // the reference leaves the acked sequence numbers untested ("TODO"); here they are what was removed
        assert.deepEqual(acked, gone);
        assert.deepEqual(contents, cur, 'the order of what remains is kept');
      }

      sendBuffer.fini();
    }
  });

  it('/format_congestion: the packet, and its MAC', () => {
    const v = VECTORS.test_takion_format_congestion;
    const gkcrypt = new GKCrypt(2, hex(v.handshake_key), hex(v.ecdh_secret));

    const keyPos = 0x1e5n;
    const buf = takionFormatCongestion({ word0: 0x42, received: 26, lost: 10 }, keyPos);
    assert.equal(buf.length, TAKION_CONGESTION_PACKET_SIZE);
    assert.deepEqual(buf, hex(v.buf_expected));

    takionPacketMac(gkcrypt, buf, keyPos);
    assert.deepEqual(buf, hex(v.buf_expected_mac));
  });

  it('/send_after_receive_error: after receiving failed, a reliable send reports "disconnected" while the socket is still open', async () => {
    // (skipped on Windows in the reference, for the socket calls of its test; the logic is the same here)
    // Fake console: a UDP socket on localhost that completes the Takion handshake, built with the reference test's own
    // header helper rather than with this port's formatters.
    const peer = await FakeConsole.start();
    const testWriteHeader = (buf: Buffer, tag: number, chunkType: number, payloadSize: number): void => {
      buf.fill(0, 0, 1 + 0x10);
      buf[0] = 0; // control packet
      buf.writeUInt32BE(tag, 1);
      buf[1 + 0xc] = chunkType;
      buf.writeUInt16BE(payloadSize + 4, 1 + 0xe);
    };

    let connected = false;
    const disconnects: Array<TakionError | undefined> = [];
    const takion = new Takion({
      onConnected: () => {
        connected = true;
      },
      onDisconnect: (reason) => disconnects.push(reason),
    });
    // the caller owns the socket, so later sends reach the send buffer
    const connecting = takion.connect({ host: '127.0.0.1', port: peer.port, enableCrypt: false, protocolVersion: 12, closeSocket: false });

    try {
      let buf = await peer.next();
      assert.equal(buf.length, 1 + 0x10 + 0x10); // INIT
      const tagLocal = buf.readUInt32BE(1 + 0x10);

      const initAck = Buffer.alloc(1 + 0x10 + 0x10 + 0x20);
      testWriteHeader(initAck, tagLocal, 2, 0x10 + 0x20);
      const pl = 1 + 0x10;
      initAck.writeUInt32BE(0x1337, pl + 0);
      initAck.writeUInt32BE(0x19000, pl + 4);
      initAck.writeUInt16BE(0x64, pl + 8);
      initAck.writeUInt16BE(0x64, pl + 0xa);
      initAck.writeUInt32BE(0x1337, pl + 0xc);
      await peer.send(initAck);

      buf = await peer.next();
      assert.equal(buf.length, 1 + 0x10 + 0x20); // COOKIE

      const cookieAck = Buffer.alloc(1 + 0x10);
      testWriteHeader(cookieAck, tagLocal, 0xb, 0);
      await peer.send(cookieAck);

      await connecting;
      assert.ok(connected);

      // An empty datagram makes recv() return 0, so the Takion receive loop ends with an error
      await peer.send(Buffer.alloc(0));
      await until(() => disconnects.length > 0, 'the disconnect');
      assert.equal(disconnects.length, 1);
      assert.ok(disconnects[0] instanceof TakionError && disconnects[0].code === 'network');

      // The send buffer has been finalized now, but the socket is still open
      assert.throws(() => takion.sendMessageData(1, 1, Buffer.alloc(8)), takionCode('disconnected'));

      // as in the reference, the packet itself went out before the send buffer refused it
      buf = await peer.next();
      assert.equal(buf.length, 1 + 0x10 + 9 + 8);
    } finally {
      await takion.close();
      await new Promise<void>((resolve) => takion.sock!.close(() => resolve()));
      await peer.close();
    }
    assert.equal(disconnects.length, 1, 'close() after the disconnect does not report it again');
  });
});

// ====================================================================================================================
// 2. packet layouts (this port's reading of takion.c; self-consistency)
// ====================================================================================================================

describe('takion: packet layouts', () => {
  it('where the MAC and the key position sit, per packet type', () => {
    assert.equal(takionPacketTypeMacOffset(TAKION_PACKET_TYPE.CONTROL), 5);
    assert.equal(takionPacketTypeKeyPosOffset(TAKION_PACKET_TYPE.CONTROL), 9);
    for (const type of [TAKION_PACKET_TYPE.VIDEO, TAKION_PACKET_TYPE.AUDIO]) {
      assert.equal(takionPacketTypeMacOffset(type), 0xa);
      assert.equal(takionPacketTypeKeyPosOffset(type), 0xe);
    }
    assert.equal(takionPacketTypeMacOffset(TAKION_PACKET_TYPE.CONGESTION), 7);
    assert.equal(takionPacketTypeKeyPosOffset(TAKION_PACKET_TYPE.CONGESTION), 0xb);
    for (const type of [TAKION_PACKET_TYPE.FEEDBACK_HISTORY, TAKION_PACKET_TYPE.HANDSHAKE, TAKION_PACKET_TYPE.FEEDBACK_STATE, TAKION_PACKET_TYPE.CLIENT_INFO, 7, 15]) {
      assert.equal(takionPacketTypeMacOffset(type), -1);
      assert.equal(takionPacketTypeKeyPosOffset(type), -1);
    }
  });

  it('INIT, INIT_ACK, COOKIE and COOKIE_ACK, byte for byte', () => {
    const init = takionFormatInit(0, { tag: 0xa1b2c3d4, aRwnd: TAKION_A_RWND, outboundStreams: 0x64, inboundStreams: 0x64, initialSeqNum: 0xa1b2c3d4 });
    assert.deepEqual(
      init,
      hex(`00  00000000 00000000 00000000 01 00 0014
           a1b2c3d4 00019000 0064 0064 a1b2c3d4`),
    );
    assert.equal(init.length, 1 + 0x10 + 0x10, 'the size the reference\'s fake console expects');
    const initMsg = takionParseMessage(init.subarray(1));
    assert.equal(initMsg.chunkType, TAKION_CHUNK_TYPE.INIT);
    assert.deepEqual(takionParseInitPayload(initMsg.payload), { tag: 0xa1b2c3d4, aRwnd: 0x19000, outboundStreams: 0x64, inboundStreams: 0x64, initialSeqNum: 0xa1b2c3d4 });

    const cookie = Buffer.from(Array.from({ length: 0x20 }, (_, i) => 0xc0 + i));
    const initAck = takionFormatInitAck(0xa1b2c3d4, { tag: 0x1337, aRwnd: 0x19000, outboundStreams: 0x64, inboundStreams: 0x64, initialSeqNum: 0x1337, cookie });
    assert.deepEqual(
      initAck,
      hex(`00  a1b2c3d4 00000000 00000000 02 00 0034
           00001337 00019000 0064 0064 00001337
           ${cookie.toString('hex')}`),
    );
    const ackPayload = takionParseInitAckPayload(takionParseMessage(initAck.subarray(1), { tagLocal: 0xa1b2c3d4 }).payload);
    assert.deepEqual({ ...ackPayload, cookie: Buffer.from(ackPayload.cookie) }, { tag: 0x1337, aRwnd: 0x19000, outboundStreams: 0x64, inboundStreams: 0x64, initialSeqNum: 0x1337, cookie });

    assert.deepEqual(takionFormatCookie(0x1337, cookie), hex(`00  00001337 00000000 00000000 0a 00 0024 ${cookie.toString('hex')}`));
    assert.deepEqual(takionFormatCookieAck(0xa1b2c3d4), hex('00  a1b2c3d4 00000000 00000000 0b 00 0004'));
    assert.throws(() => takionFormatCookie(1, Buffer.alloc(31)), RangeError);
    assert.throws(() => takionParseInitAckPayload(Buffer.alloc(0x2f)), takionCode('buf-too-small'));
  });

  it('DATA (with and without the data type byte) and DATA_ACK, byte for byte', () => {
    const data = takionFormatData(0x1337, 0x1_0000_0042n, 1, 0xa1b2c3d4, 9, TAKION_MESSAGE_DATA_TYPE.PROTOBUF, hex('08 03'));
    assert.deepEqual(
      data,
      hex(`00  00001337 00000000 00000042 00 01 000f
           a1b2c3d4 0009 0000 00  0803`),
      'only the low 32 bits of the key position are sent',
    );
    const parsed = takionParseDataPayload(takionParseMessage(data.subarray(1)).payload);
    assert.deepEqual({ ...parsed, data: Buffer.from(parsed.data) }, { seqNum: 0xa1b2c3d4, channel: 9, zeroA: 0, dataType: 0, data: hex('0803') });
    assert.throws(() => takionParseDataPayload(Buffer.alloc(8)), takionCode('buf-too-small'));

    assert.deepEqual(
      takionFormatDataCont(0x1337, 0n, 0, 0xa1b2c3d5, 1, hex('aa bb cc')),
      hex(`00  00001337 00000000 00000000 00 00 000f
           a1b2c3d5 0001 0000  aabbcc`),
    );

    const ack = takionFormatDataAck(0x1337, 0x2an, 0xa1b2c3d4, TAKION_A_RWND);
    assert.deepEqual(
      ack,
      hex(`00  00001337 00000000 0000002a 03 00 0010
           a1b2c3d4 00019000 0000 0000`),
    );
    assert.deepEqual(takionParseDataAckPayload(takionParseMessage(ack.subarray(1)).payload), { cumulativeSeqNum: 0xa1b2c3d4, aRwnd: 0x19000, gapAckBlocksCount: 0, dupTsnsCount: 0 });
    assert.throws(() => takionParseDataAckPayload(Buffer.alloc(0x10)), takionCode('invalid-data'));
  });

  it('parsing a control message: sizes, the tag, and the key state', () => {
    const msg = takionFormatMessage(0x11223344, 0x55n, 0x7f, 0x80, hex('01 02 03'));
    const parsed = takionParseMessage(msg.subarray(1));
    assert.deepEqual({ ...parsed, payload: Buffer.from(parsed.payload) }, { tag: 0x11223344, keyPosLow: 0x55, keyPos: 0x55n, chunkType: 0x7f, chunkFlags: 0x80, payload: hex('010203') });
    assert.equal(takionParseMessage(takionFormatCookieAck(1).subarray(1)).payload.length, 0);

    assert.throws(() => takionParseMessage(msg.subarray(1, 16)), takionCode('invalid-data'), 'shorter than the header');
    assert.throws(() => takionParseMessage(msg.subarray(1, msg.length - 1)), takionCode('invalid-data'), 'size field does not match');
    assert.throws(() => takionParseMessage(Buffer.concat([msg.subarray(1), Buffer.alloc(1)])), takionCode('invalid-data'));
    assert.throws(() => takionParseMessage(msg.subarray(1), { tagLocal: 0x11223345 }), takionCode('invalid-data'), 'tag mismatch');
    assert.ok(takionParseMessage(msg.subarray(1), { tagLocal: 0x11223344 }));

    // the key position is turned into a full one with the key state, and committed even if the tag check fails after
    const keyState = new KeyState();
    keyState.commit(0x1_ffff_fff0n);
    const wrapped = takionFormatMessage(1, 0x10n, 0, 0, Buffer.alloc(0));
    assert.throws(() => takionParseMessage(wrapped.subarray(1), { tagLocal: 2, keyState }), takionCode('invalid-data'));
    assert.equal(keyState.prev, 0x2_0000_0010n);

    const header = Buffer.alloc(0x14, 0xee);
    takionWriteMessageHeader(header, 2, 0xdeadbeef, 0xffff_ffff_0000_0001n, 3, 4, 0x1234);
    assert.deepEqual(header, hex('eeee deadbeef 00000000 00000001 03 04 1238 eeee'));
  });

  it('the MAC of a control packet ignores the key position field; without a cipher the MAC is zero', () => {
    const gkcrypt = new GKCrypt(2, Buffer.alloc(16, 0x11), Buffer.alloc(32, 0x22));
    const a = takionFormatData(0x1337, 0x30n, 1, 5, 1, 0, hex('aa'));
    const b = Buffer.from(a);
    b.writeUInt32BE(0xffffffff, 9); // another key position field, same key position for the MAC
    const macA = takionPacketMac(gkcrypt, a, 0x30n);
    const macB = takionPacketMac(gkcrypt, b, 0x30n);
    assert.deepEqual(macA.mac, macB.mac);
    assert.deepEqual(macA.macOld, Buffer.alloc(4));
    assert.deepEqual(a.subarray(5, 9), macA.mac, 'written at offset 5');
    assert.equal(a.readUInt32BE(9), 0x30, 'the key position field is restored');
    assert.equal(b.readUInt32BE(9), 0xffffffff);
    assert.notDeepEqual(takionPacketMac(gkcrypt, Buffer.from(a), 0x40n).mac, macA.mac, 'another key position, another MAC');

    // an AV packet's MAC does cover its key position field
    const av = formatAvPacket(12, { video: true, packetIndex: 1, keyPos: 0x30n, data: Buffer.alloc(8, 1) });
    const av2 = Buffer.from(av);
    av2.writeUInt32BE(0x31, 0xe);
    assert.notDeepEqual(takionPacketMac(gkcrypt, av, 0x30n).mac, takionPacketMac(gkcrypt, av2, 0x30n).mac);

    const again = takionPacketMac(null, a, 0x30n);
    assert.deepEqual(again.macOld, macA.mac);
    assert.deepEqual(again.mac, Buffer.alloc(4));
    assert.deepEqual(a.subarray(5, 9), Buffer.alloc(4));

    assert.throws(() => takionPacketMac(gkcrypt, Buffer.alloc(0), 0n), takionCode('buf-too-small'));
    assert.throws(() => takionPacketMac(gkcrypt, Buffer.from([TAKION_PACKET_TYPE.FEEDBACK_STATE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 0n), takionCode('invalid-data'));
    assert.throws(() => takionPacketMac(gkcrypt, Buffer.alloc(12), 0n), takionCode('buf-too-small'));
  });

  it('feedback state and history packets: the frame, then encrypted and authenticated in place', () => {
    const state = Buffer.from(Array.from({ length: FEEDBACK_STATE_BUF_SIZE_V12 }, (_, i) => i + 1));
    const frame = takionFormatFeedbackState(0x1234, state);
    assert.deepEqual(frame, hex(`06 1234 00 00000000 00000000 ${state.toString('hex')}`));

    const events = hex('01 02 03 04 05 06 07 08 09 0a');
    assert.deepEqual(takionFormatFeedbackHistory(0xfffe, 2, events), hex(`01 fffe 01 00000000 00000000 ${events.toString('hex')}`), 'the count is sent less one');
    assert.equal(takionFormatFeedbackHistory(1, 0, events)[3], 0, 'and never below zero');
    assert.equal(takionFormatFeedbackHistory(1, 1, events)[3], 0);

    const local = new GKCrypt(2, Buffer.alloc(16, 0x11), Buffer.alloc(32, 0x22));
    const console_ = new GKCrypt(2, Buffer.alloc(16, 0x11), Buffer.alloc(32, 0x22)); // the console's copy of that direction
    const keyPos = 0x1_0000_0100n;
    takionFeedbackPacketCrypt(local, frame, keyPos);
    assert.equal(frame.readUInt32BE(4), 0x100, 'low 32 bits of the key position at offset 4');
    assert.deepEqual(frame.subarray(0, 4), hex('06 1234 00'));
    assert.notDeepEqual(frame.subarray(0xc), state);
    // what the console does: check the GMAC over the packet with the GMAC field zeroed, then decrypt at keyPos + 16
    const check = Buffer.from(frame);
    check.fill(0, 8, 12);
    assert.deepEqual(console_.gmac(keyPos, check), frame.subarray(8, 12));
    const payload = Buffer.from(frame.subarray(0xc));
    console_.decrypt(keyPos + 16n, payload);
    assert.deepEqual(payload, state);
  });

  it('AV packets of versions 9 and 12: video, audio, haptics, the NALU info flag', () => {
    const data = Buffer.from(Array.from({ length: 16 }, (_, i) => 0x80 + i));

    for (const version of [9, 12] as const) {
      const parse = version === 9 ? takionV9AvPacketParse : takionV12AvPacketParse;

      const video = formatAvPacket(version, {
        video: true, packetIndex: 0xfffe, frameIndex: 0x1234, unitIndex: 0x7ff, unitsTotal: 0x800, unitsFec: 0x3ff, codec: 6, keyPos: 0xfedcba98n,
        wordAt0x18: 0xabcd, adaptiveStreamIndex: 5, data,
      });
      assert.equal(video.length, 0x15 + 16);
      let p = parse(new KeyState(), video);
      assert.deepEqual({ ...p, data: Buffer.from(p.data) }, {
        packetIndex: 0xfffe, frameIndex: 0x1234, usesNaluInfoStructs: false, isVideo: true, isHaptics: false, unitIndex: 0x7ff, unitsInFrameTotal: 0x800,
        unitsInFrameFec: 0x3ff, codec: 6, wordAt0x18: 0xabcd, adaptiveStreamIndex: 5, byteAt0x2c: 0x80, keyPos: 0xfedcba98n, data,
      });

      const videoNalu = formatAvPacket(version, { video: true, nalu: true, packetIndex: 7, data });
      assert.equal(videoNalu[0], 0x12);
      p = parse(new KeyState(), videoNalu);
      assert.ok(p.usesNaluInfoStructs && p.isVideo);
      assert.equal(p.data.byteOffset - videoNalu.byteOffset, 0x18);
      assert.deepEqual(Buffer.from(p.data), data);

      // audio: unit index 8 bits, total 8 bits, and the three counts packed in the low 16 bits
      const audio = formatAvPacket(version, { video: false, packetIndex: 3, frameIndex: 9, unitIndex: 0xab, unitsTotal: 0x100, unitsFec: 0x2a43, codec: 2, keyPos: 0x77n, data });
      assert.equal(audio.length, (version === 12 ? 0x14 : 0x13) + 16);
      p = parse(new KeyState(), audio);
      assert.deepEqual({ ...p, data: Buffer.from(p.data) }, {
        packetIndex: 3, frameIndex: 9, usesNaluInfoStructs: false, isVideo: false, isHaptics: false, unitIndex: 0xab, unitsInFrameTotal: 0x100,
        unitsInFrameFec: 0x2a43, codec: 2, wordAt0x18: 0, adaptiveStreamIndex: 0, byteAt0x2c: 0, keyPos: 0x77n, data,
      });
      assert.equal(avAudioUnitSize(p), 0x2a);
      assert.equal(avAudioFecUnitsCount(p), 4);
      assert.equal(avAudioSourceUnitsCount(p), 3);

      const haptics = formatAvPacket(version, { video: false, haptics: true, packetIndex: 4, data });
      assert.equal(parse(new KeyState(), haptics).isHaptics, version === 12, 'only version 12 has the haptics byte');
    }
  });

  it('AV packets: the key state supplies the high 32 bits, and too short or foreign packets are refused', () => {
    const data = Buffer.alloc(8, 7);
    const keyState = new KeyState();
    keyState.commit(0x1_ffff_ff00n);
    const p = takionV12AvPacketParse(keyState, formatAvPacket(12, { video: true, packetIndex: 1, keyPos: 0x20n, data }));
    assert.equal(p.keyPos, 0x2_0000_0020n);
    assert.equal(keyState.prev, 0x2_0000_0020n, 'committed by the parser, as in the reference');

    const video = formatAvPacket(12, { video: true, packetIndex: 1, data });
    assert.equal(video.length, 0x15 + 8);
    // the reference wants at least header size + 1 bytes after the type byte: 0x18 for video, 0x14 (v12) or 0x13 (v9) for audio
    assert.ok(takionV12AvPacketParse(new KeyState(), video.subarray(0, 0x19)));
    assert.throws(() => takionV12AvPacketParse(new KeyState(), video.subarray(0, 0x18)), takionCode('buf-too-small'));
    assert.ok(takionV9AvPacketParse(new KeyState(), video.subarray(0, 0x19)));
    assert.throws(() => takionV9AvPacketParse(new KeyState(), video.subarray(0, 0x18)), takionCode('buf-too-small'));

    const audio12 = formatAvPacket(12, { video: false, packetIndex: 1, data });
    assert.equal(takionV12AvPacketParse(new KeyState(), audio12.subarray(0, 0x15)).data.length, 1);
    assert.throws(() => takionV12AvPacketParse(new KeyState(), audio12.subarray(0, 0x14)), takionCode('buf-too-small'));
    const audio9 = formatAvPacket(9, { video: false, packetIndex: 1, data });
    assert.equal(takionV9AvPacketParse(new KeyState(), audio9.subarray(0, 0x14)).data.length, 1);
    assert.throws(() => takionV9AvPacketParse(new KeyState(), audio9.subarray(0, 0x13)), takionCode('buf-too-small'));

    // an audio packet with the NALU flag and nothing after its header: the reference would read past the end
    const audioNalu = formatAvPacket(12, { video: false, nalu: true, packetIndex: 1, data: Buffer.alloc(0) });
    assert.throws(() => takionV12AvPacketParse(new KeyState(), audioNalu.subarray(0, 0x15)), takionCode('buf-too-small'));

    assert.throws(() => takionV12AvPacketParse(new KeyState(), Buffer.alloc(0)), takionCode('buf-too-small'));
    for (const parse of [takionV9AvPacketParse, takionV12AvPacketParse, takionV7AvPacketParse]) {
      assert.throws(() => parse(new KeyState(), Buffer.alloc(40)), takionCode('invalid-data'), 'a control packet is not an AV packet');
      assert.throws(() => parse(new KeyState(), Buffer.alloc(40, 5)), takionCode('invalid-data'));
    }
  });

  it('version 7 AV packets: the header the reference formats is the header it parses', () => {
    const header = {
      isVideo: true, usesNaluInfoStructs: true, packetIndex: 0x0102, frameIndex: 0x0304, unitIndex: 5, unitsInFrameTotal: 9, unitsInFrameFec: 2, codec: 0xff,
      keyPos: 0n, wordAt0x18: 0x0607, adaptiveStreamIndex: 3,
    };
    const buf = Buffer.alloc(0x18 + 4, 0xee);
    assert.equal(takionV7AvPacketFormatHeader(buf, header), 0x18);
    // 12: video with NALU info. dword: 2 | (9 - 1) << 10 | 5 << 21 = 0x00a02002
    assert.deepEqual(buf, hex('12 0102 0304 00a02002 ff 00000000 00000000 0607 60 000000 eeeeeeee'));
    const p = takionV7AvPacketParse(null, buf);
    assert.deepEqual({ ...p, data: Buffer.from(p.data) }, {
      ...header, isHaptics: false, byteAt0x2c: 0, data: hex('eeeeeeee'),
    });

    // audio, no NALU info: 0x12 bytes
    const audio = Buffer.alloc(0x12 + 2, 0xdd);
    assert.equal(takionV7AvPacketFormatHeader(audio, { ...header, isVideo: false, usesNaluInfoStructs: false }), 0x12);
    assert.equal(audio[0], 0x03);
    const pa = takionV7AvPacketParse(null, audio);
    assert.ok(!pa.isVideo && !pa.usesNaluInfoStructs);
    assert.equal(pa.unitIndex, 5, 'version 7 uses the video bit layout for audio too');
    assert.deepEqual(Buffer.from(pa.data), hex('dddd'));

    // As in the reference: the key position is written in host order (little endian) but read big endian.
    takionV7AvPacketFormatHeader(buf, { ...header, keyPos: 0x11223344n });
    assert.deepEqual(buf.subarray(0xe, 0x12), hex('44332211'));
    assert.equal(takionV7AvPacketParse(null, buf).keyPos, 0x44332211n);

    assert.throws(() => takionV7AvPacketFormatHeader(Buffer.alloc(0x17), header), takionCode('buf-too-small'));
    assert.throws(() => takionV7AvPacketParse(null, buf.subarray(0, 0x17)), takionCode('buf-too-small'));
    assert.equal(takionV7AvPacketParse(null, buf.subarray(0, 0x18)).data.length, 0);
  });
});

// ====================================================================================================================
// 3. the send buffer's timing (self-consistency)
// ====================================================================================================================

describe('takion send buffer: resending', () => {
  it('resends after more than 200 ms without an acknowledgement, the same bytes each time', () => {
    let now = 1000;
    const sent: Buffer[] = [];
    const sendBuffer = new TakionSendBuffer((buf) => sent.push(Buffer.from(buf)), 8, { now: () => now });
    try {
      sendBuffer.push(7, hex('aa bb'));
      now += TAKION_DATA_RESEND_TIMEOUT_MS;
      sendBuffer.resend();
      assert.equal(sent.length, 0, 'exactly 200 ms is not yet "more than"');
      now += 1;
      sendBuffer.resend();
      assert.deepEqual(sent, [hex('aabb')]);
      sendBuffer.resend();
      assert.equal(sent.length, 1, 'the clock restarts with each resend');
      now += 150;
      sendBuffer.push(8, hex('cc'));
      now += 60;
      sendBuffer.resend();
      assert.deepEqual(sent, [hex('aabb'), hex('aabb')], 'the younger packet waits for its own 200 ms');
      assert.deepEqual(sendBuffer.packets.map((p) => p.tries), [2, 0]);

      assert.deepEqual(sendBuffer.ack(7), [7]);
      now += 1000;
      sendBuffer.resend();
      assert.deepEqual(sent.at(-1), hex('cc'));
      assert.equal(sent.length, 3);
    } finally {
      sendBuffer.fini();
    }
  });

  it('gives up after 25 resends, dropping that packet and every earlier one', () => {
    let now = 0;
    const sent: number[] = [];
    const sendBuffer = new TakionSendBuffer((buf) => sent.push(buf[0]!), 8, { now: () => now });
    try {
      sendBuffer.push(100, Buffer.from([1]));
      for (let i = 0; i < TAKION_DATA_RESEND_TRIES_MAX; i++) {
        now += 201;
        sendBuffer.resend();
      }
      assert.equal(sent.length, 25);
      sendBuffer.push(99, Buffer.from([2])); // an earlier sequence number that is still waiting
      sendBuffer.push(101, Buffer.from([3]));
      now += 201;
      sendBuffer.resend();
      assert.deepEqual(sendBuffer.packets.map((p) => p.seqNum), [101], '100 was given up, and 99 with it');
      // The reference's loop steps past the packet that moved into slot 0; it is resent on the next round.
      assert.equal(sent.length, 25);
      sendBuffer.resend();
      assert.deepEqual(sent.slice(25), [3]);
    } finally {
      sendBuffer.fini();
    }
  });

  it('refuses a duplicate sequence number, counts wrapped numbers as later, and forgets everything on fini', () => {
    const sendBuffer = new TakionSendBuffer(null, 4);
    sendBuffer.push(0xfffffffe, Buffer.alloc(1));
    assert.throws(() => sendBuffer.push(0xfffffffe, Buffer.alloc(1)), (e: unknown) => e instanceof TakionSendBufferError && e.code === 'invalid-data');
    sendBuffer.push(0xffffffff, Buffer.alloc(1));
    sendBuffer.push(0, Buffer.alloc(1));
    sendBuffer.push(1, Buffer.alloc(1));
    assert.deepEqual(sendBuffer.ack(0xfffffffd), [], 'an older acknowledgement removes nothing');
    assert.deepEqual(sendBuffer.ack(0), [0xfffffffe, 0xffffffff, 0], 'acknowledging 0 covers the numbers before the wrap');
    assert.deepEqual(sendBuffer.packets.map((p) => p.seqNum), [1]);
    sendBuffer.fini();
    assert.equal(sendBuffer.packets.length, 0);
    assert.equal(TAKION_SEND_BUFFER_SIZE, 1024);
    assert.throws(() => new TakionSendBuffer(null, 0), RangeError);
  });

  it('the timer resends on its own and stops when the buffer is empty', async () => {
    const sent: Buffer[] = [];
    const sendBuffer = new TakionSendBuffer((buf) => sent.push(Buffer.from(buf)), 4);
    try {
      sendBuffer.push(1, hex('01'));
      await until(() => sent.length >= 1, 'the first resend', 2000);
      assert.deepEqual(sent[0], hex('01'));
      sendBuffer.ack(1);
      const count = sent.length;
      await sleep(350);
      assert.equal(sent.length, count, 'nothing is resent after the acknowledgement');
    } finally {
      sendBuffer.fini();
    }
  });
});

// ====================================================================================================================
// 4. the connection, against a simulated console on 127.0.0.1
// ====================================================================================================================

/** What the test needs to describe an AV packet of protocol version 9 or 12. */
interface AvSpec {
  video: boolean;
  packetIndex: number;
  frameIndex?: number;
  unitIndex?: number;
  unitsTotal?: number;
  unitsFec?: number;
  codec?: number;
  keyPos?: bigint;
  nalu?: boolean;
  haptics?: boolean;
  wordAt0x18?: number;
  adaptiveStreamIndex?: number;
  data: Uint8Array;
}

/**
 * An AV packet as a console sends it (versions 9 and 12). The reference has no formatter for these, only the parser
 * (av_packet_parse() in takion.c), so this is written from the parser, for the tests only. The MAC field is left zero.
 */
function formatAvPacket(version: 9 | 12, s: AvSpec): Buffer {
  const headSize = 1 + 0x11 + (s.video ? 3 : 1) + (s.nalu ? 3 : 0) + (version === 12 && !s.video ? 1 : 0);
  const buf = Buffer.alloc(headSize + s.data.length);
  buf[0] = (s.video ? TAKION_PACKET_TYPE.VIDEO : TAKION_PACKET_TYPE.AUDIO) | (s.nalu ? 0x10 : 0);
  buf.writeUInt16BE(s.packetIndex, 1);
  buf.writeUInt16BE(s.frameIndex ?? 0, 3);
  const unitIndex = s.unitIndex ?? 0;
  const total = s.unitsTotal ?? 1;
  const fec = s.unitsFec ?? 0;
  const dword = s.video ? ((unitIndex << 0x15) | ((total - 1) << 0xa) | fec) >>> 0 : ((unitIndex << 0x18) | ((total - 1) << 0x10) | fec) >>> 0;
  buf.writeUInt32BE(dword, 5);
  buf[9] = s.codec ?? 0;
  // 0xa: the MAC
  buf.writeUInt32BE(Number((s.keyPos ?? 0n) & 0xffffffffn), 0xe);
  let off = 0x12;
  if (s.video) {
    buf.writeUInt16BE(s.wordAt0x18 ?? 0, off);
    buf[off + 2] = ((s.adaptiveStreamIndex ?? 0) << 5) & 0xff;
    off += 3;
  } else {
    off += 1; // one unknown byte
  }
  if (s.nalu) off += 3;
  if (version === 12 && !s.video) {
    buf[off] = s.haptics ? 0x02 : 0x00;
    off += 1;
  }
  buf.set(s.data, off);
  return buf;
}

const PEER_TAG = 0x1337;
// obviously fake key material for the simulated session
const FAKE_HANDSHAKE_KEY = hex('00112233445566778899aabbccddeeff');
const FAKE_ECDH_SECRET = Buffer.alloc(32, 0xa5);

/** A simulated console: a UDP socket on 127.0.0.1 that speaks the other half of Takion with this port's codecs. */
class FakeConsole {
  sock: dgram.Socket;
  port: number;
  inbox: Buffer[];
  client: { address: string; port: number } | null;
  /** The client's tag (from its INIT). */
  tagClient: number;
  /** Sequence number of the next data message this console sends. The client expects it to start at the console's tag. */
  nextSeq: number;
  /** Key position of the next packet this console sends. */
  keyPos: bigint;
  /** The cipher of what this console sends (index 3), once "the session has keys". */
  crypt: GKCrypt | null;
  private waiter: ((buf: Buffer) => void) | null;

  private constructor(sock: dgram.Socket) {
    this.sock = sock;
    this.port = sock.address().port;
    this.inbox = [];
    this.client = null;
    this.tagClient = 0;
    this.nextSeq = PEER_TAG;
    this.keyPos = 0x1000n;
    this.crypt = null;
    this.waiter = null;
    sock.on('message', (msg, rinfo) => {
      this.client = { address: rinfo.address, port: rinfo.port };
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter(msg);
      } else {
        this.inbox.push(msg);
      }
    });
  }

  static async start(): Promise<FakeConsole> {
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve));
    return new FakeConsole(sock);
  }

  /** The next datagram from the client. */
  next(timeoutMs = 3000): Promise<Buffer> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('the simulated console timed out waiting for a datagram'));
      }, timeoutMs);
      this.waiter = (buf) => {
        clearTimeout(timer);
        resolve(buf);
      };
    });
  }

  /** Asserts that the client sends nothing for a while. */
  async quiet(ms: number): Promise<void> {
    await sleep(ms);
    assert.equal(this.inbox.length, 0, 'the client sent something unexpected');
  }

  send(buf: Uint8Array): Promise<void> {
    const client = this.client;
    assert.ok(client, 'the client has not sent anything yet');
    return new Promise<void>((resolve, reject) => this.sock.send(buf, client.port, client.address, (err) => (err ? reject(err) : resolve())));
  }

  /** Several datagrams handed to the socket in one go, so that they arrive together (for tests of reordering). */
  async sendAll(bufs: Uint8Array[]): Promise<void> {
    await Promise.all(bufs.map((buf) => this.send(buf)));
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => this.sock.close(() => resolve()));
  }

  /** The console's half of the handshake. Checks what the client sends on the way. */
  async handshake(): Promise<void> {
    const initDatagram = await this.next();
    assert.equal(initDatagram.length, 1 + 0x10 + 0x10);
    assert.equal(initDatagram[0], TAKION_PACKET_TYPE.CONTROL);
    const init = takionParseMessage(initDatagram.subarray(1));
    assert.equal(init.chunkType, TAKION_CHUNK_TYPE.INIT);
    assert.equal(init.chunkFlags, 0);
    assert.equal(init.tag, 0, 'the client does not know the console\'s tag yet');
    assert.equal(init.keyPosLow, 0);
    const initPayload = takionParseInitPayload(init.payload);
    assert.equal(initPayload.aRwnd, 0x19000);
    assert.equal(initPayload.outboundStreams, 0x64);
    assert.equal(initPayload.inboundStreams, 0x64);
    assert.equal(initPayload.initialSeqNum, initPayload.tag, 'the first sequence number is the tag');
    this.tagClient = initPayload.tag;

    const cookie = Buffer.from(Array.from({ length: 0x20 }, (_, i) => (i * 7 + 1) & 0xff));
    await this.send(takionFormatInitAck(this.tagClient, { tag: PEER_TAG, aRwnd: 0x19000, outboundStreams: 0x64, inboundStreams: 0x64, initialSeqNum: PEER_TAG, cookie }));

    const cookieDatagram = await this.next();
    assert.equal(cookieDatagram.length, 1 + 0x10 + 0x20);
    const cookieMsg = takionParseMessage(cookieDatagram.subarray(1));
    assert.equal(cookieMsg.chunkType, TAKION_CHUNK_TYPE.COOKIE);
    assert.equal(cookieMsg.tag, PEER_TAG, 'from now on the client sends the console\'s tag');
    assert.deepEqual(Buffer.from(cookieMsg.payload), cookie, 'the cookie comes back unchanged');

    await this.send(takionFormatCookieAck(this.tagClient));
  }

  private takeKeyPos(): bigint {
    const keyPos = this.keyPos;
    this.keyPos += 0x40n;
    return keyPos;
  }

  /** A data message with the given sequence number, authenticated if the console has its cipher. */
  dataPacket(seqNum: number, dataType: number, data: Uint8Array, opts: { chunkFlags?: number; channel?: number; badMac?: boolean } = {}): Buffer {
    const keyPos = this.takeKeyPos();
    const buf = takionFormatData(this.tagClient, keyPos, opts.chunkFlags ?? 1, seqNum, opts.channel ?? 1, dataType, data);
    if (this.crypt) takionPacketMac(this.crypt, buf, keyPos);
    if (opts.badMac) buf[5]! ^= 0x80;
    return buf;
  }

  /** The next data message in sequence. */
  data(dataType: number, data: Uint8Array): Buffer {
    const buf = this.dataPacket(this.nextSeq, dataType, data);
    this.nextSeq = (this.nextSeq + 1) >>> 0;
    return buf;
  }

  /** An acknowledgement of everything the client sent up to seqNum. */
  ack(seqNum: number): Buffer {
    const keyPos = this.takeKeyPos();
    const buf = takionFormatDataAck(this.tagClient, keyPos, seqNum, 0x19000);
    if (this.crypt) takionPacketMac(this.crypt, buf, keyPos);
    return buf;
  }

  /** An AV packet; with the cipher, its payload is encrypted at key position + 16 and the packet authenticated. */
  av(version: 9 | 12, spec: AvSpec, opts: { badMac?: boolean } = {}): Buffer {
    const keyPos = this.takeKeyPos();
    const data = Buffer.from(spec.data);
    if (this.crypt) this.crypt.encrypt(keyPos + 16n, data);
    const buf = formatAvPacket(version, { ...spec, keyPos, data });
    if (this.crypt) takionPacketMac(this.crypt, buf, keyPos);
    if (opts.badMac) buf[0xa]! ^= 0x80;
    return buf;
  }
}

/** Everything a Takion reports, in order. */
interface Seen {
  order: string[];
  connected: number;
  disconnects: Array<TakionError | undefined>;
  data: Array<{ dataType: number; payload: Buffer }>;
  acks: number[];
  av: TakionAvPacket[];
}

function watch(): { events: TakionEvents; seen: Seen } {
  const seen: Seen = { order: [], connected: 0, disconnects: [], data: [], acks: [], av: [] };
  const events: TakionEvents = {
    onConnected: () => {
      seen.connected++;
      seen.order.push('connected');
    },
    onDisconnect: (reason) => {
      seen.disconnects.push(reason);
      seen.order.push('disconnect');
    },
    onData: (dataType, payload) => {
      seen.data.push({ dataType, payload: Buffer.from(payload) });
      seen.order.push(`data:${Buffer.from(payload).toString('hex')}`);
    },
    onDataAck: (seqNum) => {
      seen.acks.push(seqNum);
      seen.order.push('ack');
    },
    onAv: (packet) => {
      seen.av.push({ ...packet, data: Buffer.from(packet.data) });
      seen.order.push(`av:${packet.isVideo ? 'v' : 'a'}${packet.packetIndex}`);
    },
  };
  return { events, seen };
}

/** A connected pair: the client under test and the simulated console. */
async function connectPair(info: Partial<TakionConnectInfo> = {}): Promise<{ takion: Takion; peer: FakeConsole; seen: Seen; logs: string[]; end(): Promise<void> }> {
  const peer = await FakeConsole.start();
  const { events, seen } = watch();
  const logs: string[] = [];
  const takion = new Takion(events);
  const end = async (): Promise<void> => {
    await takion.close();
    await peer.close();
  };
  try {
    const connecting = takion.connect({ host: '127.0.0.1', port: peer.port, protocolVersion: 12, enableCrypt: false, log: (line) => logs.push(line), ...info });
    await peer.handshake();
    await connecting;
  } catch (e) {
    await end();
    throw e;
  }
  return { takion, peer, seen, logs, end };
}

describe('takion: handshake with a simulated console', () => {
  it('INIT, INIT_ACK, COOKIE, COOKIE_ACK; then connect() resolves and onConnected was called once', async () => {
    const { takion, seen, logs, end } = await connectPair();
    try {
      assert.equal(seen.connected, 1);
      assert.ok(takion.connected);
      assert.equal(takion.tagRemote, PEER_TAG);
      assert.equal(takion.seqNumLocal, takion.tagLocal);
      assert.equal(takion.version, 12);
      assert.ok(takion.sendBufferActive);
      assert.deepEqual(seen.order, ['connected']);
      assert.ok(logs.includes('Takion connected'));
    } finally {
      await end();
    }
    assert.ok(!takion.connected);
    assert.deepEqual(seen.order, ['connected', 'disconnect'], 'close() reports the disconnect, once');
    assert.equal(seen.disconnects[0], undefined, 'without a reason: it was closed here');
    await takion.close();
    assert.equal(seen.disconnects.length, 1);
    assert.throws(() => takion.sendMessageData(1, 1, Buffer.alloc(1)), takionCode('network'), 'the socket is closed');
    await assert.rejects(takion.connect({ host: '127.0.0.1', port: 1, protocolVersion: 12, enableCrypt: false }), /only once/);
  });

  it('retries INIT three times, then gives up with a timeout', async () => {
    const peer = await FakeConsole.start();
    const { events, seen } = watch();
    const takion = new Takion(events);
    try {
      const started = Date.now();
      await assert.rejects(takion.connect({ host: '127.0.0.1', port: peer.port, protocolVersion: 12, enableCrypt: false, expectTimeoutMs: 60 }), takionCode('timeout'));
      assert.ok(Date.now() - started >= 150, 'three waits of 60 ms');
      await sleep(30);
      assert.equal(peer.inbox.length, 3, 'three INITs');
      assert.ok(peer.inbox.every((d) => d.equals(peer.inbox[0]!)), 'all the same');
      assert.deepEqual(seen.order, [], 'neither connected nor disconnect is reported for a failed handshake');
      assert.ok(!takion.connected);
    } finally {
      await takion.close();
      await peer.close();
    }
  });

  it('an INIT_ACK that is lost once, and a COOKIE_ACK that is lost once, are asked for again', async () => {
    const peer = await FakeConsole.start();
    const { events, seen } = watch();
    const takion = new Takion(events);
    try {
      const connecting = takion.connect({ host: '127.0.0.1', port: peer.port, protocolVersion: 12, enableCrypt: false, expectTimeoutMs: 80 });
      const first = await peer.next(); // ignore the first INIT
      assert.equal(first.length, 33);
      // the second INIT is answered by handshake(); the first COOKIE that follows is ignored once
      const initAgain = await peer.next();
      assert.deepEqual(initAgain, first);
      const tagClient = takionParseInitPayload(takionParseMessage(initAgain.subarray(1)).payload).tag;
      const cookie = Buffer.alloc(0x20, 0x5a);
      await peer.send(takionFormatInitAck(tagClient, { tag: PEER_TAG, aRwnd: 0x19000, outboundStreams: 0x64, inboundStreams: 0x64, initialSeqNum: PEER_TAG, cookie }));
      const cookie1 = await peer.next();
      const cookie2 = await peer.next();
      assert.deepEqual(cookie2, cookie1, 'the cookie is sent again');
      assert.deepEqual(cookie1, takionFormatCookie(PEER_TAG, cookie));
      await peer.send(takionFormatCookieAck(tagClient));
      await connecting;
      assert.equal(seen.connected, 1);
    } finally {
      await takion.close();
      await peer.close();
    }
  });

  it('a second INIT_ACK before the COOKIE_ACK is skipped', async () => {
    const peer = await FakeConsole.start();
    const takion = new Takion();
    try {
      const connecting = takion.connect({ host: '127.0.0.1', port: peer.port, protocolVersion: 9, enableCrypt: false });
      const init = await peer.next();
      const tagClient = takionParseInitPayload(takionParseMessage(init.subarray(1)).payload).tag;
      const initAck = takionFormatInitAck(tagClient, { tag: PEER_TAG, aRwnd: 0x19000, outboundStreams: 0x64, inboundStreams: 0x64, initialSeqNum: 5, cookie: Buffer.alloc(0x20) });
      await peer.send(initAck);
      await peer.next(); // COOKIE
      await peer.send(initAck);
      await peer.send(takionFormatCookieAck(tagClient));
      await connecting;
      assert.ok(takion.connected);
      assert.equal(takion.version, 9);
    } finally {
      await takion.close();
      await peer.close();
    }
  });

  it('refuses a console tag of 0, stream counts out of range, and answers that are not what was asked for', async () => {
    /** Connects against a console that gives the same answer to every INIT, and returns how connect() ended. */
    const attempt = async (answer: (peer: FakeConsole, tagClient: number) => Promise<void>): Promise<unknown> => {
      const peer = await FakeConsole.start();
      const takion = new Takion();
      try {
        let settled = false;
        const result = takion
          .connect({ host: '127.0.0.1', port: peer.port, protocolVersion: 12, enableCrypt: false, expectTimeoutMs: 300 })
          .then(
            () => 'connected',
            (e: unknown) => e,
          )
          .finally(() => {
            settled = true;
          });
        let inits = 0;
        while (!settled) {
          let datagram: Buffer;
          try {
            datagram = await peer.next(50);
          } catch {
            continue;
          }
          const msg = takionParseMessage(datagram.subarray(1));
          if (msg.chunkType !== TAKION_CHUNK_TYPE.INIT) continue;
          inits++;
          await answer(peer, takionParseInitPayload(msg.payload).tag);
        }
        return { error: await result, inits };
      } finally {
        await takion.close();
        await peer.close();
      }
    };
    const ackWith = (over: Partial<{ tag: number; outboundStreams: number; inboundStreams: number }>) => (peer: FakeConsole, tagClient: number): Promise<void> =>
      peer.send(takionFormatInitAck(tagClient, { tag: PEER_TAG, aRwnd: 0x19000, outboundStreams: 0x64, inboundStreams: 0x64, initialSeqNum: PEER_TAG, cookie: Buffer.alloc(0x20), ...over }));
    const refused = (outcome: unknown, code: string, pattern: RegExp, inits: number): void => {
      const { error, inits: seen } = outcome as { error: unknown; inits: number };
      assert.ok(error instanceof TakionError && error.code === code && pattern.test(error.message), String(error));
      assert.equal(seen, inits, 'number of INITs the client sent');
    };

    // A readable INIT_ACK with unacceptable contents ends the handshake at once.
    refused(await attempt(ackWith({ tag: 0 })), 'invalid-response', /remote tag in init ack is 0/, 1);
    refused(await attempt(ackWith({ outboundStreams: 0 })), 'invalid-response', /min\/max check failed/, 1);
    refused(await attempt(ackWith({ inboundStreams: 0 })), 'invalid-response', /min\/max check failed/, 1);
    refused(await attempt(ackWith({ outboundStreams: 0x65 })), 'invalid-response', /min\/max check failed/, 1);
    refused(await attempt(ackWith({ inboundStreams: 0x63 })), 'invalid-response', /min\/max check failed/, 1);

    // An answer that cannot be read as an INIT_ACK is treated like no answer: INIT is sent again, three times in all,
    // and the last failure is reported.
    // a different tag in the header:
    refused(await attempt((peer, tagClient) => ackWith({})(peer, (tagClient + 1) >>> 0)), 'invalid-response', /Failed to parse message while expecting init ack/, 3);
    // a COOKIE_ACK where the INIT_ACK should be (too short):
    refused(await attempt((peer, tagClient) => peer.send(takionFormatCookieAck(tagClient))), 'invalid-response', /while expecting init ack packet of exactly 65/, 3);
    // the right size but not an INIT_ACK:
    refused(
      await attempt((peer, tagClient) => peer.send(takionFormatMessage(tagClient, 0n, TAKION_CHUNK_TYPE.DATA, 0, Buffer.alloc(0x30)))),
      'invalid-response',
      /unexpected message with type \(0x0, 0x0\) while expecting init ack/,
      3,
    );
    // an empty datagram is a failed read (recv() returning 0 in the reference):
    refused(await attempt((peer) => peer.send(Buffer.alloc(0))), 'network', /recv returned 0/, 3);
  });

  it('close() during the handshake makes connect() reject with "canceled"', async () => {
    const peer = await FakeConsole.start();
    const { events, seen } = watch();
    const takion = new Takion(events);
    try {
      const connecting = takion.connect({ host: '127.0.0.1', port: peer.port, protocolVersion: 12, enableCrypt: false });
      const rejected = assert.rejects(connecting, takionCode('canceled'));
      await peer.next(); // the INIT is out, the client is waiting for the answer
      await takion.close();
      await rejected;
      assert.deepEqual(seen.order, []);
    } finally {
      await peer.close();
    }
  });

  it('refuses a protocol version it has no AV packet layout for, before opening a socket', async () => {
    const takion = new Takion();
    await assert.rejects(takion.connect({ host: '127.0.0.1', port: 9, protocolVersion: 8, enableCrypt: false }), takionCode('invalid-data'));
    assert.equal(takion.sock, null);
    await takion.close();
  });

  it('uses a socket that is passed in, discards what was waiting on it, and leaves it open afterwards', async () => {
    const peer = await FakeConsole.start();
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve));
    const { events, seen } = watch();
    const takion = new Takion(events);
    try {
      // something left over from before (the reference expects hole punching leftovers): must not reach the handshake
      await new Promise<void>((resolve, reject) => peer.sock.send(Buffer.from('leftover'), sock.address().port, '127.0.0.1', (err) => (err ? reject(err) : resolve())));
      const connecting = takion.connect({ host: '127.0.0.1', port: peer.port, protocolVersion: 12, enableCrypt: false, socket: sock });
      await peer.handshake();
      await connecting;
      assert.equal(takion.sock, sock);
      assert.equal(takion.closeSocket, false);
      await takion.close();
      assert.deepEqual(seen.order, ['connected', 'disconnect']);
      assert.equal(sock.address().address, '127.0.0.1', 'still open: address() works');
    } finally {
      await takion.close();
      await new Promise<void>((resolve) => sock.close(() => resolve()));
      await peer.close();
    }
  });
});

describe('takion: reliable messages and AV packets with a simulated console (no encryption)', () => {
  it('a reliable message each way, acknowledged; an audio and a video packet', async () => {
    const { takion, peer, seen, end } = await connectPair();
    try {
      // client -> console: a heartbeat
      const heartbeat = encodeTakionMessage({ type: TAKION_PAYLOAD_TYPE.HEARTBEAT });
      const seqNum = takion.sendMessageData(1, 1, heartbeat);
      assert.equal(seqNum, takion.tagLocal, 'the first sequence number is the client\'s tag');
      assert.equal(takion.seqNumLocal, (takion.tagLocal + 1) >>> 0);

      const datagram = await peer.next();
      assert.deepEqual(datagram, takionFormatData(PEER_TAG, 0n, 1, seqNum, 1, 0, heartbeat), 'no cipher: key position 0 and a zero MAC');
      const msg = takionParseMessage(datagram.subarray(1));
      assert.equal(msg.chunkType, TAKION_CHUNK_TYPE.DATA);
      assert.equal(msg.chunkFlags, 1);
      const data = takionParseDataPayload(msg.payload);
      assert.deepEqual(decodeTakionMessage(data.data), { type: TAKION_PAYLOAD_TYPE.HEARTBEAT });
      assert.equal(takion.sendBuffer!.packets.length, 1, 'kept until it is acknowledged');

      await peer.send(peer.ack(seqNum));
      await until(() => seen.acks.length === 1, 'the acknowledgement');
      assert.deepEqual(seen.acks, [seqNum]);
      assert.equal(takion.sendBuffer!.packets.length, 0);

      // console -> client: a protobuf message; the client reports it and acknowledges it
      const streamInfoAck = encodeTakionMessage({ type: TAKION_PAYLOAD_TYPE.STREAMINFOACK });
      await peer.send(peer.data(TAKION_MESSAGE_DATA_TYPE.PROTOBUF, streamInfoAck));
      await until(() => seen.data.length === 1, 'the data message');
      assert.deepEqual(seen.data[0], { dataType: 0, payload: streamInfoAck });
      const ack = await peer.next();
      assert.deepEqual(ack, takionFormatDataAck(PEER_TAG, 0n, PEER_TAG, TAKION_A_RWND), 'acknowledges the console\'s first sequence number (its tag)');

      // the other data types the reference hands on; an unknown one is acknowledged but not reported
      await peer.send(peer.data(TAKION_MESSAGE_DATA_TYPE.RUMBLE, hex('01 02 03')));
      await peer.send(peer.data(TAKION_MESSAGE_DATA_TYPE.PAD_INFO, hex('04')));
      await peer.send(peer.data(TAKION_MESSAGE_DATA_TYPE.TRIGGER_EFFECTS, hex('05 06')));
      await peer.send(peer.data(5, hex('ff')));
      for (let i = 1; i <= 4; i++) {
        const next = await peer.next();
        assert.equal(takionParseDataAckPayload(takionParseMessage(next.subarray(1)).payload).cumulativeSeqNum, PEER_TAG + i);
      }
      assert.deepEqual(seen.data.slice(1), [
        { dataType: 7, payload: hex('010203') },
        { dataType: 9, payload: hex('04') },
        { dataType: 11, payload: hex('0506') },
      ]);

      // audio is reported as it arrives, video in order of its packet index
      const audioData = Buffer.from('audio unit bytes');
      await peer.send(peer.av(12, { video: false, packetIndex: 300, frameIndex: 20, unitIndex: 1, unitsTotal: 3, unitsFec: 0x1022, codec: 2, data: audioData }));
      const videoData = Buffer.from('video unit bytes');
      await peer.send(peer.av(12, { video: true, packetIndex: 40, frameIndex: 5, unitIndex: 0, unitsTotal: 2, unitsFec: 1, codec: 6, adaptiveStreamIndex: 2, data: videoData }));
      await until(() => seen.av.length === 2, 'the AV packets');
      const [audio, video] = seen.av as [TakionAvPacket, TakionAvPacket];
      assert.ok(!audio.isVideo && !audio.isHaptics);
      assert.equal(audio.packetIndex, 300);
      assert.equal(audio.frameIndex, 20);
      assert.equal(audio.unitIndex, 1);
      assert.equal(audio.unitsInFrameTotal, 3);
      assert.equal(audio.unitsInFrameFec, 0x1022);
      assert.equal(audio.codec, 2);
      assert.deepEqual(audio.data, audioData);
      assert.ok(video.isVideo);
      assert.equal(video.packetIndex, 40);
      assert.equal(video.frameIndex, 5);
      assert.equal(video.unitsInFrameTotal, 2);
      assert.equal(video.unitsInFrameFec, 1);
      assert.equal(video.codec, 6);
      assert.equal(video.adaptiveStreamIndex, 2);
      assert.deepEqual(video.data, videoData);
      assert.equal(typeof video.keyPos, 'bigint');

      await peer.quiet(30);
    } finally {
      await end();
    }
    assert.equal(seen.disconnects.length, 1);
  });

  it('a message that is not acknowledged is sent again, unchanged, until it is', async () => {
    const { takion, peer, seen, logs, end } = await connectPair();
    try {
      const started = Date.now();
      const seqNum = takion.sendMessageData(1, 1, hex('08 03'));
      const first = await peer.next();
      const second = await peer.next();
      assert.ok(Date.now() - started >= TAKION_DATA_RESEND_TIMEOUT_MS - 20, 'not before about 200 ms');
      assert.deepEqual(second, first);
      await peer.send(peer.ack(seqNum));
      await until(() => seen.acks.length === 1, 'the acknowledgement');
      peer.inbox.length = 0; // a resend may have crossed the acknowledgement
      await peer.quiet(350);
      assert.ok(logs.some((l) => l.startsWith('Takion Send Buffer re-sending packet with seqnum')));
    } finally {
      await end();
    }
  });

  it('one acknowledgement covers every earlier message; a split message uses the continuation layout', async () => {
    const { takion, peer, seen, end } = await connectPair();
    try {
      const a = takion.sendMessageData(0, 1, hex('01 02')); // first part, more follows
      const b = takion.sendMessageDataCont(0, 1, hex('03 04'));
      const c = takion.sendMessageDataCont(1, 1, hex('05')); // last part
      assert.deepEqual([b, c], [(a + 1) >>> 0, (a + 2) >>> 0]);
      assert.deepEqual(await peer.next(), takionFormatData(PEER_TAG, 0n, 0, a, 1, 0, hex('0102')));
      assert.deepEqual(await peer.next(), takionFormatDataCont(PEER_TAG, 0n, 0, b, 1, hex('0304')));
      assert.deepEqual(await peer.next(), takionFormatDataCont(PEER_TAG, 0n, 1, c, 1, hex('05')));
      await peer.send(peer.ack(c));
      await until(() => seen.acks.length === 3, 'three acknowledged messages');
      assert.deepEqual(seen.acks, [a, b, c]);
      assert.equal(takion.sendBuffer!.packets.length, 0);
    } finally {
      await end();
    }
  });

  it('data messages are reported in order of their sequence numbers and exactly once', async () => {
    const { peer, seen, end } = await connectPair();
    try {
      const s = PEER_TAG;
      await peer.send(peer.dataPacket(s + 2, 0, hex('c2')));
      await peer.send(peer.dataPacket(s + 1, 0, hex('c1')));
      await peer.quiet(40); // nothing is in order yet: nothing reported, nothing acknowledged
      assert.equal(seen.data.length, 0);

      await peer.send(peer.dataPacket(s, 0, hex('c0')));
      const ack = await peer.next();
      assert.equal(takionParseDataAckPayload(takionParseMessage(ack.subarray(1)).payload).cumulativeSeqNum, s + 2, 'one acknowledgement for all three');
      assert.deepEqual(seen.data.map((d) => d.payload.toString('hex')), ['c0', 'c1', 'c2']);

      // A repeat of something already delivered is dropped. As in the reference it is not acknowledged again.
      await peer.send(peer.dataPacket(s + 1, 0, hex('c1')));
      await peer.quiet(40);
      assert.equal(seen.data.length, 3);

      await peer.send(peer.dataPacket(s + 3, 0, hex('c3')));
      const ack2 = await peer.next();
      assert.equal(takionParseDataAckPayload(takionParseMessage(ack2.subarray(1)).payload).cumulativeSeqNum, s + 3);
      assert.equal(seen.data.length, 4);
    } finally {
      await end();
    }
  });

  it('ignores control packets with another tag, unknown chunks, unknown packet types and oversized datagrams', async () => {
    const { takion, peer, seen, logs, end } = await connectPair();
    try {
      await peer.send(takionFormatData((peer.tagClient + 1) >>> 0, 0n, 1, PEER_TAG, 1, 0, hex('aa'))); // wrong tag
      await peer.send(takionFormatMessage(peer.tagClient, 0n, 0x7, 0, hex('bb'))); // unknown chunk type
      await peer.send(Buffer.from([TAKION_PACKET_TYPE.HANDSHAKE, 1, 2, 3])); // a packet type the receive loop does not handle
      await peer.send(Buffer.alloc(1501, 0)); // longer than the reference's receive buffer
      await peer.send(takionFormatData(peer.tagClient, 0n, 1, PEER_TAG, 1, 0, Buffer.alloc(0)).subarray(0, 1 + 0x10 + 8)); // data shorter than its header, sizes inconsistent
      await peer.send(takionFormatMessage(peer.tagClient, 0n, TAKION_CHUNK_TYPE.DATA, 1, Buffer.alloc(8))); // a consistent DATA chunk below 9 bytes
      await peer.send(takionFormatMessage(peer.tagClient, 0n, TAKION_CHUNK_TYPE.DATA_ACK, 0, Buffer.alloc(0x10))); // an acknowledgement of the wrong size
      await peer.send(peer.data(0, hex('01'))); // and then something valid, to know all of the above has been seen
      await until(() => seen.data.length === 1, 'the valid message');
      assert.deepEqual(seen.order, ['connected', 'data:01']);
      assert.ok(takion.connected);
      const text = logs.join('\n');
      assert.match(text, /tag mismatch/);
      assert.match(text, /unknown chunk type = 0x7/);
      assert.match(text, /unknown type 0x4 received/);
      assert.match(text, /ignoring a datagram of 1501 bytes/);
      assert.match(text, /payload size mismatch/);
      assert.match(text, /data with a size less than the header size/);
      assert.match(text, /data ack with size 10 != 0xc/);
    } finally {
      await end();
    }
  });

  it('video packets out of order are reported in order; a missing one is skipped after about 16 ms', async () => {
    const { peer, seen, end } = await connectPair();
    try {
      const video = (packetIndex: number, unitIndex = 0): Buffer => peer.av(12, { video: true, packetIndex, unitIndex, unitsTotal: 8, data: Buffer.alloc(8, packetIndex & 0xff) });
      const order = (): string[] => seen.order.filter((o) => o.startsWith('av:'));

      // The first packet seen is unit 2 of its frame: the queue starts at the frame's first packet (index 20), which
      // never comes. Packet 22 is held back until the timeout skips the two missing ones.
      const started = Date.now();
      await peer.send(video(22, 2));
      await until(() => seen.av.length === 1, 'packet 22');
      assert.ok(Date.now() - started >= 12, `held back for the reorder timeout (${Date.now() - started} ms)`);
      assert.deepEqual(order(), ['av:v22']);

      // 24 and 25 before 23: nothing until 23 is there, then all three in order
      await peer.sendAll([video(24, 4), video(25, 5), video(23, 3)]);
      await until(() => seen.av.length === 4, 'packets 23 to 25');
      assert.deepEqual(order(), ['av:v22', 'av:v23', 'av:v24', 'av:v25']);

      // 26 is lost: 27 comes out after the timeout, and a late 26 is dropped then
      await peer.send(video(27, 7));
      await until(() => seen.av.length === 5, 'packet 27');
      await peer.send(video(26, 6));
      await peer.send(video(28, 0));
      await until(() => seen.av.length === 6, 'packet 28');
      assert.deepEqual(order(), ['av:v22', 'av:v23', 'av:v24', 'av:v25', 'av:v27', 'av:v28']);

      // audio does not go through the queue
      await peer.send(video(30, 2));
      await peer.send(peer.av(12, { video: false, packetIndex: 1, data: Buffer.alloc(4) }));
      await until(() => seen.av.length === 8, 'the audio packet and packet 30');
      assert.deepEqual(order().slice(6), ['av:a1', 'av:v30'], 'audio first: the video packet was waiting for 29');
    } finally {
      await end();
    }
  });

  it('the video packet index wraps from 0xffff to 0 without losing the order', async () => {
    const { peer, seen, end } = await connectPair();
    try {
      const video = (packetIndex: number): Buffer => peer.av(12, { video: true, packetIndex, data: Buffer.alloc(8) });
      // 0 arrives after 1: the reference's queue drops it at this point (see reorderqueue.ts)
      await peer.sendAll([video(0xfffe), video(1), video(0xffff), video(0), video(2)]);
      await until(() => seen.av.length === 5, 'five packets');
      assert.deepEqual(seen.av.map((p) => p.packetIndex), [0xfffe, 0xffff, 0, 1, 2]);
    } finally {
      await end();
    }
  });

  it('disableAudioVideo drops video, or audio except haptics, right after the transport', async () => {
    {
      const { peer, seen, end } = await connectPair({ disableAudioVideo: DISABLE_AUDIO_VIDEO.VIDEO });
      try {
        await peer.send(peer.av(12, { video: true, packetIndex: 1, data: Buffer.alloc(8) }));
        await peer.send(peer.av(12, { video: false, packetIndex: 2, data: Buffer.alloc(4) }));
        await until(() => seen.av.length === 1, 'the audio packet');
        await sleep(40);
        assert.deepEqual(seen.order.slice(1), ['av:a2']);
      } finally {
        await end();
      }
    }
    {
      const { peer, seen, end } = await connectPair({ disableAudioVideo: DISABLE_AUDIO_VIDEO.AUDIO });
      try {
        await peer.send(peer.av(12, { video: false, packetIndex: 1, data: Buffer.alloc(4) }));
        await peer.send(peer.av(12, { video: false, haptics: true, packetIndex: 2, data: Buffer.alloc(4) }));
        await peer.send(peer.av(12, { video: true, packetIndex: 3, data: Buffer.alloc(8) }));
        await until(() => seen.av.length === 2, 'haptics and video');
        assert.deepEqual(seen.order.slice(1), ['av:a2', 'av:v3']);
        assert.ok(seen.av[0]!.isHaptics);
      } finally {
        await end();
      }
    }
  });

  it('protocol versions 9 and 7 use their own AV packet layouts', async () => {
    {
      const { peer, seen, end } = await connectPair({ protocolVersion: 9 });
      try {
        // in version 9 there is no haptics byte: the same bytes as a version 12 packet give one more payload byte
        await peer.send(peer.av(9, { video: false, packetIndex: 5, data: hex('02 aa bb') }));
        await until(() => seen.av.length === 1, 'the audio packet');
        assert.deepEqual(seen.av[0]!.data, hex('02aabb'));
        assert.equal(seen.av[0]!.isHaptics, false);
      } finally {
        await end();
      }
    }
    {
      const { peer, seen, end } = await connectPair({ protocolVersion: 7 });
      try {
        const buf = Buffer.alloc(0x15 + 3, 0x77);
        takionV7AvPacketFormatHeader(buf, {
          isVideo: true, usesNaluInfoStructs: false, packetIndex: 9, frameIndex: 1, unitIndex: 0, unitsInFrameTotal: 1, unitsInFrameFec: 0, codec: 0, keyPos: 0n,
          wordAt0x18: 0, adaptiveStreamIndex: 0,
        });
        await peer.send(buf);
        await until(() => seen.av.length === 1, 'the video packet');
        assert.equal(seen.av[0]!.packetIndex, 9);
        assert.deepEqual(seen.av[0]!.data, hex('777777'));
      } finally {
        await end();
      }
    }
  });

  it('callbacks may send and close; nothing is reported after close()', async () => {
    const peer = await FakeConsole.start();
    const order: string[] = [];
    const takion: Takion = new Takion({
      onData: (_type, payload) => {
        order.push(`data:${Buffer.from(payload).toString('hex')}`);
        if (payload[0] === 0x01) takion.sendMessageData(1, 1, hex('99'));
        if (payload[0] === 0x02) void takion.close();
      },
      onDisconnect: () => order.push('disconnect'),
    });
    try {
      const connecting = takion.connect({ host: '127.0.0.1', port: peer.port, protocolVersion: 12, enableCrypt: false });
      await peer.handshake();
      await connecting;
      await peer.send(peer.data(0, hex('01')));
      const reply = await peer.next();
      assert.deepEqual(Buffer.from(takionParseDataPayload(takionParseMessage(reply.subarray(1)).payload).data), hex('99'), 'sent from inside the callback, before the acknowledgement');
      const ack = await peer.next();
      assert.equal(takionParseMessage(ack.subarray(1)).chunkType, TAKION_CHUNK_TYPE.DATA_ACK);

      await peer.send(Buffer.concat([peer.data(0, hex('02'))]));
      await peer.send(peer.data(0, hex('03')));
      await until(() => order.includes('disconnect'), 'the disconnect');
      await sleep(30);
      assert.deepEqual(order, ['data:01', 'data:02', 'disconnect']);
    } finally {
      await takion.close();
      await peer.close();
    }
  });

  it('feedback packets need the cipher; a feedback state must have the size of the protocol version', async () => {
    const { takion, peer, end } = await connectPair();
    try {
      assert.throws(() => takion.sendFeedbackState(0, Buffer.alloc(FEEDBACK_STATE_BUF_SIZE_V12)), takionCode('no-crypt'));
      assert.throws(() => takion.sendFeedbackHistory(0, 1, Buffer.alloc(5)), takionCode('no-crypt'));
      assert.throws(() => takion.sendMicPacket(Buffer.alloc(40), true), takionCode('no-crypt'));
      assert.throws(() => takion.sendFeedbackState(0, Buffer.alloc(FEEDBACK_STATE_BUF_SIZE_V9)), RangeError);
      // without a cipher a congestion packet goes out with key position 0 and a zero MAC
      takion.sendCongestion({ word0: 0, received: 100, lost: 2 });
      assert.deepEqual(await peer.next(), hex('05 0000 0064 0002 00000000 00000000'));
      assert.equal(takion.cryptAdvanceKeyPos(100), 0n);
      assert.equal(takion.keyPosLocal, 0n);
    } finally {
      await end();
    }
  });
});

describe('takion: with encryption, against a simulated console', () => {
  /** A connected pair with enableCrypt, and the four ciphers: two per side. */
  const cryptPair = async (): Promise<Awaited<ReturnType<typeof connectPair>> & { local: GKCrypt; remote: GKCrypt; consoleSees: GKCrypt }> => {
    const pair = await connectPair({ enableCrypt: true });
    return {
      ...pair,
      local: new GKCrypt(2, FAKE_HANDSHAKE_KEY, FAKE_ECDH_SECRET), // what the client sends
      remote: new GKCrypt(3, FAKE_HANDSHAKE_KEY, FAKE_ECDH_SECRET), // what the console sends, as the client checks it
      consoleSees: new GKCrypt(2, FAKE_HANDSHAKE_KEY, FAKE_ECDH_SECRET), // the console's copy of the client's direction
    };
  };
  /** What the console does with a control or congestion packet from the client: recompute the MAC and compare. */
  const consoleChecksMac = (consoleSees: GKCrypt, datagram: Buffer): bigint => {
    const keyPos = BigInt(datagram.readUInt32BE(takionPacketTypeKeyPosOffset(datagram[0]! & 0xf)));
    const copy = Buffer.from(datagram);
    const { mac, macOld } = takionPacketMac(consoleSees, copy, keyPos);
    assert.deepEqual(mac, macOld, 'the MAC the client wrote is the one the console computes');
    assert.notDeepEqual(macOld, Buffer.alloc(4));
    return keyPos;
  };
  /** chiaki_takion_crypt_advance_key_pos(): how far a packet of that size moves the key position. */
  const advance = (size: number): bigint => BigInt(size + (size % 16));

  it('packets wait until the keys are set; then MACs are checked both ways and payloads can be decrypted', async () => {
    const { takion, peer, seen, logs, local, remote, consoleSees, end } = await cryptPair();
    try {
      peer.crypt = new GKCrypt(3, FAKE_HANDSHAKE_KEY, FAKE_ECDH_SECRET);

      // An audio packet before the keys are known: kept back, because its MAC cannot be checked yet.
      const audioClear = Buffer.from('first audio unit');
      await peer.send(peer.av(12, { video: false, packetIndex: 1, data: audioClear }));
      await sleep(40);
      assert.equal(seen.av.length, 0);

      // The message that carries the console's key (the BANG in the real protocol). The stream connection derives the
      // keys in this callback and sets them; here they are simply known.
      takion.events.onData = (dataType, payload) => {
        seen.data.push({ dataType, payload: Buffer.from(payload) });
        seen.order.push(`data:${Buffer.from(payload).toString('hex')}`);
        if (payload[0] === 0xba) takion.setCrypt(local, remote);
      };
      await peer.send(peer.data(0, hex('ba')));

      // The acknowledgement is the first packet the client authenticates: key position 0.
      let expectedKeyPos = 0n;
      const ack = await peer.next();
      assert.equal(consoleChecksMac(consoleSees, ack), expectedKeyPos);
      assert.equal(takionParseDataAckPayload(takionParseMessage(ack.subarray(1)).payload).cumulativeSeqNum, PEER_TAG);
      expectedKeyPos += advance(ack.length);
      assert.equal(expectedKeyPos, 42n, '29 + 29 % 16, the reference\'s arithmetic');

      // Right after that callback the packet that was kept back is checked and reported, still encrypted.
      await until(() => seen.av.length === 1, 'the postponed audio packet');
      assert.deepEqual(seen.order, ['connected', 'data:ba', 'av:a1']);
      assert.ok(logs.includes('Takion flushing 1 postpone packet(s)'));
      const audio = seen.av[0]!;
      assert.notDeepEqual(audio.data, audioClear);
      remote.decrypt(audio.keyPos + 16n, audio.data); // what the stream connection does with every AV packet
      assert.deepEqual(audio.data, audioClear);

      // From now on: a good MAC is accepted, a bad one is dropped (AV and data alike).
      await peer.send(peer.av(12, { video: false, packetIndex: 2, data: Buffer.from('bad') }, { badMac: true }));
      await peer.send(peer.av(12, { video: false, packetIndex: 3, data: Buffer.from('good') }));
      await until(() => seen.av.length === 2, 'the good audio packet');
      assert.equal(seen.av[1]!.packetIndex, 3);
      assert.ok(logs.some((l) => /^Takion packet MAC mismatch for packet type 0x3 with key_pos 0x[0-9a-f]+$/.test(l)));

      const badData = peer.dataPacket(peer.nextSeq, 0, hex('bd'), { badMac: true });
      await peer.send(badData);
      await peer.quiet(40); // not reported, not acknowledged
      await peer.send(peer.data(0, hex('0d')));
      const ack2 = await peer.next();
      assert.equal(consoleChecksMac(consoleSees, ack2), expectedKeyPos);
      expectedKeyPos += advance(ack2.length);
      assert.deepEqual(seen.data.map((d) => d.payload.toString('hex')), ['ba', '0d']);

      // client -> console: a reliable message
      const seqNum = takion.sendMessageData(1, 1, hex('08 03'));
      const data = await peer.next();
      assert.equal(consoleChecksMac(consoleSees, data), expectedKeyPos);
      assert.deepEqual(Buffer.from(takionParseDataPayload(takionParseMessage(data.subarray(1)).payload).data), hex('0803'), 'data messages are authenticated, not encrypted');
      expectedKeyPos += advance(2);
      await peer.send(peer.ack(seqNum));
      await until(() => seen.acks.length === 1, 'the acknowledgement');

      // congestion
      takion.sendCongestion({ word0: 0x42, received: 26, lost: 10 });
      const congestion = await peer.next();
      assert.equal(congestion.length, 15);
      assert.equal(consoleChecksMac(consoleSees, congestion), expectedKeyPos);
      assert.deepEqual(congestion.subarray(0, 7), hex('05 0042 001a 000a'));
      expectedKeyPos += advance(15);

      // feedback state: 12 byte header; payload encrypted at key position + 16; GMAC over the whole packet
      const state = Buffer.from(Array.from({ length: FEEDBACK_STATE_BUF_SIZE_V12 }, (_, i) => 0x40 + i));
      const stateBefore = Buffer.from(state);
      takion.sendFeedbackState(0x0102, state);
      assert.deepEqual(state, stateBefore, 'the caller\'s buffer is not touched');
      const feedback = await peer.next();
      assert.equal(feedback.length, 0xc + FEEDBACK_STATE_BUF_SIZE_V12);
      assert.deepEqual(feedback.subarray(0, 4), hex('06 0102 00'));
      assert.equal(BigInt(feedback.readUInt32BE(4)), expectedKeyPos);
      const checkCopy = Buffer.from(feedback);
      checkCopy.fill(0, 8, 12);
      assert.deepEqual(consoleSees.gmac(expectedKeyPos, checkCopy), feedback.subarray(8, 12));
      const statePayload = Buffer.from(feedback.subarray(0xc));
      assert.notDeepEqual(statePayload, state);
      consoleSees.decrypt(expectedKeyPos + 16n, statePayload);
      assert.deepEqual(statePayload, state);
      expectedKeyPos += advance(FEEDBACK_STATE_BUF_SIZE_V12 + 16);

      // feedback history: the same frame with type 1 and the event count less one
      const history = hex('80 01 02 03 04  81 05 06 07 08  82 09 0a 0b 0c');
      takion.sendFeedbackHistory(0xffff, 3, history);
      const historyPacket = await peer.next();
      assert.deepEqual(historyPacket.subarray(0, 4), hex('01 ffff 02'));
      assert.equal(BigInt(historyPacket.readUInt32BE(4)), expectedKeyPos);
      const historyCopy = Buffer.from(historyPacket);
      historyCopy.fill(0, 8, 12);
      assert.deepEqual(consoleSees.gmac(expectedKeyPos, historyCopy), historyPacket.subarray(8, 12));
      const historyPayload = Buffer.from(historyPacket.subarray(0xc));
      consoleSees.decrypt(expectedKeyPos + 16n, historyPayload);
      assert.deepEqual(historyPayload, history);
      expectedKeyPos += advance(history.length + 16);

      // microphone packet: a PS5 audio header of 20 bytes, GMAC at 10, key position at 14, payload encrypted in place
      const micClear = Buffer.from('microphone samples');
      const mic = Buffer.concat([Buffer.alloc(20, 0x33), micClear]);
      mic[0] = TAKION_PACKET_TYPE.AUDIO;
      mic.fill(0, 10, 14); // the GMAC field must be zero when the packet is handed over: it is part of what is authenticated
      takion.sendMicPacket(mic, true);
      const micPacket = await peer.next();
      assert.deepEqual(micPacket, mic, 'sent as it now is: encrypted in place');
      assert.equal(BigInt(micPacket.readUInt32BE(14)), expectedKeyPos);
      const micCopy = Buffer.from(micPacket);
      const micMac = takionPacketMac(consoleSees, micCopy, expectedKeyPos); // an audio packet: the MAC sits at 10 and covers the key position
      assert.deepEqual(micMac.mac, micMac.macOld);
      const micPayload = Buffer.from(micPacket.subarray(20));
      consoleSees.decrypt(expectedKeyPos + 16n, micPayload);
      assert.deepEqual(micPayload, micClear);
      expectedKeyPos += advance(micClear.length + 16);

      assert.equal(takion.keyPosLocal, expectedKeyPos, 'every packet moved the local key position as the reference does');
      // nothing in the log is key material, a MAC or a payload
      const text = logs.join('\n');
      for (const secret of [FAKE_HANDSHAKE_KEY, FAKE_ECDH_SECRET, local.keyBase, local.iv, remote.keyBase, remote.iv, local.keyGmacBase, remote.keyGmacBase]) {
        assert.ok(!text.includes(secret.toString('hex')));
      }
      assert.ok(!text.includes(Buffer.from(badData.subarray(5, 9)).toString('hex')), 'not even the MAC of the packet that was refused');
    } finally {
      await end();
    }
  });

  it('data that was queued before the keys were set has its MAC checked once they are', async () => {
    const { takion, peer, seen, logs, local, remote, end } = await cryptPair();
    try {
      peer.crypt = new GKCrypt(3, FAKE_HANDSHAKE_KEY, FAKE_ECDH_SECRET);
      takion.events.onData = (dataType, payload) => {
        seen.data.push({ dataType, payload: Buffer.from(payload) });
        if (payload[0] === 0xba) takion.setCrypt(local, remote);
      };
      const s = PEER_TAG;
      // s + 2 arrives first, with a MAC that will not verify; without keys it is queued unchecked behind the gap
      await peer.send(peer.dataPacket(s + 2, 0, hex('e2'), { badMac: true }));
      await sleep(30);
      // s carries the key; after its callback the queue is re-checked and s + 2 is thrown out
      await peer.send(peer.dataPacket(s, 0, hex('ba')));
      const ack = await peer.next();
      assert.equal(takionParseDataAckPayload(takionParseMessage(ack.subarray(1)).payload).cumulativeSeqNum, s);
      await until(() => logs.includes('Found an invalid MAC'), 'the re-check');
      assert.ok(logs.includes('Crypt has become available. Re-checking MACs of 2 packets'), 'the window still holds the gap and the queued packet');

      // s + 1 fills the gap: only it is reported, s + 2 is gone until the console sends it again
      await peer.send(peer.dataPacket(s + 1, 0, hex('e1')));
      const ack1 = await peer.next();
      assert.equal(takionParseDataAckPayload(takionParseMessage(ack1.subarray(1)).payload).cumulativeSeqNum, s + 1);
      await peer.send(peer.dataPacket(s + 2, 0, hex('e2')));
      const ack2 = await peer.next();
      assert.equal(takionParseDataAckPayload(takionParseMessage(ack2.subarray(1)).payload).cumulativeSeqNum, s + 2);
      assert.deepEqual(seen.data.map((d) => d.payload.toString('hex')), ['ba', 'e1', 'e2']);
    } finally {
      await end();
    }
  });

  it('at most 32 AV packets are kept back; setCrypt() outside a callback releases them at once', async () => {
    const { takion, peer, seen, logs, local, remote, end } = await cryptPair();
    try {
      peer.crypt = new GKCrypt(3, FAKE_HANDSHAKE_KEY, FAKE_ECDH_SECRET);
      for (let i = 0; i < 34; i++) await peer.send(peer.av(12, { video: false, packetIndex: i, data: Buffer.alloc(4, i) }));
      await until(() => logs.filter((l) => l === 'Should postpone a packet, but there is no space left').length === 2, 'the two packets that did not fit');
      assert.equal(seen.av.length, 0);
      takion.setCrypt(local, remote);
      assert.equal(seen.av.length, 32, 'released synchronously');
      assert.deepEqual(seen.av.map((p) => p.packetIndex), Array.from({ length: 32 }, (_, i) => i));
    } finally {
      await end();
    }
  });

  it('with enableCrypt false nothing is kept back and MACs are not looked at, even after setCrypt(null, null)', async () => {
    const { takion, peer, seen, end } = await connectPair({ enableCrypt: false });
    try {
      takion.setCrypt(null, null);
      await peer.send(peer.av(12, { video: false, packetIndex: 1, data: Buffer.alloc(4) }, { badMac: true }));
      await until(() => seen.av.length === 1, 'the audio packet');
      assert.equal(seen.av[0]!.packetIndex, 1);
    } finally {
      await end();
    }
  });
});

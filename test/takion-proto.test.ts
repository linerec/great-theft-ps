// SPDX-License-Identifier: AGPL-3.0-only
//
// The protobuf messages of the Takion stream (chiaki-ng lib/protobuf/takion.proto, commit 43728af).
//
// The reference's tests contain no encoded protobuf examples, so the expected bytes below are derived by hand from the
// protobuf wire format rules (tag = field number << 3 | wire type; varints least significant group first; strings,
// bytes and sub-messages prefixed with their length; fixed32 and fixed64 little endian) for the messages the reference
// builds in lib/src/streamconnection.c and lib/src/senkusha.c. Where the reference encodes into a fixed buffer, the
// size is compared with that buffer: two of them (disconnect: 26 bytes, the Senkusha BIG: 12 bytes) are filled exactly,
// which is independent evidence that the layout is the one nanopb produces.
//
// STATUS: hand-derived encodings and round trips of all 44 messages pass. The schema table was compared mechanically
// with takion.proto when it was written and is pinned by a digest here. NOT compared with real nanopb output, NOT run
// against a console.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import * as proto from '../src/console/takion-proto.ts';
import {
  CONTROLLER_TYPE, decodeMessage, decodeTakionMessage, DIRECT_MESSAGE_DESTINATION, encodeMessage, encodeTakionMessage, SENKUSHA_COMMAND,
  TAKION_PAYLOAD_TYPE, TAKION_PROTO_SCHEMAS, TakionProtoError,
  type TakionProtoField, type TakionProtoMessageName, type TakionProtoMessages, type TakionProtoScalarType,
} from '../src/console/takion-proto.ts';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const ascii = (s: string): string => Buffer.from(s, 'latin1').toString('hex');
const NAMES = Object.keys(TAKION_PROTO_SCHEMAS) as TakionProtoMessageName[];
const SCALARS = new Set(['uint32', 'int32', 'int64', 'uint64', 'bool', 'enum', 'float', 'double', 'string', 'bytes']);

describe('takion.proto: the table', () => {
  it('has all 44 messages, each with unique ascending field numbers and types that exist', () => {
    assert.equal(NAMES.length, 44);
    for (const name of NAMES) {
      const fields = TAKION_PROTO_SCHEMAS[name];
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i]!;
        assert.ok(Number.isInteger(f.number) && f.number >= 1, `${name}.${f.name}`);
        if (i > 0) assert.ok(f.number > fields[i - 1]!.number, `${name}: field numbers ascend`);
        assert.ok(SCALARS.has(f.type) || NAMES.includes(f.type as TakionProtoMessageName), `${name}.${f.name}: type ${f.type}`);
      }
      assert.equal(new Set(fields.map((f) => f.name)).size, fields.length, `${name}: unique names`);
    }
  });

  it('is the table that was compared with takion.proto field by field (191 fields, 13 enums with 95 values)', () => {
    // When this file was written, a script parsed the reference's takion.proto and compared every message, field
    // number, label, type and enum value with the exports of takion-proto.ts: no difference. This digest pins that
    // state. If it changes, the table or an enum was edited: compare with the .proto again before updating it.
    const enums = Object.keys(proto).filter((k) => /^[A-Z0-9_]+$/.test(k) && k !== 'TAKION_PROTO_SCHEMAS').sort();
    assert.equal(enums.length, 13);
    const dump = JSON.stringify([TAKION_PROTO_SCHEMAS, enums.map((k) => [k, (proto as Record<string, unknown>)[k]])]);
    assert.equal(NAMES.reduce((n, name) => n + TAKION_PROTO_SCHEMAS[name].length, 0), 191);
    assert.equal(createHash('sha256').update(dump).digest('hex'), '31e741afa533926b8ac128e2f40d1f6623751c087fe7a5b3531248b5287fcb68');
  });

  it('enum values the reference relies on', () => {
    assert.equal(TAKION_PAYLOAD_TYPE.BIG, 0);
    assert.equal(TAKION_PAYLOAD_TYPE.BANG, 1);
    assert.equal(TAKION_PAYLOAD_TYPE.HEARTBEAT, 3);
    assert.equal(TAKION_PAYLOAD_TYPE.CORRUPTFRAME, 5);
    assert.equal(TAKION_PAYLOAD_TYPE.DISCONNECT, 8);
    assert.equal(TAKION_PAYLOAD_TYPE.SENKUSHA, 12);
    assert.equal(TAKION_PAYLOAD_TYPE.STREAMINFO, 13);
    assert.equal(TAKION_PAYLOAD_TYPE.STREAMINFOACK, 14);
    assert.equal(TAKION_PAYLOAD_TYPE.CONTROLLERCONNECTION, 21);
    assert.equal(TAKION_PAYLOAD_TYPE.IDRREQUEST, 25);
    assert.equal(TAKION_PAYLOAD_TYPE.TAKIONPROTOCOLREQUEST, 31);
    assert.equal(TAKION_PAYLOAD_TYPE.TAKIONPROTOCOLREQUESTACK, 32);
    assert.equal(SENKUSHA_COMMAND.CLIENT_MTU_COMMAND, 4);
    assert.equal(CONTROLLER_TYPE.DUALSENSE, 6);
    assert.equal(DIRECT_MESSAGE_DESTINATION.CLIENT, 1001);
  });
});

describe('takion.proto: the messages the reference sends, bytes derived by hand', () => {
  /** Encodes, compares, and checks that decoding gives the message back. */
  const check = (msg: proto.TakionMessage, expected: string, fitsIn?: number): Buffer => {
    const bytes = encodeTakionMessage(msg);
    assert.equal(bytes.toString('hex'), hex(expected).toString('hex'));
    if (fitsIn !== undefined) assert.ok(bytes.length <= fitsIn, `fits the reference's buffer of ${fitsIn} bytes`);
    assert.deepEqual(decodeTakionMessage(bytes), msg);
    return bytes;
  };

  it('heartbeat, stream info ack, IDR request: only the type', () => {
    check({ type: TAKION_PAYLOAD_TYPE.HEARTBEAT }, '08 03', 8);
    check({ type: TAKION_PAYLOAD_TYPE.STREAMINFOACK }, '08 0e', 3);
    check({ type: TAKION_PAYLOAD_TYPE.IDRREQUEST }, '08 19', 0x10);
  });

  it('disconnect: exactly the 26 bytes of the reference\'s buffer', () => {
    // 08 08: type = DISCONNECT. 52: field 10, length delimited. 0a: field 1, length delimited, 20 characters.
    const bytes = check(
      { type: TAKION_PAYLOAD_TYPE.DISCONNECT, disconnectPayload: { reason: 'Client Disconnecting' } },
      `08 08 52 16 0a 14 ${ascii('Client Disconnecting')}`,
      26,
    );
    assert.equal(bytes.length, 26);
  });

  it('the Senkusha BIG (empty strings, type 0 written): exactly the 12 bytes of the reference\'s buffer', () => {
    const bytes = check(
      { type: TAKION_PAYLOAD_TYPE.BIG, bigPayload: { clientVersion: 9, sessionKey: '', launchSpec: '', encryptedKey: Buffer.alloc(0) } },
      '08 00 12 08 08 09 12 00 1a 00 22 00',
      12,
    );
    assert.equal(bytes.length, 12);
  });

  it('the stream BIG: version, session id, launch spec, four zero bytes, ECDH public key and signature', () => {
    check(
      {
        type: TAKION_PAYLOAD_TYPE.BIG,
        bigPayload: {
          clientVersion: 12,
          sessionKey: 'abc',
          launchSpec: 'QUJD',
          encryptedKey: Buffer.alloc(4), // chiaki_pb_encode_zero_encrypted_key
          ecdhPubKey: hex('04 aa bb'),
          ecdhSig: hex('cc dd'),
        },
      },
      '08 00 12 1c  08 0c  12 03 61 62 63  1a 04 51 55 4a 44  22 04 00 00 00 00  2a 03 04 aa bb  32 02 cc dd',
      2048,
    );
  });

  it('takion protocol request: field 31 needs a two byte tag, the version list is not packed', () => {
    check({ type: TAKION_PAYLOAD_TYPE.TAKIONPROTOCOLREQUEST, takionProtocolRequest: { supportedTakionVersions: [9] } }, '08 1f fa 01 02 08 09', 12);
    check(
      { type: TAKION_PAYLOAD_TYPE.TAKIONPROTOCOLREQUEST, takionProtocolRequest: { supportedTakionVersions: [9, 12] } },
      '08 1f fa 01 04 08 09 08 0c',
    );
  });

  it('corrupt frame report: two byte varints', () => {
    check({ type: TAKION_PAYLOAD_TYPE.CORRUPTFRAME, corruptPayload: { start: 0x1234, end: 0x1235 } }, '08 05 32 06 08 b4 24 10 b5 24', 0x10);
    check({ type: TAKION_PAYLOAD_TYPE.CORRUPTFRAME, corruptPayload: { start: 0, end: 0 } }, '08 05 32 04 08 00 10 00', 0x10);
  });

  it('controller connection: connected and the controller type, no controller id', () => {
    check(
      { type: TAKION_PAYLOAD_TYPE.CONTROLLERCONNECTION, controllerConnectionPayload: { connected: true, controllerType: CONTROLLER_TYPE.DUALSENSE } },
      '08 15 b2 01 04 10 01 18 06',
      2048,
    );
    check(
      { type: TAKION_PAYLOAD_TYPE.CONTROLLERCONNECTION, controllerConnectionPayload: { connected: true, controllerType: CONTROLLER_TYPE.DUALSHOCK4 } },
      '08 15 b2 01 04 10 01 18 02',
    );
  });

  it('stream info with only an audio header (how the reference enables the microphone)', () => {
    const audioHeader = hex('00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d'); // 14 bytes, the size of an audio header
    check(
      { type: TAKION_PAYLOAD_TYPE.STREAMINFO, streamInfoPayload: { resolution: [], audioHeader, audioChannel: [] } },
      '08 0d 7a 10 12 0e 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d',
      2048,
    );
  });

  it('Senkusha commands: echo, MTU and client MTU', () => {
    check(
      { type: TAKION_PAYLOAD_TYPE.SENKUSHA, senkushaPayload: { command: SENKUSHA_COMMAND.ECHO_COMMAND, echoCommand: { state: true } } },
      '08 0c 72 06 08 00 12 02 08 01',
      0x10,
    );
    check(
      { type: TAKION_PAYLOAD_TYPE.SENKUSHA, senkushaPayload: { command: SENKUSHA_COMMAND.ECHO_COMMAND, echoCommand: { state: false } } },
      '08 0c 72 06 08 00 12 02 08 00',
      0x10,
    );
    // The reference sets `num` in the struct but not has_num, so nanopb does not send it: id and mtu_req only.
    check(
      { type: TAKION_PAYLOAD_TYPE.SENKUSHA, senkushaPayload: { command: SENKUSHA_COMMAND.MTU_COMMAND, mtuCommand: { id: 1, mtuReq: 1454 } } },
      '08 0c 72 09 08 01 1a 05 08 01 10 ae 0b',
      0x20,
    );
    check(
      { type: TAKION_PAYLOAD_TYPE.SENKUSHA, senkushaPayload: { command: SENKUSHA_COMMAND.MTU_COMMAND, mtuCommand: { id: 1, mtuReq: 1454, num: 1 } } },
      '08 0c 72 0b 08 01 1a 07 08 01 10 ae 0b 20 01',
      0x20,
    );
    check(
      {
        type: TAKION_PAYLOAD_TYPE.SENKUSHA,
        senkushaPayload: { command: SENKUSHA_COMMAND.CLIENT_MTU_COMMAND, clientMtuCommand: { id: 2, mtuReq: 1454, state: true, mtuDown: 1454 } },
      },
      '08 0c 72 0e 08 04 2a 0a 08 02 10 ae 0b 18 01 20 ae 0b',
      0x20,
    );
  });
});

describe('takion.proto: scalar encodings, bytes derived by hand', () => {
  const check = <K extends TakionProtoMessageName>(name: K, msg: TakionProtoMessages[K], expected: string): void => {
    assert.equal(encodeMessage(name, msg).toString('hex'), hex(expected).toString('hex'));
    assert.deepEqual(decodeMessage(name, hex(expected)), msg);
  };

  it('the two examples of the protobuf encoding documentation: 150 and "testing"', () => {
    check('FpsChangePayload', { fps: 150 }, '08 96 01');
    check('PlayTimeLeftPayload', { reason: 'testing' }, '12 07 74 65 73 74 69 6e 67');
    check('ServerMessagePayload', { payload: 'testing' }, '0a 07 74 65 73 74 69 6e 67');
  });

  it('varints at the edges', () => {
    check('FpsChangePayload', { fps: 0 }, '08 00');
    check('FpsChangePayload', { fps: 127 }, '08 7f');
    check('FpsChangePayload', { fps: 128 }, '08 80 01');
    check('FpsChangePayload', { fps: 0xffffffff }, '08 ff ff ff ff 0f');
    check('DirectMessagePayload', { directMessageType: 0, destination: 1000 }, '08 00 10 e8 07');
  });

  it('int32 below zero is ten bytes, int64 and uint64 are bigint', () => {
    check('ControllerConnectionPayload', { controllerId: -1 }, '08 ff ff ff ff ff ff ff ff ff 01');
    check('ControllerConnectionPayload', { controllerId: -0x80000000 }, '08 80 80 80 80 f8 ff ff ff ff 01');
    check('ControllerConnectionPayload', { controllerId: 0x7fffffff }, '08 ff ff ff ff 07');
    check('LogMessage', { timestamp: -2n, level: 1, component: 'c', message: 'm' }, '08 fe ff ff ff ff ff ff ff ff 01 10 01 1a 01 63 22 01 6d');
    check('ConnectionQualityPayload', { loss: (1n << 64n) - 1n }, '30 ff ff ff ff ff ff ff ff ff 01');
    check('ConnectionQualityPayload', { loss: 1n << 63n }, '30 80 80 80 80 80 80 80 80 80 01');
    // a plain number is accepted for a 64 bit field when encoding; decoding always gives a bigint
    assert.equal(encodeMessage('ConnectionQualityPayload', { loss: 300 as unknown as bigint }).toString('hex'), '30ac02');
    assert.deepEqual(decodeMessage('ConnectionQualityPayload', hex('30 ac 02')), { loss: 300n });
  });

  it('float is fixed32, double is fixed64, both little endian; bool is one byte', () => {
    check('ConnectionQualityPayload', { upstreamLoss: 0.5, rtt: 1 }, '1d 00 00 00 3f  29 00 00 00 00 00 00 f0 3f');
    check('BitratePayload', { toggle: true, bitrateChange: -2 }, '08 01 15 00 00 00 c0');
    check('ConnectionQualityPayload', { disableUpstreamAudio: false }, '20 00');
  });

  it('an optional field that is present is written even when it is zero, false or empty', () => {
    check('OverlayPayload', { enable: false, toggle: false, location: 0, level: 0 }, '08 00 10 00 18 00 20 00');
    check('ServerMessagePayload', { payload: '' }, '0a 00');
    check('OverlayPayload', {}, '');
    check('CursorPayload', { id: 0, width: 0, height: 0, hotspotX: 0, hotspotY: 0, pixels: Buffer.alloc(0) }, '08 00 10 00 18 00 20 00 28 00 32 00');
  });

  it('strings are UTF-8', () => {
    check('ServerMessagePayload', { payload: 'é€' }, '0a 05 c3 a9 e2 82 ac');
  });
});

describe('takion.proto: decoding what a console could send', () => {
  it('a BANG with an ECDH key and signature', () => {
    // 08 01: type BANG. 1a 12: field 3, 18 bytes. Then server_version 12, token 0, both flags true, session key "k",
    // ecdh_pub_key (field 8) 04 aa, ecdh_sig (field 9) cc.
    const msg = decodeTakionMessage(hex('08 01 1a 12  08 0c  10 00  18 01  20 01  2a 01 6b  42 02 04 aa  4a 01 cc'));
    assert.deepEqual(msg, {
      type: TAKION_PAYLOAD_TYPE.BANG,
      bangPayload: { serverVersion: 12, token: 0, encryptedKeyAccepted: true, versionAccepted: true, sessionKey: 'k', ecdhPubKey: hex('04aa'), ecdhSig: hex('cc') },
    });
    assert.ok(Buffer.isBuffer(msg.bangPayload?.ecdhPubKey));
  });

  it('bytes are copied out of the input', () => {
    const input = hex('0a 02 aa bb 10 01'); // PeriodicTimestampPayload
    const msg = decodeMessage('PeriodicTimestampPayload', input);
    input.fill(0);
    assert.deepEqual(msg, { periodicTsInfo: hex('aabb'), version: 1 });
  });

  it('unknown fields of every wire type are skipped', () => {
    // field 7 does not exist in TakionMessage: as varint (38), fixed64 (39), length delimited (3a), fixed32 (3d);
    // field 99 (two byte tag 98 06) as varint.
    const input = hex('38 2a  39 01 02 03 04 05 06 07 08  08 03  3a 02 aa bb  3d 01 02 03 04  98 06 05');
    assert.deepEqual(decodeTakionMessage(input), { type: TAKION_PAYLOAD_TYPE.HEARTBEAT });
  });

  it('repeated scalars are accepted packed, unpacked and mixed', () => {
    assert.deepEqual(decodeMessage('TakionProtocolRequestPayload', hex('08 07 08 09 08 0c')), { supportedTakionVersions: [7, 9, 12] });
    assert.deepEqual(decodeMessage('TakionProtocolRequestPayload', hex('0a 03 07 09 0c')), { supportedTakionVersions: [7, 9, 12] });
    assert.deepEqual(decodeMessage('TakionProtocolRequestPayload', hex('08 07 0a 02 09 0c 08 0d')), { supportedTakionVersions: [7, 9, 12, 13] });
    assert.deepEqual(decodeMessage('TakionProtocolRequestPayload', hex('')), { supportedTakionVersions: [] });
  });

  it('repeated messages keep their order; a decoded message always has its repeated fields as arrays', () => {
    const input = hex('0a 07 08 02 10 03 1a 01 aa  12 01 ee  0a 06 08 04 10 05 1a 00');
    assert.deepEqual(decodeMessage('StreamInfoPayload', input), {
      resolution: [
        { width: 2, height: 3, videoHeader: hex('aa') },
        { width: 4, height: 5, videoHeader: Buffer.alloc(0) },
      ],
      audioHeader: hex('ee'),
      audioChannel: [],
    });
  });

  it('a second occurrence of a sub-message is merged into the first; a repeated scalar field keeps the last value', () => {
    assert.deepEqual(decodeMessage('DebugOption', hex('08 00  12 02 08 01  12 02 20 03')), { type: 0, overlay: { enable: true, level: 3 } });
    assert.deepEqual(decodeMessage('FpsChangePayload', hex('08 01 08 02')), { fps: 2 });
  });

  it('int32 accepts the five byte form some encoders write for negative numbers', () => {
    assert.deepEqual(decodeMessage('ControllerConnectionPayload', hex('08 ff ff ff ff 0f')), { controllerId: -1 });
    assert.deepEqual(decodeMessage('ControllerConnectionPayload', hex('08 ff ff ff ff ff ff ff ff ff 01')), { controllerId: -1 });
  });

  it('a missing required field is refused, as nanopb does, unless lenient', () => {
    assert.throws(() => decodeTakionMessage(hex('')), /TakionMessage\.type: missing required field/);
    assert.deepEqual(decodeTakionMessage(hex(''), { lenient: true }), {});
    // nested: a BANG without its session key
    const bang = hex('08 01 1a 08  08 0c  10 00  18 01  20 01');
    assert.throws(() => decodeTakionMessage(bang), /bangPayload\.sessionKey: missing required field/);
    assert.deepEqual(decodeTakionMessage(bang, { lenient: true }), {
      type: 1,
      bangPayload: { serverVersion: 12, token: 0, encryptedKeyAccepted: true, versionAccepted: true },
    });
  });

  it('malformed input is refused', () => {
    const bad = (name: TakionProtoMessageName, input: string, pattern: RegExp): void => {
      assert.throws(() => decodeMessage(name, hex(input)), (e: unknown) => e instanceof TakionProtoError && pattern.test(e.message), `${name} ${input}`);
    };
    bad('FpsChangePayload', '08', /truncated varint/);
    bad('ServerMessagePayload', '0a 05 61', /length runs past the end/);
    bad('ConnectionQualityPayload', '1d 00 00', /truncated message/);
    bad('FpsChangePayload', '00 00', /zero tag/);
    bad('FpsChangePayload', '0a 01 00', /wrong wire type/);
    bad('ServerMessagePayload', '08 01', /wrong wire type/);
    bad('TakionMessage', '08 03 12 01', /wrong wire type|length runs past the end/);
    bad('FpsChangePayload', '08 80 80 80 80 10', /integer too large/);
    bad('FpsChangePayload', '08 ff ff ff ff ff ff ff ff ff ff 01', /varint overflow/);
    bad('FpsChangePayload', '08 ff ff ff ff ff ff ff ff ff 02', /varint overflow/);
    bad('TakionMessage', '08 03 3b', /invalid wire type 3/);
    bad('TakionMessage', '08 03 3c', /invalid wire type 4/);
  });
});

describe('takion.proto: what the encoder refuses', () => {
  const refuses = (fn: () => unknown, pattern: RegExp): void => {
    assert.throws(fn, (e: unknown) => e instanceof TakionProtoError && pattern.test(e.message));
  };
  const loose = encodeMessage as (name: string, msg: unknown) => Buffer; // these calls are wrong on purpose

  it('a missing required field, at any depth (nanopb would silently send a zero: pass the zero)', () => {
    refuses(() => loose('TakionMessage', {}), /TakionMessage\.type: required field is missing/);
    refuses(() => loose('TakionMessage', { type: 0, bigPayload: { clientVersion: 9, sessionKey: '', launchSpec: '' } }), /bigPayload\.encryptedKey: required/);
    refuses(() => loose('LogPayload', { messages: [{ timestamp: 0n, level: 0, component: '' }] }), /messages\[0\]\.message: required/);
  });

  it('a property the message does not have (a typo would otherwise go unnoticed: nothing checks types in this repo)', () => {
    refuses(() => loose('TakionMessage', { type: 3, heartbeat: true }), /TakionMessage has no field "heartbeat"/);
    refuses(() => loose('FpsChangePayload', { fps: 1, Fps: 2 }), /no field "Fps"/);
    assert.equal(loose('FpsChangePayload', { fps: 1, Fps: undefined }).toString('hex'), '0801', 'undefined is the same as absent');
  });

  it('values that do not fit the field', () => {
    refuses(() => loose('FpsChangePayload', { fps: -1 }), /fps: expected an integer from 0 to 4294967295/);
    refuses(() => loose('FpsChangePayload', { fps: 0x100000000 }), /fps: expected/);
    refuses(() => loose('FpsChangePayload', { fps: 1.5 }), /fps: expected/);
    refuses(() => loose('FpsChangePayload', { fps: '1' }), /fps: expected/);
    refuses(() => loose('ControllerConnectionPayload', { controllerId: 0x80000000 }), /controllerId: expected a 32 bit signed integer/);
    refuses(() => loose('ControllerConnectionPayload', { connected: 1 }), /connected: expected a boolean/);
    refuses(() => loose('ServerMessagePayload', { payload: Buffer.from('x') }), /payload: expected a string/);
    refuses(() => loose('PeriodicTimestampPayload', { periodicTsInfo: 'x', version: 1 }), /periodicTsInfo: expected a Uint8Array/);
    refuses(() => loose('ConnectionQualityPayload', { loss: -1n }), /loss: expected a 64 bit unsigned integer/);
    refuses(() => loose('ConnectionQualityPayload', { loss: 1n << 64n }), /loss: expected/);
    refuses(() => loose('ConnectionQualityPayload', { rtt: 1n }), /rtt: expected a number/);
    refuses(() => loose('LogMessage', { timestamp: 1n << 63n, level: 0, component: '', message: '' }), /timestamp: expected a 64 bit signed integer/);
    refuses(() => loose('TakionProtocolRequestPayload', { supportedTakionVersions: 9 }), /supportedTakionVersions: expected an array/);
    refuses(() => loose('TakionMessage', { type: 0, bigPayload: 'x' }), /bigPayload: expected a BigPayload object/);
    refuses(() => loose('TakionMessage', null), /expected a TakionMessage object/);
    refuses(() => loose('NoSuchMessage', {}), /unknown message NoSuchMessage/);
    refuses(() => (decodeMessage as (name: string, buf: Uint8Array) => unknown)('NoSuchMessage', Buffer.alloc(0)), /unknown message/);
  });
});

describe('takion.proto: every message survives encoding and decoding', () => {
  const scalar = (type: TakionProtoScalarType, n: number): unknown => {
    switch (type) {
      case 'uint32':
        return n % 2 ? 0xffffffff - n : n * 1000;
      case 'int32':
        return n % 2 ? -n * 100000 : n * 100000;
      case 'int64':
        return -(1n << 40n) - BigInt(n);
      case 'uint64':
        return (1n << 63n) + BigInt(n);
      case 'bool':
        return n % 2 === 0;
      case 'enum':
        return n % 5;
      case 'float':
        return Math.fround(n + 0.25);
      case 'double':
        return n + 0.1;
      case 'string':
        return `s${n}é`;
      case 'bytes':
        return Buffer.from([n & 0xff, 0, 0xff]);
    }
  };

  /** A message with every field set ("full"), or with only what is required ("minimal"). */
  const sample = (name: TakionProtoMessageName, full: boolean, seed = 0): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of TAKION_PROTO_SCHEMAS[name] as readonly TakionProtoField[]) {
      const one = (i: number): unknown =>
        SCALARS.has(f.type) ? scalar(f.type as TakionProtoScalarType, f.number + seed + i) : sample(f.type as TakionProtoMessageName, full, seed + i + 1);
      if (f.label === 'repeated') out[f.name] = full ? [one(0), one(1), one(2)] : [];
      else if (f.label === 'required' || full) out[f.name] = one(0);
    }
    return out;
  };

  for (const name of NAMES) {
    it(name, () => {
      for (const full of [true, false]) {
        const msg = sample(name, full) as unknown as TakionProtoMessages[typeof name];
        const bytes = encodeMessage(name, msg);
        assert.deepEqual(decodeMessage(name, bytes), msg, full ? 'every field' : 'required fields only');
        assert.deepEqual(encodeMessage(name, decodeMessage(name, bytes)), bytes, 'and encodes to the same bytes again');
      }
    });
  }

  it('the envelope with every payload at once is still one consistent message', () => {
    const msg = sample('TakionMessage', true) as unknown as proto.TakionMessage;
    const bytes = encodeTakionMessage(msg);
    assert.equal(Object.keys(msg).length, TAKION_PROTO_SCHEMAS.TakionMessage.length, 'all 31 fields of the envelope are set');
    assert.ok(bytes.length > 0x80, 'long enough that sub-message lengths need two byte varints');
    assert.deepEqual(decodeTakionMessage(bytes), msg);
  });
});

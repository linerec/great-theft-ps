// SPDX-License-Identifier: AGPL-3.0-only
//
// Takion: the UDP transport of a Remote Play stream. It is very similar to SCTP (RFC 4960): a four step handshake
// (INIT, INIT_ACK, COOKIE, COOKIE_ACK), reliable "data" messages that are acknowledged and resent, and unreliable
// audio/video, congestion and feedback packets next to them.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/takion.c and lib/include/chiaki/takion.h
// (commit 43728af). Packet layouts, offsets, constants and the order of steps are transcribed from there; function
// names follow the reference's (chiaki_takion_send_message_data -> sendMessageData, takion_handle_packet ->
// handlePacket, ...) so both can be read side by side.
//
// Datagram layouts (all integers big endian unless noted). The low nibble of the first byte is the packet type.
//   control (type 0):  00 | tag(4) gmac(4) key_pos(4) chunk_type(1) chunk_flags(1) payload_size+4 (2) | payload
//     INIT (1) payload:      tag(4) a_rwnd(4) outbound_streams(2) inbound_streams(2) initial_seq_num(4)
//     INIT_ACK (2) payload:  the same 16 bytes, then a 32 byte cookie
//     COOKIE (0xa) payload:  the cookie.  COOKIE_ACK (0xb): no payload
//     DATA (0) payload:      seq_num(4) channel(2) zero(2) data_type(1) data   (a continuation has no data_type byte)
//     DATA_ACK (3) payload:  cumulative_seq_num(4) a_rwnd(4) gap_ack_blocks_count(2) dup_tsns_count(2)
//   video (2) / audio (3): see avPacketParse() below; gmac at 0xa, key_pos at 0xe
//   congestion (5):        05 | word_0(2) received(2) lost(2) gmac(4) key_pos(4)
//   feedback state (6) / history (1): type | seq_num(2) count-1 (1) key_pos(4) gmac(4) | encrypted payload
//
// Adapted to Node: the reference's receive thread becomes the socket's 'message' events (one event is one iteration of
// the reference's loop), the blocking handshake becomes a promise, and the timeout of the video reorder queue becomes a
// timer. Callbacks run on the event loop, so, unlike in the reference, they may call close() and the send methods.
//
// Differences from the reference, all deliberate:
//  - connect() rejects when the handshake fails; onDisconnect is reported only after a completed handshake (the
//    reference reports DISCONNECT in both cases).
//  - node:dgram cannot set the "don't fragment" flag, so `ipDontFrag` is accepted but has no effect.
//  - A datagram longer than 1500 bytes is ignored (the reference reads into a 1500 byte buffer).
//  - Packet contents and MACs are never written to the log (the reference hex dumps packets with a bad MAC).
//  - Sending feedback or microphone packets without a local cipher is an error (the reference dereferences NULL).
//  - Only what the reference logs at info level or above is passed to `log`.
// What Takion does NOT do, in the reference or here: it does not decrypt audio/video payloads. onAv delivers them still
// encrypted; the stream connection decrypts with `gkcryptRemote.decrypt(packet.keyPos + 16n, packet.data)`.
//
// STATUS: the packet codecs are checked against the reference implementation's own test vectors (test/takion.c: AV
// packet parsing including decryption of a real captured video frame, the congestion packet and its MAC, the send
// buffer, sending after a receive error), the connection against a simulated peer on 127.0.0.1 that is written with
// the same codecs (test/takion.test.ts), which can only show that the pieces agree with each other. It has NOT been
// run against a real console. Secrets: nothing here logs keys, key stream, MACs or packet contents.

import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';

import type { TakionAvPacket } from './av-packet.ts';
import { GKCRYPT_BLOCK_SIZE, GKCRYPT_GMAC_SIZE, KeyState, type GKCrypt } from './gkcrypt.ts';
import { REORDER_QUEUE_DROP_STRATEGY, ReorderQueue } from './reorderqueue.ts';
import { TAKION_SEND_BUFFER_SIZE, TakionSendBuffer, TakionSendBufferError } from './takionsendbuffer.ts';

// ------------------------------------------------------------------ constants

export const TAKION_A_RWND = 0x19000;
export const TAKION_OUTBOUND_STREAMS = 0x64;
export const TAKION_INBOUND_STREAMS = 0x64;

export const TAKION_REORDER_QUEUE_SIZE_EXP = 4; // => 16 entries
export const TAKION_AV_VIDEO_REORDER_QUEUE_SIZE_EXP = 6; // => 64 entries
export const TAKION_AV_REORDER_TIMEOUT_US = 16000; // ~1 frame at 60fps

export const TAKION_POSTPONE_PACKETS_SIZE = 32;
export const TAKION_MESSAGE_HEADER_SIZE = 0x10;
export const TAKION_PACKET_BASE_TYPE_MASK = 0xf;
export const TAKION_EXPECT_TIMEOUT_MS = 5000;
export const TAKION_MAX_CONNECT_RESEND_TRIES = 3;
export const TAKION_COOKIE_SIZE = 0x20;
/** Size of the reference's receive buffer; longer datagrams are ignored here. */
export const TAKION_RECV_BUF_SIZE = 1500;

export const TAKION_CONGESTION_PACKET_SIZE = 0xf;

export const TAKION_V9_AV_HEADER_SIZE_VIDEO = 0x17;
export const TAKION_V9_AV_HEADER_SIZE_AUDIO = 0x12;
export const TAKION_V12_AV_HEADER_SIZE_VIDEO = 0x17;
export const TAKION_V12_AV_HEADER_SIZE_AUDIO = 0x13;
export const TAKION_V7_AV_HEADER_SIZE_BASE = 0x12;
export const TAKION_V7_AV_HEADER_SIZE_VIDEO_ADD = 0x3;
export const TAKION_V7_AV_HEADER_SIZE_NALU_INFO_STRUCTS_ADD = 0x3;

/** Sizes of a formatted feedback state (lib/include/chiaki/feedback.h); the formatting itself is not part of Takion. */
export const FEEDBACK_STATE_BUF_SIZE_V9 = 0x19;
export const FEEDBACK_STATE_BUF_SIZE_V12 = 0x1c;
/** Header of a feedback state or history packet: type, sequence number, count, key position, GMAC. */
export const TAKION_FEEDBACK_HEADER_SIZE = 0xc;

/** ChiakiTakionMessageDataType: the kind of a received data message. */
export const TAKION_MESSAGE_DATA_TYPE = {
  PROTOBUF: 0,
  RUMBLE: 7,
  PAD_INFO: 9,
  TRIGGER_EFFECTS: 11,
} as const;

/** TakionPacketType: base type of Takion packets, the lower nibble of the first byte of a datagram. */
export const TAKION_PACKET_TYPE = {
  CONTROL: 0,
  FEEDBACK_HISTORY: 1,
  VIDEO: 2,
  AUDIO: 3,
  HANDSHAKE: 4,
  CONGESTION: 5,
  FEEDBACK_STATE: 6,
  CLIENT_INFO: 8,
} as const;

/** TakionChunkType */
export const TAKION_CHUNK_TYPE = {
  DATA: 0,
  INIT: 1,
  INIT_ACK: 2,
  DATA_ACK: 3,
  COOKIE: 0xa,
  COOKIE_ACK: 0xb,
} as const;

/** ChiakiDisableAudioVideo: what is dropped right after the transport instead of being handed on. A bit mask. */
export const DISABLE_AUDIO_VIDEO = {
  NONE: 0,
  AUDIO: 1,
  VIDEO: 2,
  AUDIO_VIDEO: 3,
} as const;

/**
 * The reference's error codes that Takion can produce.
 * 'no-crypt' is this port's: a send that needs the local cipher before setCrypt() (the reference would crash).
 */
export type TakionErrorCode =
  | 'invalid-data'
  | 'invalid-response'
  | 'invalid-mac'
  | 'buf-too-small'
  | 'timeout'
  | 'network'
  | 'canceled'
  | 'disconnected'
  | 'overflow'
  | 'no-crypt';

export class TakionError extends Error {
  code: TakionErrorCode;
  constructor(code: TakionErrorCode, message: string) {
    super(message);
    this.name = 'TakionError';
    this.code = code;
  }
}

// ------------------------------------------------------------------ byte helpers

const rd16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const rd32 = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const wr16 = (b: Uint8Array, o: number, v: number): void => {
  b[o] = (v >>> 8) & 0xff;
  b[o + 1] = v & 0xff;
};
const wr32 = (b: Uint8Array, o: number, v: number): void => {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
};
/** The low 32 bits of a key position, which is all a packet carries. */
const low32 = (keyPos: bigint): number => Number(keyPos & 0xffffffffn);
const U64_MAX = (1n << 64n) - 1n;

// ------------------------------------------------------------------ MAC and key position placement

/** takion_packet_type_mac_offset(): the offset of the 4 byte MAC inside a packet of this type, or -1 if unknown. */
export function takionPacketTypeMacOffset(type: number): number {
  switch (type) {
    case TAKION_PACKET_TYPE.CONTROL:
      return 5;
    case TAKION_PACKET_TYPE.VIDEO:
    case TAKION_PACKET_TYPE.AUDIO:
      return 0xa;
    case TAKION_PACKET_TYPE.CONGESTION:
      return 7;
    default:
      return -1;
  }
}

/** takion_packet_type_key_pos_offset(): the offset of the 4 byte key position inside a packet, or -1 if unknown. */
export function takionPacketTypeKeyPosOffset(type: number): number {
  switch (type) {
    case TAKION_PACKET_TYPE.CONTROL:
      return 0x9;
    case TAKION_PACKET_TYPE.VIDEO:
    case TAKION_PACKET_TYPE.AUDIO:
      return 0xe;
    case TAKION_PACKET_TYPE.CONGESTION:
      return 0xb;
    default:
      return -1;
  }
}

/**
 * chiaki_takion_packet_mac(): work out the MAC of a control, video, audio or congestion packet and WRITE IT INTO `buf`.
 * Without a cipher the MAC field is set to zero. For control and congestion packets the key position field counts as
 * zero while the MAC is computed.
 * @returns `mac`: what is now in the packet; `macOld`: what was there before (to compare for a received packet).
 */
export function takionPacketMac(crypt: GKCrypt | null, buf: Uint8Array, keyPos: bigint): { mac: Buffer; macOld: Buffer } {
  if (buf.length < 1) throw new TakionError('buf-too-small', 'empty packet');

  const baseType = buf[0]! & TAKION_PACKET_BASE_TYPE_MASK;
  const macOffset = takionPacketTypeMacOffset(baseType);
  const keyPosOffset = takionPacketTypeKeyPosOffset(baseType);
  if (macOffset < 0 || keyPosOffset < 0) throw new TakionError('invalid-data', `packets of type ${baseType} carry no MAC`);

  if (buf.length < macOffset + GKCRYPT_GMAC_SIZE || buf.length < keyPosOffset + 4) throw new TakionError('buf-too-small', 'packet too short for a MAC');

  const macOld = Buffer.from(buf.subarray(macOffset, macOffset + GKCRYPT_GMAC_SIZE));
  buf.fill(0, macOffset, macOffset + GKCRYPT_GMAC_SIZE);

  if (crypt) {
    const zeroKeyPos = baseType === TAKION_PACKET_TYPE.CONTROL || baseType === TAKION_PACKET_TYPE.CONGESTION;
    let keyPosTmp: Buffer | null = null;
    if (zeroKeyPos) {
      keyPosTmp = Buffer.from(buf.subarray(keyPosOffset, keyPosOffset + 4));
      buf.fill(0, keyPosOffset, keyPosOffset + 4);
    }
    const gmac = crypt.gmac(keyPos, buf);
    buf.set(gmac, macOffset);
    if (keyPosTmp) buf.set(keyPosTmp, keyPosOffset);
  }

  return { mac: Buffer.from(buf.subarray(macOffset, macOffset + GKCRYPT_GMAC_SIZE)), macOld };
}

// ------------------------------------------------------------------ control messages

/** TakionMessage of takion.c: one control packet (a "chunk") after its type byte. */
export interface TakionControlMessage {
  tag: number;
  /** The 4 bytes at offset 8. */
  keyPosLow: number;
  /** The full key position if a key state was given, otherwise the low 32 bits. */
  keyPos: bigint;
  /** One of TAKION_CHUNK_TYPE. */
  chunkType: number;
  chunkFlags: number;
  /** A view into the packet; empty for chunks without a payload. */
  payload: Uint8Array;
}

/**
 * takion_write_message_header(): the 16 byte header of a control message, written at buf[offset..].
 * @param payloadDataSize size of the payload that follows (the size field holds this plus 4)
 */
export function takionWriteMessageHeader(buf: Uint8Array, offset: number, tag: number, keyPos: bigint, chunkType: number, chunkFlags: number, payloadDataSize: number): void {
  wr32(buf, offset + 0, tag >>> 0);
  buf.fill(0, offset + 4, offset + 4 + GKCRYPT_GMAC_SIZE);
  wr32(buf, offset + 8, low32(keyPos));
  buf[offset + 0xc] = chunkType & 0xff;
  buf[offset + 0xd] = chunkFlags & 0xff;
  wr16(buf, offset + 0xe, (payloadDataSize + 4) & 0xffff);
}

/** A whole control datagram: the type byte, the header and the payload. The MAC field is left zero. */
export function takionFormatMessage(tag: number, keyPos: bigint, chunkType: number, chunkFlags: number, payload: Uint8Array): Buffer {
  const buf = Buffer.alloc(1 + TAKION_MESSAGE_HEADER_SIZE + payload.length);
  buf[0] = TAKION_PACKET_TYPE.CONTROL;
  takionWriteMessageHeader(buf, 1, tag, keyPos, chunkType, chunkFlags, payload.length);
  buf.set(payload, 1 + TAKION_MESSAGE_HEADER_SIZE);
  return buf;
}

/**
 * takion_parse_message(): read a control message. `buf` starts AFTER the packet type byte.
 * In the order of the reference: the key position is committed to the key state (if one is given) before the tag and
 * the size are checked.
 * @param check.tagLocal if given, a message with another tag is refused
 * Throws TakionError 'invalid-data'.
 */
export function takionParseMessage(buf: Uint8Array, check: { tagLocal?: number; keyState?: KeyState } = {}): TakionControlMessage {
  if (buf.length < TAKION_MESSAGE_HEADER_SIZE) throw new TakionError('invalid-data', 'Takion message received that is too short');

  const tag = rd32(buf, 0);
  const keyPosLow = rd32(buf, 0x8);
  const keyPos = check.keyState ? check.keyState.requestPos(keyPosLow, true) : BigInt(keyPosLow);
  const chunkType = buf[0xc]!;
  const chunkFlags = buf[0xd]!;
  let payloadSize = rd16(buf, 0xe);

  if (check.tagLocal !== undefined && tag !== check.tagLocal >>> 0) throw new TakionError('invalid-data', 'Takion received message tag mismatch');
  if (buf.length !== payloadSize + 0xc) throw new TakionError('invalid-data', 'Takion received message payload size mismatch');

  payloadSize -= 0x4;
  return { tag, keyPosLow, keyPos, chunkType, chunkFlags, payload: buf.subarray(0x10, 0x10 + payloadSize) };
}

/** TakionMessagePayloadInit */
export interface TakionInitPayload {
  tag: number;
  aRwnd: number;
  outboundStreams: number;
  inboundStreams: number;
  initialSeqNum: number;
}

/** TakionMessagePayloadInitAck */
export interface TakionInitAckPayload extends TakionInitPayload {
  /** 32 bytes. */
  cookie: Uint8Array;
}

function writeInitPayload(pl: Uint8Array, payload: TakionInitPayload): void {
  wr32(pl, 0, payload.tag >>> 0);
  wr32(pl, 4, payload.aRwnd >>> 0);
  wr16(pl, 8, payload.outboundStreams);
  wr16(pl, 0xa, payload.inboundStreams);
  wr32(pl, 0xc, payload.initialSeqNum >>> 0);
}

/** takion_send_message_init(): the INIT datagram. `tagRemote` is still 0 when the client sends it. */
export function takionFormatInit(tagRemote: number, payload: TakionInitPayload): Buffer {
  const pl = new Uint8Array(0x10);
  writeInitPayload(pl, payload);
  return takionFormatMessage(tagRemote, 0n, TAKION_CHUNK_TYPE.INIT, 0, pl);
}

/** The payload of an INIT (what the console reads; not in the reference, used by simulated peers). */
export function takionParseInitPayload(pl: Uint8Array): TakionInitPayload {
  if (pl.length < 0x10) throw new TakionError('buf-too-small', 'INIT payload too short');
  return { tag: rd32(pl, 0), aRwnd: rd32(pl, 4), outboundStreams: rd16(pl, 8), inboundStreams: rd16(pl, 0xa), initialSeqNum: rd32(pl, 0xc) };
}

/** The INIT_ACK datagram (what the console sends; not in the reference, used by simulated peers). */
export function takionFormatInitAck(tag: number, payload: TakionInitAckPayload): Buffer {
  if (payload.cookie.length !== TAKION_COOKIE_SIZE) throw new RangeError(`the cookie must be ${TAKION_COOKIE_SIZE} bytes`);
  const pl = new Uint8Array(0x10 + TAKION_COOKIE_SIZE);
  writeInitPayload(pl, payload);
  pl.set(payload.cookie, 0x10);
  return takionFormatMessage(tag, 0n, TAKION_CHUNK_TYPE.INIT_ACK, 0, pl);
}

/** The payload of an INIT_ACK, as takion_recv_message_init_ack() reads it. */
export function takionParseInitAckPayload(pl: Uint8Array): TakionInitAckPayload {
  if (pl.length < 0x10 + TAKION_COOKIE_SIZE) throw new TakionError('buf-too-small', 'INIT_ACK payload too short');
  return { ...takionParseInitPayload(pl), cookie: Uint8Array.from(pl.subarray(0x10, 0x10 + TAKION_COOKIE_SIZE)) };
}

/** takion_send_message_cookie(): the COOKIE datagram, echoing the cookie of the INIT_ACK. */
export function takionFormatCookie(tagRemote: number, cookie: Uint8Array): Buffer {
  if (cookie.length !== TAKION_COOKIE_SIZE) throw new RangeError(`the cookie must be ${TAKION_COOKIE_SIZE} bytes`);
  return takionFormatMessage(tagRemote, 0n, TAKION_CHUNK_TYPE.COOKIE, 0, cookie);
}

/** The COOKIE_ACK datagram (what the console sends; not in the reference, used by simulated peers). */
export function takionFormatCookieAck(tag: number): Buffer {
  return takionFormatMessage(tag, 0n, TAKION_CHUNK_TYPE.COOKIE_ACK, 0, new Uint8Array(0));
}

/**
 * The datagram of chiaki_takion_send_message_data(): a DATA chunk with the 9 byte data header.
 * The reference always writes 0 (PROTOBUF) as the data type of what it sends; a console also sends 7, 9 and 11.
 */
export function takionFormatData(tag: number, keyPos: bigint, chunkFlags: number, seqNum: number, channel: number, dataType: number, data: Uint8Array): Buffer {
  const buf = Buffer.alloc(1 + TAKION_MESSAGE_HEADER_SIZE + 9 + data.length);
  buf[0] = TAKION_PACKET_TYPE.CONTROL;
  takionWriteMessageHeader(buf, 1, tag, keyPos, TAKION_CHUNK_TYPE.DATA, chunkFlags, 9 + data.length);
  const pl = 1 + TAKION_MESSAGE_HEADER_SIZE;
  wr32(buf, pl + 0, seqNum >>> 0);
  wr16(buf, pl + 4, channel);
  wr16(buf, pl + 6, 0);
  buf[pl + 8] = dataType & 0xff;
  buf.set(data, pl + 9);
  return buf;
}

/** The datagram of chiaki_takion_send_message_data_cont(): a DATA chunk continuing a split message (8 byte header). */
export function takionFormatDataCont(tag: number, keyPos: bigint, chunkFlags: number, seqNum: number, channel: number, data: Uint8Array): Buffer {
  const buf = Buffer.alloc(1 + TAKION_MESSAGE_HEADER_SIZE + 8 + data.length);
  buf[0] = TAKION_PACKET_TYPE.CONTROL;
  takionWriteMessageHeader(buf, 1, tag, keyPos, TAKION_CHUNK_TYPE.DATA, chunkFlags, 8 + data.length);
  const pl = 1 + TAKION_MESSAGE_HEADER_SIZE;
  wr32(buf, pl + 0, seqNum >>> 0);
  wr16(buf, pl + 4, channel);
  wr16(buf, pl + 6, 0);
  buf.set(data, pl + 8);
  return buf;
}

export interface TakionDataPayload {
  seqNum: number;
  channel: number;
  /** The two bytes at offset 6; the reference warns when they are not zero. */
  zeroA: number;
  /** One of TAKION_MESSAGE_DATA_TYPE. */
  dataType: number;
  /** A view into the packet. */
  data: Uint8Array;
}

/** The payload of a DATA chunk with the 9 byte data header. Throws 'buf-too-small' below 9 bytes. */
export function takionParseDataPayload(payload: Uint8Array): TakionDataPayload {
  if (payload.length < 9) throw new TakionError('buf-too-small', 'Takion received data with a size less than the header size');
  return { seqNum: rd32(payload, 0), channel: rd16(payload, 4), zeroA: rd16(payload, 6), dataType: payload[8]!, data: payload.subarray(9) };
}

/** The datagram of chiaki_takion_send_message_data_ack(): acknowledges everything up to `seqNum`. */
export function takionFormatDataAck(tag: number, keyPos: bigint, seqNum: number, aRwnd: number): Buffer {
  const buf = Buffer.alloc(1 + TAKION_MESSAGE_HEADER_SIZE + 0xc);
  buf[0] = TAKION_PACKET_TYPE.CONTROL;
  takionWriteMessageHeader(buf, 1, tag, keyPos, TAKION_CHUNK_TYPE.DATA_ACK, 0, 0xc);
  const pl = 1 + TAKION_MESSAGE_HEADER_SIZE;
  wr32(buf, pl + 0, seqNum >>> 0);
  wr32(buf, pl + 4, aRwnd >>> 0);
  wr16(buf, pl + 8, 0); // gap_ack_blocks_count
  wr16(buf, pl + 0xa, 0); // dup_tsns_count
  return buf;
}

export interface TakionDataAck {
  cumulativeSeqNum: number;
  aRwnd: number;
  gapAckBlocksCount: number;
  dupTsnsCount: number;
}

/** The payload of a DATA_ACK chunk, which must be exactly 12 bytes (the reference accepts no gap blocks). */
export function takionParseDataAckPayload(payload: Uint8Array): TakionDataAck {
  if (payload.length !== 0xc) throw new TakionError('invalid-data', `Takion received data ack with size 0x${payload.length.toString(16)} != 0xc`);
  return { cumulativeSeqNum: rd32(payload, 0), aRwnd: rd32(payload, 4), gapAckBlocksCount: rd16(payload, 8), dupTsnsCount: rd16(payload, 0xa) };
}

// ------------------------------------------------------------------ congestion and feedback packets

/** ChiakiTakionCongestionPacket */
export interface TakionCongestionPacket {
  word0: number;
  received: number;
  lost: number;
}

/** chiaki_takion_format_congestion(): the 15 byte congestion packet, MAC field zero. */
export function takionFormatCongestion(packet: TakionCongestionPacket, keyPos: bigint): Buffer {
  const buf = Buffer.alloc(TAKION_CONGESTION_PACKET_SIZE);
  buf[0] = TAKION_PACKET_TYPE.CONGESTION;
  wr16(buf, 1, packet.word0);
  wr16(buf, 3, packet.received);
  wr16(buf, 5, packet.lost);
  wr32(buf, 7, 0);
  wr32(buf, 0xb, low32(keyPos));
  return buf;
}

/**
 * The feedback state packet of chiaki_takion_send_feedback_state() before it is encrypted: a 12 byte header and the
 * formatted state (0x19 bytes for protocol versions up to 9, 0x1c bytes after).
 */
export function takionFormatFeedbackState(seqNum: number, state: Uint8Array): Buffer {
  const buf = Buffer.alloc(TAKION_FEEDBACK_HEADER_SIZE + state.length);
  buf[0] = TAKION_PACKET_TYPE.FEEDBACK_STATE;
  wr16(buf, 1, seqNum);
  buf[3] = 0; // number of states in the packet less one
  // 4: key pos, 8: gmac, both filled in by takionFeedbackPacketCrypt()
  buf.set(state, TAKION_FEEDBACK_HEADER_SIZE);
  return buf;
}

/** The feedback history packet of chiaki_takion_send_feedback_history() before it is encrypted. */
export function takionFormatFeedbackHistory(seqNum: number, eventCount: number, payload: Uint8Array): Buffer {
  const buf = Buffer.alloc(TAKION_FEEDBACK_HEADER_SIZE + payload.length);
  buf[0] = TAKION_PACKET_TYPE.FEEDBACK_HISTORY;
  wr16(buf, 1, seqNum);
  // number of events in the payload less one: the console adds one back, so the full count
  // would make it read past the payload and reject the packet
  buf[3] = eventCount ? (eventCount - 1) & 0xff : 0;
  buf.set(payload, TAKION_FEEDBACK_HEADER_SIZE);
  return buf;
}

/**
 * The cipher steps of takion_send_feedback_packet(), in place: encrypt the payload (everything after the 12 byte
 * header) at keyPos + 16, write the key position at offset 4, then the GMAC of the whole packet at offset 8.
 */
export function takionFeedbackPacketCrypt(crypt: GKCrypt, buf: Uint8Array, keyPos: bigint): void {
  if (buf.length < TAKION_FEEDBACK_HEADER_SIZE) throw new TakionError('buf-too-small', 'feedback packet too short');
  crypt.encrypt(keyPos + BigInt(GKCRYPT_BLOCK_SIZE), buf.subarray(TAKION_FEEDBACK_HEADER_SIZE));
  wr32(buf, 4, low32(keyPos));
  buf.set(crypt.gmac(keyPos, buf), 8);
}

// ------------------------------------------------------------------ audio/video packets

/** ChiakiTakionAVPacketParse */
export type TakionAvPacketParse = (keyState: KeyState, buf: Uint8Array) => TakionAvPacket;

const emptyAvPacket = (): TakionAvPacket => ({
  packetIndex: 0,
  frameIndex: 0,
  usesNaluInfoStructs: false,
  isVideo: false,
  isHaptics: false,
  unitIndex: 0,
  unitsInFrameTotal: 0,
  unitsInFrameFec: 0,
  codec: 0,
  wordAt0x18: 0,
  adaptiveStreamIndex: 0,
  byteAt0x2c: 0,
  keyPos: 0n,
  data: new Uint8Array(0),
});

/** av_packet_parse(): protocol versions 9 and 12. `buf` is the whole datagram. The key state is committed. */
function avPacketParse(v12: boolean, keyState: KeyState, buf: Uint8Array): TakionAvPacket {
  const packet = emptyAvPacket();

  if (buf.length < 1) throw new TakionError('buf-too-small', 'empty AV packet');

  const baseType = buf[0]! & TAKION_PACKET_BASE_TYPE_MASK;

  if (baseType !== TAKION_PACKET_TYPE.VIDEO && baseType !== TAKION_PACKET_TYPE.AUDIO) throw new TakionError('invalid-data', 'not an AV packet');

  packet.isVideo = baseType === TAKION_PACKET_TYPE.VIDEO;

  packet.usesNaluInfoStructs = ((buf[0]! >> 4) & 1) !== 0;

  let av = 1; // offset of the AV header in buf
  let avSize = buf.length - 1;
  const avHeaderSize = v12
    ? packet.isVideo
      ? TAKION_V12_AV_HEADER_SIZE_VIDEO
      : TAKION_V12_AV_HEADER_SIZE_AUDIO
    : packet.isVideo
      ? TAKION_V9_AV_HEADER_SIZE_VIDEO
      : TAKION_V9_AV_HEADER_SIZE_AUDIO;
  if (avSize < avHeaderSize + 1) throw new TakionError('buf-too-small', 'AV packet shorter than its header');

  packet.packetIndex = rd16(buf, av + 0);
  packet.frameIndex = rd16(buf, av + 2);

  const dword2 = rd32(buf, av + 4);
  if (packet.isVideo) {
    packet.unitIndex = (dword2 >>> 0x15) & 0x7ff;
    packet.unitsInFrameTotal = ((dword2 >>> 0xa) & 0x7ff) + 1;
    packet.unitsInFrameFec = dword2 & 0x3ff;
  } else {
    packet.unitIndex = (dword2 >>> 0x18) & 0xff;
    packet.unitsInFrameTotal = ((dword2 >>> 0x10) & 0xff) + 1;
    packet.unitsInFrameFec = dword2 & 0xffff;
  }

  packet.codec = buf[av + 8]!;
  // av + 9: the 4 byte GMAC
  const keyPosLow = rd32(buf, av + 0xd);
  packet.keyPos = keyState.requestPos(keyPosLow, true);

  // av + 0x11: one unknown byte

  av += 0x11;
  avSize -= 0x11;

  if (packet.isVideo) {
    packet.wordAt0x18 = rd16(buf, av + 0);
    packet.adaptiveStreamIndex = buf[av + 2]! >> 5;
    av += 3;
    avSize -= 3;
  } else {
    av += 1;
    avSize -= 1;
    // unknown
  }

  if (packet.isVideo) packet.byteAt0x2c = buf[av]!;

  if (packet.usesNaluInfoStructs) {
    av += 3;
    avSize -= 3;
  }

  if (v12 && !packet.isVideo) {
    // The reference reads this byte without checking that it exists (an audio packet with the NALU flag set can be
    // that short); here such a packet is refused.
    if (avSize < 1) throw new TakionError('buf-too-small', 'AV packet shorter than its header');
    packet.isHaptics = buf[av] === 0x02;
    av += 1;
    avSize -= 1;
  }

  if (avSize < 0) throw new TakionError('buf-too-small', 'AV packet shorter than its header'); // size_t underflow in the reference
  packet.data = buf.subarray(av, av + avSize);

  return packet;
}

/** chiaki_takion_v9_av_packet_parse(). Throws TakionError 'buf-too-small' or 'invalid-data'. */
export function takionV9AvPacketParse(keyState: KeyState, buf: Uint8Array): TakionAvPacket {
  return avPacketParse(false, keyState, buf);
}

/** chiaki_takion_v12_av_packet_parse(). Throws TakionError 'buf-too-small' or 'invalid-data'. */
export function takionV12AvPacketParse(keyState: KeyState, buf: Uint8Array): TakionAvPacket {
  return avPacketParse(true, keyState, buf);
}

/** The header fields chiaki_takion_v7_av_packet_format_header() reads. */
export type TakionV7AvPacketHeader = Pick<
  TakionAvPacket,
  'isVideo' | 'usesNaluInfoStructs' | 'packetIndex' | 'frameIndex' | 'unitIndex' | 'unitsInFrameTotal' | 'unitsInFrameFec' | 'codec' | 'keyPos' | 'wordAt0x18' | 'adaptiveStreamIndex'
>;

/**
 * chiaki_takion_v7_av_packet_format_header(): write the header of a version 7 AV packet at the start of `buf`.
 * As in the reference, the key position is written in the HOST's byte order (little endian on every machine this runs
 * on) although the parser reads it big endian; the reference only ever formats packets with key position 0.
 * @returns the size of the header. Throws 'buf-too-small' if `buf` cannot hold it.
 */
export function takionV7AvPacketFormatHeader(buf: Uint8Array, packet: TakionV7AvPacketHeader): number {
  let headerSize = TAKION_V7_AV_HEADER_SIZE_BASE;
  if (packet.isVideo) headerSize += TAKION_V7_AV_HEADER_SIZE_VIDEO_ADD;
  if (packet.usesNaluInfoStructs) headerSize += TAKION_V7_AV_HEADER_SIZE_NALU_INFO_STRUCTS_ADD;

  if (headerSize > buf.length) throw new TakionError('buf-too-small', 'buffer too small for a version 7 AV header');

  buf[0] = packet.isVideo ? TAKION_PACKET_TYPE.VIDEO : TAKION_PACKET_TYPE.AUDIO;
  if (packet.usesNaluInfoStructs) buf[0] |= 0x10;

  wr16(buf, 1, packet.packetIndex);
  wr16(buf, 3, packet.frameIndex);

  wr32(buf, 5, ((packet.unitsInFrameFec & 0x3ff) | (((packet.unitsInFrameTotal - 1) & 0x7ff) << 0xa) | ((packet.unitIndex & 0xffff) << 0x15)) >>> 0);

  buf[9] = packet.codec & 0xff;

  wr32(buf, 0xa, 0); // unknown

  const keyPosLow = low32(packet.keyPos); // host byte order in the reference: little endian
  buf[0xe] = keyPosLow & 0xff;
  buf[0xf] = (keyPosLow >>> 8) & 0xff;
  buf[0x10] = (keyPosLow >>> 16) & 0xff;
  buf[0x11] = (keyPosLow >>> 24) & 0xff;

  let cur = 0x12;
  if (packet.isVideo) {
    wr16(buf, cur, packet.wordAt0x18);
    buf[cur + 2] = (packet.adaptiveStreamIndex << 5) & 0xff;
    cur += 3;
  }

  if (packet.usesNaluInfoStructs) {
    wr16(buf, cur, 0); // unknown
    buf[cur + 2] = 0; // unknown
  }

  return headerSize;
}

/**
 * chiaki_takion_v7_av_packet_parse(). Version 7 packets (used by the Senkusha connection test) carry the key position
 * as it is: the key state is not used, the parameter exists so that the three parsers have the same signature.
 */
export function takionV7AvPacketParse(_keyState: KeyState | null, buf: Uint8Array): TakionAvPacket {
  const packet = emptyAvPacket();

  if (buf.length < 1) throw new TakionError('buf-too-small', 'empty AV packet');

  const baseType = buf[0]! & TAKION_PACKET_BASE_TYPE_MASK;

  if (baseType !== TAKION_PACKET_TYPE.VIDEO && baseType !== TAKION_PACKET_TYPE.AUDIO) throw new TakionError('invalid-data', 'not an AV packet');

  packet.isVideo = baseType === TAKION_PACKET_TYPE.VIDEO;
  packet.usesNaluInfoStructs = ((buf[0]! >> 4) & 1) !== 0;

  let headerSize = TAKION_V7_AV_HEADER_SIZE_BASE;
  if (packet.isVideo) headerSize += TAKION_V7_AV_HEADER_SIZE_VIDEO_ADD;
  if (packet.usesNaluInfoStructs) headerSize += TAKION_V7_AV_HEADER_SIZE_NALU_INFO_STRUCTS_ADD;

  if (buf.length < headerSize) throw new TakionError('buf-too-small', 'AV packet shorter than its header');

  packet.packetIndex = rd16(buf, 1);
  packet.frameIndex = rd16(buf, 3);

  const dword2 = rd32(buf, 5);
  packet.unitIndex = (dword2 >>> 0x15) & 0x7ff;
  packet.unitsInFrameTotal = ((dword2 >>> 0xa) & 0x7ff) + 1;
  packet.unitsInFrameFec = dword2 & 0x3ff;

  packet.codec = buf[9]!;
  // unknown: the 4 bytes at 0xa
  packet.keyPos = BigInt(rd32(buf, 0xe));

  let off = 0x12;

  if (packet.isVideo) {
    packet.wordAt0x18 = rd16(buf, off + 0);
    packet.adaptiveStreamIndex = buf[off + 2]! >> 5;
    off += 3;
  }

  if (packet.usesNaluInfoStructs) {
    off += 3;
    // unknown
  }

  packet.data = buf.subarray(off);

  return packet;
}

// ------------------------------------------------------------------ the connection

/** ChiakiTakionConnectInfo */
export interface TakionConnectInfo {
  /** The console's address (IPv4 or IPv6 literal, or a name). */
  host: string;
  /** 9296 for the stream, 9297 for the Senkusha connection test. */
  port: number;
  /**
   * info->protocol_version: 7 (Senkusha), 9 (PS4) or 12 (PS5). Selects the AV packet layout and the size of a feedback
   * state.
   */
  protocolVersion: number;
  /**
   * Whether encryption should be used. If false, encryption and MACs are disabled completely. If true, they are used
   * once setCrypt() was called; until then only control packets are handed on and audio/video packets are kept back
   * (up to 32) so that eventually every MAC is checked.
   */
  enableCrypt: boolean;
  /** info->ip_dontfrag, the reference's MTU related switch. node:dgram cannot set it: accepted, logged, no effect. */
  ipDontFrag?: boolean;
  /** One of DISABLE_AUDIO_VIDEO: packets of that kind are dropped instead of being reported. Default NONE. */
  disableAudioVideo?: number;
  /** Kept for the layers above, as in the reference; Takion itself does not use it. */
  enableDualsense?: boolean;
  /**
   * An existing socket to use (the reference's `sock` argument, for connections set up by hole punching). Datagrams
   * already waiting on it are discarded first (for up to one second). If it is not connected yet it is connected to
   * host:port.
   */
  socket?: dgram.Socket;
  /** Close the socket when Takion finishes. Default: true for a socket Takion created, false for one passed in. */
  closeSocket?: boolean;
  /** Progress lines (info level and above). Never contains keys, MACs or packet contents. */
  log?: (line: string) => void;
  /** How long to wait for each handshake answer. Default 5000. Changed only by tests. */
  expectTimeoutMs?: number;
}

/**
 * What Takion reports (ChiakiTakionEvent). Set these before calling connect(): a message can arrive before the code
 * after `await connect()` runs. The callbacks run on the event loop and may call the send methods and close().
 */
export interface TakionEvents {
  /** CHIAKI_TAKION_EVENT_TYPE_CONNECTED: the handshake is complete (connect() resolves right after). */
  onConnected?: () => void;
  /**
   * CHIAKI_TAKION_EVENT_TYPE_DISCONNECT: the connection ended after it had been established: close() was called (no
   * reason), or receiving failed (reason). Called exactly once. A failed handshake rejects connect() instead.
   */
  onDisconnect?: (reason?: TakionError) => void;
  /**
   * CHIAKI_TAKION_EVENT_TYPE_DATA: a reliable message, in order and exactly once.
   * @param dataType one of TAKION_MESSAGE_DATA_TYPE (0 = protobuf: decode with takion-proto.ts)
   * @param payload a view into the datagram: copy it if it must outlive the callback
   */
  onData?: (dataType: number, payload: Uint8Array) => void;
  /** CHIAKI_TAKION_EVENT_TYPE_DATA_ACK: the console acknowledged the reliable message sent with this sequence number. */
  onDataAck?: (seqNum: number) => void;
  /**
   * CHIAKI_TAKION_EVENT_TYPE_AV: an audio or video packet whose MAC was checked (when crypt is set). Its payload is
   * still encrypted: decrypt in place with `gkcryptRemote.decrypt(packet.keyPos + 16n, packet.data)`.
   * Video packets come in the order of their packet index (a missing one is skipped after 16 ms); audio as it arrives.
   */
  onAv?: (packet: TakionAvPacket) => void;
}

/** TakionDataPacketEntry */
interface DataPacketEntry {
  packetBuf: Uint8Array;
  typeB: number;
  payload: Uint8Array; // inside packetBuf
  channel: number;
}

/** TakionAVPacketEntry */
interface AvPacketEntry {
  baseType: number;
  buf: Uint8Array;
  packet: TakionAvPacket;
}

interface RxWaiter {
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
}

type TakionState = 'idle' | 'handshake' | 'connected' | 'closed';

/** ChiakiTakion: one Takion connection. Use once: construct, connect(), ..., close(). */
export class Takion {
  events: TakionEvents;
  /** Takion protocol version: 7, 9 or 12. */
  version: number;
  disableAudioVideo: number;
  enableCrypt: boolean;
  enableDualsense: boolean;
  closeSocket: boolean;

  /** If null (default), no GMAC is calculated and nothing is encrypted. */
  gkcryptLocal: GKCrypt | null;
  /** Key position of the next packet this side sends. */
  keyPosLocal: bigint;
  /** If null (default), remote GMACs are IGNORED (!) and everything is expected to be unencrypted. */
  gkcryptRemote: GKCrypt | null;

  /** The UDP socket. Stays open after the connection ended if closeSocket is false: then closing it is the caller's job. */
  sock: dgram.Socket | null;
  tagLocal: number;
  tagRemote: number;
  /** Sequence number of the next reliable message this side sends. */
  seqNumLocal: number;
  /** Advertised Receiver Window Credit */
  aRwnd: number;
  /** High part of the key position of what the console sends. */
  keyState: KeyState;
  /** send_buffer only exists from the end of the handshake until receiving ends. */
  sendBuffer: TakionSendBuffer | null;
  sendBufferActive: boolean;

  private state: TakionState;
  private log: (line: string) => void;
  private expectTimeoutMs: number;
  private avPacketParse: TakionAvPacketParse;
  private sockClosed: boolean;
  private rxQueue: Buffer[];
  private rxWaiter: RxWaiter | null;
  private dataQueue: ReorderQueue<DataPacketEntry> | null;
  private videoQueue: ReorderQueue<AvPacketEntry> | null;
  private videoQueueHeadWaitStartUs: number;
  private videoQueueHeadWaitSeqNum: number;
  private postponedPackets: Uint8Array[] | null;
  private cryptAvailable: boolean;
  private loopDepth: number;
  private avTimer: ReturnType<typeof setTimeout> | null;
  private closedPromise: Promise<void>;
  private resolveClosed: () => void;
  private readonly onMessage: (msg: Buffer) => void;
  private readonly onSocketError: (err: Error) => void;

  constructor(events: TakionEvents = {}) {
    this.events = events;
    this.version = 0;
    this.disableAudioVideo = DISABLE_AUDIO_VIDEO.NONE;
    this.enableCrypt = false;
    this.enableDualsense = false;
    this.closeSocket = true;
    this.gkcryptLocal = null;
    this.keyPosLocal = 0n;
    this.gkcryptRemote = null;
    this.sock = null;
    this.tagLocal = 0;
    this.tagRemote = 0;
    this.seqNumLocal = 0;
    this.aRwnd = TAKION_A_RWND;
    // The reference never calls chiaki_key_state_init() on takion->key_state; it relies on the struct being zeroed.
    this.keyState = new KeyState();
    this.sendBuffer = null;
    this.sendBufferActive = false;

    this.state = 'idle';
    this.log = () => {};
    this.expectTimeoutMs = TAKION_EXPECT_TIMEOUT_MS;
    this.avPacketParse = takionV12AvPacketParse;
    this.sockClosed = false;
    this.rxQueue = [];
    this.rxWaiter = null;
    this.dataQueue = null;
    this.videoQueue = null;
    this.videoQueueHeadWaitStartUs = 0;
    this.videoQueueHeadWaitSeqNum = 0;
    this.postponedPackets = null;
    this.cryptAvailable = false;
    this.loopDepth = 0;
    this.avTimer = null;
    this.resolveClosed = () => {};
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });

    this.onMessage = (msg: Buffer): void => {
      if (this.state === 'handshake') {
        if (this.rxWaiter) this.rxWaiter.resolve(msg);
        else this.rxQueue.push(msg);
      } else if (this.state === 'connected') {
        this.loopIteration(() => this.handleDatagram(msg));
      }
    };
    this.onSocketError = (err: Error): void => {
      if (this.state !== 'handshake' && this.state !== 'connected') return;
      const code = (err as { code?: string }).code;
      this.log(`Takion recv failed: ${code ?? err.message}`);
      this.teardown(new TakionError('network', `Takion socket error: ${code ?? err.message}`));
    };
  }

  /** True from the end of the handshake until the connection ends. */
  get connected(): boolean {
    return this.state === 'connected';
  }

  // ---------------------------------------------------------------- connect and close

  /**
   * chiaki_takion_connect(): open the socket and run the handshake. Resolves when the connection is established (the
   * reference's CONNECTED event; onConnected is called just before). Rejects with a TakionError if the handshake fails
   * ('timeout', 'invalid-response', 'network', or 'canceled' when close() was called meanwhile); the socket is then
   * closed like after a disconnect.
   */
  async connect(info: TakionConnectInfo): Promise<void> {
    if (this.state !== 'idle') throw new Error('Takion.connect() can be called only once');

    this.log = info.log ?? (() => {});
    this.closeSocket = info.closeSocket ?? info.socket === undefined;
    this.version = info.protocolVersion;
    this.disableAudioVideo = info.disableAudioVideo ?? DISABLE_AUDIO_VIDEO.NONE;
    this.expectTimeoutMs = info.expectTimeoutMs ?? TAKION_EXPECT_TIMEOUT_MS;

    switch (this.version) {
      case 7:
        this.avPacketParse = takionV7AvPacketParse;
        break;
      case 9:
        this.avPacketParse = takionV9AvPacketParse;
        break;
      case 12:
        this.avPacketParse = takionV12AvPacketParse;
        break;
      default:
        this.state = 'closed';
        this.resolveClosed();
        throw new TakionError('invalid-data', `Unknown Takion Protocol Version ${this.version}`);
    }

    this.gkcryptLocal = null;
    this.keyPosLocal = 0n;
    this.gkcryptRemote = null;
    this.aRwnd = TAKION_A_RWND;

    this.tagLocal = randomBytes(4).readUInt32BE(0);
    this.seqNumLocal = this.tagLocal;
    this.tagRemote = 0;

    this.sendBufferActive = false;

    this.enableCrypt = info.enableCrypt;
    this.postponedPackets = null;
    this.enableDualsense = info.enableDualsense ?? false;

    this.log(`Takion connecting (version ${this.version})`);

    this.state = 'handshake';
    try {
      await this.openSocket(info);
      this.checkHandshaking();

      const seqNumRemoteInitial = await this.handshake();
      this.checkHandshaking();

      this.dataQueue = ReorderQueue.init32<DataPacketEntry>(TAKION_REORDER_QUEUE_SIZE_EXP, seqNumRemoteInitial);
      this.dataQueue.setDropCb((seqNum) => this.log(`Takion dropping data with seq num 0x${seqNum.toString(16)}`));

      // The send buffer size MUST be consistent with what a data ack can acknowledge at once
      this.sendBuffer = new TakionSendBuffer(
        (buf) => {
          try {
            this.sendRaw(buf);
          } catch {
            // the socket went away; the reference ignores the result of a resend too
          }
        },
        TAKION_SEND_BUFFER_SIZE,
        { log: this.log },
      );
      this.sendBufferActive = true;
      this.state = 'connected';
    } catch (e) {
      this.teardown(e instanceof TakionError ? e : new TakionError('network', (e as Error).message));
      throw e;
    }

    this.loopDepth++;
    try {
      this.events.onConnected?.();
    } finally {
      this.loopDepth--;
    }

    this.cryptAvailable = this.gkcryptRemote !== null;

    // What arrived during the handshake without being part of it is what the receive loop finds first.
    this.loopIteration(() => {});
    while (this.state === 'connected' && this.rxQueue.length) {
      const msg = this.rxQueue.shift()!;
      this.loopIteration(() => this.handleDatagram(msg));
    }
  }

  /**
   * chiaki_takion_close(): stop receiving. If the connection was established, onDisconnect is called (as the reference
   * does when its receive thread ends). The socket is closed if closeSocket is set.
   * @returns a promise that resolves when the socket is closed (at once if it is left open)
   */
  close(): Promise<void> {
    this.teardown(null);
    return this.closedPromise;
  }

  /**
   * chiaki_takion_set_crypt(): from now on outgoing packets get a MAC from `gkcryptLocal` and incoming ones are checked
   * against `gkcryptRemote`. Call it from the onData callback that handles the console's BANG, as the reference does:
   * the packets that were kept back until now are then checked and handed on right after that callback returns.
   */
  setCrypt(gkcryptLocal: GKCrypt | null, gkcryptRemote: GKCrypt | null): void {
    this.gkcryptLocal = gkcryptLocal;
    this.gkcryptRemote = gkcryptRemote;
    if (this.state === 'connected' && this.loopDepth === 0) this.loopIteration(() => {});
  }

  private checkHandshaking(): void {
    if (this.state !== 'handshake') throw new TakionError('canceled', 'Takion was closed during the handshake');
  }

  private async openSocket(info: TakionConnectInfo): Promise<void> {
    if (info.socket) {
      const sock = info.socket;
      this.sock = sock;
      sock.on('message', this.onMessage);
      sock.on('error', this.onSocketError);
      await this.readExtraSockMessages();
      this.checkHandshaking();
      let isConnected = true;
      try {
        sock.remoteAddress();
      } catch {
        isConnected = false;
      }
      if (!isConnected) await this.connectSocket(sock, info); // also binds it if it was not bound
      try {
        sock.setRecvBufferSize(this.aRwnd);
      } catch (e) {
        throw new TakionError('network', `Takion failed to setsockopt SO_RCVBUF: ${(e as Error).message}`);
      }
    } else {
      const sock = dgram.createSocket({ type: net.isIP(info.host) === 6 ? 'udp6' : 'udp4', recvBufferSize: this.aRwnd });
      this.sock = sock;
      sock.on('message', this.onMessage);
      sock.on('error', this.onSocketError);
      await this.connectSocket(sock, info);
    }
    if (info.ipDontFrag) this.log("Don't fragment is not supported on this platform, MTU values may be incorrect.");
  }

  private connectSocket(sock: dgram.Socket, info: TakionConnectInfo): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const fail = (err: Error): void => reject(new TakionError('network', `Takion failed to connect: ${(err as { code?: string }).code ?? err.message}`));
      try {
        // node calls back without an argument once connected, or with the error (a failed lookup, for instance)
        sock.connect(info.port, info.host, (err?: Error) => {
          if (err) fail(err);
          else resolve();
        });
      } catch (e) {
        fail(e as Error);
      }
    });
  }

  /** takion_read_extra_sock_messages(): throw away what is already waiting on a socket that was passed in. */
  private async readExtraSockMessages(): Promise<void> {
    // Stop trying after 1s
    const expired = performance.now() + 1000;
    for (;;) {
      if (performance.now() > expired) return;
      try {
        await this.recvRaw(200);
      } catch (e) {
        if (e instanceof TakionError && e.code === 'timeout') return;
        throw e;
      }
    }
  }

  /** One datagram, or a TakionError: 'timeout', 'canceled' (closed meanwhile) or 'network'. */
  private recvRaw(timeoutMs: number): Promise<Buffer> {
    if (this.state !== 'handshake') return Promise.reject(new TakionError('canceled', 'Takion was closed'));
    const queued = this.rxQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rxWaiter = null;
        reject(new TakionError('timeout', 'Takion timed out waiting for a packet'));
      }, timeoutMs);
      this.rxWaiter = {
        resolve: (buf) => {
          clearTimeout(timer);
          this.rxWaiter = null;
          resolve(buf);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.rxWaiter = null;
          reject(err);
        },
      };
    });
  }

  /** takion_recv(): like recvRaw, but an empty datagram is a network error (recv() returning 0 in the reference). */
  private async recv(timeoutMs: number): Promise<Buffer> {
    const buf = await this.recvRaw(timeoutMs);
    if (buf.length === 0) throw new TakionError('network', 'Takion recv returned 0');
    return buf;
  }

  private sendRawAsync(buf: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = this.sock;
      if (!sock || this.sockClosed) {
        reject(new TakionError('network', 'Takion failed to send raw: the socket is closed'));
        return;
      }
      try {
        sock.send(buf, (err) => {
          if (err) reject(new TakionError('network', `Takion failed to send raw: ${(err as { code?: string }).code ?? err.message}`));
          else resolve();
        });
      } catch (e) {
        reject(new TakionError('network', `Takion failed to send raw: ${(e as Error).message}`));
      }
    });
  }

  /** takion_handshake(). @returns the sequence number of the first data message the console will send */
  private async handshake(): Promise<number> {
    // INIT ->

    const initPayload: TakionInitPayload = {
      tag: this.tagLocal,
      aRwnd: TAKION_A_RWND,
      outboundStreams: TAKION_OUTBOUND_STREAMS,
      inboundStreams: TAKION_INBOUND_STREAMS,
      initialSeqNum: this.seqNumLocal,
    };
    let initAckPayload: TakionInitAckPayload | null = null;
    let err: unknown = null;
    for (let tries = 0; tries < TAKION_MAX_CONNECT_RESEND_TRIES; tries++) {
      if (tries > 0) this.log(`Takion hasn't received init ack yet, retrying init [attempt ${tries + 1}] ...`);
      await this.sendRawAsync(takionFormatInit(this.tagRemote, initPayload));
      this.checkHandshaking();

      this.log('Takion sent init');

      // INIT_ACK <-
      try {
        initAckPayload = await this.recvMessageInitAck();
        err = null;
        break;
      } catch (e) {
        if (this.state !== 'handshake') throw e; // closed, or the socket failed
        err = e;
      }
    }
    if (err !== null || initAckPayload === null) {
      this.log('Takion failed to receive init ack');
      throw err ?? new TakionError('invalid-response', 'Takion failed to receive init ack');
    }

    if (initAckPayload.tag === 0) {
      this.log('Takion remote tag in init ack is 0');
      throw new TakionError('invalid-response', 'Takion remote tag in init ack is 0');
    }

    this.log(
      `Takion received init ack with remote tag 0x${initAckPayload.tag.toString(16)}, outbound streams: 0x${initAckPayload.outboundStreams.toString(16)}, inbound streams: 0x${initAckPayload.inboundStreams.toString(16)}`,
    );

    this.tagRemote = initAckPayload.tag;
    // The reference starts the incoming sequence at the remote tag, not at init_ack_payload.initial_seq_num.
    const seqNumRemoteInitial = this.tagRemote;

    if (
      initAckPayload.outboundStreams === 0 ||
      initAckPayload.inboundStreams === 0 ||
      initAckPayload.outboundStreams > TAKION_INBOUND_STREAMS ||
      initAckPayload.inboundStreams < TAKION_OUTBOUND_STREAMS
    ) {
      this.log('Takion min/max check failed');
      throw new TakionError('invalid-response', 'Takion min/max check failed');
    }

    // COOKIE ->
    err = null;
    let done = false;
    for (let tries = 0; tries < TAKION_MAX_CONNECT_RESEND_TRIES; tries++) {
      if (tries > 0) this.log(`Takion hasn't received cookie ack yet, resending cookie [attempt ${tries + 1}] ...`);
      await this.sendRawAsync(takionFormatCookie(this.tagRemote, initAckPayload.cookie));
      this.checkHandshaking();

      this.log('Takion sent cookie');

      // COOKIE_ACK <-
      try {
        await this.recvMessageCookieAck();
        err = null;
        done = true;
        break;
      } catch (e) {
        if (this.state !== 'handshake') throw e;
        err = e;
      }
    }
    if (!done) {
      this.log('Takion failed to receive cookie ack');
      throw err ?? new TakionError('invalid-response', 'Takion failed to receive cookie ack');
    }

    this.log('Takion received cookie ack');

    // done!

    this.log('Takion connected');

    return seqNumRemoteInitial;
  }

  /** takion_recv_message_init_ack() */
  private async recvMessageInitAck(): Promise<TakionInitAckPayload> {
    const expected = 1 + TAKION_MESSAGE_HEADER_SIZE + 0x10 + TAKION_COOKIE_SIZE;
    const message = await this.recv(this.expectTimeoutMs);

    if (message.length < expected) {
      throw new TakionError('invalid-response', `Takion received packet of size ${message.length} while expecting init ack packet of exactly ${expected}`);
    }

    if (message[0] !== TAKION_PACKET_TYPE.CONTROL) {
      throw new TakionError('invalid-response', `Takion received packet of type 0x${message[0]!.toString(16)} while expecting init ack message`);
    }

    let msg: TakionControlMessage;
    try {
      msg = takionParseMessage(message.subarray(1), { tagLocal: this.tagLocal, keyState: this.keyState });
    } catch {
      throw new TakionError('invalid-response', 'Failed to parse message while expecting init ack');
    }

    if (msg.chunkType !== TAKION_CHUNK_TYPE.INIT_ACK || msg.chunkFlags !== 0x0) {
      throw new TakionError('invalid-response', `Takion received unexpected message with type (0x${msg.chunkType.toString(16)}, 0x${msg.chunkFlags.toString(16)}) while expecting init ack`);
    }

    // The reference reads into a buffer of exactly this size and asserts.
    if (msg.payload.length !== 0x10 + TAKION_COOKIE_SIZE) throw new TakionError('invalid-response', 'Takion received an init ack of the wrong size');

    return takionParseInitAckPayload(msg.payload);
  }

  /** takion_recv_message_cookie_ack() */
  private async recvMessageCookieAck(): Promise<void> {
    const expected = 1 + TAKION_MESSAGE_HEADER_SIZE;
    let message = await this.recv(this.expectTimeoutMs);

    if (message.length > 0xd && message[0xd] === TAKION_CHUNK_TYPE.INIT_ACK) {
      this.log('Received second init ack, looking for cookie ack in next message');
      message = await this.recv(this.expectTimeoutMs);
    }

    if (message.length < expected) {
      throw new TakionError('invalid-response', `Takion received packet of size ${message.length} while expecting cookie ack packet of exactly ${expected}`);
    }

    if (message[0] !== TAKION_PACKET_TYPE.CONTROL) {
      throw new TakionError('invalid-response', `Takion received packet of type 0x${message[0]!.toString(16)} while expecting cookie ack message`);
    }

    let msg: TakionControlMessage;
    try {
      msg = takionParseMessage(message.subarray(1), { tagLocal: this.tagLocal, keyState: this.keyState });
    } catch {
      throw new TakionError('invalid-response', 'Failed to parse message while expecting cookie ack');
    }

    if (msg.chunkType !== TAKION_CHUNK_TYPE.COOKIE_ACK || msg.chunkFlags !== 0x0) {
      throw new TakionError('invalid-response', `Takion received unexpected message with type (0x${msg.chunkType.toString(16)}, 0x${msg.chunkFlags.toString(16)}) while expecting cookie ack`);
    }

    if (msg.payload.length !== 0) throw new TakionError('invalid-response', 'Takion received a cookie ack with a payload');
  }

  /**
   * The end of the reference's receive thread: stop the send buffer, empty the queues, report the disconnect, close the
   * socket. `reason` is null for close().
   */
  private teardown(reason: TakionError | null): void {
    if (this.state === 'closed') return;
    const prev = this.state;
    this.state = 'closed';

    if (this.avTimer !== null) {
      clearTimeout(this.avTimer);
      this.avTimer = null;
    }
    if (this.rxWaiter) this.rxWaiter.reject(reason ?? new TakionError('canceled', 'Takion was closed'));
    this.rxQueue.length = 0;

    if (prev === 'connected') {
      // Other code may still send data, so stop it from using the send buffer first
      this.sendBufferActive = false;
      this.sendBuffer?.fini();

      if (this.videoQueue) {
        this.videoQueue.fini();
        this.videoQueue = null;
      }

      this.dataQueue?.fini();
      this.postponedPackets = null;
    }

    const sock = this.sock;
    if (sock) sock.off('message', this.onMessage); // the error listener stays, inert, so a late error cannot crash the process

    if (prev === 'connected') {
      try {
        this.events.onDisconnect?.(reason ?? undefined);
      } finally {
        this.finishSocket();
      }
    } else {
      this.finishSocket();
    }
  }

  private finishSocket(): void {
    const sock = this.sock;
    if (this.closeSocket && sock && !this.sockClosed) {
      this.sockClosed = true;
      try {
        sock.close(() => this.resolveClosed());
      } catch {
        this.resolveClosed(); // it was closed already
      }
    } else {
      this.resolveClosed();
    }
  }

  // ---------------------------------------------------------------- sending

  /**
   * chiaki_takion_crypt_advance_key_pos(): the key position for a packet about to be sent, advancing the local position
   * by `dataSize`. 0 while there is no local cipher.
   * As in the reference, the amount is `dataSize + dataSize % 16` (not a rounding up to the block size).
   */
  cryptAdvanceKeyPos(dataSize: number): bigint {
    dataSize += dataSize % GKCRYPT_BLOCK_SIZE;
    if (this.gkcryptLocal) {
      const cur = this.keyPosLocal;
      if (U64_MAX - cur < BigInt(dataSize)) throw new TakionError('overflow', 'Takion key position overflow');
      this.keyPosLocal = cur + BigInt(dataSize);
      return cur;
    }
    return 0n;
  }

  /**
   * chiaki_takion_send_raw(): send a datagram as it is. Throws TakionError 'network' if the socket is closed. A failure
   * the operating system reports later is only logged.
   */
  sendRaw(buf: Uint8Array): void {
    const sock = this.sock;
    if (!sock || this.sockClosed) throw new TakionError('network', 'Takion failed to send raw: the socket is closed');
    try {
      sock.send(buf, (err) => {
        if (err) this.log(`Takion failed to send raw: ${(err as { code?: string }).code ?? err.message}`);
      });
    } catch (e) {
      throw new TakionError('network', `Takion failed to send raw: ${(e as Error).message}`);
    }
  }

  /**
   * chiaki_takion_send(): calculate the MAC for the packet depending on its type (the first byte of buf), write it into
   * buf at the respective position and send the packet. Without a local cipher the MAC is set to 0.
   */
  send(buf: Uint8Array, keyPos: bigint): void {
    takionPacketMac(this.gkcryptLocal, buf, keyPos);
    this.sendRaw(buf);
  }

  /**
   * takion_send_buffer_push(): keep a sent packet for resending, unless the connection has ended.
   * The reference ignores a full buffer here: the packet has been sent once and is simply not resent.
   */
  private sendBufferPush(seqNum: number, buf: Uint8Array): void {
    if (this.sendBufferActive && this.sendBuffer) {
      try {
        this.sendBuffer.push(seqNum, buf);
      } catch (e) {
        if (!(e instanceof TakionSendBufferError)) throw e;
      }
    } else {
      throw new TakionError('disconnected', 'Takion is not connected');
    }
  }

  /**
   * chiaki_takion_send_message_data(): send a reliable message. It is resent every 200 ms until the console
   * acknowledges it (onDataAck) or 25 resends have gone by.
   * @param chunkFlags 1 for a complete message or the last part of a split one, 0 for a part that is followed by more
   * @param channel the reference uses 1 for most messages, 2 for corrupt frame and IDR requests, 8 for Senkusha
   *   commands and 9 for the stream info ack
   * @param buf the message, normally an encoded protobuf TakionMessage. Not kept: it is copied into the packet.
   * @returns the sequence number of the message
   * Throws TakionError: 'network' if the socket is closed; 'disconnected' if the connection is not established (the
   * packet has then been sent once all the same, as in the reference).
   */
  sendMessageData(chunkFlags: number, channel: number, buf: Uint8Array): number {
    const keyPos = this.cryptAdvanceKeyPos(buf.length);

    const seqNumVal = this.seqNumLocal;
    this.seqNumLocal = (this.seqNumLocal + 1) >>> 0;

    const packetBuf = takionFormatData(this.tagRemote, keyPos, chunkFlags, seqNumVal, channel, TAKION_MESSAGE_DATA_TYPE.PROTOBUF, buf);

    this.send(packetBuf, keyPos); // alters packetBuf with the gmac

    this.sendBufferPush(seqNumVal, packetBuf);

    return seqNumVal;
  }

  /**
   * chiaki_takion_send_message_data_cont(): like sendMessageData() for every part after the first of a message that is
   * split over several packets (the stream's BIG message when it does not fit the MTU).
   */
  sendMessageDataCont(chunkFlags: number, channel: number, buf: Uint8Array): number {
    const keyPos = this.cryptAdvanceKeyPos(buf.length);

    const seqNumVal = this.seqNumLocal;
    this.seqNumLocal = (this.seqNumLocal + 1) >>> 0;

    const packetBuf = takionFormatDataCont(this.tagRemote, keyPos, chunkFlags, seqNumVal, channel, buf);

    this.send(packetBuf, keyPos); // alters packetBuf with the gmac

    this.sendBufferPush(seqNumVal, packetBuf);

    return seqNumVal;
  }

  /** chiaki_takion_send_message_data_ack(): acknowledge everything the console sent up to `seqNum`. */
  private sendMessageDataAck(seqNum: number): void {
    const size = 1 + TAKION_MESSAGE_HEADER_SIZE + 0xc;
    const keyPos = this.cryptAdvanceKeyPos(size);
    this.send(takionFormatDataAck(this.tagRemote, keyPos, seqNum, this.aRwnd), keyPos);
  }

  /** chiaki_takion_send_congestion(): report how many packets were received and lost. */
  sendCongestion(packet: TakionCongestionPacket): void {
    const keyPos = this.cryptAdvanceKeyPos(TAKION_CONGESTION_PACKET_SIZE);
    this.send(takionFormatCongestion(packet, keyPos), keyPos);
  }

  /** takion_send_feedback_packet(): encrypt, authenticate and send a feedback packet. Needs the local cipher. */
  private sendFeedbackPacket(buf: Uint8Array): void {
    if (!this.gkcryptLocal) throw new TakionError('no-crypt', 'feedback packets cannot be sent before setCrypt()');
    const payloadSize = buf.length - TAKION_FEEDBACK_HEADER_SIZE;
    const keyPos = this.cryptAdvanceKeyPos(payloadSize + GKCRYPT_BLOCK_SIZE);
    takionFeedbackPacketCrypt(this.gkcryptLocal, buf, keyPos);
    try {
      this.sendRaw(buf);
    } catch (e) {
      this.log((e as Error).message); // the reference does not report a failed send here either
    }
  }

  /**
   * chiaki_takion_send_feedback_state(): send the controller state.
   * @param seqNum 16 bit sequence number of feedback state packets (the feedback sender counts it)
   * @param state the state as formatted by chiaki_feedback_state_format_v9/_v12 (not part of this module): 0x19 bytes
   *   for protocol versions up to 9, 0x1c bytes for 12. It is not modified.
   * Throws TakionError 'no-crypt' before setCrypt().
   */
  sendFeedbackState(seqNum: number, state: Uint8Array): void {
    const expected = this.version <= 9 ? FEEDBACK_STATE_BUF_SIZE_V9 : FEEDBACK_STATE_BUF_SIZE_V12;
    if (state.length !== expected) throw new RangeError(`a feedback state for protocol version ${this.version} must be ${expected} bytes, got ${state.length}`);
    this.sendFeedbackPacket(takionFormatFeedbackState(seqNum, state));
  }

  /**
   * chiaki_takion_send_feedback_history(): send controller events.
   * @param seqNum 16 bit sequence number of feedback history packets
   * @param eventCount number of history events contained in payload
   * @param payload the formatted events. It is not modified.
   * Throws TakionError 'no-crypt' before setCrypt().
   */
  sendFeedbackHistory(seqNum: number, eventCount: number, payload: Uint8Array): void {
    this.sendFeedbackPacket(takionFormatFeedbackHistory(seqNum, eventCount, payload));
  }

  /**
   * chiaki_takion_send_mic_packet(): encrypt (IN PLACE), authenticate and send an audio packet that the caller has laid
   * out: an AV header of 19 bytes (20 for a PS5), GMAC at offset 10, key position at offset 14, then the payload.
   * The GMAC field must be zero when the packet is handed over: as in the reference, the packet is authenticated as it
   * is and the result written into that field afterwards.
   * Throws TakionError 'no-crypt' before setCrypt().
   */
  sendMicPacket(buf: Uint8Array, ps5: boolean): void {
    const headerSize = 19 + (ps5 ? 1 : 0);
    if (buf.length < headerSize) throw new TakionError('buf-too-small', 'microphone packet shorter than its header');
    if (!this.gkcryptLocal) throw new TakionError('no-crypt', 'microphone packets cannot be sent before setCrypt()');
    const payloadSize = buf.length - headerSize;

    const keyPos = this.cryptAdvanceKeyPos(payloadSize + GKCRYPT_BLOCK_SIZE);

    this.gkcryptLocal.encrypt(keyPos + BigInt(GKCRYPT_BLOCK_SIZE), buf.subarray(headerSize));

    wr32(buf, 14, low32(keyPos));

    buf.set(this.gkcryptLocal.gmac(keyPos, buf), 10);

    try {
      this.sendRaw(buf);
    } catch (e) {
      this.log((e as Error).message);
    }
  }

  // ---------------------------------------------------------------- receiving

  /**
   * One iteration of the loop in takion_thread_func(): the body (handling one datagram, or the reorder timeout), then
   * what the reference does at the top of the next iteration before it blocks in recv again.
   */
  private loopIteration(body: () => void): void {
    if (this.state !== 'connected') return;
    this.loopDepth++;
    try {
      body();
      if (this.state === 'connected') this.loopTop();
    } finally {
      this.loopDepth--;
    }
    if (this.loopDepth === 0) this.armAvTimer();
  }

  /** The two checks at the top of the reference's receive loop. */
  private loopTop(): void {
    const dataQueue = this.dataQueue;
    if (this.enableCrypt && !this.cryptAvailable && this.gkcryptRemote && dataQueue) {
      this.cryptAvailable = true;
      this.log(`Crypt has become available. Re-checking MACs of ${dataQueue.count} packets`);
      for (let i = 0; i < dataQueue.count; i++) {
        const element = dataQueue.peek(i);
        if (!element) continue;
        const packet = element.user;
        if (packet.packetBuf.length === 0) continue;
        const baseType = packet.packetBuf[0]! & TAKION_PACKET_BASE_TYPE_MASK;
        if (!this.handlePacketMac(baseType, packet.packetBuf)) {
          this.log('Found an invalid MAC');
          dataQueue.drop(i);
        }
      }
    }

    if (this.postponedPackets && this.gkcryptRemote) {
      // there are some postponed packets that were waiting until crypt is initialized and it is now :-)
      const packets = this.postponedPackets;
      this.postponedPackets = null;

      this.log(`Takion flushing ${packets.length} postpone packet(s)`);

      for (const packet of packets) {
        if (this.state !== 'connected') return;
        this.handlePacket(packet);
      }
    }
  }

  /** What the reference does with the result of takion_recv() in its loop. */
  private handleDatagram(msg: Buffer): void {
    if (msg.length === 0) {
      // recv() returning 0 ends the reference's receive loop
      this.log('Takion recv returned 0');
      this.teardown(new TakionError('network', 'Takion recv returned 0'));
      return;
    }
    if (msg.length > TAKION_RECV_BUF_SIZE) {
      this.log(`Takion ignoring a datagram of ${msg.length} bytes`);
      return;
    }
    this.handlePacket(msg);
  }

  /** takion_av_queues_next_timeout_ms() and the timeout branch of the reference's loop. */
  private armAvTimer(): void {
    if (this.avTimer !== null) {
      clearTimeout(this.avTimer);
      this.avTimer = null;
    }
    if (this.state !== 'connected' || this.videoQueueHeadWaitStartUs === 0) return;

    const remainingUs = TAKION_AV_REORDER_TIMEOUT_US - (this.nowUs() - this.videoQueueHeadWaitStartUs);
    const timeoutMs = remainingUs <= 0 ? 0 : Math.floor((remainingUs + 999) / 1000);
    this.avTimer = setTimeout(() => {
      this.avTimer = null;
      this.loopIteration(() => this.avQueueFlushWithTimeout());
    }, timeoutMs);
  }

  /** Monotonic microseconds, never 0 (0 means "not waiting" in the reorder timeout). */
  private nowUs(): number {
    return Math.max(1, Math.round(performance.now() * 1000));
  }

  /**
   * takion_handle_packet_mac(): check the MAC of a received packet against the remote cipher (and remember its key
   * position if it is good). Without a remote cipher every packet passes.
   */
  private handlePacketMac(baseType: number, buf: Uint8Array): boolean {
    if (!this.gkcryptRemote) return true;

    // chiaki_takion_packet_read_key_pos()
    const keyPosOffset = takionPacketTypeKeyPosOffset(buf[0]! & TAKION_PACKET_BASE_TYPE_MASK);
    if (keyPosOffset < 0 || buf.length < keyPosOffset + 4) {
      this.log('Takion failed to pull key_pos out of received packet');
      return false;
    }
    const keyPos = this.keyState.requestPos(rd32(buf, keyPosOffset), false);

    let result: { mac: Buffer; macOld: Buffer };
    try {
      result = takionPacketMac(this.gkcryptRemote, buf, keyPos);
    } catch {
      this.log('Takion failed to calculate mac for received packet');
      return false;
    }

    if (!result.mac.equals(result.macOld)) {
      this.log(`Takion packet MAC mismatch for packet type 0x${baseType.toString(16)} with key_pos 0x${keyPos.toString(16)}`);
      return false;
    }

    this.keyState.commit(keyPos);

    return true;
  }

  /** takion_postpone_packet() */
  private postponePacket(buf: Uint8Array): void {
    if (!this.postponedPackets) this.postponedPackets = [];

    if (this.postponedPackets.length >= TAKION_POSTPONE_PACKETS_SIZE) {
      this.log('Should postpone a packet, but there is no space left');
      return;
    }

    this.log(`Postpone packet of size 0x${buf.length.toString(16)}`);
    this.postponedPackets.push(buf);
  }

  /** takion_handle_packet(): one received datagram (not empty). */
  private handlePacket(buf: Uint8Array): void {
    const baseType = buf[0]! & TAKION_PACKET_BASE_TYPE_MASK;

    if (!this.handlePacketMac(baseType, buf)) return;

    switch (baseType) {
      case TAKION_PACKET_TYPE.CONTROL:
        this.handlePacketMessage(buf);
        break;
      case TAKION_PACKET_TYPE.VIDEO:
      case TAKION_PACKET_TYPE.AUDIO:
        if (this.enableCrypt && !this.gkcryptRemote) this.postponePacket(buf);
        else this.handlePacketAv(baseType, buf);
        break;
      default:
        this.log(`Takion packet with unknown type 0x${baseType.toString(16)} received`);
        break;
    }
  }

  /** takion_handle_packet_message() */
  private handlePacketMessage(buf: Uint8Array): void {
    let msg: TakionControlMessage;
    try {
      msg = takionParseMessage(buf.subarray(1), { tagLocal: this.tagLocal, keyState: this.keyState });
    } catch (e) {
      this.log((e as Error).message);
      return;
    }

    switch (msg.chunkType) {
      case TAKION_CHUNK_TYPE.DATA:
        this.handlePacketMessageData(buf, msg.chunkFlags, msg.payload);
        break;
      case TAKION_CHUNK_TYPE.DATA_ACK:
        this.handlePacketMessageDataAck(msg.chunkFlags, msg.payload);
        break;
      default:
        this.log(`Takion received message with unknown chunk type = 0x${msg.chunkType.toString(16)}`);
        break;
    }
  }

  /** takion_flush_data_queue(): hand on every data message that is next in order, then acknowledge the last of them. */
  private flushDataQueue(): void {
    const dataQueue = this.dataQueue;
    if (!dataQueue) return;
    let seqNum = 0;
    let ack = false;
    for (;;) {
      const element = dataQueue.pull();
      if (!element) break;
      seqNum = element.seqNum;
      const entry = element.user;
      ack = true;

      if (entry.payload.length < 9) continue;

      const zeroA = rd16(entry.payload, 6);
      const dataType = entry.payload[8]!; // & 0xf

      if (zeroA !== 0) this.log(`Takion received data with unexpected nonzero 0x${zeroA.toString(16)} at buf+6`);

      if (
        dataType !== TAKION_MESSAGE_DATA_TYPE.PROTOBUF &&
        dataType !== TAKION_MESSAGE_DATA_TYPE.RUMBLE &&
        dataType !== TAKION_MESSAGE_DATA_TYPE.TRIGGER_EFFECTS &&
        dataType !== TAKION_MESSAGE_DATA_TYPE.PAD_INFO
      ) {
        this.log(`Takion received data with unexpected data type 0x${dataType.toString(16)}`);
      } else if (this.events.onData) {
        this.events.onData(dataType, entry.payload.subarray(9));
        if (this.state !== 'connected') return; // closed from inside the callback
      }
    }

    if (ack) {
      try {
        this.sendMessageDataAck(seqNum >>> 0);
      } catch (e) {
        this.log((e as Error).message);
      }
    }
  }

  /** takion_handle_packet_message_data() */
  private handlePacketMessageData(packetBuf: Uint8Array, typeB: number, payload: Uint8Array): void {
    if (typeB !== 1) this.log(`Takion received data with type_b = 0x${typeB.toString(16)} (was expecting 0x1)`);

    if (payload.length < 9) {
      this.log('Takion received data with a size less than the header size');
      return;
    }

    const entry: DataPacketEntry = { typeB, packetBuf, payload, channel: rd16(payload, 4) };
    const seqNum = rd32(payload, 0);

    this.dataQueue?.push(seqNum, entry);
    this.flushDataQueue();
  }

  /** takion_handle_packet_message_data_ack() */
  private handlePacketMessageDataAck(_flags: number, buf: Uint8Array): void {
    if (buf.length !== 0xc) {
      this.log(`Takion received data ack with size ${buf.length.toString(16)} != 0xc`);
      return;
    }

    const cumulativeSeqNum = rd32(buf, 0);
    const gapAckBlocksCount = rd16(buf, 8);
    const dupTsnsCount = rd16(buf, 0xa);

    if (buf.length !== gapAckBlocksCount * 4 + 0xc) {
      this.log('Takion received data ack with invalid gap_ack_blocks_count');
      return;
    }

    if (dupTsnsCount !== 0) this.log(`Takion received data ack with nonzero dup_tsns_count 0x${dupTsnsCount.toString(16)}`);

    const ackedSeqNums = this.sendBuffer ? this.sendBuffer.ack(cumulativeSeqNum) : [];

    for (const seqNum of ackedSeqNums) {
      this.events.onDataAck?.(seqNum);
      if (this.state !== 'connected') return;
    }
  }

  /** takion_handle_packet_av() */
  private handlePacketAv(baseType: number, buf: Uint8Array): void {
    if (this.disableAudioVideo & DISABLE_AUDIO_VIDEO.VIDEO && baseType === TAKION_PACKET_TYPE.VIDEO) return;

    let packet: TakionAvPacket;
    try {
      packet = this.avPacketParse(this.keyState, buf);
    } catch (e) {
      if (e instanceof TakionError && e.code === 'buf-too-small') this.log('Takion received AV packet that was too small');
      else if (!(e instanceof TakionError)) throw e;
      return;
    }
    if (this.disableAudioVideo & DISABLE_AUDIO_VIDEO.AUDIO && baseType === TAKION_PACKET_TYPE.AUDIO && !packet.isHaptics) return;

    const isVideo = baseType === TAKION_PACKET_TYPE.VIDEO;
    if (!isVideo) {
      this.events.onAv?.(packet);
      return;
    }

    if (!this.videoQueue) {
      let queueBegin = packet.packetIndex;
      if (packet.unitIndex > 0) queueBegin = (packet.packetIndex - packet.unitIndex) & 0xffff;
      this.videoQueue = ReorderQueue.init16<AvPacketEntry>(TAKION_AV_VIDEO_REORDER_QUEUE_SIZE_EXP, queueBegin);
      this.videoQueue.setDropStrategy(REORDER_QUEUE_DROP_STRATEGY.BEGIN);
      // takion_av_drop() only logs at debug level
      this.videoQueueHeadWaitStartUs = 0;
      this.videoQueueHeadWaitSeqNum = queueBegin;
    }

    this.videoQueue.push(packet.packetIndex, { baseType, buf, packet });
    this.avQueueFlushWithTimeout();
  }

  /**
   * takion_av_queue_flush_with_timeout(): pull and dispatch all in-order entries from the video queue. If the head
   * packet is missing, wait up to TAKION_AV_REORDER_TIMEOUT_US before skipping it, then retry. This handles WiFi
   * jitter without stalling on lost packets.
   */
  private avQueueFlushWithTimeout(): void {
    const queue = this.videoQueue;
    if (!queue) return;

    const now = this.nowUs();
    let madeProgress = true;

    while (madeProgress) {
      madeProgress = false;

      for (let element = queue.pull(); element; element = queue.pull()) {
        madeProgress = true;
        if (this.events.onAv) {
          this.events.onAv(element.user.packet);
          if (this.state !== 'connected') return; // closed from inside the callback
        }
      }

      if (madeProgress) this.videoQueueHeadWaitStartUs = 0;

      if (queue.count === 0) break;

      if (this.videoQueueHeadWaitStartUs !== 0 && queue.begin !== this.videoQueueHeadWaitSeqNum) {
        if (queue.seqNumGt(queue.begin, this.videoQueueHeadWaitSeqNum)) {
          // The missing head advanced within the same loss burst. Keep the
          // original timeout budget but track the new missing sequence.
          this.videoQueueHeadWaitSeqNum = queue.begin;
        } else {
          // A genuinely new gap appeared; start a fresh timeout window.
          this.videoQueueHeadWaitStartUs = now;
          this.videoQueueHeadWaitSeqNum = queue.begin;
          break;
        }
      }

      // Head slot is missing (packet lost or not yet arrived)
      if (this.videoQueueHeadWaitStartUs === 0) {
        this.videoQueueHeadWaitStartUs = now;
        this.videoQueueHeadWaitSeqNum = queue.begin;
        break;
      }

      if (now - this.videoQueueHeadWaitStartUs <= TAKION_AV_REORDER_TIMEOUT_US) break;

      // Timeout exceeded: skip directly to the first buffered packet so startup
      // and burst reordering only pay a single timeout.
      let skipped = 0;
      while (skipped < queue.count) {
        if (queue.peek(skipped)) break;
        skipped++;
      }
      if (skipped >= queue.count) break;

      queue.begin = queue.seqNumAdd(queue.begin, skipped);
      queue.count -= skipped;
      this.videoQueueHeadWaitStartUs = 0;
      madeProgress = true;
    }
  }
}

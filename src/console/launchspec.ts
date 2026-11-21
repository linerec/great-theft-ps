// SPDX-License-Identifier: AGPL-3.0-only
//
// The "launch spec": a JSON document the client sends inside the first stream message (BIG) to say which picture it
// wants (resolution, frame rate, bitrate, codec) and what the network looks like (MTU, round trip time).
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/launchspec.c and the part of
// lib/src/streamconnection.c that encrypts it (stream_connection_send_big) (commit 43728af). The JSON text is
// transcribed character for character: the console parses it, so the placeholder values of the reference are kept.
//
// STATUS: the text is compared with the reference's format string in tests. Not yet sent to a real console.

import { encrypt, isPs5Target, type KnownTarget, type RpCrypt } from './rpcrypt.ts';

export type LaunchCodec = 'h264' | 'h265' | 'h265-hdr';

export interface LaunchSpec {
  target: KnownTarget;
  width: number;
  height: number;
  maxFps: number;
  /** Bitrate the client asks for, in kbit/s. */
  bitrateKbps: number;
  codec: LaunchCodec;
  /** Incoming MTU in bytes (1454 when not measured). */
  mtu: number;
  /** Round trip time in milliseconds (1 when not measured). */
  rttMs: number;
  /** 16 random bytes chosen by the client for this session. */
  handshakeKey: Uint8Array;
}

/** Port of chiaki_launchspec_format(). */
export function formatLaunchSpec(s: LaunchSpec): string {
  if (s.handshakeKey.length !== 16) throw new RangeError('the handshake key must be 16 bytes');
  const ps5 = isPs5Target(s.target);
  const extra0 = ps5 ? ',"adaptiveStreamMode": "resize"' : '';
  const extra1 = ps5 ? (s.codec === 'h264' ? '"videoCodec":"avc",' : '"videoCodec":"hevc",') : '';
  const extra2 = ps5 ? (s.codec === 'h265-hdr' ? '"dynamicRange":"HDR",' : '"dynamicRange":"SDR",') : '';
  const u = (n: number): string => String(Math.max(0, Math.trunc(n)) >>> 0);
  return (
    '{' +
    '"sessionId":"sessionId4321",' +
    '"streamResolutions":[' +
    '{' +
    '"resolution":' +
    '{' +
    `"width":${u(s.width)},` +
    `"height":${u(s.height)}` +
    '},' +
    `"maxFps":${u(s.maxFps)},` +
    '"score":10' +
    '}' +
    '],' +
    '"network":{' +
    `"bwKbpsSent":${u(s.bitrateKbps)},` +
    '"bwLoss":0.001000,' +
    `"mtu":${u(s.mtu)},` +
    `"rtt":${u(s.rttMs)},` +
    '"ports":[53,2053]' +
    '},' +
    '"slotId":1,' +
    '"appSpecification":{' +
    '"minFps":30,' +
    '"minBandwidth":0,' +
    '"extTitleId":"ps3",' +
    '"version":1,' +
    '"timeLimit":1,' +
    '"startTimeout":100,' +
    '"afkTimeout":100,' +
    '"afkTimeoutDisconnect":100' +
    '},' +
    '"konan":{' +
    '"ps3AccessToken":"accessToken",' +
    '"ps3RefreshToken":"refreshToken"' +
    '},"requestGameSpecification":{' +
    '"model":"bravia_tv",' +
    '"platform":"android",' +
    '"audioChannels":"5.1",' +
    '"language":"sp",' +
    '"acceptButton":"X",' +
    '"connectedControllers":["xinput","ds3","ds4"],' +
    '"yuvCoefficient":"bt601",' +
    '"videoEncoderProfile":"hw4.1",' +
    '"audioEncoderProfile":"audio1"' +
    extra0 +
    '},' +
    '"userProfile":{' +
    '"onlineId":"psnId",' +
    '"npId":"npId",' +
    '"region":"US",' +
    '"languagesUsed":["en","jp"]' +
    '},' +
    extra1 +
    extra2 +
    `"handshakeKey":"${Buffer.from(s.handshakeKey).toString('base64')}"` +
    '}'
  );
}

/**
 * The launch spec as it travels in the BIG message: the JSON text plus its terminating zero, XORed with the key stream
 * the session cipher produces for counter 0 (the cipher run over zeros), then base64. This is NOT the same as encrypting
 * the text: in CFB the key stream depends on the ciphertext, so the reference's two-step form is kept exactly.
 */
export function encryptLaunchSpec(json: string, crypt: RpCrypt): string {
  const plain = Buffer.from(`${json}\0`, 'latin1');
  const stream = encrypt(crypt, 0, new Uint8Array(plain.length));
  for (let i = 0; i < plain.length; i++) plain[i] = plain[i]! ^ stream[i]!;
  return plain.toString('base64');
}

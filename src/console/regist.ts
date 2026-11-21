// SPDX-License-Identifier: AGPL-3.0-only
//
// Registering this program with a console ("Link Device" on a PS5, "Add Device" on a PS4).
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/regist.c and lib/include/chiaki/regist.h
// (commit 43728af). The request layout, offsets, header names and the order of the network steps are transcribed from
// there. Only the plain LAN registration is ported, not the PSN (internet) one.
//
// The exchange: a UDP "SRC3" (PS5) or "SRC2" (PS4) probe to port 9295, answered "RES3"/"RES2"; then one TCP request to
// the same port carrying a 0x1e0 byte header block plus an encrypted line pair with the PSN account id; the console
// answers with an encrypted block that holds the registration key, the key and its MAC address.
//
// STATUS: the cipher is checked against the reference implementation's test vectors, the request layout and the whole
// flow against a simulated console. It has NOT been run against a real console. Secrets: the PIN, the account id and
// the keys are never logged here.

import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';

import type { ConsoleTarget } from './discovery.ts';
import {
  aeropause, aeropausePs4Pre10, decrypt, encrypt, initRegist, initRegistPs4Pre10, isKnownTarget, isPreTen, isPs5Target, KEY_SIZE,
  type KnownTarget, type RpCrypt,
} from './rpcrypt.ts';

export const REGIST_PORT = 9295;
const INNER_HEADER_OFFSET = 0x1e0;
const CLIENT_TYPE = 'dabfa2ec873de5839bee8d3f4c0239c4282c07c25c6077a2931afcf0adc0d34f';
const CLIENT_TYPE_PS4_PRE10 = 'Windows';
const SEARCH_TIMEOUT_MS = 3000;
const SEARCH_SETTLE_MS = 100; // a PS4 does not accept the request immediately after answering the search
const MAX_RESPONSE_BYTES = 64 * 1024;

export const APPLICATION_REASON = {
  registFailed: 0x80108b09,
  invalidPsnId: 0x80108b02,
  inUse: 0x80108b10,
  crash: 0x80108b15,
  rpVersion: 0x80108b11,
} as const;

export function applicationReasonText(reason: number): string {
  switch (reason) {
    case APPLICATION_REASON.registFailed:
      return 'Registration failed, most likely a wrong or expired PIN';
    case APPLICATION_REASON.invalidPsnId:
      return 'The console does not accept this PSN account id';
    case APPLICATION_REASON.inUse:
      return 'Remote Play is already in use on the console';
    case APPLICATION_REASON.crash:
      return 'Remote Play on the console crashed';
    case APPLICATION_REASON.rpVersion:
      return 'The console rejected the Remote Play version';
    default:
      return 'unknown reason';
  }
}

export type RegistErrorCode = 'invalid-input' | 'unsupported-target' | 'refused' | 'timeout' | 'network' | 'rejected' | 'invalid-response';

export class RegistError extends Error {
  code: RegistErrorCode;
  /** The console's own reason code, when it gave one. */
  reason?: number;
  constructor(code: RegistErrorCode, message: string, reason?: number) {
    super(message);
    this.name = 'RegistError';
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }
}

/** The result of a successful registration. `registKey` and `rpKey` are secrets that let a client control the console. */
export interface RegisteredConsole {
  target: KnownTarget;
  /** The console's MAC address, 12 lower case hex digits. */
  mac: string;
  nickname: string;
  /** 16 bytes, zero padded. */
  registKey: Uint8Array;
  rpKeyType: number;
  rpKey: Uint8Array;
}

// ------------------------------------------------------------------ inputs

/** The PIN the console shows: eight digits. Spaces and dashes are ignored. */
export function parsePin(input: string | number): number {
  const digits = String(input).replace(/[\s-]/g, '');
  if (!/^\d{8}$/.test(digits)) throw new RegistError('invalid-input', 'The PIN is the 8 digit number the console shows');
  return Number(digits);
}

/**
 * The PSN account id as the 8 bytes the console wants. Accepted: the decimal number (up to 20 digits), or those 8 bytes
 * (little endian) as base64, which is how other Remote Play programs show it. Hex is not accepted: 16 hex digits and a
 * 16 digit decimal look the same.
 */
export function parseAccountId(input: string): Uint8Array {
  const text = input.trim();
  if (/^\d{1,20}$/.test(text)) {
    const n = BigInt(text);
    if (n >= 1n << 64n) throw new RegistError('invalid-input', 'The account id is too large');
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  }
  if (/^[A-Za-z0-9+/]{11}=$/.test(text)) {
    const b = Buffer.from(text, 'base64');
    if (b.length === 8) return b;
  }
  throw new RegistError('invalid-input', 'The account id is either a decimal number or 8 bytes in base64 (ends with "=")');
}

// ------------------------------------------------------------------ request

function requestPath(target: KnownTarget): string {
  if (isPs5Target(target)) return '/sie/ps5/rp/sess/rgst';
  if (isPreTen(target)) return '/sce/rp/regist';
  return '/sie/ps4/rp/sess/rgst';
}

const rpVersion = (target: KnownTarget): string => ({ 'ps4-8': '8.0', 'ps4-9': '9.0', 'ps4-10': '10.0', 'ps5-1': '1.0' })[target];

export interface PayloadInput {
  target: KnownTarget;
  /** 16 random bytes. Fixed only in tests. */
  ambassador: Uint8Array;
  pin: number;
  /** 8 bytes. Required for PS5 and PS4 10 and later. */
  accountId?: Uint8Array;
  /** PS4 before 10 identifies the user by online id instead. */
  onlineId?: string;
}

/** Port of chiaki_regist_request_payload_format(). Returns the body and the cipher state needed to read the answer. */
export function buildRegistPayload(input: PayloadInput): { payload: Buffer; crypt: RpCrypt } {
  const { target, ambassador, pin } = input;
  if (!isKnownTarget(target)) throw new RegistError('unsupported-target', `This console generation (${String(target)}) is not supported`);
  const buf = Buffer.alloc(0x400);
  buf.fill(0x41, 0, INNER_HEADER_OFFSET); // 'A': filler, the console ignores it except where the keys are hidden
  let onlineId = input.onlineId;
  let crypt: RpCrypt;
  if (isPreTen(target)) {
    crypt = initRegistPs4Pre10(ambassador, pin);
    buf.set(aeropausePs4Pre10(crypt.ambassador), 0x11c);
  } else {
    const key0Off = buf[0x18d]! & 0x1f;
    const key1Off = buf[0]! >> 3;
    crypt = initRegist(target, ambassador, key0Off, pin);
    const hidden = aeropause(target, key1Off, crypt.ambassador);
    buf.set(hidden.subarray(8, 16), 0xc7);
    buf.set(hidden.subarray(0, 8), 0x191);
    onlineId = undefined; // not used from PS4 10 on
  }

  let inner: string;
  if (onlineId !== undefined) {
    inner = `Client-Type: Windows\r\nNp-Online-Id: ${onlineId}\r\n`;
  } else if (input.accountId) {
    if (input.accountId.length !== 8) throw new RegistError('invalid-input', 'The account id must be 8 bytes');
    inner = `Client-Type: ${isPreTen(target) ? CLIENT_TYPE_PS4_PRE10 : CLIENT_TYPE}\r\nNp-AccountId: ${Buffer.from(input.accountId).toString('base64')}\r\n`;
  } else {
    throw new RegistError('invalid-input', 'A PSN account id is needed to register this console');
  }
  const innerBytes = Buffer.from(inner, 'latin1');
  if (INNER_HEADER_OFFSET + innerBytes.length > buf.length) throw new RegistError('invalid-input', 'The request does not fit');
  buf.set(encrypt(crypt, 0, innerBytes), INNER_HEADER_OFFSET);
  return { payload: buf.subarray(0, INNER_HEADER_OFFSET + innerBytes.length), crypt };
}

/** The HTTP head. The doubled " HTTP/1.1" on the first line and the made up host are what the reference sends. */
export function buildRegistRequestHead(target: KnownTarget, payloadLength: number): Buffer {
  let head =
    `POST ${requestPath(target)} HTTP/1.1\r\n HTTP/1.1\r\n` +
    'HOST: 10.0.2.15\r\n' +
    'User-Agent: remoteplay Windows\r\n' +
    'Connection: close\r\n' +
    `Content-Length: ${payloadLength}\r\n`;
  if (target !== 'ps4-8') head += `RP-Version: ${rpVersion(target)}\r\n`;
  head += '\r\n';
  return Buffer.from(head, 'latin1');
}

// ------------------------------------------------------------------ response

/** "Key: value" lines. A line without a colon, or with an empty key or value, makes the block invalid. */
export function parseHeaderBlock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line === '' || line.includes('\0')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new RegistError('invalid-response', 'The console sent a malformed header line');
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (value === '') throw new RegistError('invalid-response', 'The console sent an empty header value');
    out.set(line.slice(0, colon), value);
  }
  return out;
}

function hexBytes(value: string, exact?: number, max?: number): Buffer | null {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) return null;
  const b = Buffer.from(value, 'hex');
  if (exact !== undefined && b.length !== exact) return null;
  if (max !== undefined && b.length > max) return null;
  return b;
}

/** Port of regist_parse_response_payload(). Fields other than the keys, MAC and nickname are ignored on purpose. */
export function parseRegistPayload(text: string, target: KnownTarget): RegisteredConsole {
  const h = parseHeaderBlock(text);
  const ps5 = isPs5Target(target);
  const registKeyRaw = hexBytes(h.get(ps5 ? 'PS5-RegistKey' : 'PS4-RegistKey') ?? '', undefined, KEY_SIZE);
  const rpKey = hexBytes(h.get('RP-Key') ?? '', KEY_SIZE);
  const mac = hexBytes(h.get(ps5 ? 'PS5-Mac' : 'PS4-Mac') ?? '', 6);
  if (!registKeyRaw) throw new RegistError('invalid-response', 'The answer has no valid registration key');
  if (!rpKey) throw new RegistError('invalid-response', 'The answer has no valid key');
  if (!mac) throw new RegistError('invalid-response', 'The answer has no valid MAC address');
  const registKey = new Uint8Array(KEY_SIZE);
  registKey.set(registKeyRaw);
  return {
    target,
    mac: mac.toString('hex'),
    nickname: h.get(ps5 ? 'PS5-Nickname' : 'PS4-Nickname') ?? '',
    registKey,
    rpKeyType: Number(h.get('RP-KeyType') ?? 0) >>> 0,
    rpKey: Uint8Array.from(rpKey),
  };
}

/** Split an HTTP response into status code, headers and the body bytes received so far. */
export function parseHttpResponse(data: Buffer): { code: number; headers: Map<string, string>; body: Buffer } | null {
  const end = data.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const head = data.subarray(0, end).toString('latin1');
  const lines = head.split('\r\n');
  const status = /^HTTP\/\d\.\d (\d{3})/.exec(lines[0] ?? '');
  if (!status) throw new RegistError('invalid-response', 'The console did not answer with HTTP');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { code: Number(status[1]), headers, body: data.subarray(end + 4) };
}

// ------------------------------------------------------------------ network

export interface RegisterOptions {
  host: string;
  target: ConsoleTarget;
  pin: string | number;
  /** Decimal or base64, see parseAccountId. */
  accountId: string;
  /** Overall limit for each network step. Default 3000. */
  timeoutMs?: number;
  /** Port for both the UDP search and the TCP request. Default 9295. Changed only by tests. */
  port?: number;
  /** Progress lines. Never contains the PIN, the account id or any key. */
  log?: (line: string) => void;
  /** Random source. Replaced only by tests. */
  randomBytes?: (n: number) => Uint8Array;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function search(host: string, port: number, ps5: boolean, timeoutMs: number): Promise<{ address: string; port: number }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    const want = ps5 ? 'RES3' : 'RES2';
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new RegistError('timeout', 'The console did not answer the search. Keep its Link Device screen (PS5) or Add Device screen (PS4) with the code open'))), timeoutMs);
    socket.on('error', (e: NodeJS.ErrnoException) =>
      done(() =>
        reject(
          e.code === 'ECONNREFUSED'
            ? new RegistError('refused', 'The console refused the search. Keep its Link Device screen (PS5) or Add Device screen (PS4) with the code open')
            : new RegistError('network', `Could not reach the console (${e.code ?? e.message})`),
        ),
      ),
    );
    socket.on('message', (msg, rinfo) => {
      if (msg.length >= want.length && msg.subarray(0, want.length).toString('latin1') === want) done(() => resolve({ address: rinfo.address, port: rinfo.port }));
    });
    socket.connect(port, host, () => {
      socket.send(Buffer.from(`${ps5 ? 'SRC3' : 'SRC2'}\0`, 'latin1'), (err) => {
        if (err) done(() => reject(new RegistError('network', `Could not send the search (${err.message})`)));
      });
    });
  });
}

/** Send `request`, return the HTTP answer once its Content-Length is complete (or the connection ends). */
function exchange(host: string, port: number, request: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new RegistError('timeout', 'The console did not answer the registration request in time'))), timeoutMs);
    const complete = (): boolean => {
      const all = Buffer.concat(chunks);
      const end = all.indexOf('\r\n\r\n');
      if (end < 0) return false;
      const m = /content-length:\s*(\d+)/i.exec(all.subarray(0, end).toString('latin1'));
      return m ? all.length - (end + 4) >= Number(m[1]) : false;
    };
    socket.on('connect', () => socket.write(request));
    socket.on('data', (d: Buffer) => {
      chunks.push(d);
      total += d.length;
      if (total > MAX_RESPONSE_BYTES) return done(() => reject(new RegistError('invalid-response', 'The answer is too large')));
      if (complete()) done(() => resolve(Buffer.concat(chunks)));
    });
    socket.on('end', () => done(() => (total > 0 ? resolve(Buffer.concat(chunks)) : reject(new RegistError('network', 'The console closed the connection without answering')))));
    socket.on('error', (e: NodeJS.ErrnoException) => done(() => reject(new RegistError(e.code === 'ECONNREFUSED' ? 'refused' : 'network', `Could not talk to the console (${e.code ?? e.message})`))));
  });
}

export async function register(opts: RegisterOptions): Promise<RegisteredConsole> {
  const log = opts.log ?? (() => {});
  const target = opts.target;
  if (!isKnownTarget(target)) throw new RegistError('unsupported-target', `This console generation (${target}) is not supported by this version`);
  const pin = parsePin(opts.pin);
  const accountId = parseAccountId(opts.accountId);
  const port = opts.port ?? REGIST_PORT;
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const ambassador = (opts.randomBytes ?? ((n: number) => randomBytes(n)))(KEY_SIZE);

  const { payload, crypt } = buildRegistPayload({ target, ambassador, pin, accountId });
  const request = Buffer.concat([buildRegistRequestHead(target, payload.length), payload]);

  log('searching for the console');
  const found = await search(opts.host, port, isPs5Target(target), timeoutMs);
  await sleep(SEARCH_SETTLE_MS);
  log('sending the registration request');
  const raw = await exchange(found.address, found.port, request, timeoutMs);

  const response = parseHttpResponse(raw);
  if (!response) throw new RegistError('invalid-response', 'The console answered with an incomplete response');
  if (response.code !== 200) {
    const reasonText = response.headers.get('rp-application-reason');
    const reason = reasonText ? parseInt(reasonText, 16) : undefined;
    throw new RegistError('rejected', `The console answered ${response.code}${reason !== undefined ? `: ${applicationReasonText(reason)}` : ''}`, reason);
  }
  const length = Number(response.headers.get('content-length') ?? 0);
  if (!length) throw new RegistError('invalid-response', 'The answer has no content');
  if (response.body.length < length) throw new RegistError('invalid-response', 'The answer is shorter than it says');
  const text = decrypt(crypt, 0, response.body.subarray(0, length)).toString('latin1');
  const result = parseRegistPayload(text, target);
  log('the console accepted the registration');
  return result;
}

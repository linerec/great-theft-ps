// SPDX-License-Identifier: AGPL-3.0-only
//
// Asking a registered console to start a Remote Play session (the first request of every connection).
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/session.c, session_thread_request_session()
// and parse_session_response() (commit 43728af). The request layout, header names and the reading of the answer are
// transcribed from there.
//
// What happens: one TCP request to the console's port 9295, `GET /sie/ps5/rp/sess/init` (PS5) with the registration key
// as an RP-Registkey header and the Remote Play version as Rp-Version. A console that knows the key answers 200 with an
// RP-Nonce header (16 bytes, base64). That nonce and the key received at registration (RP-Key) give the session keys
// that protect everything after this step (see initAuth in rpcrypt.ts).
//
// STATUS: checked against a simulated console and the reference's test vector for the key schedule (PS4 10). NOT yet
// run against a real console. Secrets: the registration key and the keys are never logged here.

import type { ConsoleTarget } from './discovery.ts';
import { applicationReasonText, exchange, parseHttpResponse, RegistError, APPLICATION_REASON } from './regist.ts';
import { initAuth, isKnownTarget, isPreTen, isPs5Target, KEY_SIZE, type KnownTarget, type RpCrypt } from './rpcrypt.ts';

export const SESSION_PORT = 9295;
const SESSION_TIMEOUT_MS = 5000;
const REASON_UNKNOWN = 0x80108bff;

export type SessionErrorCode = 'unsupported-target' | 'refused' | 'timeout' | 'network' | 'rejected' | 'version-mismatch' | 'invalid-response';

export class SessionError extends Error {
  code: SessionErrorCode;
  /** The console's own reason code, when it gave one. */
  reason?: number;
  /** Set for 'version-mismatch': the Remote Play version the console says it speaks. */
  serverVersion?: string;
  constructor(code: SessionErrorCode, message: string, extra: { reason?: number; serverVersion?: string } = {}) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    if (extra.reason !== undefined) this.reason = extra.reason;
    if (extra.serverVersion !== undefined) this.serverVersion = extra.serverVersion;
  }
}

/** What the console accepted: the nonce and the session cipher state derived from it. Secrets: keep in memory only. */
export interface SessionGrant {
  target: KnownTarget;
  nonce: Uint8Array;
  crypt: RpCrypt;
}

const rpVersion = (target: KnownTarget): string => ({ 'ps4-8': '8.0', 'ps4-9': '9.0', 'ps4-10': '10.0', 'ps5-1': '1.0' })[target];

function path(target: KnownTarget): string {
  if (isPs5Target(target)) return '/sie/ps5/rp/sess/init';
  if (isPreTen(target)) return '/sce/rp/session';
  return '/sie/ps4/rp/sess/init';
}

/**
 * The registration key as the console wants it in the header: the hex of its bytes up to the first zero byte (the key is
 * stored zero padded to 16 bytes), as the reference does.
 */
export function registKeyHex(registKey: Uint8Array): string {
  const end = registKey.indexOf(0);
  return Buffer.from(end < 0 ? registKey : registKey.subarray(0, end)).toString('hex');
}

export function buildSessionRequest(host: string, port: number, target: KnownTarget, registKey: Uint8Array): Buffer {
  return Buffer.from(
    `GET ${path(target)} HTTP/1.1\r\n` +
      `Host: ${host}:${port}\r\n` +
      'User-Agent: remoteplay Windows\r\n' +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n' +
      `RP-Registkey: ${registKeyHex(registKey)}\r\n` +
      `Rp-Version: ${rpVersion(target)}\r\n` +
      '\r\n',
    'latin1',
  );
}

/** Port of parse_session_response() plus what the caller does with it. Throws SessionError unless the console accepted. */
export function readSessionResponse(raw: Buffer, target: KnownTarget): Uint8Array {
  let response;
  try {
    response = parseHttpResponse(raw);
  } catch (e) {
    throw new SessionError('invalid-response', (e as Error).message);
  }
  if (!response) throw new SessionError('invalid-response', 'The console answered with an incomplete response');
  const reasonText = response.headers.get('rp-application-reason');
  const reason = reasonText ? parseInt(reasonText, 16) : undefined;
  const nonceText = response.headers.get('rp-nonce');

  if (response.code === 200 && nonceText) {
    const nonce = /^[A-Za-z0-9+/]+={0,2}$/.test(nonceText) ? Buffer.from(nonceText, 'base64') : Buffer.alloc(0);
    if (nonce.length !== KEY_SIZE) throw new SessionError('invalid-response', 'The console sent a nonce of the wrong size');
    return Uint8Array.from(nonce);
  }
  const serverVersion = response.headers.get('rp-version');
  if ((reason === APPLICATION_REASON.rpVersion || reason === REASON_UNKNOWN) && serverVersion && serverVersion !== rpVersion(target)) {
    throw new SessionError('version-mismatch', `The console speaks Remote Play version ${serverVersion}, this client sent ${rpVersion(target)}`, { reason, serverVersion });
  }
  if (response.code === 200) throw new SessionError('invalid-response', 'The console accepted the request but sent no nonce');
  throw new SessionError(
    'rejected',
    `The console answered ${response.code}${reason !== undefined ? `: ${applicationReasonText(reason)} (0x${reason.toString(16)})` : ''}`,
    reason !== undefined ? { reason } : {},
  );
}

export interface SessionRequestOptions {
  host: string;
  target: ConsoleTarget;
  /** 16 bytes, from the registration. */
  registKey: Uint8Array;
  /** The registration's RP-Key (16 bytes). */
  rpKey: Uint8Array;
  /** Default 9295. Changed only by tests. */
  port?: number;
  timeoutMs?: number;
  /** Progress lines. Never contains a key. */
  log?: (line: string) => void;
}

export async function requestSession(opts: SessionRequestOptions): Promise<SessionGrant> {
  const target = opts.target;
  if (!isKnownTarget(target)) throw new SessionError('unsupported-target', `This console generation (${target}) is not supported by this version`);
  if (opts.registKey.length !== KEY_SIZE || opts.rpKey.length !== KEY_SIZE) throw new RangeError('the registration keys must be 16 bytes each');
  const log = opts.log ?? (() => {});
  const port = opts.port ?? SESSION_PORT;

  log('sending the session request');
  let raw: Buffer;
  try {
    raw = await exchange(opts.host, port, buildSessionRequest(opts.host, port, target, opts.registKey), opts.timeoutMs ?? SESSION_TIMEOUT_MS, 'session request');
  } catch (e) {
    if (e instanceof RegistError && (e.code === 'refused' || e.code === 'timeout' || e.code === 'network')) {
      throw new SessionError(
        e.code,
        e.code === 'refused'
          ? 'The console refused the connection. Is it on (not in rest mode) and is Remote Play enabled in its settings?'
          : e.message,
      );
    }
    if (e instanceof RegistError) throw new SessionError('invalid-response', e.message);
    throw e;
  }
  const nonce = readSessionResponse(raw, target);
  log('the console accepted the session request');
  return { target, nonce, crypt: initAuth(target, nonce, opts.rpKey) };
}

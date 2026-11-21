// SPDX-License-Identifier: AGPL-3.0-only
//
// The control connection: the long-lived TCP connection that follows an accepted session request. Over it the console
// hands out the session id (needed to start the stream), asks for a login PIN when the account has one, and exchanges
// heartbeats and small commands.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/ctrl.c and lib/src/session.c (the device id)
// (commit 43728af). The request layout, the order in which values are encrypted, the message framing and the message
// numbers are transcribed from there. Only the LAN path is ported (not the PSN / RUDP one).
//
// How it works: `GET /sie/ps5/rp/sess/ctrl` on TCP 9295, with several header values encrypted with the session keys
// (see initAuth in rpcrypt.ts), each with the next counter: the registration key (counter 0), a device id (1), the OS
// name (2), a start bitrate (3) and, on PS5, the streaming type (4). The console answers 200. After that both sides send
// messages: an 8 byte header (payload length, 4 bytes big endian; type, 2 bytes big endian; 2 zero bytes) and a payload
// encrypted with the next counter of the sender. An empty payload does not use a counter.
//
// STATUS: checked against a simulated console in tests. This is the first place the session keys are used, so a real
// console accepting this request is what proves the session key schedule. Secrets: nothing here logs keys, the device
// id, the session id or a login PIN.

import { randomBytes } from 'node:crypto';
import net from 'node:net';

import { decrypt, encrypt, isKnownTarget, isPreTen, isPs5Target, KEY_SIZE, type KnownTarget, type RpCrypt } from './rpcrypt.ts';

export const CTRL_PORT = 9295;
const CTRL_TIMEOUT_MS = 5000;
const OS_TYPE = 'Win10.0.0';
export const DID_SIZE = 32;
const SESSION_ID_MAX = 80;
const MAX_MESSAGE_BYTES = 1 << 20;

export const CTRL_MESSAGE = {
  sessionId: 0x33,
  heartbeatReq: 0xfe,
  heartbeatRep: 0x1fe,
  loginPinReq: 0x4,
  loginPinRep: 0x8004,
  login: 0x5,
  gotoBed: 0x50,
  goHome: 0x14,
  displayA: 0x1,
  displayB: 0x16,
  micConnect: 0x30,
  micToggle: 0x36,
  displayDevices: 0x910,
  switchToStreamConnection: 0x34,
} as const;

export type CtrlErrorCode = 'unsupported-target' | 'refused' | 'timeout' | 'network' | 'rejected' | 'invalid-response' | 'closed';

export class CtrlError extends Error {
  code: CtrlErrorCode;
  constructor(code: CtrlErrorCode, message: string) {
    super(message);
    this.name = 'CtrlError';
    this.code = code;
  }
}

export type VideoCodec = 'h264' | 'h265' | 'h265-hdr';

/** A device id as the reference builds it: a fixed prefix, 16 random bytes, six zero bytes. */
export function makeDid(random: (n: number) => Uint8Array = (n) => randomBytes(n)): Uint8Array {
  const prefix = [0x00, 0x18, 0x00, 0x00, 0x00, 0x07, 0x00, 0x40, 0x00, 0x80];
  const did = new Uint8Array(DID_SIZE);
  did.set(prefix, 0);
  did.set(random(DID_SIZE - prefix.length - 6), prefix.length);
  return did;
}

const rpVersion = (target: KnownTarget): string => ({ 'ps4-8': '8.0', 'ps4-9': '9.0', 'ps4-10': '10.0', 'ps5-1': '1.0' })[target];

function path(target: KnownTarget): string {
  if (isPs5Target(target)) return '/sie/ps5/rp/sess/ctrl';
  if (isPreTen(target)) return '/sce/rp/session/ctrl';
  return '/sie/ps4/rp/sess/ctrl';
}

export interface CtrlRequestInput {
  host: string;
  port: number;
  target: KnownTarget;
  crypt: RpCrypt;
  /** 16 bytes, zero padded, as stored. */
  registKey: Uint8Array;
  did: Uint8Array;
  codec: VideoCodec;
}

/** Port of the first half of ctrl_connect(). Returns the request and how many counters it used. */
export function buildCtrlRequest(i: CtrlRequestInput): { request: Buffer; localCounter: number } {
  if (i.registKey.length !== KEY_SIZE) throw new RangeError('the registration key must be 16 bytes');
  if (i.did.length !== DID_SIZE) throw new RangeError('the device id must be 32 bytes');
  let counter = 0;
  const enc = (data: Uint8Array): string => encrypt(i.crypt, counter++, data).toString('base64');
  const auth = enc(i.registKey);
  const did = enc(i.did);
  const os = enc(Buffer.from(`${OS_TYPE}\0`, 'latin1')); // the reference encrypts the terminating zero too
  let extra = '';
  if (isPs5Target(i.target)) extra += 'RP-PadProcNo: 3\r\n';
  if (!isPreTen(i.target)) extra += `RP-StartBitrate: ${enc(new Uint8Array(4))}\r\n`;
  if (isPs5Target(i.target)) {
    const type = i.codec === 'h265' ? 2 : i.codec === 'h265-hdr' ? 3 : 1;
    extra += `RP-StreamingType: ${enc(Uint8Array.from([type & 0xff, (type >> 8) & 0xff, (type >> 16) & 0xff, (type >> 24) & 0xff]))}\r\n`;
  }
  const request =
    `GET ${path(i.target)} HTTP/1.1\r\n` +
    `Host: ${i.host}:${i.port}\r\n` +
    'User-Agent: remoteplay Windows\r\n' +
    'Connection: keep-alive\r\n' +
    'Content-Length: 0\r\n' +
    `RP-Auth: ${auth}\r\n` +
    `RP-Version: ${rpVersion(i.target)}\r\n` +
    `RP-Did: ${did}\r\n` +
    'RP-ControllerType: 3\r\n' +
    'RP-ClientType: 11\r\n' +
    `RP-OSType: ${os}\r\n` +
    'RP-ConPath: 1\r\n' +
    extra +
    '\r\n';
  return { request: Buffer.from(request, 'latin1'), localCounter: counter };
}

/** One message: 8 byte header and the (already encrypted) payload. */
export function frameCtrlMessage(type: number, encryptedPayload: Uint8Array = new Uint8Array(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(encryptedPayload.length, 0);
  header.writeUInt16BE(type, 4);
  return Buffer.concat([header, encryptedPayload]);
}

/** A session id the console sent is usable when it is 24 to 78 letters and digits. */
export function readSessionId(payload: Uint8Array): string | null {
  if (payload.length < 2) return null;
  const body = payload.subarray(1); // the first byte is a length-like marker (0x4a on a PS5)
  if (body.length >= SESSION_ID_MAX - 1 || body.length < 24) return null;
  const text = Buffer.from(body).toString('latin1');
  return /^[A-Za-z0-9]+$/.test(text) ? text : null;
}

/** What the reference uses when the console's session id is unusable: seconds since start plus 48 random bytes in base64. */
export function fallbackSessionId(nowMs: number = Date.now(), random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  return `${Math.floor(nowMs / 1000)}`.slice(0, 15) + Buffer.from(random(48)).toString('base64');
}

export interface CtrlOptions {
  host: string;
  target: KnownTarget;
  /** The session cipher state (initAuth of the nonce and the registration's RP-Key). */
  crypt: RpCrypt;
  registKey: Uint8Array;
  did?: Uint8Array;
  codec?: VideoCodec;
  /** Default 9295. Changed only by tests. */
  port?: number;
  timeoutMs?: number;
  /** Progress lines. Never contains a key, the device id, the session id or a PIN. */
  log?: (line: string) => void;
}

export interface CtrlEvents {
  onSessionId?: (sessionId: string) => void;
  /** The account on the console has a login PIN and the console wants it. */
  onLoginPinRequest?: () => void;
  onLogin?: (ok: boolean) => void;
  /** Every message, after decryption. For the code that builds on this. */
  onMessage?: (type: number, payload: Buffer) => void;
  /** The connection ended (by either side, or by an error). Called once. */
  onClose?: (reason: string) => void;
}

export class Ctrl {
  /** 0 = PS4, 1 = PS4 Pro, 2 = PS5. Known after connect() when the console said. */
  serverType: number | undefined;
  sessionId: string | undefined;
  events: CtrlEvents = {};

  #opts: CtrlOptions;
  #socket: net.Socket | null = null;
  #localCounter = 0;
  #remoteCounter = 0;
  #buffer: Buffer = Buffer.alloc(0);
  #closed = false;
  #connected = false;
  #sessionWaiters: Array<{ resolve: (id: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(opts: CtrlOptions) {
    if (!isKnownTarget(opts.target)) throw new CtrlError('unsupported-target', `This console generation (${String(opts.target)}) is not supported`);
    this.#opts = opts;
  }

  #log(line: string): void {
    this.#opts.log?.(line);
  }

  /** Open the connection and send the request. Resolves once the console has answered 200. */
  connect(): Promise<void> {
    const o = this.#opts;
    const port = o.port ?? CTRL_PORT;
    const { request, localCounter } = buildCtrlRequest({ host: o.host, port, target: o.target, crypt: o.crypt, registKey: o.registKey, did: o.did ?? makeDid(), codec: o.codec ?? 'h264' });
    this.#localCounter = localCounter;
    this.#remoteCounter = 0;

    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: o.host, port });
      this.#socket = socket;
      socket.setNoDelay(true);
      let settled = false;
      const fail = (e: CtrlError): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
        this.#end(e.message);
      };
      const timer = setTimeout(() => fail(new CtrlError('timeout', 'The console did not answer the control request in time')), o.timeoutMs ?? CTRL_TIMEOUT_MS);
      socket.on('connect', () => {
        this.#log('sending the control request');
        socket.write(request);
      });
      socket.on('error', (e: NodeJS.ErrnoException) => fail(new CtrlError(e.code === 'ECONNREFUSED' ? 'refused' : 'network', `Control connection failed (${e.code ?? e.message})`)));
      socket.on('close', () => {
        if (!settled) fail(new CtrlError('closed', 'The console closed the control connection before answering'));
        else this.#end('the control connection was closed');
      });
      socket.on('data', (chunk: Buffer) => {
        this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
        if (!this.#connected) {
          const end = this.#buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (this.#buffer.length > 8192) fail(new CtrlError('invalid-response', 'The console sent an oversized response head'));
            return;
          }
          const head = this.#buffer.subarray(0, end).toString('latin1');
          this.#buffer = this.#buffer.subarray(end + 4);
          const error = this.#readResponse(head);
          if (error) return fail(error);
          this.#connected = true;
          settled = true;
          clearTimeout(timer);
          this.#log('the console accepted the control connection');
          resolve();
        }
        try {
          this.#drain();
        } catch (e) {
          this.#end((e as Error).message);
        }
      });
    });
  }

  /** Port of parse_ctrl_response() and what follows it. Returns an error, or null when the console accepted. */
  #readResponse(head: string): CtrlError | null {
    const lines = head.split('\r\n');
    const status = /^HTTP\/\d\.\d (\d{3})/.exec(lines[0] ?? '');
    if (!status) return new CtrlError('invalid-response', 'The console did not answer the control request with HTTP');
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
    if (status[1] !== '200') {
      const reason = headers.get('rp-application-reason');
      return new CtrlError('rejected', `The console answered ${status[1]} to the control request${reason ? ` (reason 0x${reason})` : ''}`);
    }
    const serverType = headers.get('rp-server-type');
    if (serverType !== undefined) {
      const raw = /^[A-Za-z0-9+/]+={0,2}$/.test(serverType) ? Buffer.from(serverType, 'base64') : Buffer.alloc(0);
      // Only a value of exactly 16 bytes is decrypted, and only then does it use a counter.
      if (raw.length === 0x10) this.serverType = decrypt(this.#opts.crypt, this.#remoteCounter++, raw)[0];
    }
    return null;
  }

  #drain(): void {
    while (this.#buffer.length >= 8) {
      const size = this.#buffer.readUInt32BE(0);
      if (size > MAX_MESSAGE_BYTES) throw new CtrlError('invalid-response', 'The console sent an oversized control message');
      if (this.#buffer.length < 8 + size) return;
      const type = this.#buffer.readUInt16BE(4);
      const raw = this.#buffer.subarray(8, 8 + size);
      this.#buffer = this.#buffer.subarray(8 + size);
      const payload = size > 0 ? decrypt(this.#opts.crypt, this.#remoteCounter++, raw) : Buffer.alloc(0);
      this.#received(type, payload);
    }
  }

  #received(type: number, payload: Buffer): void {
    this.events.onMessage?.(type, payload);
    switch (type) {
      case CTRL_MESSAGE.sessionId: {
        if (this.sessionId !== undefined) return;
        const id = readSessionId(payload);
        if (!id) this.#log('the console sent an unusable session id, using a fallback as the reference does');
        this.sessionId = id ?? fallbackSessionId();
        this.#log('received the session id');
        this.#enableFeatures();
        this.events.onSessionId?.(this.sessionId);
        for (const w of this.#sessionWaiters.splice(0)) {
          clearTimeout(w.timer);
          w.resolve(this.sessionId);
        }
        break;
      }
      case CTRL_MESSAGE.heartbeatReq:
        this.send(CTRL_MESSAGE.heartbeatRep);
        break;
      case CTRL_MESSAGE.loginPinReq:
        this.#log('the console asks for the login PIN of the account');
        this.events.onLoginPinRequest?.();
        break;
      case CTRL_MESSAGE.login:
        if (payload.length >= 1) this.events.onLogin?.(payload[0] === 0);
        break;
      default:
        break;
    }
  }

  /** What the reference sends right after the session id (without the optional DualSense and keyboard features). */
  #enableFeatures(): void {
    const micToggle = Uint8Array.from([0, 1, 1, 89]);
    this.send(CTRL_MESSAGE.micToggle, micToggle);
    this.send(CTRL_MESSAGE.micToggle, micToggle);
    this.send(CTRL_MESSAGE.displayDevices, new Uint8Array(4));
  }

  /** Send one message. A payload is encrypted with the next local counter; an empty one uses none. */
  send(type: number, payload?: Uint8Array): void {
    const socket = this.#socket;
    if (!socket || this.#closed || !this.#connected) return;
    const body = payload && payload.length > 0 ? encrypt(this.#opts.crypt, this.#localCounter++, payload) : new Uint8Array(0);
    socket.write(frameCtrlMessage(type, body));
  }

  /** The login PIN of the console account (digits), when the console asked for it. Never logged. */
  sendLoginPin(pin: string): void {
    this.send(CTRL_MESSAGE.loginPinRep, Buffer.from(pin, 'latin1'));
  }

  /** Resolves with the session id, which the console sends shortly after accepting the connection. */
  waitForSessionId(timeoutMs = CTRL_TIMEOUT_MS): Promise<string> {
    if (this.sessionId !== undefined) return Promise.resolve(this.sessionId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#sessionWaiters = this.#sessionWaiters.filter((w) => w.timer !== timer);
        reject(new CtrlError('timeout', 'The console did not send a session id in time'));
      }, timeoutMs);
      this.#sessionWaiters.push({ resolve, reject, timer });
    });
  }

  #end(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket?.destroy();
    for (const w of this.#sessionWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new CtrlError('closed', reason));
    }
    this.events.onClose?.(reason);
  }

  close(): void {
    this.#end('closed by this side');
  }

  get closed(): boolean {
    return this.#closed;
  }
}

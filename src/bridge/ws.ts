// SPDX-License-Identifier: AGPL-3.0-only
//
// A minimal RFC 6455 WebSocket server side, written against node:http upgrade so the project needs no
// dependencies. Server role only: it accepts masked client frames and sends unmasked frames.
// Limits: message size is capped, client frames must be masked, control frames are validated.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export type WsData = Uint8Array | string;

export class WsConnection {
  onMessage: (data: WsData) => void = () => {};
  onClose: (code: number) => void = () => {};

  #socket: Duplex;
  #maxBytes: number;
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentOpcode = 0;
  #fragmentBytes = 0;
  #closed = false;

  constructor(socket: Duplex, head: Buffer, maxBytes: number) {
    this.#socket = socket;
    this.#maxBytes = maxBytes;
    socket.on('data', (chunk: Buffer) => this.#feed(chunk));
    socket.on('close', () => this.#finish(1006));
    socket.on('error', () => this.#finish(1006));
    if (head.length > 0) this.#feed(head);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Bytes queued for the peer and not yet written. Used to drop video when the client cannot keep up. */
  get bufferedBytes(): number {
    return this.#socket.writableLength;
  }

  sendBinary(data: Uint8Array): void {
    this.#write(0x2, data);
  }

  sendText(text: string): void {
    this.#write(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000, reason = ''): void {
    if (this.#closed) return;
    const r = Buffer.from(reason, 'utf8').subarray(0, 100);
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    this.#write(0x8, body);
    // Let the close frame flush before the socket goes away.
    this.#socket.end();
    this.#closed = true;
    setTimeout(() => this.#socket.destroy(), 1000).unref();
    this.onClose(code);
  }

  #finish(code: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.onClose(code);
  }

  #write(opcode: number, payload: Uint8Array): void {
    if (this.#closed || !this.#socket.writable) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.#socket.write(Buffer.concat([header, payload]));
  }

  #fail(code: number): void {
    this.close(code);
  }

  #feed(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const b = this.#buffer;
      if (b.length < 2) return;
      const fin = (b[0]! & 0x80) !== 0;
      const rsv = b[0]! & 0x70;
      const opcode = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let offset = 2;
      if (rsv !== 0 || !masked) return this.#fail(1002);
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.#maxBytes)) return this.#fail(1009);
        len = Number(big);
        offset = 10;
      }
      if (len > this.#maxBytes) return this.#fail(1009);
      const isControl = opcode >= 0x8;
      if (isControl && (!fin || len > 125)) return this.#fail(1002);
      if (b.length < offset + 4 + len) return;
      const mask = b.subarray(offset, offset + 4);
      const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
      this.#buffer = b.subarray(offset + 4 + len);

      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.close(code === 1005 ? 1000 : code);
        return;
      }
      if (opcode === 0x9) {
        this.#write(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (this.#fragmentOpcode !== 0) return this.#fail(1002);
        if (fin) this.#deliver(opcode, payload);
        else {
          this.#fragmentOpcode = opcode;
          this.#fragments = [payload];
          this.#fragmentBytes = payload.length;
        }
      } else if (opcode === 0x0) {
        if (this.#fragmentOpcode === 0) return this.#fail(1002);
        this.#fragmentBytes += payload.length;
        if (this.#fragmentBytes > this.#maxBytes) return this.#fail(1009);
        this.#fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.#fragments);
          const op = this.#fragmentOpcode;
          this.#fragmentOpcode = 0;
          this.#fragments = [];
          this.#fragmentBytes = 0;
          this.#deliver(op, whole);
        }
      } else {
        return this.#fail(1002);
      }
      if (this.#closed) return;
    }
  }

  #deliver(opcode: number, payload: Buffer): void {
    if (opcode === 0x1) {
      const text = payload.toString('utf8');
      this.onMessage(text);
    } else {
      this.onMessage(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
    }
  }
}

/** Complete the upgrade handshake. Returns null (after answering with an HTTP error) if the request is not a valid WebSocket upgrade. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, maxBytes: number): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const connection = String(req.headers.connection ?? '').toLowerCase();
  if (upgrade !== 'websocket' || !connection.includes('upgrade') || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  return new WsConnection(socket, head, maxBytes);
}

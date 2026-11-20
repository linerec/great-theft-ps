// SPDX-License-Identifier: AGPL-3.0-only
//
// CoreLink: the bridge side of the gtp-core contract. gtp-core is a small native program built on libchiaki
// that talks to a real PlayStation. See docs/gtp-core-contract.md. This file is covered by tests that use a
// fake core process, so the contract is verified here; the native program itself is built and tested on a
// machine with a compiler and a console.
//
// Framing on both pipes: u32 little-endian length, then that many bytes. The first byte is the message type.
//   to core   (stdin):  PAD (0x01, same bytes as on the WebSocket), QUALITY (0x02, JSON), QUIT (0x03), KEYFRAME (0x04)
//   from core (stdout): VIDEO (0x10, same bytes as on the WebSocket), STATUS (0x13, JSON), LOG (0x14, UTF-8 text)

import { spawn, type ChildProcess } from 'node:child_process';

import type { VirtualPadState } from '../engine/types.ts';
import type { ConsoleLink, LinkHandlers } from './console-link.ts';
import { decodeVideo, encodePad, MSG } from './protocol.ts';
import type { QualityRequest } from './quality.ts';

export const CORE_MSG = { PAD: 0x01, QUALITY: 0x02, QUIT: 0x03, KEYFRAME: 0x04, STATUS: 0x13, LOG: 0x14 } as const;

/** Cuts a byte stream into length-prefixed messages, whatever the chunking. Oversized messages end the stream. */
export class FrameReader {
  #buf: Buffer = Buffer.alloc(0);
  #maxBytes: number;
  #onMessage: (body: Uint8Array) => void;
  #onError: (why: string) => void;

  constructor(maxBytes: number, onMessage: (body: Uint8Array) => void, onError: (why: string) => void) {
    this.#maxBytes = maxBytes;
    this.#onMessage = onMessage;
    this.#onError = onError;
  }

  push(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    for (;;) {
      if (this.#buf.length < 4) return;
      const len = this.#buf.readUInt32LE(0);
      if (len === 0 || len > this.#maxBytes) {
        this.#buf = Buffer.alloc(0);
        return this.#onError(`bad message length ${len}`);
      }
      if (this.#buf.length < 4 + len) return;
      const body = this.#buf.subarray(4, 4 + len);
      this.#buf = this.#buf.subarray(4 + len);
      this.#onMessage(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    }
  }
}

export function writeFrame(body: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  out.set(body, 4);
  return out;
}

export interface CoreLinkOptions {
  command: string;
  args: string[];
  log?: (line: string) => void;
}

export class CoreLink implements ConsoleLink {
  readonly name = 'core';

  #opts: CoreLinkOptions;
  #child: ChildProcess | null = null;
  #handlers: LinkHandlers | null = null;
  #stopping = false;

  constructor(opts: CoreLinkOptions) {
    this.#opts = opts;
  }

  async start(handlers: LinkHandlers, quality: QualityRequest): Promise<void> {
    this.#handlers = handlers;
    handlers.onStatus({ state: 'connecting', detail: `starting ${this.#opts.command}` });
    const child = spawn(this.#opts.command, this.#opts.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#child = child;

    const reader = new FrameReader(
      8 * 1024 * 1024,
      (body) => this.#fromCore(body),
      (why) => handlers.onStatus({ state: 'error', detail: `gtp-core protocol error: ${why}` }),
    );
    child.stdout!.on('data', (c: Buffer) => reader.push(c));
    child.stderr!.on('data', (c: Buffer) => this.#opts.log?.(`[core stderr] ${c.toString('utf8').trimEnd()}`));
    child.stdin!.on('error', () => {});
    child.on('error', (e) => handlers.onStatus({ state: 'error', detail: `cannot start gtp-core: ${e.message}` }));
    child.on('exit', (code, signal) => {
      if (this.#stopping) return;
      handlers.onStatus({ state: code === 0 ? 'closed' : 'error', detail: `gtp-core exited (${signal ?? code})` });
    });
    this.setQuality(quality);
  }

  #fromCore(body: Uint8Array): void {
    const handlers = this.#handlers;
    if (!handlers) return;
    const type = body[0];
    if (type === MSG.VIDEO) {
      const v = decodeVideo(body);
      if (v) handlers.onVideo({ header: v.header, data: v.payload });
    } else if (type === CORE_MSG.STATUS) {
      try {
        const j = JSON.parse(Buffer.from(body.subarray(1)).toString('utf8')) as { state?: string; detail?: string };
        const state = j.state === 'streaming' || j.state === 'connecting' || j.state === 'closed' || j.state === 'error' ? j.state : 'error';
        handlers.onStatus({ state, detail: typeof j.detail === 'string' ? j.detail.slice(0, 200) : undefined });
      } catch {
        handlers.onStatus({ state: 'error', detail: 'gtp-core sent a malformed status' });
      }
    } else if (type === CORE_MSG.LOG) {
      this.#opts.log?.(`[core] ${Buffer.from(body.subarray(1)).toString('utf8').slice(0, 500)}`);
    }
  }

  #send(body: Uint8Array): void {
    const stdin = this.#child?.stdin;
    if (stdin && stdin.writable) stdin.write(writeFrame(body));
  }

  sendPad(seq: number, state: VirtualPadState): void {
    this.#send(encodePad(seq, state, true));
  }

  setQuality(quality: QualityRequest): void {
    this.#send(Buffer.concat([Buffer.from([CORE_MSG.QUALITY]), Buffer.from(JSON.stringify(quality), 'utf8')]));
  }

  requestKeyframe(): void {
    this.#send(Uint8Array.of(CORE_MSG.KEYFRAME));
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    if (!child) return;
    this.#send(Uint8Array.of(CORE_MSG.QUIT));
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.exitCode !== null) {
        clearTimeout(timer);
        resolve();
      }
    });
    this.#child = null;
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// The packets of reliable Takion messages that the other side has not acknowledged yet, and their retransmission.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/takionsendbuffer.c and
// lib/include/chiaki/takionsendbuffer.h (commit 43728af). The timing constants, the acknowledgement rule (an
// acknowledgement covers its sequence number and every earlier one) and the resend loop are transcribed from there.
//
// Adapted to Node: the reference runs a thread that wakes every 100 ms while packets are waiting; here a timer does
// the same and runs only while the buffer is not empty. The reference removes acknowledged packets by shifting the
// array in place; here the array is filtered, which leaves the same packets in the same order. The buffer does not
// know Takion: it is given the function that sends a datagram (null for unit tests, as the reference allows a NULL
// takion).
//
// STATUS: checked against the reference implementation's own test (test/takion.c, /send_buffer, ported to
// test/takion.test.ts); the resend timing is checked only by this port's own tests. NOT run against a real console.

import { seqNum32Lt, type SeqNum32 } from './seqnum.ts';

/**
 * Unacknowledged reliable packets kept for resending: enough for every packet within the console's receive window, so
 * a burst sent during loss is resent rather than sent once untracked.
 */
export const TAKION_SEND_BUFFER_SIZE = 1024;

export const TAKION_DATA_RESEND_TIMEOUT_MS = 200;
export const TAKION_DATA_RESEND_WAKEUP_TIMEOUT_MS = TAKION_DATA_RESEND_TIMEOUT_MS / 2;
export const TAKION_DATA_RESEND_TRIES_MAX = 25;

/** 'overflow': the buffer is full (CHIAKI_ERR_OVERFLOW). 'invalid-data': that sequence number is already in it. */
export type TakionSendBufferErrorCode = 'overflow' | 'invalid-data';

export class TakionSendBufferError extends Error {
  code: TakionSendBufferErrorCode;
  constructor(code: TakionSendBufferErrorCode, message: string) {
    super(message);
    this.name = 'TakionSendBufferError';
    this.code = code;
  }
}

/** ChiakiTakionSendBufferPacket */
export interface TakionSendBufferPacket {
  seqNum: SeqNum32;
  tries: number;
  /** Monotonic milliseconds. */
  lastSendMs: number;
  buf: Uint8Array;
}

export interface TakionSendBufferOptions {
  /** Progress lines. Never contains packet contents. */
  log?: (line: string) => void;
  /** Monotonic clock in milliseconds. Changed only by tests. */
  now?: () => number;
}

export class TakionSendBuffer {
  /** Allocated size: the number of packet slots. */
  readonly packetsSize: number;
  /** The packets waiting for an acknowledgement, oldest push first. Read only: use push() and ack(). */
  packets: TakionSendBufferPacket[];
  private readonly sendRaw: ((buf: Uint8Array) => void) | null;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null;
  private stopped: boolean;

  /**
   * chiaki_takion_send_buffer_init()
   * @param sendRaw sends one datagram (chiaki_takion_send_raw). With null nothing is ever resent (for unit tests).
   * @param size number of packet slots
   */
  constructor(sendRaw: ((buf: Uint8Array) => void) | null, size: number, opts: TakionSendBufferOptions = {}) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');
    this.packetsSize = size;
    this.packets = [];
    this.sendRaw = sendRaw;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => performance.now());
    this.timer = null;
    this.stopped = false;
  }

  /** chiaki_takion_send_buffer_fini(): stop resending and forget every packet. */
  fini(): void {
    this.stopped = true;
    this.stopTimer();
    this.packets = [];
  }

  /**
   * chiaki_takion_send_buffer_push(): remember a packet that was just sent. The buffer keeps `buf` and resends exactly
   * these bytes, so do not change them afterwards.
   * Throws TakionSendBufferError: 'overflow' when full, 'invalid-data' for a sequence number that is already waiting.
   */
  push(seqNum: SeqNum32, buf: Uint8Array): void {
    seqNum >>>= 0;
    if (this.packets.length >= this.packetsSize) {
      this.log('Takion Send Buffer overflow');
      throw new TakionSendBufferError('overflow', 'Takion Send Buffer overflow');
    }
    for (const packet of this.packets) {
      if (packet.seqNum === seqNum) {
        this.log('Tried to push duplicate seqnum into Takion Send Buffer');
        throw new TakionSendBufferError('invalid-data', 'Tried to push duplicate seqnum into Takion Send Buffer');
      }
    }

    this.packets.push({ seqNum, tries: 0, lastSendMs: this.now(), buf });

    // the buffer was empty before, so nothing was watching it => wake up
    if (!this.stopped && this.sendRaw && this.timer === null) {
      this.timer = setInterval(() => this.onTimer(), TAKION_DATA_RESEND_WAKEUP_TIMEOUT_MS);
    }
  }

  /**
   * chiaki_takion_send_buffer_ack(): the other side acknowledged `seqNum`, which covers every packet with that or an
   * earlier sequence number.
   * @returns the sequence numbers that were removed, in the order they were pushed
   */
  ack(seqNum: SeqNum32): SeqNum32[] {
    seqNum >>>= 0;
    const acked: SeqNum32[] = [];
    const rest: TakionSendBufferPacket[] = [];
    for (const packet of this.packets) {
      if (packet.seqNum === seqNum || seqNum32Lt(packet.seqNum, seqNum)) acked.push(packet.seqNum);
      else rest.push(packet);
    }
    if (acked.length) this.packets = rest;
    if (this.packets.length === 0) this.stopTimer();
    return acked;
  }

  private onTimer(): void {
    if (this.stopped || this.packets.length === 0) {
      this.stopTimer();
      return;
    }
    this.resend();
    if (this.packets.length === 0) this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * takion_send_buffer_resend(): send again every packet that has waited more than 200 ms since it was last sent, and
   * give up on a packet after 25 resends (which, like an acknowledgement, also drops every earlier packet).
   * Called by the timer every 100 ms while packets are waiting; public so tests can drive it with their own clock.
   */
  resend(): void {
    if (!this.sendRaw) return;

    const now = this.now();

    for (let i = 0; i < this.packets.length; i++) {
      const packet = this.packets[i]!;
      if (now - packet.lastSendMs > TAKION_DATA_RESEND_TIMEOUT_MS) {
        if (packet.tries >= TAKION_DATA_RESEND_TRIES_MAX) {
          this.log(`Hit max retries of ${TAKION_DATA_RESEND_TRIES_MAX} tries... giving up on packet with seqnum 0x${packet.seqNum.toString(16)}`);
          this.ack(packet.seqNum);
          // The reference steps back one slot and continues; with i == 0 the packet that moved into slot 0 is looked
          // at on the next wake-up instead.
          if (i > 0) i -= 1;
          continue;
        }
        this.log(`Takion Send Buffer re-sending packet with seqnum 0x${packet.seqNum.toString(16)}, tries: ${packet.tries}`);
        packet.lastSendMs = now;
        this.sendRaw(packet.buf);
        packet.tries++;
      }
    }
  }
}

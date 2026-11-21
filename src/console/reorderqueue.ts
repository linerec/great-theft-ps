// SPDX-License-Identifier: AGPL-3.0-only
//
// A fixed size queue that hands out elements in the order of their sequence numbers, whatever order they arrived in.
// Takion uses one for reliable data messages (32 bit numbers) and one for video packets (16 bit numbers).
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/src/reorderqueue.c and
// lib/include/chiaki/reorderqueue.h (commit 43728af). push, pull, peek and drop are transcribed statement by statement.
//
// One deliberate difference. The reference adds 16 bit sequence numbers as
// `(uint64_t)((ChiakiSeqNum16)a + (ChiakiSeqNum16)b)`: C promotes both operands to int, so the sum does not wrap and
// 0xffff + 1 gives 0x10000. `begin` then holds 0x10000 for one step, and a late packet with number 0 is not recognised
// as the head of a non-empty queue and is dropped. The name and the 32 bit variant (which does wrap) show that wrapping
// was meant, so here the 16 bit sum is reduced to 16 bits. Nothing the reference's tests cover is affected.
//
// STATUS: checked against the reference implementation's own tests (test/reorderqueue.c, ported to
// test/reorderqueue.test.ts). The behaviour at the 16 bit wrap is this port's, checked only by its own tests.

import { seqNum16Gt, seqNum16Lt, seqNum32Gt, seqNum32Lt } from './seqnum.ts';

export const REORDER_QUEUE_DROP_STRATEGY = {
  /** Drop the packet with the lowest number. */
  BEGIN: 0,
  /** Drop the packet with the highest number (the one being pushed). */
  END: 1,
} as const;
export type ReorderQueueDropStrategy = (typeof REORDER_QUEUE_DROP_STRATEGY)[keyof typeof REORDER_QUEUE_DROP_STRATEGY];

export type ReorderQueueDropCb<T> = (seqNum: number, user: T) => void;
export type ReorderQueueSeqNumCmp = (a: number, b: number) => boolean;
export type ReorderQueueSeqNumAdd = (a: number, b: number) => number;

export interface ReorderQueueElement<T> {
  seqNum: number;
  user: T;
}

interface Entry<T> {
  user: T | undefined;
  set: boolean;
}

export class ReorderQueue<T> {
  /** The queue holds 2^sizeExp elements. */
  readonly sizeExp: number;
  /** Sequence number of the next element to be pulled. Read by Takion's video reorder timeout, like in the reference. */
  begin: number;
  /** Width of the window from `begin` to the highest number present, gaps included. */
  count: number;
  readonly seqNumGt: ReorderQueueSeqNumCmp;
  readonly seqNumLt: ReorderQueueSeqNumCmp;
  readonly seqNumAdd: ReorderQueueSeqNumAdd;
  dropStrategy: ReorderQueueDropStrategy;
  dropCb: ReorderQueueDropCb<T> | null;
  private readonly queue: Entry<T>[];

  /**
   * chiaki_reorder_queue_init()
   * @param sizeExp exponent of 2 for the size
   * @param seqNumStart sequence number of the first expected element
   */
  constructor(sizeExp: number, seqNumStart: number, seqNumGt: ReorderQueueSeqNumCmp, seqNumLt: ReorderQueueSeqNumCmp, seqNumAdd: ReorderQueueSeqNumAdd) {
    if (!Number.isInteger(sizeExp) || sizeExp < 0 || sizeExp > 16) throw new RangeError('sizeExp must be 0..16');
    this.sizeExp = sizeExp;
    this.begin = seqNumStart;
    this.count = 0;
    this.seqNumGt = seqNumGt;
    this.seqNumLt = seqNumLt;
    this.seqNumAdd = seqNumAdd;
    this.dropStrategy = REORDER_QUEUE_DROP_STRATEGY.END;
    this.dropCb = null;
    this.queue = Array.from({ length: 1 << sizeExp }, (): Entry<T> => ({ user: undefined, set: false }));
  }

  /** chiaki_reorder_queue_init_16(): a queue of ChiakiSeqNum16 numbers. See the note at the top about the sum. */
  static init16<T>(sizeExp: number, seqNumStart: number): ReorderQueue<T> {
    return new ReorderQueue<T>(sizeExp, seqNumStart & 0xffff, seqNum16Gt, seqNum16Lt, (a, b) => ((a & 0xffff) + (b & 0xffff)) & 0xffff);
  }

  /** chiaki_reorder_queue_init_32(): a queue of ChiakiSeqNum32 numbers. */
  static init32<T>(sizeExp: number, seqNumStart: number): ReorderQueue<T> {
    return new ReorderQueue<T>(sizeExp, seqNumStart >>> 0, seqNum32Gt, seqNum32Lt, (a, b) => ((a >>> 0) + (b >>> 0)) >>> 0);
  }

  /** chiaki_reorder_queue_fini(): hand every element still queued to the drop callback. The queue is empty afterwards. */
  fini(): void {
    if (this.dropCb) {
      for (let i = 0; i < this.count; i++) {
        const seqNum = this.seqNumAdd(this.begin, i);
        const entry = this.queue[this.idx(seqNum)]!;
        if (entry.set) this.dropCb(seqNum, entry.user as T);
      }
    }
    for (const entry of this.queue) {
      entry.set = false;
      entry.user = undefined;
    }
    this.count = 0;
  }

  setDropStrategy(dropStrategy: ReorderQueueDropStrategy): void {
    this.dropStrategy = dropStrategy;
  }

  setDropCb(cb: ReorderQueueDropCb<T> | null): void {
    this.dropCb = cb;
  }

  /** chiaki_reorder_queue_size() */
  size(): number {
    return 1 << this.sizeExp;
  }

  private idx(seqNum: number): number {
    return seqNum & ((1 << this.sizeExp) - 1);
  }

  private ge(a: number, b: number): boolean {
    return a === b || this.seqNumGt(a, b);
  }

  /**
   * chiaki_reorder_queue_push()
   *
   * Depending on the drop strategy this may drop elements, which are handed to the drop callback. The callback also
   * gets the new element itself if one with the same number is already queued, or if its number is before `begin`.
   */
  push(seqNum: number, user: T): void {
    const lt = this.seqNumLt;
    const add = this.seqNumAdd;
    const queueSize = this.size();
    if (this.count > queueSize) throw new Error('reorder queue: count exceeds the size');
    let end = add(this.begin, this.count);

    if (this.ge(seqNum, this.begin) && lt(seqNum, end)) {
      const entry = this.queue[this.idx(seqNum)]!;
      if (entry.set) {
        // received twice
        this.dropIt(seqNum, user);
        return;
      }
      entry.user = user;
      entry.set = true;
      return;
    }

    if (lt(seqNum, this.begin)) {
      this.dropIt(seqNum, user);
      return;
    }

    // => ge(seqNum, end)
    if (!this.ge(seqNum, end)) {
      // Sequence comparisons are undefined at half the serial-number space.
      // If the queue is empty and callers opted into dropping from the begin,
      // rebase to the new packet; otherwise drop it.
      if (this.count === 0 && this.dropStrategy === REORDER_QUEUE_DROP_STRATEGY.BEGIN) {
        this.begin = seqNum;
        end = seqNum;
      } else {
        this.dropIt(seqNum, user);
        return;
      }
    }

    let freeElems = queueSize - this.count;
    let totalEnd = add(end, freeElems);
    const newEnd = add(seqNum, 1);
    if (lt(totalEnd, newEnd)) {
      if (this.dropStrategy === REORDER_QUEUE_DROP_STRATEGY.END) {
        this.dropIt(seqNum, user);
        return;
      }

      // drop first until empty or enough space
      while (this.count > 0 && lt(totalEnd, newEnd)) {
        const entry = this.queue[this.idx(this.begin)]!;
        if (entry.set && this.dropCb) this.dropCb(this.begin, entry.user as T);
        entry.user = undefined; // nothing reads it any more; let it be collected
        this.begin = add(this.begin, 1);
        this.count--;
        freeElems = queueSize - this.count;
        totalEnd = add(end, freeElems);
      }

      // empty, just shift to the seqNum
      if (this.count === 0) this.begin = seqNum;
    }

    // move end until newEnd
    end = add(this.begin, this.count);
    while (lt(end, newEnd)) {
      this.count++;
      this.queue[this.idx(end)]!.set = false;
      end = add(this.begin, this.count);
      if (this.count > queueSize) throw new Error('reorder queue: count exceeds the size');
    }

    const entry = this.queue[this.idx(seqNum)]!;
    entry.set = true;
    entry.user = user;
  }

  private dropIt(seqNum: number, user: T): void {
    if (this.dropCb) this.dropCb(seqNum, user);
  }

  /**
   * chiaki_reorder_queue_pull(): the next element in order, or null if it has not arrived (or the queue is empty).
   * Call repeatedly until it returns null to get everything that is available in order.
   */
  pull(): ReorderQueueElement<T> | null {
    if (this.count > this.size()) throw new Error('reorder queue: count exceeds the size');
    if (this.count === 0) return null;

    const entry = this.queue[this.idx(this.begin)]!;
    if (!entry.set) return null;

    const element = { seqNum: this.begin, user: entry.user as T };
    entry.user = undefined; // the slot is outside the window now; `set` is reset when it comes back in
    this.begin = this.seqNumAdd(this.begin, 1);
    this.count--;
    return element;
  }

  /**
   * chiaki_reorder_queue_peek(): the element at `index` positions after `begin` (an offset, NOT a sequence number;
   * 0 <= index < count), or null if there is none there.
   */
  peek(index: number): ReorderQueueElement<T> | null {
    if (index >= this.count) return null;

    const seqNum = this.seqNumAdd(this.begin, index);
    const entry = this.queue[this.idx(seqNum)]!;
    if (!entry.set) return null;
    return { seqNum, user: entry.user as T };
  }

  /**
   * chiaki_reorder_queue_drop(): drop the element at `index` positions after `begin` (handing it to the drop callback).
   * `begin` does not change; `count` shrinks if the last element was dropped.
   */
  drop(index: number): void {
    if (index >= this.count) return;

    let seqNum = this.seqNumAdd(this.begin, index);
    let entry = this.queue[this.idx(seqNum)]!;
    if (!entry.set) return;

    if (this.dropCb) this.dropCb(seqNum, entry.user as T);
    entry.set = false;
    entry.user = undefined;

    // reduce count if necessary
    if (index === this.count - 1) {
      while (!entry.set) {
        this.count--;
        if (this.count === 0) break;
        seqNum = this.seqNumAdd(this.begin, this.count - 1);
        entry = this.queue[this.idx(seqNum)]!;
      }
    }
  }
}

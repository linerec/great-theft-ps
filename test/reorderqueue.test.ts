// SPDX-License-Identifier: AGPL-3.0-only
//
// The reorder queue. The first group is chiaki-ng's own two tests (test/reorderqueue.c, commit 43728af), step for step.
// The second group covers what the reference does not test: the 32 bit variant, the wrap of the sequence numbers (where
// this port deliberately differs from the reference, see src/console/reorderqueue.ts), and fini().
//
// STATUS: the reference's tests pass on the port. The second group is self-consistency only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REORDER_QUEUE_DROP_STRATEGY, ReorderQueue } from '../src/console/reorderqueue.ts';

const DROP_RECORD_MAX = 16;

interface DropRecord {
  count: number[];
  seqNum: number[];
  failed: boolean;
}

const newRecord = (): DropRecord => ({ count: new Array<number>(DROP_RECORD_MAX).fill(0), seqNum: new Array<number>(DROP_RECORD_MAX).fill(0), failed: false });

/** The reference's drop(): the element's user value is a small number used as the index into the record. */
const recorder = (record: DropRecord) => (seqNum: number, v: number): void => {
  if (v > DROP_RECORD_MAX) {
    record.failed = true;
    return;
  }
  record.count[v]! += 1;
  record.seqNum[v] = seqNum;
};

const reset = (record: DropRecord): void => {
  record.count.fill(0);
  record.seqNum.fill(0);
  record.failed = false;
};

/** Asserts that exactly the given user value was dropped once (or nothing, with -1). */
const assertOnlyDropped = (record: DropRecord, v: number): void => {
  assert.ok(!record.failed);
  for (let i = 0; i < DROP_RECORD_MAX; i++) assert.equal(record.count[i], i === v ? 1 : 0, `drop count of ${i}`);
};

describe('reorder queue: chiaki-ng tests (test/reorderqueue.c)', () => {
  it('/reorder_queue_16', () => {
    const queue = ReorderQueue.init16<number>(2, 42);
    assert.equal(queue.size(), 4);
    assert.equal(queue.count, 0);

    queue.setDropStrategy(REORDER_QUEUE_DROP_STRATEGY.END);

    const dropRecord = newRecord();
    queue.setDropCb(recorder(dropRecord));

    // pull from empty
    let pulled = queue.pull();
    assert.equal(pulled, null);
    assert.equal(queue.count, 0);
    assert.ok(!dropRecord.failed);

    // push one
    queue.push(42, 0);
    assert.equal(queue.count, 1);

    // pull one
    pulled = queue.pull();
    assert.ok(pulled);
    assert.equal(queue.count, 0);
    assert.ok(!dropRecord.failed);
    assert.equal(dropRecord.count[0], 0);
    assert.equal(pulled.user, 0);
    assert.equal(pulled.seqNum, 42);

    // push outdated
    queue.push(42, 0);
    assert.equal(queue.count, 0);
    assert.ok(!dropRecord.failed);
    assert.equal(dropRecord.count[0], 1);
    assert.equal(dropRecord.seqNum[0], 42);
    reset(dropRecord);

    // push until full out of order and try to pull in between
    queue.push(46, 1);
    assert.equal(queue.pull(), null);
    queue.push(45, 2);
    assert.equal(queue.pull(), null);
    queue.push(44, 3);
    assert.equal(queue.pull(), null);
    queue.push(43, 4);
    assertOnlyDropped(dropRecord, -1);

    // push more, because of the END strategy this should be dropped
    queue.push(47, 5);
    assertOnlyDropped(dropRecord, 5);
    assert.equal(dropRecord.seqNum[5], 47);
    reset(dropRecord);

    // push more with the BEGIN strategy, so older elements should be dropped
    queue.setDropStrategy(REORDER_QUEUE_DROP_STRATEGY.BEGIN);
    queue.push(47, 5);
    assertOnlyDropped(dropRecord, 4);
    assert.equal(dropRecord.seqNum[4], 43);
    reset(dropRecord);

    // pull all, elements should arrive in order
    assert.deepEqual(queue.pull(), { seqNum: 44, user: 3 });
    assert.deepEqual(queue.pull(), { seqNum: 45, user: 2 });
    assert.deepEqual(queue.pull(), { seqNum: 46, user: 1 });
    assert.deepEqual(queue.pull(), { seqNum: 47, user: 5 });

    // should be empty now again
    assert.equal(queue.pull(), null);
    assert.equal(queue.count, 0);
    assertOnlyDropped(dropRecord, -1);

    // now push something much higher, because of the BEGIN strategy the queue should be relocated
    queue.push(1337, 6);
    assert.equal(queue.count, 1);
    assertOnlyDropped(dropRecord, -1);

    // and pull again
    assert.deepEqual(queue.pull(), { seqNum: 1337, user: 6 });
    assert.equal(queue.count, 0);

    // same as before, but with an element in the queue that will be dropped
    queue.push(1338, 7);
    assert.equal(queue.count, 1);
    assertOnlyDropped(dropRecord, -1);

    queue.push(2000, 8);
    assert.equal(queue.count, 1);
    assertOnlyDropped(dropRecord, 7);
    assert.equal(dropRecord.seqNum[7], 1338);

    // pull again
    assert.deepEqual(queue.pull(), { seqNum: 2000, user: 8 });
    assert.equal(queue.count, 0);

    queue.fini();
  });

  it('/reorder_queue_drop', () => {
    const queue = ReorderQueue.init16<number>(2, 42);

    const dropRecord = newRecord();
    queue.setDropCb(recorder(dropRecord));

    queue.push(42, 0);
    queue.push(43, 1);
    queue.push(44, 2);
    assert.equal(queue.count, 3);

    // drop the head, it must not be peeked or pulled afterwards
    queue.drop(0);
    assert.ok(!dropRecord.failed);
    assert.equal(dropRecord.count[0], 1);
    assert.equal(dropRecord.seqNum[0], 42);
    assert.equal(queue.peek(0), null);
    assert.equal(queue.pull(), null);

    // dropping it again does nothing
    queue.drop(0);
    assert.equal(dropRecord.count[0], 1);

    // drop the tail, count shrinks to the last set element
    queue.drop(2);
    assert.equal(dropRecord.count[2], 1);
    assert.equal(queue.count, 2);

    // a packet pushed into the dropped head slot is pulled, then the remaining one
    queue.push(42, 3);
    assert.ok(!dropRecord.failed);
    assert.equal(dropRecord.count[3], 0);
    assert.deepEqual(queue.pull(), { seqNum: 42, user: 3 });
    assert.deepEqual(queue.pull(), { seqNum: 43, user: 1 });
    assert.equal(queue.count, 0);

    queue.fini();
  });
});

describe('reorder queue: beyond the reference tests (self-consistency)', () => {
  it('peek looks at offsets from the head, not at sequence numbers', () => {
    const queue = ReorderQueue.init32<string>(3, 100);
    queue.push(102, 'c');
    queue.push(100, 'a');
    assert.equal(queue.count, 3);
    assert.deepEqual(queue.peek(0), { seqNum: 100, user: 'a' });
    assert.equal(queue.peek(1), null, 'the gap');
    assert.deepEqual(queue.peek(2), { seqNum: 102, user: 'c' });
    assert.equal(queue.peek(3), null, 'beyond count');
    assert.deepEqual(queue.pull(), { seqNum: 100, user: 'a' });
    assert.equal(queue.pull(), null, 'stops at the gap');
    queue.push(101, 'b');
    assert.deepEqual(queue.pull(), { seqNum: 101, user: 'b' });
    assert.deepEqual(queue.pull(), { seqNum: 102, user: 'c' });
  });

  it('32 bit numbers: in order across the wrap from 0xffffffff to 0', () => {
    const dropped: number[] = [];
    const queue = ReorderQueue.init32<string>(4, 0xfffffffe);
    queue.setDropCb((seqNum) => dropped.push(seqNum));
    queue.push(1, 'd');
    queue.push(0, 'c');
    queue.push(0xffffffff, 'b');
    assert.equal(queue.pull(), null);
    queue.push(0xfffffffe, 'a');
    assert.deepEqual([queue.pull(), queue.pull(), queue.pull(), queue.pull(), queue.pull()], [
      { seqNum: 0xfffffffe, user: 'a' },
      { seqNum: 0xffffffff, user: 'b' },
      { seqNum: 0, user: 'c' },
      { seqNum: 1, user: 'd' },
      null,
    ]);
    assert.equal(queue.begin, 2);
    queue.push(0xffffffff, 'late'); // already pulled: dropped
    assert.deepEqual(dropped, [0xffffffff]);
  });

  it('16 bit numbers: in order across the wrap from 0xffff to 0, including a head that arrives late (differs from the reference)', () => {
    const dropped: number[] = [];
    const queue = ReorderQueue.init16<string>(3, 0xfffe);
    queue.setDropStrategy(REORDER_QUEUE_DROP_STRATEGY.BEGIN);
    queue.setDropCb((seqNum) => dropped.push(seqNum));
    queue.push(0xfffe, 'a');
    queue.push(0xffff, 'b');
    queue.push(1, 'd'); // 0 is still missing
    assert.deepEqual(queue.pull(), { seqNum: 0xfffe, user: 'a' });
    assert.deepEqual(queue.pull(), { seqNum: 0xffff, user: 'b' });
    assert.equal(queue.begin, 0, 'the head wrapped to 0 (the reference would hold 0x10000 here)');
    assert.equal(queue.pull(), null);
    queue.push(0, 'c'); // the reference drops this one: 0 is not "equal to or after" 0x10000
    assert.deepEqual(dropped, []);
    assert.deepEqual(queue.pull(), { seqNum: 0, user: 'c' });
    assert.deepEqual(queue.pull(), { seqNum: 1, user: 'd' });
    assert.equal(queue.count, 0);
    assert.equal(queue.begin, 2);
  });

  it('a duplicate is handed to the drop callback and the queued element stays', () => {
    const dropped: Array<[number, string]> = [];
    const queue = ReorderQueue.init16<string>(2, 10);
    queue.setDropCb((seqNum, user) => dropped.push([seqNum, user]));
    queue.push(11, 'first');
    queue.push(11, 'second');
    assert.deepEqual(dropped, [[11, 'second']]);
    queue.push(10, 'head');
    assert.deepEqual(queue.pull(), { seqNum: 10, user: 'head' });
    assert.deepEqual(queue.pull(), { seqNum: 11, user: 'first' });
  });

  it('half the number space away: dropped with the END strategy, rebased with BEGIN when the queue is empty', () => {
    const dropped: number[] = [];
    const queue = ReorderQueue.init16<string>(2, 0);
    queue.setDropCb((seqNum) => dropped.push(seqNum));
    queue.push(0x8000, 'far');
    assert.deepEqual(dropped, [0x8000]);
    assert.equal(queue.count, 0);

    queue.setDropStrategy(REORDER_QUEUE_DROP_STRATEGY.BEGIN);
    queue.push(0x8000, 'far');
    assert.equal(queue.begin, 0x8000);
    assert.deepEqual(queue.pull(), { seqNum: 0x8000, user: 'far' });
  });

  it('fini hands everything still queued to the drop callback and leaves the queue empty', () => {
    const dropped: Array<[number, string]> = [];
    const queue = ReorderQueue.init32<string>(3, 5);
    queue.setDropCb((seqNum, user) => dropped.push([seqNum, user]));
    queue.push(6, 'x');
    queue.push(8, 'y');
    queue.fini();
    assert.deepEqual(dropped, [[6, 'x'], [8, 'y']]);
    assert.equal(queue.count, 0);
    assert.equal(queue.pull(), null);
    queue.fini();
    assert.equal(dropped.length, 2);
  });

  it('refuses a size exponent that makes no sense', () => {
    assert.throws(() => ReorderQueue.init16<number>(-1, 0), RangeError);
    assert.throws(() => ReorderQueue.init16<number>(1.5, 0), RangeError);
  });
});

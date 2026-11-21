// SPDX-License-Identifier: AGPL-3.0-only
//
// Wrapping sequence number comparison. The first two tests are chiaki-ng's own (test/seqnum.c, commit 43728af),
// loop for loop. The last one only pins down what the port does at the edges the reference does not test.
//
// STATUS: the reference's tests pass on the port. Nothing here involves a console.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { seqNum16Gt, seqNum16Lt, seqNum32Gt, seqNum32Lt } from '../src/console/seqnum.ts';

describe('sequence numbers: chiaki-ng tests (test/seqnum.c)', () => {
  it('seq_num_16: every number against its successor and against the one 0xfff ahead', () => {
    let a = 0;
    do {
      const b = (a + 1) & 0xffff;
      if (!seqNum16Gt(b, a) || seqNum16Gt(a, b) || !seqNum16Lt(a, b) || seqNum16Lt(b, a)) assert.fail(`successor of ${a}`);
      a = b;
    } while (a);

    a = 0;
    do {
      const b = (a + 0xfff) & 0xffff;
      if (!seqNum16Gt(b, a) || seqNum16Gt(a, b) || !seqNum16Lt(a, b) || seqNum16Lt(b, a)) assert.fail(`${a} + 0xfff`);
      a = (a + 1) & 0xffff;
    } while (a);

    assert.ok(seqNum16Gt(1, 0xfff5));
    assert.ok(!seqNum16Gt(0xfff5, 1));
  });

  it('seq_num_32', () => {
    assert.ok(seqNum32Gt(1, 0));
    assert.ok(!seqNum32Gt(0, 1));
    assert.ok(!seqNum32Lt(1, 0));
    assert.ok(seqNum32Lt(0, 1));
    assert.ok(seqNum32Gt(1, 0xfffffff5));
    assert.ok(!seqNum32Gt(0xfffffff5, 1));
  });
});

describe('sequence numbers: edges (not in the reference tests)', () => {
  it('equal numbers are neither less nor greater', () => {
    for (const v of [0, 1, 0x7fff, 0x8000, 0xffff]) {
      assert.ok(!seqNum16Lt(v, v));
      assert.ok(!seqNum16Gt(v, v));
    }
    for (const v of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff]) {
      assert.ok(!seqNum32Lt(v, v));
      assert.ok(!seqNum32Gt(v, v));
    }
  });

  it('at exactly half the number space the order is undefined: neither holds, in either direction', () => {
    assert.ok(!seqNum16Lt(0, 0x8000) && !seqNum16Gt(0, 0x8000) && !seqNum16Lt(0x8000, 0) && !seqNum16Gt(0x8000, 0));
    assert.ok(!seqNum32Lt(0, 0x80000000) && !seqNum32Gt(0, 0x80000000) && !seqNum32Lt(0x80000000, 0) && !seqNum32Gt(0x80000000, 0));
    assert.ok(seqNum16Lt(0, 0x7fff) && seqNum16Gt(0, 0x8001));
    assert.ok(seqNum32Lt(0, 0x7fffffff) && seqNum32Gt(0, 0x80000001));
  });

  it('the 32 bit comparison wraps where the 16 bit one does not, and arguments are reduced to their width', () => {
    assert.ok(seqNum32Lt(0xfff5, 1) === false && seqNum32Gt(0xfff5, 1), '0xfff5 is simply larger in 32 bits');
    assert.ok(seqNum16Lt(0x1fff5, 1), 'reduced to 0xfff5, which is before 1 in 16 bits');
    assert.ok(seqNum32Gt(0x100000001, 0xfffffff5), 'reduced to 1');
  });
});

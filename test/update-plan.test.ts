// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { crashLoop, planUpdate, splitArgs } from '../src/deploy/update-plan.ts';

const base = { local: 'aaa', remote: 'bbb', bad: new Set<string>(), busy: false as boolean | null };

describe('when a server takes a new version', () => {
  it('does nothing when it is current, or when git cannot say', () => {
    assert.deepEqual(planUpdate({ ...base, remote: 'aaa' }), { action: 'none', why: 'up-to-date' });
    assert.deepEqual(planUpdate({ ...base, remote: null }), { action: 'none', why: 'unknown-remote' });
  });

  it('takes a newer commit when nobody is playing', () => {
    assert.deepEqual(planUpdate(base), { action: 'try', commit: 'bbb' });
  });

  it('never cuts a stream, and does not guess when it cannot tell whether one is running', () => {
    assert.deepEqual(planUpdate({ ...base, busy: true }), { action: 'wait', why: 'someone-is-playing' });
    assert.deepEqual(planUpdate({ ...base, busy: null }), { action: 'wait', why: 'someone-is-playing' });
  });

  it('leaves a commit that failed its start-up check alone until the branch moves on', () => {
    assert.deepEqual(planUpdate({ ...base, bad: new Set(['bbb']) }), { action: 'skip', why: 'known-bad' });
    assert.deepEqual(planUpdate({ ...base, remote: 'ccc', bad: new Set(['bbb']) }), { action: 'try', commit: 'ccc' });
  });
});

describe('small helpers', () => {
  it('splits the bridge arguments', () => {
    assert.deepEqual(splitArgs('--accounts  --trust-host ps5.example.org\n--no-phone'), ['--accounts', '--trust-host', 'ps5.example.org', '--no-phone']);
    assert.deepEqual(splitArgs(undefined), []);
    assert.deepEqual(splitArgs('   '), []);
  });

  it('gives up on a bridge that keeps dying, not on one that died once in a while', () => {
    const now = 1_000_000;
    assert.equal(crashLoop([now - 1000, now - 2000, now - 3000, now - 4000], now), false);
    assert.equal(crashLoop([now - 1000, now - 2000, now - 3000, now - 4000, now - 5000], now), true);
    assert.equal(crashLoop([now - 100_000, now - 90_000, now - 80_000, now - 70_000, now - 65_000], now), false, 'old deaths do not count');
  });
});

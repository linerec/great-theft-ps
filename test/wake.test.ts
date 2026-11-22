// SPDX-License-Identifier: AGPL-3.0-only
//
// Waking a console that is in rest mode (src/console/wake.ts and the credential in discovery.ts). The waiting logic runs
// on a clock that only the waiting moves, so these tests take no time. The datagram itself is checked against the
// reference's format and a simulated console on 127.0.0.1.

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { describe, it } from 'node:test';

import { credentialFromStoredKey, formatWakeup, wakeup } from '../src/console/discovery.ts';
import { probePresence, wakeConsole, type Presence, type WakeDeps } from '../src/console/wake.ts';

/** A stored registration key: the text padded with zero bytes to 16 bytes, as hexadecimal. */
const stored = (text: string): string => Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc(16 - text.length)]).toString('hex');

describe('the wake-up credential from a stored registration key', () => {
  it('reads the key bytes as the text of a hexadecimal number, cut at the first zero byte (as chiaki-ng does)', () => {
    assert.equal(credentialFromStoredKey(stored('1f2e3d4c')), 0x1f2e3d4cn);
    assert.equal(credentialFromStoredKey(stored('A')), 0xan);
    assert.equal(credentialFromStoredKey(stored('ffffffff')), 0xffffffffn);
    assert.equal(credentialFromStoredKey(stored('00000001')), 1n, 'leading zero characters belong to the number, they are not padding');
  });

  it('is not the number you get from reading the stored hexadecimal itself', () => {
    // The stored form is hexadecimal of the key's TEXT; reading that as a number gives something else entirely.
    assert.notEqual(credentialFromStoredKey(stored('1f2e3d4c')), BigInt(`0x${stored('1f2e3d4c').slice(0, 16)}`));
  });

  it('refuses what the reference refuses: more than 8 characters, text that is not hexadecimal, nothing at all', () => {
    assert.throws(() => credentialFromStoredKey(stored('1f2e3d4c5')), /not usable for waking/);
    assert.throws(() => credentialFromStoredKey(stored('abcdefgh')), /not usable for waking/);
    assert.throws(() => credentialFromStoredKey('00'.repeat(16)), /not usable for waking/);
    assert.throws(() => credentialFromStoredKey('zz'), /not hexadecimal bytes/);
    assert.throws(() => credentialFromStoredKey('abc'), /not hexadecimal bytes/);
  });

  it('is carried in the datagram as a decimal number', () => {
    const text = formatWakeup(credentialFromStoredKey(stored('1f2e3d4c')), '00030010').toString('latin1');
    assert.match(text, /^WAKEUP \* HTTP\/1\.1\nclient-type:vr\nauth-type:R\nmodel:w\napp-type:r\nuser-credential:523124044\n/);
  });
});

describe('the datagram reaches a console on UDP', () => {
  it("arrives at the console's port with that credential, twice because a datagram can get lost", async () => {
    const received: string[] = [];
    const fake = dgram.createSocket('udp4');
    fake.on('message', (m) => received.push(m.toString('latin1')));
    await new Promise<void>((r) => fake.bind(0, '127.0.0.1', r));
    try {
      await wakeup('127.0.0.1', credentialFromStoredKey(stored('1f2e3d4c')), true, { port: fake.address().port, repeat: 2 });
      for (let i = 0; i < 50 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(received.length, 2);
      assert.match(received[0]!, /user-credential:523124044\n/);
      assert.match(received[0]!, /device-discovery-protocol-version:00030010\n/);
    } finally {
      fake.close();
    }
  });
});

describe('asking whether a console is on', () => {
  const answer = (state: 'ready' | 'standby') => async () => ({ hosts: [{ address: '192.168.1.50', state, statusCode: state === 'ready' ? 200 : 620, isPs5: true, target: 'ps5-1' as const }] });

  it('maps what the console says', async () => {
    assert.equal(await probePresence('192.168.1.50', answer('ready') as never), 'ready');
    assert.equal(await probePresence('192.168.1.50', answer('standby') as never), 'standby');
  });

  it('says absent after two silent probes, and recovers from one lost probe', async () => {
    let calls = 0;
    assert.equal(await probePresence('192.168.1.50', (async () => (calls++, { hosts: [] })) as never), 'absent');
    assert.equal(calls, 2);
    let n = 0;
    assert.equal(await probePresence('192.168.1.50', (async () => ({ hosts: n++ === 0 ? [] : (await answer('standby')()).hosts })) as never), 'standby');
  });

  it('treats a failing probe as silence', async () => {
    const failing = async (): Promise<never> => {
      throw new Error('network is down');
    };
    assert.equal(await probePresence('192.168.1.50', failing as never), 'absent');
  });
});

/** Console states in turn (the last for ever) on a clock that only sleeping moves; the datagrams sent are recorded. */
function world(states: Presence[], sendFails = false): { deps: WakeDeps; sent: number[]; now: () => number } {
  let t = 0;
  let i = 0;
  const sent: number[] = [];
  return {
    sent,
    now: () => t,
    deps: {
      probe: async () => states[Math.min(i++, states.length - 1)]!,
      send: async () => {
        if (sendFails) throw Object.assign(new Error('x'), { code: 'ENETUNREACH' });
        sent.push(t);
      },
      sleep: async (ms) => void (t += ms),
      now: () => t,
    },
  };
}
const target = { host: '192.168.1.50', target: 'ps5-1' as const, registKey: stored('1f2e3d4c') };

describe('waking and waiting', () => {
  it('does nothing for a console that is on', async () => {
    const w = world(['ready']);
    assert.deepEqual(await wakeConsole(target, {}, w.deps), { result: 'already-on' });
    assert.equal(w.sent.length, 0);
  });

  it('does nothing for a console that does not answer: there is nothing to wake', async () => {
    const w = world(['absent']);
    assert.deepEqual(await wakeConsole(target, {}, w.deps), { result: 'absent' });
    assert.equal(w.sent.length, 0);
  });

  it('wakes a sleeping console and reports the seconds until it said ready', async () => {
    const w = world(['standby', 'standby', 'standby', 'ready']);
    const seen: Array<[Presence, number]> = [];
    let signalled = 0;
    const r = await wakeConsole(target, { pollMs: 1000, settleMs: 500, onSent: () => signalled++, onState: (p, s) => seen.push([p, s]) }, w.deps);
    assert.deepEqual(r, { result: 'woke', seconds: 3 });
    assert.equal(signalled, 1);
    assert.deepEqual(seen, [['standby', 1], ['standby', 2], ['ready', 3]]);
    assert.equal(w.sent.length, 1);
    assert.equal(w.now(), 3500, 'it paused 500 ms after the first ready before handing the console on');
  });

  it('sends the datagram again every few seconds while the console still sleeps', async () => {
    const w = world(['standby']);
    const r = await wakeConsole(target, { timeoutMs: 20_000, pollMs: 1000, resendMs: 8000 }, w.deps);
    assert.equal(r.result, 'timeout');
    assert.deepEqual(w.sent, [0, 8000, 16000]);
  });

  it('does not send again while the console is starting up and silent', async () => {
    const w = world(['standby', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent', 'ready']);
    const r = await wakeConsole(target, { pollMs: 1000, resendMs: 3000, settleMs: 0 }, w.deps);
    assert.equal(r.result, 'woke');
    assert.equal(w.sent.length, 1, 'only "standby" asks for another datagram');
  });

  it('times out after the time allowed', async () => {
    const w = world(['standby']);
    assert.deepEqual(await wakeConsole(target, { timeoutMs: 5000, pollMs: 1000 }, w.deps), { result: 'timeout', seconds: 5 });
  });

  it('stops when told to, without another probe', async () => {
    const w = world(['standby']);
    let stop = false;
    const r = await wakeConsole(target, { pollMs: 1000, stopped: () => stop, onState: (_p, s) => (stop = s >= 2) }, w.deps);
    assert.deepEqual(r, { result: 'cancelled' });
  });

  it('reports a key it cannot use and a datagram it cannot send, instead of throwing', async () => {
    const w = world(['standby']);
    const bad = await wakeConsole({ ...target, registKey: stored('abcdefgh') }, {}, w.deps);
    assert.equal(bad.result, 'error');
    assert.equal(w.sent.length, 0);
    const down = await wakeConsole(target, {}, world(['standby'], true).deps);
    assert.equal(down.result, 'error');
    assert.match((down as { message: string }).message, /ENETUNREACH/);
  });

  it('marks a PS4 as a PS4 when sending', async () => {
    let flag: boolean | undefined;
    const deps: WakeDeps = { ...world(['standby', 'ready']).deps, send: async (_h, _c, ps5) => void (flag = ps5) };
    await wakeConsole({ ...target, target: 'ps4-10' }, { settleMs: 0 }, deps);
    assert.equal(flag, false);
  });
});

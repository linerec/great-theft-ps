// SPDX-License-Identifier: AGPL-3.0-only
//
// The stand-in for a worse network: everything arrives, in order, later; sometimes nothing arrives for a while and
// then all at once; and no more per second than the line carries. Time is stepped by hand here.

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeLink } from './support/fake-link.ts';
import { DelayLine, LINK_PROFILES, parseLinkSim, type LinkProfile } from '../src/bridge/linksim.ts';
import { decodePong, encodePing, MSG } from '../src/bridge/protocol.ts';
import { startBridge } from '../src/bridge/server.ts';

/** A clock and timers that only move when told to. */
function world(randomValues: number[] = [0.5]) {
  let now = 0;
  let r = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let ids = 0;
  return {
    options: {
      now: () => now,
      random: () => randomValues[r++ % randomValues.length]!,
      setTimer: (fn: () => void, ms: number) => {
        const id = ++ids;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimer: (h: unknown) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    /** Move time forward, running whatever comes due on the way. */
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        next.fn();
      }
      now = end;
    },
    get now() {
      return now;
    },
  };
}
const plain: LinkProfile = { delayMs: 40, jitterMs: 0, stallMs: 0, stallEveryMs: 0, kbps: 0 };

describe('link simulator: one direction', () => {
  it('delivers everything later by the delay, in the order it was sent', () => {
    const w = world();
    const got: Array<[number, string]> = [];
    const line = new DelayLine<string>(plain, (x) => got.push([w.now, x]), w.options);
    line.push('a', 100);
    w.advance(10);
    line.push('b', 100);
    w.advance(100);
    assert.deepEqual(got, [[40, 'a'], [50, 'b']]);
    assert.equal(line.queuedBytes, 0);
  });

  it('adds a different amount to each message but never lets one overtake another', () => {
    const w = world([0.9, 0.1, 0.5]); // the first is held longest
    const got: Array<[number, string]> = [];
    const line = new DelayLine<string>({ ...plain, jitterMs: 50 }, (x) => got.push([w.now, x]), w.options);
    line.push('a', 1); // 40 + 45 = 85
    line.push('b', 1); // 40 + 5 = 45, but not before a
    w.advance(5);
    line.push('c', 1); // 5 + 40 + 25 = 70, but not before a
    w.advance(200);
    assert.deepEqual(got.map(([, x]) => x), ['a', 'b', 'c']);
    assert.deepEqual(got.map(([t]) => t), [85, 85, 85], 'the later ones come right behind the one that held them up');
  });

  it('lets through no more per second than the line carries, and says how much is waiting', () => {
    const w = world();
    const got: number[] = [];
    // 800 kbit/s = 100 bytes per ms: a 10 000 byte message takes 100 ms of the line.
    const line = new DelayLine<number>({ ...plain, delayMs: 0, kbps: 800 }, () => got.push(w.now), w.options);
    for (let i = 0; i < 3; i++) line.push(i, 10_000);
    assert.equal(line.queuedBytes, 30_000);
    w.advance(1);
    assert.deepEqual(got, [0], 'the first goes at once');
    assert.equal(line.queuedBytes, 20_000);
    w.advance(300);
    assert.deepEqual(got, [0, 100, 200]);
  });

  it('stalls now and then: nothing for a while, then everything that was held up at once', () => {
    // random 0.5 makes every gap exactly the mean: a stall of 300 ms starting at 1000, the next at 2300.
    const w = world([0.5]);
    const got: Array<[number, number]> = [];
    const line = new DelayLine<number>({ delayMs: 20, jitterMs: 0, stallMs: 300, stallEveryMs: 1000, kbps: 0 }, (x) => got.push([Math.round(w.now), x]), w.options);
    for (let t = 0; t < 1600; t += 100) {
      line.push(t, 10);
      w.advance(100);
    }
    w.advance(500);
    const at = new Map(got.map(([when, sent]) => [sent, when]));
    assert.equal(at.get(900), 920, 'before the stall: as usual');
    assert.equal(at.get(1000), 1300, 'sent into the stall: out when it ends');
    assert.equal(at.get(1100), 1300);
    assert.equal(at.get(1200), 1300, 'three messages at the same moment: the burst');
    assert.equal(at.get(1300), 1320, 'and as usual again afterwards');
    assert.deepEqual(line.stalls[0], [1000, 1300]);
    assert.deepEqual(got.map(([, x]) => x), [...got.map(([, x]) => x)].sort((a, b) => a - b), 'still in order');
  });

  it('drops what is waiting when it is closed, and takes nothing more', () => {
    const w = world();
    const got: string[] = [];
    const line = new DelayLine<string>(plain, (x) => got.push(x), w.options);
    line.push('a', 5);
    line.close();
    line.push('b', 5);
    w.advance(500);
    assert.deepEqual(got, []);
    assert.equal(line.queuedBytes, 0);
  });
});

describe('link simulator: in the bridge', () => {
  it('holds back what goes to the page and what comes from it, so a ping takes both ways', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const way: LinkProfile = { delayMs: 60, jitterMs: 0, stallMs: 0, stallEveryMs: 0, kbps: 0 };
    const bridge = await startBridge({ host: '127.0.0.1', port: 0, root, createLink: () => new FakeLink(), linkSim: { note: 'test', down: way, up: way } });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`);
      ws.binaryType = 'arraybuffer';
      const frames: number[] = [];
      const rtts: number[] = [];
      let ready = false;
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          if ((JSON.parse(e.data) as { type?: string }).type === 'ready') ready = true;
          return;
        }
        const bytes = new Uint8Array(e.data as ArrayBuffer);
        const pong = bytes[0] === MSG.PONG ? decodePong(bytes) : null;
        if (pong) rtts.push(performance.now() - pong.clientTime);
        if (bytes[0] === MSG.VIDEO) frames.push(performance.now());
      };
      await new Promise<void>((resolve, reject) => ((ws.onopen = () => resolve()), (ws.onerror = () => reject(new Error('ws error')))));
      ws.send(JSON.stringify({ type: 'hello', client: 'test' }));
      for (let i = 0; i < 200 && !ready; i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(ready, 'the hello gets through the link too');
      // Three pings: on a busy machine (the whole suite runs at once) one of them can be held up by something else, and the
      // fastest is the one that says what the link does.
      for (let k = 0; k < 3; k++) {
        ws.send(encodePing(performance.now()));
        await new Promise((r) => setTimeout(r, 150));
      }
      for (let i = 0; i < 100 && rtts.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(rtts.length >= 1, 'a pong comes back');
      const rtt = Math.min(...rtts);
      assert.ok(rtt >= 115 && rtt < 400, `a round trip of ${rtt.toFixed(0)} ms through 60 ms each way`);
      for (let i = 0; i < 100 && frames.length < 5; i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(frames.length >= 5, 'video still flows');
      ws.close();
    } finally {
      await bridge.close();
    }
  });
});

describe('link simulator: profiles', () => {
  it('has named profiles for both directions, each saying that its numbers are assumed', () => {
    for (const [name, p] of Object.entries(LINK_PROFILES)) {
      assert.match(p.note, /assumed/, name);
      assert.ok(p.down.kbps >= p.up.kbps, `${name}: a mobile line carries more down than up`);
      assert.ok(p.down.delayMs > 0 && p.down.stallMs > 0);
    }
    assert.equal(parseLinkSim('lte-average'), LINK_PROFILES['lte-average']);
  });

  it('takes five numbers instead of a name, and refuses anything else', () => {
    assert.deepEqual(parseLinkSim('30,20,400,10000,5000')!.down, { delayMs: 30, jitterMs: 20, stallMs: 400, stallEveryMs: 10000, kbps: 5000 });
    for (const bad of ['', 'wifi', '1,2,3', '1,2,3,4,x', '1,2,3,4,-5']) assert.equal(parseLinkSim(bad), null, bad);
  });
});

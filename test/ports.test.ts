// SPDX-License-Identifier: AGPL-3.0-only
//
// Finding a port for the bridge when nobody asked for one (src/bridge/ports.ts).

import assert from 'node:assert/strict';
import net from 'node:net';
import { after, describe, it } from 'node:test';

import { firstFreePort, portInUse, probeHostFor } from '../src/bridge/ports.ts';

const servers: net.Server[] = [];
after(() => servers.forEach((s) => s.close()));

/** Take a port on loopback; returns it. */
function take(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      servers.push(s);
      resolve((s.address() as net.AddressInfo).port);
    });
  });
}

/** A port nothing has right now. */
async function spare(): Promise<number> {
  const s = net.createServer();
  const port = await new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port)));
  await new Promise((resolve) => s.close(resolve));
  return port;
}

describe('which address to ask about', () => {
  it('asks loopback about "all addresses" and the address itself otherwise', () => {
    assert.equal(probeHostFor('0.0.0.0'), '127.0.0.1');
    assert.equal(probeHostFor('::'), '127.0.0.1');
    assert.equal(probeHostFor('127.0.0.1'), '127.0.0.1');
    assert.equal(probeHostFor('100.64.0.2'), '100.64.0.2');
  });
});

describe('first free port', () => {
  it('gives the port asked for when it is free', async () => {
    const p = await spare();
    assert.equal(await portInUse('127.0.0.1', p), false);
    assert.equal(await firstFreePort('127.0.0.1', p), p);
  });

  it('moves on to the next one when the first is taken, and on again when that one is too', async () => {
    const a = await take();
    const found = await firstFreePort('127.0.0.1', a);
    assert.ok(found !== null && found > a && found < a + 20);
    assert.equal(await portInUse('127.0.0.1', found!), false);
    // Take the one it found as well: the answer moves past it.
    let second: number | null = null;
    try {
      await take(found!);
      second = await firstFreePort('127.0.0.1', a);
    } catch {
      /* the port was taken by someone else in between: the first half of the test stands */
    }
    if (second !== null) assert.ok(second > found!);
  });

  it('gives up with null when none of the few it looks at is free', async () => {
    const a = await take();
    assert.equal(await firstFreePort('127.0.0.1', a, 1), null);
  });
});

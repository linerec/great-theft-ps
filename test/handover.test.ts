// SPDX-License-Identifier: AGPL-3.0-only
//
// Handing the console over between this project's own clients: an unlocked client lets go when asked, a locked one
// says so and stays, and nobody without the same registration can read a signal or make a client let go.
// Everything here runs on 127.0.0.1 with the clients pointed at each other; nothing is sent to a network.

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { broadcastTargets, Handover, type HandoverTarget } from '../src/bridge/handover.ts';
import type { RegisteredConsole } from '../src/console/regist.ts';
import { ConsoleStore } from '../src/console/store.ts';

const dirs: string[] = [];
const open: Handover[] = [];
const sockets: dgram.Socket[] = [];
after(() => {
  for (const h of open) h.close();
  for (const s of sockets) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const MAC = '0123456789ab';
const reg = (rpKey: string): RegisteredConsole => ({ target: 'ps5-1', mac: MAC, nickname: 'Living room', registKey: Buffer.from('61626364656667680000000000000000', 'hex'), rpKeyType: 2, rpKey: Buffer.from(rpKey, 'hex') });
const SAME = '00112233445566778899aabbccddeeff';
const OTHER = 'ffeeddccbbaa99887766554433221100';

function storeWith(rpKey: string | null): ConsoleStore {
  const d = mkdtempSync(path.join(tmpdir(), 'gtp-handover-'));
  dirs.push(d);
  const s = new ConsoleStore(path.join(d, 'consoles.json'));
  if (rpKey) s.put(reg(rpKey), '192.168.1.50');
  return s;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** A client on 127.0.0.1 that sends its requests to the given ports. */
async function client(name: string, rpKey: string | null, o: { port?: number; targets?: () => HandoverTarget[]; now?: () => number; announceMs?: number } = {}): Promise<Handover> {
  const port = o.port ?? (await freePort());
  // No targets given: this client's own requests and announcements reach nobody (on a real network they are broadcast).
  const h = new Handover({ store: storeWith(rpKey), name, port, bind: '127.0.0.1', targets: o.targets ?? (() => []), announceMs: o.announceMs ?? 60_000, ...(o.now ? { now: o.now } : {}) });
  await h.start();
  open.push(h);
  return h;
}
const to = (...clients: Handover[]) => (): HandoverTarget[] => clients.map((c) => ({ address: '127.0.0.1', port: c.port }));

describe('handing the console over between this project\'s clients', () => {
  it('an unlocked client lets go when another one asks, once', async () => {
    const holder = await client('Desk PC', SAME);
    const asker = await client('Mac Studio', SAME, { targets: to(holder) });
    const released: string[] = [];
    holder.hold(MAC, { locked: false, release: (by) => released.push(by) });
    assert.deepEqual(holder.status().holding, [{ mac: MAC, locked: false }]);

    const answer = await asker.ask(MAC);
    assert.deepEqual(answer, { result: 'yielded', name: 'Desk PC' });
    assert.deepEqual(released, ['Mac Studio'], 'told who asked; and although the request is sent twice, it let go once');
    assert.deepEqual(holder.status().holding, []);
    // Nobody has it now: asking again gets no answer.
    assert.deepEqual(await asker.ask(MAC, 200), { result: 'none' });
  });

  it('a locked client says so and stays; unlocking it lets the next request through', async () => {
    const holder = await client('Desk PC', SAME);
    const asker = await client('Mac Studio', SAME, { targets: to(holder) });
    let released = 0;
    holder.hold(MAC, { locked: true, release: () => released++ });
    assert.deepEqual(await asker.ask(MAC), { result: 'locked', name: 'Desk PC' });
    assert.equal(released, 0);
    holder.setLocked(MAC, false);
    assert.equal((await asker.ask(MAC)).result, 'yielded');
    assert.equal(released, 1);
  });

  it('works when the client that has the console cannot be spoken to first: it announces itself, and the request comes back as an answer', async () => {
    // A firewall in front of the holder: the asker's own request reaches nobody. The holder's announcements go out, though.
    const asker = await client('Mac Studio', SAME);
    const holder = await client('Desk PC', SAME, { targets: to(asker), announceMs: 40 });
    const released: string[] = [];
    holder.hold(MAC, { locked: false, release: (by) => released.push(by) });
    assert.deepEqual(await asker.ask(MAC, 1500), { result: 'yielded', name: 'Desk PC' });
    assert.deepEqual(released, ['Mac Studio']);

    // A locked holder's announcement says so, and that settles it without a request.
    const locked = await client('Desk PC', SAME, { targets: to(asker), announceMs: 40 });
    let let_go = 0;
    locked.hold(MAC, { locked: true, release: () => let_go++ });
    assert.deepEqual(await asker.ask(MAC, 1500), { result: 'locked', name: 'Desk PC' });
    assert.equal(let_go, 0);

    // Announcements for a console nobody here is waiting for do nothing.
    const bystander = await client('Laptop', SAME);
    const loud = await client('Desk PC', SAME, { targets: to(bystander), announceMs: 30 });
    let moved = 0;
    loud.hold(MAC, { locked: false, release: () => moved++ });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(moved, 0);
  });

  it('says who has the console without changing anything', async () => {
    const holder = await client('Desk PC', SAME);
    const other = await client('Mac Studio', SAME, { targets: to(holder) });
    let released = 0;
    assert.deepEqual(await other.who(MAC, 200), [], 'nobody yet');
    holder.hold(MAC, { locked: true, release: () => released++ });
    assert.deepEqual(await other.who(MAC, 200), [{ name: 'Desk PC', locked: true }]);
    holder.setLocked(MAC, false);
    assert.deepEqual(await other.who(MAC, 200), [{ name: 'Desk PC', locked: false }]);
    assert.equal(released, 0, 'asking who has it lets nobody go');
    assert.deepEqual(await (await client('Someone else', OTHER, { targets: to(holder) })).who(MAC, 200), [], 'not for those without the registration');
  });

  it('a client that no longer has the console is not asked to do anything', async () => {
    const holder = await client('Desk PC', SAME);
    const asker = await client('Mac Studio', SAME, { targets: to(holder) });
    let released = 0;
    const done = holder.hold(MAC, { locked: false, release: () => released++ });
    done();
    assert.deepEqual(await asker.ask(MAC, 200), { result: 'none' });
    assert.equal(released, 0);
  });

  it('cannot be read or used without the same registration', async () => {
    const holder = await client('Desk PC', SAME);
    let released = 0;
    holder.hold(MAC, { locked: false, release: () => released++ });

    // A client that registered separately has other keys: it gets no answer and moves nothing.
    const stranger = await client('Someone else', OTHER, { targets: to(holder) });
    assert.deepEqual(await stranger.ask(MAC, 250), { result: 'none' });
    // One without any registration cannot even form a request.
    const empty = await client('Nobody', null, { targets: to(holder) });
    assert.deepEqual(await empty.ask(MAC, 100), { result: 'none' });
    assert.equal(released, 0);

    // What goes over the wire shows neither the names nor the console.
    const tap = dgram.createSocket('udp4');
    sockets.push(tap);
    const seen: Buffer[] = [];
    tap.on('message', (m) => seen.push(m));
    await new Promise<void>((r) => tap.bind(0, '127.0.0.1', () => r()));
    const friend = await client('Mac Studio', SAME, { targets: () => [{ address: '127.0.0.1', port: tap.address().port }] });
    await friend.ask(MAC, 150);
    assert.ok(seen.length >= 1);
    const wire = seen[0]!.toString('latin1');
    assert.ok(!wire.includes('Mac Studio') && !wire.includes(MAC) && !wire.includes('ask'), 'nothing readable in the datagram');
  });

  it('ignores a signal that was changed, recorded and sent again, or is not fresh', async () => {
    let released = 0;
    const holder = await client('Desk PC', SAME);
    holder.hold(MAC, { locked: false, release: () => released++ });

    // Record a real request on its way.
    const tap = dgram.createSocket('udp4');
    sockets.push(tap);
    const recorded: Buffer[] = [];
    tap.on('message', (m) => recorded.push(Buffer.from(m)));
    await new Promise<void>((r) => tap.bind(0, '127.0.0.1', () => r()));
    const asker = await client('Mac Studio', SAME, { targets: () => [{ address: '127.0.0.1', port: tap.address().port }] });
    await asker.ask(MAC, 120);
    const real = recorded[0]!;
    const send = (data: Buffer): Promise<void> => new Promise((r) => tap.send(data, holder.port, '127.0.0.1', () => setTimeout(r, 60)));

    // One bit changed: it does not open.
    const changed = Buffer.from(real);
    changed[changed.length - 20]! ^= 1;
    await send(changed);
    assert.equal(released, 0);
    // Rubbish, and something far too long.
    await send(Buffer.from('GTPH\x01 not really'));
    await send(Buffer.alloc(5000, 1));
    assert.equal(released, 0);

    // The real one works once...
    await send(real);
    assert.equal(released, 1);
    // ...and sending the recording again does nothing, even though the client has the console again.
    holder.hold(MAC, { locked: false, release: () => released++ });
    await send(real);
    assert.equal(released, 1);

    // A request made three minutes ago (by the holder's clock) is too old to act on.
    let clock = Date.now();
    const late = await client('Desk PC 2', SAME, { now: () => clock });
    let lateReleased = 0;
    late.hold(MAC, { locked: false, release: () => lateReleased++ });
    clock += 3 * 60 * 1000;
    const again = await client('Mac Studio', SAME, { targets: to(late) });
    assert.deepEqual(await again.ask(MAC, 200), { result: 'none' });
    assert.equal(lateReleased, 0);
  });

  it('still works for asking when its listening port is taken, and says that it cannot be asked', async () => {
    const taken = dgram.createSocket('udp4'); // without address reuse: the port cannot be shared
    sockets.push(taken);
    await new Promise<void>((r) => taken.bind(0, '127.0.0.1', () => r()));
    const holder = await client('Desk PC', SAME);
    holder.hold(MAC, { locked: false, release: () => {} });
    const lines: string[] = [];
    const h = new Handover({ store: storeWith(SAME), name: 'Mac Studio', port: taken.address().port, bind: '127.0.0.1', targets: to(holder), announceMs: 60_000, log: (l) => lines.push(l) });
    await h.start();
    open.push(h);
    assert.equal(h.listening, false);
    assert.match(lines.join('\n'), /could not listen/);
    assert.equal((await h.ask(MAC)).result, 'yielded');
  });

  it('finds the broadcast address of a network from its address and mask', () => {
    for (const t of broadcastTargets(47876)) {
      assert.equal(t.port, 47876);
      assert.match(t.address, /^\d+\.\d+\.\d+\.\d+$/);
      assert.notEqual(t.address, '127.255.255.255', 'the loopback interface is left out');
    }
  });
});

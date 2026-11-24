// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { DevReload } from '../src/bridge/devreload.ts';

const fakeRes = (): { res: any; written: string[]; head: any } => {
  const written: string[] = [];
  const out = { head: undefined as any };
  const res = { writeHead: (_s: number, h: unknown) => (out.head = h), write: (t: string) => written.push(t), end: () => written.push('<end>') };
  return { res, written, head: out };
};
const fakeReq = (): any => new EventEmitter();
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('live reload', () => {
  it('tells every open page to reload once, after the changes have settled', async () => {
    let fire: () => void = () => {};
    const d = new DevReload({ dirs: ['web'], debounceMs: 30, watchFn: (_dir, onChange) => ((fire = onChange), { close() {} }) });
    const a = fakeRes();
    const b = fakeRes();
    d.handle(fakeReq(), a.res);
    d.handle(fakeReq(), b.res);
    assert.equal(a.head.head['Content-Type'], 'text/event-stream');
    assert.equal(d.listeners, 2);
    for (let i = 0; i < 5; i++) fire(); // an editor saves in several steps
    assert.deepEqual(a.written.filter((w) => w.includes('reload')), [], 'not at once');
    await tick(80);
    assert.deepEqual(a.written.filter((w) => w.includes('reload')), ['data: reload\n\n'], 'one message, not five');
    assert.deepEqual(b.written.filter((w) => w.includes('reload')), ['data: reload\n\n']);
    d.close();
  });

  it('forgets a page that went away, and ends the rest when closed', async () => {
    let fire: () => void = () => {};
    const d = new DevReload({ dirs: ['web'], debounceMs: 10, watchFn: (_dir, onChange) => ((fire = onChange), { close() {} }) });
    const gone = fakeRes();
    const stays = fakeRes();
    const goneReq = fakeReq();
    d.handle(goneReq, gone.res);
    d.handle(fakeReq(), stays.res);
    goneReq.emit('close');
    assert.equal(d.listeners, 1);
    fire();
    await tick(40);
    assert.ok(!gone.written.some((w) => w.includes('reload')));
    assert.ok(stays.written.some((w) => w.includes('reload')));
    d.close();
    assert.equal(stays.written.at(-1), '<end>');
    assert.equal(d.listeners, 0);
  });

  it('watches real folders without failing when one cannot be watched', () => {
    const d = new DevReload({ dirs: ['/this/folder/does/not/exist'] });
    assert.equal(d.listeners, 0);
    d.close();
  });
});

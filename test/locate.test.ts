// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DiscoveredHost } from '../src/console/discovery.ts';
import { locateConsole, type LocateDeps } from '../src/console/locate.ts';

const host = (address: string, hostId?: string): DiscoveredHost => ({ address, state: 'standby', isPs5: true, target: 'ps5-1', ...(hostId ? { hostId } : {}) }) as DiscoveredHost;
const MAC = '00aa11bb22cc';
const deps = (o: { ask?: DiscoveredHost | null; search?: DiscoveredHost[] }): LocateDeps & { searches: number } => {
  const d = { searches: 0, ask: async () => o.ask ?? null, search: async () => (d.searches++, o.search ?? []) };
  return d;
};

describe('finding a console again', () => {
  it('says it is here when it answers at the stored address as itself, without searching the network', async () => {
    const d = deps({ ask: host('192.168.1.50', MAC.toUpperCase()) });
    assert.deepEqual(await locateConsole({ mac: MAC, host: '192.168.1.50' }, d), { result: 'here' });
    assert.equal(d.searches, 0);
  });

  it('counts an answer without an id as the console (nothing to tell it apart by)', async () => {
    const d = deps({ ask: host('192.168.1.50') });
    assert.deepEqual(await locateConsole({ mac: MAC, host: '192.168.1.50' }, d), { result: 'here' });
  });

  it('finds the console at its new address when the old one is silent', async () => {
    const d = deps({ ask: null, search: [host('192.168.1.9', 'aaaaaaaaaaaa'), host('192.168.1.77', MAC)] });
    assert.deepEqual(await locateConsole({ mac: MAC, host: '192.168.1.50' }, d), { result: 'moved', host: '192.168.1.77' });
  });

  it('does not take another console that now answers at the old address for this one', async () => {
    const d = deps({ ask: host('192.168.1.50', 'bbbbbbbbbbbb'), search: [host('192.168.1.50', 'bbbbbbbbbbbb'), host('192.168.1.77', MAC)] });
    assert.deepEqual(await locateConsole({ mac: MAC, host: '192.168.1.50' }, d), { result: 'moved', host: '192.168.1.77' });
  });

  it('says absent when nothing answers as that console anywhere (it is shut down, or not on this network)', async () => {
    const d = deps({ ask: null, search: [host('192.168.1.9', 'aaaaaaaaaaaa')] });
    assert.deepEqual(await locateConsole({ mac: MAC, host: '192.168.1.50' }, d), { result: 'absent' });
  });

  it('says here when the search finds it at the stored address after all (a lost first answer)', async () => {
    const d = deps({ ask: null, search: [host('192.168.1.50', MAC)] });
    assert.deepEqual(await locateConsole({ mac: MAC, host: '192.168.1.50' }, d), { result: 'here' });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// Finding a registered console again when its address has changed. This project's own.
//
// A registration is kept with the address the console had when it was made. A home router hands addresses out
// for a day at a time and may give another one the next time (and not every router can be told to keep one for a
// console). The console answers a search on the local network with its own id, the same id the registration is kept
// under, so the registration can follow the console: ask the stored address first, and when nothing answers there
// as that console, search the network for the id.
//
// A console that is shut down (not in rest mode) answers nothing at all; that is "absent" and says nothing about
// where it is.

import { discover as realDiscover, type DiscoveredHost } from './discovery.ts';

export type Located = { result: 'here' } | { result: 'moved'; host: string } | { result: 'absent' };

export interface LocateDeps {
  /** What answers a search sent to this one address, if anything. */
  ask(host: string): Promise<DiscoveredHost | null>;
  /** Everything on the local network that answers a search. */
  search(): Promise<DiscoveredHost[]>;
}

export const realLocateDeps: LocateDeps = {
  ask: async (host) => {
    const answer = await realDiscover({ hosts: [host], timeoutMs: 1200 }).catch(() => null);
    return answer?.hosts.find((h) => h.address === host) ?? answer?.hosts[0] ?? null;
  },
  search: async () => (await realDiscover({ timeoutMs: 2500 }).catch(() => ({ hosts: [] as DiscoveredHost[] }))).hosts,
};

const sameId = (found: string | undefined, mac: string): boolean => (found ?? '').toLowerCase() === mac.toLowerCase();

/** Is the console of this registration where the registration says, and if not, where is it? */
export async function locateConsole(rec: { mac: string; host: string }, deps: LocateDeps = realLocateDeps): Promise<Located> {
  const here = await deps.ask(rec.host);
  // An answer without an id cannot be told apart from another console, so it counts as this one (as before).
  if (here && (here.hostId === undefined || sameId(here.hostId, rec.mac))) return { result: 'here' };
  const everything = await deps.search();
  const found = everything.find((h) => sameId(h.hostId, rec.mac));
  if (!found) return { result: 'absent' };
  return found.address === rec.host ? { result: 'here' } : { result: 'moved', host: found.address };
}

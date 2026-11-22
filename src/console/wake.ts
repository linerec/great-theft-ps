// SPDX-License-Identifier: AGPL-3.0-only
//
// Waking a console that is in rest mode, and waiting until it answers. This project's own, on top of discovery.ts (the
// WAKEUP packet itself is ported from chiaki-ng; see there).
//
// How a console in rest mode shows itself: it still answers the discovery probe, with state "standby" (HTTP 620), as
// long as its rest-mode settings let the network reach it. It is woken by one UDP datagram to port 9302 (PS5) or 987
// (PS4) that carries the credential made from the registration key (credentialFromStoredKey). The console needs
// "Enable Turning on PS5 from Network" (PS4: "Enable Turning on PS4 from Network") in its rest-mode settings; without it
// the datagram is ignored, and that is not something this side can see.
//
// A console that does not answer the probe at all is not in rest mode with the network on: it is shut down, or not at
// that address. There is nothing to wake, so this says so and leaves the rest to the caller.
//
// STATUS: the packet is checked against the reference's format and a simulated console; the waiting logic is tested
// with a replaced clock. NOT yet sent to a real console. What to look at on the first real try: how long "standby"
// lasts after the packet, whether the console answers the probe while it starts up, and whether it takes a session
// request right when it first says "ready" (settleMs is a guess).

import { credentialFromStoredKey, discover, wakeup } from './discovery.ts';
import { isPs5Target } from './rpcrypt.ts';
import type { KnownTarget } from './rpcrypt.ts';

export type Presence = 'ready' | 'standby' | 'absent';

/** What is needed of a stored registration to wake its console. The key stays in memory only, never logged. */
export interface WakeTarget {
  host: string;
  target: KnownTarget;
  /** `registKey` as the console store keeps it: the key bytes as hexadecimal. */
  registKey: string;
}

export interface WakeDeps {
  probe(host: string): Promise<Presence>;
  send(host: string, credential: bigint, ps5: boolean): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Ask the console's address directly whether it is on, asleep, or silent. A lost probe gets one more try. */
export async function probePresence(host: string, discoverFn: typeof discover = discover): Promise<Presence> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await discoverFn({ hosts: [host], timeoutMs: 1200 }).catch(() => null);
    const found = answer?.hosts.find((h) => h.address === host) ?? answer?.hosts[0];
    if (found) return found.state === 'ready' ? 'ready' : 'standby';
  }
  return 'absent';
}

export const realWakeDeps: WakeDeps = {
  probe: (host) => probePresence(host),
  send: (host, credential, ps5) => wakeup(host, credential, ps5),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export interface WakeOptions {
  /** How long to wait for the console to say "ready" after the first datagram. Default 60 s. */
  timeoutMs?: number;
  /** How often to ask. Default 1500 ms. */
  pollMs?: number;
  /** The datagram can get lost, so it is sent again this often while the console still sleeps. Default 8 s. */
  resendMs?: number;
  /** A pause after the console first says "ready", before anything else is asked of it. Default 1500 ms (a guess). */
  settleMs?: number;
  /** Called once, right after the first datagram has been sent. */
  onSent?: () => void;
  /** Called after every answer while waiting, with the seconds since the datagram. */
  onState?: (presence: Presence, seconds: number) => void;
  /** Return true to give up waiting (the person disconnected). */
  stopped?: () => boolean;
}

export type WakeResult =
  | { result: 'already-on' }
  | { result: 'absent' }
  | { result: 'woke'; seconds: number }
  | { result: 'timeout'; seconds: number }
  | { result: 'cancelled' }
  | { result: 'error'; message: string };

/** Wake the console if it is in rest mode, and wait until it says "ready". Never throws. */
export async function wakeConsole(target: WakeTarget, options: WakeOptions = {}, deps: WakeDeps = realWakeDeps): Promise<WakeResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 1500;
  const resendMs = options.resendMs ?? 8000;
  const settleMs = options.settleMs ?? 1500;
  const ps5 = isPs5Target(target.target);

  let presence = await deps.probe(target.host);
  if (options.stopped?.()) return { result: 'cancelled' };
  if (presence === 'ready') return { result: 'already-on' };
  if (presence === 'absent') return { result: 'absent' };

  let credential: bigint;
  try {
    credential = credentialFromStoredKey(target.registKey);
  } catch (error) {
    return { result: 'error', message: (error as Error).message };
  }
  const startedAt = deps.now();
  let lastSent = startedAt;
  try {
    await deps.send(target.host, credential, ps5);
  } catch (error) {
    return { result: 'error', message: `the wake-up datagram could not be sent: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
  }
  options.onSent?.();

  while (deps.now() - startedAt < timeoutMs) {
    await deps.sleep(pollMs);
    if (options.stopped?.()) return { result: 'cancelled' };
    presence = await deps.probe(target.host);
    const seconds = Math.round((deps.now() - startedAt) / 1000);
    options.onState?.(presence, seconds);
    if (presence === 'ready') {
      await deps.sleep(settleMs);
      return { result: 'woke', seconds };
    }
    // "absent" while waiting is normal: a console that is starting up may not answer for a few seconds.
    if (presence === 'standby' && deps.now() - lastSent >= resendMs) {
      lastSent = deps.now();
      await deps.send(target.host, credential, ps5).catch(() => {});
    }
  }
  return { result: 'timeout', seconds: Math.round((deps.now() - startedAt) / 1000) };
}

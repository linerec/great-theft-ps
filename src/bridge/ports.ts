// SPDX-License-Identifier: AGPL-3.0-only
//
// Port helpers for starting the bridge.

import net from 'node:net';

/**
 * True if something already accepts connections on host:port.
 *
 * Why this exists: on some systems a server bound to one address (127.0.0.1) can start while another program holds
 * the same port on all addresses, and the two silently split the traffic by destination address. Connecting first
 * catches that before the bridge starts.
 */
export function portInUse(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (inUse: boolean): void => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** The host to connect to when asking whether a port is taken: a program on "all addresses" answers on loopback. */
export const probeHostFor = (host: string): string => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);

/**
 * The first port from `start` on that nothing answers on, looking at most `tries` ports far. Used when nobody asked for
 * a particular port, so that `npm run dev` works on a computer where the usual one is taken. Null when all are taken.
 */
export async function firstFreePort(host: string, start: number, tries = 20): Promise<number | null> {
  const probe = probeHostFor(host);
  for (let port = start; port < start + tries && port <= 65535; port++) {
    if (!(await portInUse(probe, port))) return port;
  }
  return null;
}

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

// SPDX-License-Identifier: AGPL-3.0-only
//
// Finding PlayStation consoles on the local network, and waking one from rest mode.
//
// Derived from chiaki-ng (https://github.com/chiaki-ng/chiaki-ng, AGPL-3.0-only with an OpenSSL exception):
// lib/src/discovery.c, lib/include/chiaki/discovery.h and lib/src/http.c (commit 43728af). The packet formats,
// ports, protocol version strings, response codes and header names below are transcribed from there.
//
// STATUS: verified against a simulated console in tests only. It has NOT been run against a real PlayStation.
// Run `npm run discover` on the network where the console is and report what it prints.

import dgram from 'node:dgram';
import os from 'node:os';

export const DISCOVERY = {
  ps4: { port: 987, version: '00020020' },
  ps5: { port: 9302, version: '00030010' },
  /** The reference client first tries local ports 9303 to 9319, then any free port. */
  localPortMin: 9303,
  localPortMax: 9319,
} as const;

export type HostState = 'ready' | 'standby' | 'unknown';
export type ConsoleTarget = 'ps5-1' | 'ps5-unknown' | 'ps4-10' | 'ps4-9' | 'ps4-8' | 'ps4-unknown';

export interface DiscoveredHost {
  /** Address the answer came from. */
  address: string;
  /** 200 means ready, 620 means in rest mode (standby). */
  state: HostState;
  statusCode: number;
  hostRequestPort?: number;
  systemVersion?: string;
  protocolVersion?: string;
  hostName?: string;
  hostType?: string;
  hostId?: string;
  runningAppTitleId?: string;
  runningAppName?: string;
  isPs5: boolean;
  target: ConsoleTarget;
}

/** "SRCH" probe. The reference implementation sends the trailing NUL as well, so we do too. */
export function formatSrch(protocolVersion: string): Buffer {
  return Buffer.from(`SRCH * HTTP/1.1\ndevice-discovery-protocol-version:${protocolVersion}\n\0`, 'latin1');
}

/** Largest value the wire format can carry (unsigned 64 bit). */
const U64_MAX = (1n << 64n) - 1n;

/** The wake-up credential is the registration key read as a hexadecimal number. */
export function credentialFromRegistKey(registKey: string): bigint {
  if (!/^[0-9a-fA-F]{1,16}$/.test(registKey)) throw new Error('the registration key must be 1 to 16 hexadecimal characters');
  return BigInt(`0x${registKey}`);
}

/**
 * The wake-up credential from a registration as it is STORED here (`registKey` in the console store: the 16 key bytes
 * as hexadecimal). Those bytes are themselves the text of a hexadecimal number, padded with zero bytes: the console's
 * answer to the registration carries the key that way. The reference client (chiaki-ng, gui/src/discoverymanager.cpp
 * SendWakeup) cuts the bytes at the first zero, reads them as text, refuses more than 8 characters, and reads that text
 * as a hexadecimal number. Feeding the stored hexadecimal to credentialFromRegistKey would be a different number.
 */
export function credentialFromStoredKey(storedRegistKeyHex: string): bigint {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(storedRegistKeyHex)) throw new Error('the stored registration key is not hexadecimal bytes');
  const bytes = Buffer.from(storedRegistKeyHex, 'hex');
  const zero = bytes.indexOf(0);
  const text = bytes.subarray(0, zero < 0 ? bytes.length : zero).toString('latin1');
  if (text.length === 0 || text.length > 8 || !/^[0-9a-fA-F]+$/.test(text)) throw new Error('the registration key is not usable for waking the console (it is not up to 8 hexadecimal characters)');
  return BigInt(`0x${text}`);
}

export function formatWakeup(credential: bigint, protocolVersion: string): Buffer {
  if (credential < 0n || credential > U64_MAX) throw new Error('credential out of range');
  return Buffer.from(
    'WAKEUP * HTTP/1.1\n' +
      'client-type:vr\n' +
      'auth-type:R\n' +
      'model:w\n' +
      'app-type:r\n' +
      `user-credential:${credential.toString(10)}\n` +
      `device-discovery-protocol-version:${protocolVersion}\n\0`,
    'latin1',
  );
}

/** Maps the reported system version to a console generation the same way the reference client does (including the fall-through). */
export function targetFromSystemVersion(systemVersion: string | undefined, isPs5: boolean): ConsoleTarget {
  const version = Number.parseInt(systemVersion ?? '', 10) || 0; // like C atoi: stops at the first non-digit, 0 when none
  if (version >= 8050001 && isPs5) return 'ps5-1';
  if (version >= 8050000 && isPs5) return 'ps5-unknown';
  if (version >= 8000000) return 'ps4-10';
  if (version >= 7000000) return 'ps4-9';
  if (version > 0) return 'ps4-8';
  return 'ps4-unknown';
}

/**
 * Parse an answer to SRCH. Returns null for anything that is not a well-formed answer.
 * Rules (from http.c): the status line starts with "HTTP/1.1 " and has a non-zero number; every following
 * non-empty line is "key:value" with at most one space after the colon, a non-empty key and a non-empty value.
 * Unlike the reference we also accept a last header that has no line ending.
 */
export function parseSrchResponse(data: Uint8Array | string, address: string): DiscoveredHost | null {
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('latin1');
  const nul = text.indexOf('\0');
  const body = nul >= 0 ? text.slice(0, nul) : text;
  if (!body.startsWith('HTTP/1.1 ')) return null;
  const lines = body.split(/\r?\n/);
  const statusCode = Number.parseInt(lines[0]!.slice(9), 10);
  if (!Number.isInteger(statusCode) || statusCode === 0) return null;

  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (value === '') return null;
    headers.set(line.slice(0, colon), value);
  }

  const protocolVersion = headers.get('device-discovery-protocol-version');
  const isPs5 = protocolVersion === DISCOVERY.ps5.version;
  const systemVersion = headers.get('system-version');
  const requestPort = headers.get('host-request-port');
  return {
    address,
    state: statusCode === 200 ? 'ready' : statusCode === 620 ? 'standby' : 'unknown',
    statusCode,
    hostRequestPort: requestPort === undefined ? undefined : Number.parseInt(requestPort, 0) & 0xffff,
    systemVersion,
    protocolVersion,
    hostName: headers.get('host-name'),
    hostType: headers.get('host-type'),
    hostId: headers.get('host-id'),
    runningAppTitleId: headers.get('running-app-titleid'),
    runningAppName: headers.get('running-app-name'),
    isPs5,
    target: targetFromSystemVersion(systemVersion, isPs5),
  };
}

/** Directed broadcast address of each non-loopback IPv4 interface (255.255.255.255 only leaves one interface on some systems). */
export function broadcastOf(address: string, netmask: string): string {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((octet, i) => (octet | (~m[i]! & 0xff)) & 0xff).join('.');
}

/**
 * Interfaces that can carry a broadcast. Point-to-point links such as VPN tunnels (/32) are skipped: their
 * "broadcast" address is their own address, so probing it would only talk to ourselves.
 */
export function localBroadcastAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): { iface: string; address: string; broadcast: string }[] {
  const out: { iface: string; address: string; broadcast: string }[] = [];
  for (const [iface, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const broadcast = broadcastOf(a.address, a.netmask);
      if (broadcast !== a.address) out.push({ iface, address: a.address, broadcast });
    }
  }
  return out;
}

export interface DiscoverOptions {
  /** Ask these console addresses directly instead of broadcasting. */
  hosts?: string[];
  /** Broadcast addresses to use. Default: 255.255.255.255 plus each interface's directed broadcast. */
  broadcast?: string[];
  ps4?: boolean;
  ps5?: boolean;
  /** Override the console ports (for tests). */
  ports?: { ps4: number; ps5: number };
  timeoutMs?: number;
  /** How many times to send each probe (UDP can lose packets). */
  repeat?: number;
  log?: (line: string) => void;
  /** Called with every datagram received, before it is parsed. For capturing real responses. */
  onRaw?: (data: Buffer, from: string) => void;
}

export interface DiscoverResult {
  hosts: DiscoveredHost[];
  /** Every probe that was sent, for diagnostics. */
  sent: string[];
  localPort: number;
}

/** Bind like the reference client: local ports 9303 to 9319 first, then any free port. */
async function bindDiscoverySocket(socket: dgram.Socket, log: (s: string) => void): Promise<number> {
  const candidates = [...Array.from({ length: DISCOVERY.localPortMax - DISCOVERY.localPortMin + 1 }, (_, i) => DISCOVERY.localPortMin + i), 0];
  for (const port of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = (): void => resolve(false);
      socket.once('error', onError);
      socket.bind({ port, address: '0.0.0.0' }, () => {
        socket.off('error', onError);
        resolve(true);
      });
    });
    if (ok) return socket.address().port;
    log(`local port ${port} is busy, trying the next`);
  }
  throw new Error('could not bind a local UDP port for discovery');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function discover(opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const log = opts.log ?? (() => {});
  const ports = opts.ports ?? { ps4: DISCOVERY.ps4.port, ps5: DISCOVERY.ps5.port };
  const kinds: { name: 'PS4' | 'PS5'; port: number; version: string }[] = [];
  if (opts.ps5 !== false) kinds.push({ name: 'PS5', port: ports.ps5, version: DISCOVERY.ps5.version });
  if (opts.ps4 !== false) kinds.push({ name: 'PS4', port: ports.ps4, version: DISCOVERY.ps4.version });

  const targets = opts.hosts ?? opts.broadcast ?? ['255.255.255.255', ...localBroadcastAddresses().map((b) => b.broadcast)];
  const uniqueTargets = [...new Set(targets)];
  const found = new Map<string, DiscoveredHost>();
  const sent: string[] = [];

  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    opts.onRaw?.(msg, rinfo.address);
    const host = parseSrchResponse(msg, rinfo.address);
    if (!host) return log(`ignored an unrecognised answer from ${rinfo.address}`);
    found.set(host.hostId ?? host.address, host);
  });
  socket.on('error', (e) => log(`socket error: ${e.message}`));

  try {
    const localPort = await bindDiscoverySocket(socket, log);
    socket.setBroadcast(true);
    const repeat = Math.max(1, opts.repeat ?? 2);
    for (let round = 0; round < repeat; round++) {
      for (const target of uniqueTargets) {
        for (const kind of kinds) {
          await new Promise<void>((resolve) => {
            socket.send(formatSrch(kind.version), kind.port, target, (err) => {
              if (err) log(`could not send to ${target}:${kind.port}: ${err.message}`);
              else if (round === 0) sent.push(`${kind.name} SRCH -> ${target}:${kind.port}`);
              resolve();
            });
          });
        }
      }
      if (round < repeat - 1) await sleep(250);
    }
    await sleep(opts.timeoutMs ?? 2000);
    return { hosts: [...found.values()], sent, localPort };
  } finally {
    socket.close();
  }
}

/** Ask a console in rest mode to wake up. `credential` comes from credentialFromRegistKey. */
export async function wakeup(host: string, credential: bigint, ps5: boolean, opts: { port?: number; repeat?: number } = {}): Promise<void> {
  const kind = ps5 ? DISCOVERY.ps5 : DISCOVERY.ps4;
  const packet = formatWakeup(credential, kind.version);
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind({ port: 0, address: '0.0.0.0' }, () => resolve());
    });
    for (let i = 0; i < (opts.repeat ?? 2); i++) {
      await new Promise<void>((resolve, reject) => socket.send(packet, opts.port ?? kind.port, host, (err) => (err ? reject(err) : resolve())));
      await sleep(100);
    }
  } finally {
    socket.close();
  }
}

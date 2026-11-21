// SPDX-License-Identifier: AGPL-3.0-only
//
// Handing a console over between this project's own clients. This project's own work, not a port.
//
// A console serves one Remote Play client at a time and offers no way to end somebody else's session: the client that
// has it must let go itself. So the clients of one person agree on a rule among themselves:
//
//   - A client that is connected lets go when another of them asks, unless it was locked.
//   - A locked client answers that it is locked, and stays.
//
// This cannot do anything about other programs (the official app, chiaki): they do not take part.
//
// How they find each other: a small signal over UDP on the local network, sent to the broadcast address. Only clients
// that hold the SAME registration for the console can read or write it: every datagram is encrypted and authenticated
// (AES-256-GCM) with a key derived from that registration's keys, so nothing readable is on the wire and nobody else
// can make a client let go. A signal is accepted once, and only when it is fresh (clock within two minutes).
// Clients that registered separately have different keys and do not hear each other; copying the registration from
// one computer to the other (npm run consoles) is what makes them a group.
//
// Two ways for a request to arrive, because a firewall often lets a computer answer but not be spoken to first:
//   1. The client that wants the console asks (broadcast). Works when the one that has it can be reached.
//   2. The client that has the console says so once a second (broadcast). A client that is waiting for the console
//      answers that with its request, sent straight back to where the announcement came from. To a firewall that is a
//      reply to something this computer sent, so it gets in. Works when the one that wants it can be reached.
// One of the two computers accepting incoming datagrams is enough.
//
// What this listener can be made to do, at most, by someone who has the registration: end this client's stream.
// It cannot start anything, read anything, or reach the bridge's page or API.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import dgram from 'node:dgram';
import os from 'node:os';

import type { ConsoleStore } from '../console/store.ts';

export const HANDOVER_PORT = 47876;
const MAGIC = Buffer.from('GTPH\x01');
const AAD = Buffer.from('gtp-handover/v1');
const TAG_SIZE = 8;
const FRESH_MS = 120_000;
const MAX_DATAGRAM = 600;

export type HandoverAnswer = { result: 'yielded' | 'locked'; name: string } | { result: 'none' };

export interface HandoverTarget {
  address: string;
  port: number;
}

export interface HandoverOptions {
  store: ConsoleStore;
  /** What this client calls itself to the others. Default: the computer's name. */
  name?: string;
  /** Default 47876. */
  port?: number;
  /** Default: every address ('0.0.0.0'), which is what receiving a broadcast needs. */
  bind?: string;
  /** Where requests are sent. Default: the broadcast address of every network this computer is on. Replaced by tests. */
  targets?: () => HandoverTarget[];
  log?: (line: string) => void;
  now?: () => number;
  /** How often a client that has a console says so, in ms. Default 1000. */
  announceMs?: number;
}

interface Held {
  locked: boolean;
  release: (by: string) => void;
}

interface Signal {
  /** ask: let go of the console, please. yield: I did. locked: I am locked and stay. have: I have the console (said every second, and in answer to who). who: does one of us have the console? (changes nothing) */
  t: 'ask' | 'yield' | 'locked' | 'have' | 'who';
  /** With have: whether the sender is locked. */
  locked?: boolean;
  /** The sender, a random id per process. */
  id: string;
  /** A fresh random value per signal. */
  n: string;
  /** When it was made, in ms. */
  ts: number;
  name: string;
  /** For an answer: the `n` of the request it answers. */
  re?: string;
}

/** The key and the public tag of one registration. The tag lets a receiver pick the key without trying them all. */
function keysFor(registKeyHex: string, rpKeyHex: string): { key: Buffer; tag: Buffer } {
  const secret = Buffer.concat([Buffer.from(rpKeyHex, 'hex'), Buffer.from(registKeyHex, 'hex')]);
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'gtp-handover/v1 key', 32));
  const tag = createHmac('sha256', key).update('gtp-handover/v1 tag').digest().subarray(0, TAG_SIZE);
  return { key, tag };
}

function seal(key: Buffer, tag: Buffer, signal: Signal): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify(signal), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, tag, iv, body, cipher.getAuthTag()]);
}

function open(key: Buffer, datagram: Buffer): Signal | null {
  const from = MAGIC.length + TAG_SIZE;
  if (datagram.length < from + 12 + 16 + 2) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, datagram.subarray(from, from + 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(datagram.subarray(datagram.length - 16));
    const text = Buffer.concat([decipher.update(datagram.subarray(from + 12, datagram.length - 16)), decipher.final()]).toString('utf8');
    const s = JSON.parse(text) as Signal;
    if ((s.t !== 'ask' && s.t !== 'yield' && s.t !== 'locked' && s.t !== 'have' && s.t !== 'who') || typeof s.id !== 'string' || typeof s.n !== 'string' || typeof s.ts !== 'number' || typeof s.name !== 'string') return null;
    return s;
  } catch {
    return null; // not ours, or changed on the way
  }
}

/** The broadcast address of every IPv4 network this computer is on. */
export function broadcastTargets(port: number): HandoverTarget[] {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      out.add(ip.map((b, i) => (b | (~mask[i]! & 0xff)) & 0xff).join('.'));
    }
  }
  return [...out].map((address) => ({ address, port }));
}

export class Handover {
  readonly name: string;
  readonly port: number;
  #o: HandoverOptions;
  #id = randomBytes(8).toString('hex');
  #now: () => number;
  /** Hears requests. Shared port: several of this project's programs on one computer can all listen. */
  #listener: dgram.Socket | null = null;
  /** Sends requests and hears the answers to them, on a port of its own. */
  #asker: dgram.Socket | null = null;
  #held = new Map<string, Held>();
  #seen = new Map<string, number>();
  #waiting = new Map<string, { mac: string; datagram: Buffer; done: (answer: HandoverAnswer) => void }>();
  #asking = new Map<string, { mac: string; found: Map<string, { name: string; locked: boolean }> }>();
  #announcer: ReturnType<typeof setInterval> | null = null;
  listening = false;

  constructor(o: HandoverOptions) {
    this.#o = o;
    this.name = (o.name ?? os.hostname()).slice(0, 40) || 'GTP';
    this.port = o.port ?? HANDOVER_PORT;
    this.#now = o.now ?? Date.now;
  }

  /** Start listening. Never throws: when the port cannot be had, this client simply cannot be asked (it can still ask). */
  async start(): Promise<void> {
    const log = this.#o.log ?? (() => {});
    const bind = (socket: dgram.Socket, port: number): Promise<boolean> =>
      new Promise((resolve) => {
        socket.once('error', () => resolve(false));
        socket.bind(port, this.#o.bind ?? '0.0.0.0', () => resolve(true));
      });
    const listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    if (await bind(listener, this.port)) {
      listener.on('message', (data, from) => this.#heard(data, from, listener));
      listener.on('error', () => {});
      this.#listener = listener;
      this.listening = true;
    } else {
      log(`handover: could not listen on UDP ${this.port}; other clients cannot ask this one to let go`);
      listener.close();
    }
    const asker = dgram.createSocket({ type: 'udp4' });
    if (await bind(asker, 0)) {
      try {
        asker.setBroadcast(true);
      } catch {
        /* requests then reach only what the system lets them reach */
      }
      asker.on('message', (data, from) => this.#heard(data, from, asker));
      asker.on('error', () => {});
      this.#asker = asker;
    } else asker.close();
  }

  close(): void {
    for (const s of [this.#listener, this.#asker]) {
      try {
        s?.close();
      } catch {
        /* already closed */
      }
    }
    this.#listener = this.#asker = null;
    this.listening = false;
    if (this.#announcer) clearInterval(this.#announcer);
    this.#announcer = null;
    for (const w of [...this.#waiting.values()]) w.done({ result: 'none' });
    this.#waiting.clear();
  }

  /**
   * This client now has the console `mac`. `release` is called when another client asked for it and this one let go.
   * Returns what to call when this client no longer has the console.
   */
  hold(mac: string, held: Held): () => void {
    this.#held.set(mac, held);
    this.#announcer ??= setInterval(() => this.#announce(), this.#o.announceMs ?? 1000);
    this.#announcer.unref?.();
    return () => {
      if (this.#held.get(mac) === held) this.#held.delete(mac);
    };
  }

  /** Say which consoles this client has, to whoever of this project's clients is waiting for one. */
  #announce(): void {
    if (this.#held.size === 0) {
      if (this.#announcer) clearInterval(this.#announcer);
      this.#announcer = null;
      return;
    }
    const asker = this.#asker;
    if (!asker) return;
    const targets = (this.#o.targets ?? (() => broadcastTargets(this.port)))();
    for (const [mac, held] of this.#held) {
      const record = this.#o.store.get(mac);
      if (!record) continue;
      const { key, tag } = keysFor(record.registKey, record.rpKey);
      const datagram = seal(key, tag, { t: 'have', locked: held.locked, id: this.#id, n: randomBytes(8).toString('hex'), ts: this.#now(), name: this.name });
      for (const t of targets) asker.send(datagram, t.port, t.address, () => {});
    }
  }

  setLocked(mac: string, locked: boolean): void {
    const h = this.#held.get(mac);
    if (h) h.locked = locked;
  }

  status(): { listening: boolean; port: number; name: string; holding: Array<{ mac: string; locked: boolean }> } {
    return { listening: this.listening, port: this.port, name: this.name, holding: [...this.#held].map(([mac, h]) => ({ mac, locked: h.locked })) };
  }

  /** Which of this project's clients has the console `mac`, if any? Changes nothing. */
  who(mac: string, waitMs = 1300): Promise<Array<{ name: string; locked: boolean }>> {
    const record = this.#o.store.get(mac);
    const asker = this.#asker;
    if (!record || !asker) return Promise.resolve([]);
    const { key, tag } = keysFor(record.registKey, record.rpKey);
    const n = randomBytes(8).toString('hex');
    const datagram = seal(key, tag, { t: 'who', id: this.#id, n, ts: this.#now(), name: this.name });
    const found = new Map<string, { name: string; locked: boolean }>();
    this.#asking.set(n, { mac, found });
    for (const t of (this.#o.targets ?? (() => broadcastTargets(this.port)))()) asker.send(datagram, t.port, t.address, () => {});
    return new Promise((resolve) =>
      setTimeout(() => {
        this.#asking.delete(n);
        resolve([...found.values()]);
      }, waitMs),
    );
  }

  /** Ask whichever of this project's clients has the console `mac` to let go. Resolves with the first answer, or 'none'. */
  ask(mac: string, waitMs = 1600): Promise<HandoverAnswer> {
    const record = this.#o.store.get(mac);
    const asker = this.#asker;
    if (!record || !asker) return Promise.resolve({ result: 'none' });
    const { key, tag } = keysFor(record.registKey, record.rpKey);
    const n = randomBytes(8).toString('hex');
    const datagram = seal(key, tag, { t: 'ask', id: this.#id, n, ts: this.#now(), name: this.name });
    const targets = (this.#o.targets ?? (() => broadcastTargets(this.port)))();
    return new Promise((resolve) => {
      const done = (answer: HandoverAnswer): void => {
        if (!this.#waiting.delete(n)) return;
        clearTimeout(timer);
        clearTimeout(again);
        resolve(answer);
      };
      // While this request waits, an announcement from the client that has the console is answered with it (see #heard).
      const send = (): void => {
        for (const t of targets) asker.send(datagram, t.port, t.address, () => {});
      };
      this.#waiting.set(n, { mac, datagram, done });
      const timer = setTimeout(() => done({ result: 'none' }), waitMs);
      const again = setTimeout(send, Math.min(250, waitMs / 3)); // a datagram can get lost: the same request once more
      send();
    });
  }

  #heard(data: Buffer, from: dgram.RemoteInfo, socket: dgram.Socket): void {
    if (data.length > MAX_DATAGRAM || data.length < MAGIC.length + TAG_SIZE || !data.subarray(0, MAGIC.length).equals(MAGIC)) return;
    const theirTag = data.subarray(MAGIC.length, MAGIC.length + TAG_SIZE);
    // Which of the registrations on this computer is it for?
    for (const c of this.#o.store.list()) {
      const record = this.#o.store.get(c.mac);
      if (!record) continue;
      const { key, tag } = keysFor(record.registKey, record.rpKey);
      if (!timingSafeEqual(tag, theirTag)) continue;
      const signal = open(key, data);
      if (!signal || signal.id === this.#id) return;
      const now = this.#now();
      if (Math.abs(now - signal.ts) > FRESH_MS) return;
      if (signal.t === 'ask') this.#asked(c.mac, signal, key, tag, from, socket, now);
      else if (signal.t === 'who') {
        const held = this.#held.get(c.mac);
        if (held) socket.send(seal(key, tag, { t: 'have', locked: held.locked, id: this.#id, n: randomBytes(8).toString('hex'), ts: now, name: this.name, re: signal.n }), from.port, from.address, () => {});
      } else if (signal.t === 'have') {
        for (const q of this.#asking.values()) if (q.mac === c.mac) q.found.set(signal.id, { name: signal.name, locked: signal.locked === true });
        // Somebody has the console this client is waiting for: a locked one settles it, an unlocked one gets the
        // request sent straight back to where its announcement came from.
        for (const w of [...this.#waiting.values()]) {
          if (w.mac !== c.mac) continue;
          if (signal.locked === true) w.done({ result: 'locked', name: signal.name });
          else this.#asker?.send(w.datagram, from.port, from.address, () => {});
        }
      } else if (signal.re) this.#waiting.get(signal.re)?.done({ result: signal.t === 'yield' ? 'yielded' : 'locked', name: signal.name });
      return;
    }
  }

  #asked(mac: string, signal: Signal, key: Buffer, tag: Buffer, from: dgram.RemoteInfo, socket: dgram.Socket, now: number): void {
    const held = this.#held.get(mac);
    if (!held) return; // not ours to give
    // The same request arrives twice on purpose (and could be recorded and sent again): it is acted on once, answered each time.
    for (const [n, at] of this.#seen) if (now - at > 2 * FRESH_MS) this.#seen.delete(n);
    const first = !this.#seen.has(signal.n);
    this.#seen.set(signal.n, now);
    const answer: Signal = { t: held.locked ? 'locked' : 'yield', id: this.#id, n: randomBytes(8).toString('hex'), ts: now, name: this.name, re: signal.n };
    socket.send(seal(key, tag, answer), from.port, from.address, () => {});
    if (!first || held.locked) return;
    (this.#o.log ?? (() => {}))(`handover: letting go of the console for ${signal.name}`);
    this.#held.delete(mac);
    held.release(signal.name);
  }
}

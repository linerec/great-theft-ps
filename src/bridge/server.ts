// SPDX-License-Identifier: AGPL-3.0-only
//
// The bridge: serves the web client and relays between ONE browser client and a console link.
//
// Safety, because this process can press buttons on a console:
//  - binds to loopback unless told otherwise. On loopback no token is needed (the checks below keep other web pages and
//    other hosts out). Listening beyond loopback REQUIRES a token (first message, constant-time compare);
//  - the WebSocket upgrade must be same-origin, so a random web page cannot drive it;
//  - with `accounts`, every address needs a login (or the token): people have a role and minutes per day, and a stream
//    that runs out of minutes is ended;
//  - one client at a time; a second one is refused;
//  - when the client goes quiet or disconnects the pad is released, so no button can stay stuck on the console;
//  - messages are size limited and rate limited; video is dropped (not queued) when the client cannot keep up.

import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

import { emptyPadState, type VirtualPadState } from '../engine/types.ts';
import type { ConsoleLink } from './console-link.ts';
import { decodePad, decodePing, encodeAudio, encodePong, encodeVideo, isNeutral, MSG, type ClientControl } from './protocol.ts';
import { DEFAULT_QUALITY, parseQuality, type QualityRequest } from './quality.ts';
import type { ConsoleStore } from '../console/store.ts';
import type { AccountStore, PublicUser } from './accounts.ts';
import type { DevReload } from './devreload.ts';
import { handleApi, type ApiOptions } from './api.ts';
import { isPlainViaProxy, userOf } from './auth-api.ts';
import type { Handover } from './handover.ts';
import type { StudyStore } from './study-store.ts';
import { DelayLine, type LinkSimProfile } from './linksim.ts';
import type { StreamResearch } from './ps5-link.ts';
import { portInUse, probeHostFor } from './ports.ts';
import { classifyClient, coarseDevice, probeWithin, type PathProbe } from './runlog.ts';
import { handleStatic, hostAllowed, hostName, originAllowed, send } from './static.ts';
import { explainListenError } from './tls.ts';
import { acceptUpgrade, type WsConnection } from './ws.ts';

const MAX_MESSAGE_BYTES = 64 * 1024; // from the client: pads and small JSON only
const AUTH_TIMEOUT_MS = 5000;
const SILENCE_MS = 2000;
const BACKPRESSURE_BYTES = 1_500_000;
const MAX_PADS_PER_SECOND = 2000;
const USAGE_FLUSH_SECONDS = 5;

/** One more address the same bridge answers on, with its own token, TLS and trusted names (see BridgeOptions.also). */
export interface ExtraListener {
  host: string;
  port: number;
  /** Required: an extra address is for other devices, which must show it. */
  token: string;
  trustedHosts?: string[];
  tls?: { cert: string | Buffer; key: string | Buffer };
}

export interface BridgeOptions {
  host: string;
  port: number;
  /** Optional on loopback. Required when `host` is anything else, and when a host name is trusted. */
  token?: string;
  /**
   * Host names under which this bridge is reached through a proxy on this computer (for example the HTTPS address
   * `tailscale serve` gives it). The bridge keeps listening on loopback; requests naming one of these hosts are
   * accepted as well. They come from other devices, so a token is then required for everything.
   */
  trustedHosts?: string[];
  /**
   * Serve HTTPS instead of HTTP with this certificate and key (PEM), for example the files `tailscale cert <name>` writes.
   * A browser decodes video only on a secure page, so a phone reaching the bridge over a private network needs this.
   * The WebSocket then runs over TLS as well (wss), on the same port.
   */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /**
   * More addresses this same bridge answers on, for example this computer's tailnet address with TLS and a token next to
   * the loopback address without. There is still one bridge: one client at a time across all of them, one console link,
   * one set of measurements.
   */
  also?: ExtraListener[];
  root: string;
  createLink: () => ConsoleLink;
  /** Where registered consoles are kept. Without it the /api/ endpoints are off. */
  store?: ConsoleStore;
  /** Measurements and settings of the stream (see /api/stream/). */
  research?: StreamResearch;
  /** Asks how the way to a tailnet client looks (direct or through a relay), to be kept with the run. Off without it. */
  pathProbe?: PathProbe;
  /** Handing the console over between this project's clients (see /api/handover). */
  handover?: Handover;
  /**
   * Put a stand-in for a worse network between this bridge and the page (linksim.ts): everything to and from the page
   * is delayed, held up now and then, and limited in rate. For trying things at a desk; off in normal use.
   */
  linkSim?: LinkSimProfile;
  /**
   * People who log in (accounts.ts). When set, a page must be logged in (or show the token) on EVERY address, loopback
   * included, and each person's minutes per day are counted and kept. Without it nothing changes: loopback needs nothing
   * and other addresses need the token.
   */
  accounts?: AccountStore;
  /** Where the scores of the mouse-feel study are kept (study-store.ts). */
  study?: StudyStore;
  /** Live reload for whoever is developing (see devreload.ts). Only offered on the loopback address, never to other devices. */
  devReload?: DevReload;
  /** What is running, for the page's small version line (GET /api/version). */
  version?: { commit: string; subject: string; startedAt: string };
  /** Replaces network discovery and registration. For tests. */
  api?: Pick<ApiOptions, 'discover' | 'register' | 'psn' | 'session' | 'network' | 'wake'>;
  log?: (line: string) => void;
  /** Test hook: when set, a client message {type:'e2e', ...} is passed to it. Off in normal use. */
  onE2eReport?: (report: unknown) => void;
}

export interface Bridge {
  port: number;
  url: string;
  /** The other addresses (see BridgeOptions.also), in the order given. */
  also: Array<{ port: number; url: string }>;
  close(): Promise<void>;
}

/** What differs between the addresses the bridge answers on. */
interface Face {
  host: string;
  port: number;
  token: string | undefined;
  /** Host names reached through a proxy or the tailnet name (lower case). */
  trusted: string[];
  tls: { cert: string | Buffer; key: string | Buffer } | undefined;
  /** The port actually bound (differs from `port` when that is 0). */
  bound: number;
}

function makeFace(l: { host: string; port: number; token?: string | undefined; trustedHosts?: string[] | undefined; tls?: { cert: string | Buffer; key: string | Buffer } | undefined }, accounts = false): Face {
  const loopbackOnly = l.host === '127.0.0.1' || l.host === 'localhost' || l.host === '::1';
  if (!loopbackOnly && !l.token && !accounts) throw new Error(`listening on ${l.host} (beyond this computer) requires a token: pass --token or leave --host out`);
  const trusted = (l.trustedHosts ?? []).map((h) => hostName(h)).filter(Boolean);
  if (trusted.length > 0 && !l.token && !accounts) throw new Error('trusting a host name lets other devices in through a proxy, which requires a token or a login');
  return { host: l.host, port: l.port, token: l.token, trusted, tls: l.tls, bound: l.port };
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const log = opts.log ?? (() => {});
  const accounts = opts.accounts;
  const faces: Face[] = [
    makeFace(opts, !!accounts),
    ...(opts.also ?? []).map((l) => {
      if (!l.token && !accounts) throw new Error('an extra address is for other devices and needs a token');
      return makeFace(l, !!accounts);
    }),
  ];
  let active: { conn: WsConnection; stop(): Promise<void> } | null = null;
  const connections = new Set<WsConnection>();

  /** One HTTP(S) server for one address: the same page, API and WebSocket, with that address's own rules. */
  const serverFor = (face: Face): http.Server => {
    /** Was the request sent to an address this bridge answers to? (Keeps a web page from reaching it under another name.) */
    const hostOk = (host: string | undefined): boolean => hostAllowed(host, { bound: face.host, port: face.bound, trusted: face.trusted });
    const handle: http.RequestListener = (req, res) => {
      if (!hostOk(req.headers.host)) return send(res, 421, { 'Content-Type': 'text/plain' }, 'Misdirected request');
      // Only a name the person trusted is sent on (never whatever the request says), and only to the same path.
      if (isPlainViaProxy(req) && face.trusted.includes(hostName(req.headers.host)) && (req.url ?? '/').startsWith('/')) {
        return send(res, 308, { 'Content-Type': 'text/plain', Location: `https://${hostName(req.headers.host)}${req.url ?? '/'}`, 'Cache-Control': 'no-store' }, 'Use https');
      }
      if (opts.store && (req.url ?? '').startsWith('/api/')) {
        const api: ApiOptions = { store: opts.store, ...(face.token !== undefined ? { token: face.token } : {}), ...(accounts ? { accounts } : {}), ...(opts.version ? { version: opts.version } : {}), ...(opts.research ? { research: opts.research } : {}), ...(opts.handover ? { handover: opts.handover } : {}), ...(opts.study ? { study: opts.study } : {}), ...(face.trusted.length ? { trustedHosts: face.trusted } : {}), ...opts.api, log };
        void handleApi(req, res, api).catch(() => send(res, 500, { 'Content-Type': 'text/plain' }, 'error'));
        return;
      }
      if (opts.devReload && face.host === '127.0.0.1' && req.method === 'GET' && (req.url ?? '').startsWith('/__dev/events') && !accounts) return opts.devReload.handle(req, res);
      void handleStatic(req, res, opts.root);
    };
    // Both kinds of server emit 'upgrade' for the WebSocket handshake, so everything below works for either.
    const server: http.Server = face.tls ? https.createServer({ cert: face.tls.cert, key: face.tls.key }, handle) : http.createServer(handle);
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') return void socket.destroy();
      if (!hostOk(req.headers.host)) return void socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n');
      // Same-origin only (or a trusted host name). Browsers always send Origin on WebSocket handshakes.
      if (!originAllowed(req.headers.origin, req.headers.host, face.trusted)) return void socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      const conn = acceptUpgrade(req, socket, head, MAX_MESSAGE_BYTES);
      if (conn) {
        connections.add(conn);
        const net = socket as { remoteAddress?: string; localAddress?: string };
        handleClient(conn, { remote: net.remoteAddress, local: net.localAddress, userAgent: req.headers['user-agent'], user: accounts ? userOf(req, accounts) : null }, face);
      }
    });
    return server;
  };

  function handleClient(conn: WsConnection, from: { remote?: string | undefined; local?: string | undefined; userAgent?: string | undefined; user?: PublicUser | null }, face: Face): void {
    let authed = false;
    let unsaved = 0;
    let quotaTick = 0;
    let player: PublicUser | null = null;
    let link: ConsoleLink | null = null;
    let lastSeq = 0;
    let lastPad: VirtualPadState = emptyPadState();
    let lastInputAt = Date.now();
    let padWindowStart = Date.now();
    let padWindowCount = 0;
    let padsLastSecond = 0;
    const counters = { frames: 0, bytes: 0, dropped: 0 };
    let dropStreak = false;
    const timers: ReturnType<typeof setInterval>[] = [];
    let closed = false;

    const sendJson = (o: unknown): void => conn.sendText(JSON.stringify(o));
    // With a simulated link, video and pongs go out through it and whatever the page sends comes in through it.
    const down = opts.linkSim ? new DelayLine<Uint8Array>(opts.linkSim.down, (bytes) => void (closed || conn.sendBinary(bytes))) : null;
    const up = opts.linkSim ? new DelayLine<string | Uint8Array>(opts.linkSim.up, (data) => received(data)) : null;
    const sendBinary = (bytes: Uint8Array): void => (down ? down.push(bytes, bytes.length) : conn.sendBinary(bytes));
    const authTimer = setTimeout(() => {
      if (!authed) conn.close(4401, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    /** Write the played seconds not yet kept (see USAGE_FLUSH_SECONDS). */
    const flushUsage = (): void => {
      if (player && accounts && unsaved > 0) accounts.addUsage(player.name, unsaved);
      unsaved = 0;
    };

    const release = (): void => {
      if (link && !isNeutral(lastPad)) {
        lastPad = emptyPadState();
        link.sendPad(++lastSeq, lastPad);
      }
    };

    /** Ask how the way to this client looks, if it is on the tailnet and a probe is there; give up after `ms`. */
    const notePath = async (ms: number): Promise<void> => {
      if (!opts.pathProbe || !opts.research || !from.remote || classifyClient(from.remote, from.local) !== 'tailnet') return;
      const found = await probeWithin(opts.pathProbe, from.remote, ms);
      if (found) opts.research.notePath(found);
    };

    const cleanup = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      connections.delete(conn);
      down?.close();
      up?.close();
      clearTimeout(authTimer);
      timers.forEach(clearInterval);
      flushUsage();
      release();
      if (active?.conn === conn) active = null;
      await notePath(1500); // the way to a phone is worth knowing at the end too: it can change from relay to direct
      await link?.stop();
      log('client disconnected');
    };

    conn.onClose = () => void cleanup();

    async function authenticate(msg: ClientControl): Promise<void> {
      const tokenGiven = face.token !== undefined && typeof msg.token === 'string' && timingSafeEqual(sha(msg.token), sha(face.token));
      // With accounts a login (or the token) is needed everywhere; without them only an address with a token asks for it.
      const allowed = accounts ? !!from.user || tokenGiven : face.token === undefined || tokenGiven;
      if (msg.type !== 'hello' || !allowed) {
        sendJson({ type: 'error', code: 'unauthorized', message: accounts ? 'log in first' : 'bad token' });
        return conn.close(4401, 'unauthorized');
      }
      // Whoever logged in has minutes per day. The token is the owner's (a tool, no limit), so it is not counted.
      player = accounts && from.user && !tokenGiven ? from.user : null;
      if (player && accounts && accounts.remainingSeconds(player.name) === 0) {
        sendJson({ type: 'error', code: 'quota-exhausted', message: '오늘 사용할 수 있는 시간을 모두 썼습니다' });
        return conn.close(4403, 'no time left today');
      }
      if (active) {
        sendJson({ type: 'error', code: 'busy', message: 'another client is connected' });
        return conn.close(4409, 'busy');
      }
      authed = true;
      clearTimeout(authTimer);
      active = { conn, stop: cleanup };
      // What the page asked to start with. A console fixes resolution and frame rate when its stream starts.
      const quality: QualityRequest = (msg.quality !== undefined ? parseQuality(msg.quality) : null) ?? DEFAULT_QUALITY;
      link = opts.createLink();
      try {
        await link.start(
          {
            onVideo: (f) => {
              if (closed) return;
              // The page is not taking frames as fast as they come. A frame that is left out breaks every frame after
              // it up to the next key frame (each one builds on the one before), so once one is dropped they all are,
              // and a key frame is asked for. Sending the later ones anyway would show a broken picture.
              if (!f.header.key && (dropStreak || conn.bufferedBytes + (down?.queuedBytes ?? 0) > BACKPRESSURE_BYTES)) {
                counters.dropped++;
                if (!dropStreak) link?.requestKeyframe();
                dropStreak = true;
                return;
              }
              dropStreak = false;
              const bytes = encodeVideo(f.header, f.data);
              counters.frames++;
              counters.bytes += bytes.length;
              sendBinary(bytes);
            },
            // The sound: Opus, one small message per frame (about 10 ms of sound). The page is told the format once.
            onAudioHeader: (h) => {
              if (!closed) sendJson({ type: 'audio', channels: h.channels, bits: h.bits, rate: h.rate, frameSize: h.frameSize });
            },
            onAudio: (frame) => {
              if (closed) return;
              // A gap in the sound is heard at once and a late frame of the picture is not, so the sound goes out unless
              // the page is far behind (then it could not play it in time anyway).
              if (conn.bufferedBytes + (down?.queuedBytes ?? 0) > BACKPRESSURE_BYTES) return;
              sendBinary(encodeAudio(frame));
            },
            onStatus: (s) => {
              if (s.state !== 'closed') return sendJson({ type: 'status', state: s.state, detail: s.detail });
              // The link ended by itself (the console closed it, or this client let go for another one). The page is
              // told why, and the connection ends with it: an open connection without a picture helps nobody.
              sendJson({ type: 'error', code: 'link-closed', message: s.detail ?? 'the connection to the console ended' });
              conn.close(1000, 'link closed');
            },
          },
          quality,
          { ...(typeof msg.console === 'string' && /^[0-9a-f]{12}$/i.test(msg.console) ? { mac: msg.console.toLowerCase() } : {}), locked: msg.lock === true },
        );
      } catch (e) {
        sendJson({ type: 'error', code: 'link', message: String((e as Error).message ?? e) });
        return conn.close(1011, 'link failed');
      }
      sendJson({ type: 'ready', link: link.name, quality });
      log(`client connected, link=${link.name}`);
      opts.research?.setClient({ kind: classifyClient(from.remote, from.local), device: coarseDevice(from.userAgent) });
      timers.push(setTimeout(() => void notePath(4000), 10_000));

      timers.push(
        setInterval(() => {
          if (player && accounts) {
            // Play time: each second of a running stream counts, and what is not yet written is written every few seconds.
            unsaved++;
            if (unsaved >= USAGE_FLUSH_SECONDS) flushUsage();
            const left = accounts.remainingSeconds(player.name);
            const remaining = left === null ? null : Math.max(0, left - unsaved);
            quotaTick++;
            if (quotaTick % 5 === 1 || (remaining !== null && remaining <= 60)) sendJson({ type: 'quota', remainingSeconds: remaining, dailyMinutes: accounts.get(player.name)?.dailyMinutes ?? null });
            if (remaining === 0) {
              flushUsage();
              sendJson({ type: 'error', code: 'quota-ended', message: '오늘 사용할 수 있는 시간이 끝났습니다' });
              return conn.close(4403, 'no time left today');
            }
          }
          padsLastSecond = padWindowCount;
          sendJson({
            type: 'stats',
            link: link?.name,
            fps: counters.frames,
            kbps: Math.round((counters.bytes * 8) / 1000),
            dropped: counters.dropped,
            padsPerSecond: padsLastSecond,
            lastPad: { buttons: lastPadWire.buttons, l2: lastPadWire.l2, r2: lastPadWire.r2, lx: lastPadWire.lx, ly: lastPadWire.ly, rx: lastPadWire.rx, ry: lastPadWire.ry },
          });
          opts.research?.addLeg({ frames: counters.frames, kbps: Math.round((counters.bytes * 8) / 1000), dropped: counters.dropped });
          counters.frames = 0;
          counters.bytes = 0;
          counters.dropped = 0;
          padWindowCount = 0;
        }, 1000),
        // If the client goes quiet while something is held, let go of everything.
        setInterval(() => {
          if (Date.now() - lastInputAt > SILENCE_MS) release();
        }, 500),
      );
    }

    const lastPadWire = { buttons: 0, l2: 0, r2: 0, lx: 0, ly: 0, rx: 0, ry: 0 };

    conn.onMessage = (data) => {
      // A message that waits in the simulated link must not share memory with the socket's buffer.
      if (up) up.push(typeof data === 'string' ? data : Uint8Array.from(data), data.length);
      else received(data);
    };
    function received(data: string | Uint8Array): void {
      if (closed) return;
      if (typeof data === 'string') {
        let msg: ClientControl;
        try {
          msg = JSON.parse(data) as ClientControl;
        } catch {
          return;
        }
        if (!authed) return void authenticate(msg);
        if (msg.type === 'quality') {
          const q = parseQuality(msg);
          if (!q) return sendJson({ type: 'error', code: 'bad-quality', message: 'invalid quality request' });
          link?.setQuality(q);
          sendJson({ type: 'status', state: 'quality', detail: JSON.stringify(q) });
        } else if (msg.type === 'keyframe') {
          link?.requestKeyframe();
        } else if (msg.type === 'lock') {
          link?.setLocked?.(msg.locked === true);
        } else if (msg.type === 'display') {
          opts.research?.addDisplay(msg);
        } else if (msg.type === 'bye') {
          conn.close(1000, 'bye');
        } else if ((msg as { type?: string }).type === 'e2e' && opts.onE2eReport) {
          opts.onE2eReport(msg);
        }
        return;
      }
      if (!authed || !link) return;
      lastInputAt = Date.now();
      if (data[0] === MSG.PAD) {
        const now = Date.now();
        if (now - padWindowStart >= 1000) {
          padWindowStart = now;
          padWindowCount = 0;
        }
        if (++padWindowCount > MAX_PADS_PER_SECOND) return;
        const pad = decodePad(data);
        if (!pad) return;
        lastSeq = pad.seq;
        lastPad = pad.state;
        lastPadWire.buttons = pad.state.buttons;
        lastPadWire.l2 = pad.state.l2;
        lastPadWire.r2 = pad.state.r2;
        lastPadWire.lx = Math.round(pad.state.leftX * 32767);
        lastPadWire.ly = Math.round(pad.state.leftY * 32767);
        lastPadWire.rx = Math.round(pad.state.rightX * 32767);
        lastPadWire.ry = Math.round(pad.state.rightY * 32767);
        link.sendPad(pad.seq, pad.state);
      } else if (data[0] === MSG.PING) {
        const t = decodePing(data);
        if (t !== null) sendBinary(encodePong(t, Date.now()));
      }
    }
  }

  for (const face of faces) {
    if (face.port === 0) continue;
    const probeHost = probeHostFor(face.host);
    if (await portInUse(probeHost, face.port)) {
      throw new Error(`port ${face.port} on ${probeHost} is already in use by another program. Choose another one with --port.`);
    }
  }
  const servers: http.Server[] = [];
  try {
    for (const face of faces) {
      const server = serverFor(face);
      await new Promise<void>((resolve, reject) => {
        server.once('error', (error) => reject(explainListenError(error as NodeJS.ErrnoException, face.host, face.port)));
        server.listen(face.port, face.host, resolve);
      });
      face.bound = (server.address() as AddressInfo).port;
      servers.push(server);
    }
  } catch (error) {
    // One address failed: do not leave the ones that did start running.
    for (const server of servers) server.close();
    throw error;
  }
  const urlOf = (face: Face): string => `${face.tls ? 'https' : 'http'}://${face.host === '0.0.0.0' ? '127.0.0.1' : face.host}:${face.bound}/`;
  return {
    port: faces[0]!.bound,
    url: urlOf(faces[0]!),
    also: faces.slice(1).map((f) => ({ port: f.bound, url: urlOf(f) })),
    close: async () => {
      opts.devReload?.close();
      // Upgraded sockets are not tracked by http.Server, so close every WebSocket ourselves.
      for (const c of [...connections]) c.close(1001, 'bridge closing');
      await active?.stop();
      for (const server of servers) {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

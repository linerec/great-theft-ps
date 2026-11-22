// SPDX-License-Identifier: AGPL-3.0-only
//
// The bridge: serves the web client and relays between ONE browser client and a console link.
//
// Safety, because this process can press buttons on a console:
//  - binds to loopback unless told otherwise. On loopback no token is needed (the checks below keep other web pages and
//    other hosts out). Listening beyond loopback REQUIRES a token (first message, constant-time compare);
//  - the WebSocket upgrade must be same-origin, so a random web page cannot drive it;
//  - one client at a time; a second one is refused;
//  - when the client goes quiet or disconnects the pad is released, so no button can stay stuck on the console;
//  - messages are size limited and rate limited; video is dropped (not queued) when the client cannot keep up.

import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

import { emptyPadState, type VirtualPadState } from '../engine/types.ts';
import type { ConsoleLink } from './console-link.ts';
import { decodePad, decodePing, encodePong, encodeVideo, isNeutral, MSG, type ClientControl } from './protocol.ts';
import { DEFAULT_QUALITY, parseQuality, type QualityRequest } from './quality.ts';
import type { ConsoleStore } from '../console/store.ts';
import { handleApi, type ApiOptions } from './api.ts';
import type { Handover } from './handover.ts';
import { DelayLine, type LinkSimProfile } from './linksim.ts';
import type { StreamResearch } from './ps5-link.ts';
import { portInUse } from './ports.ts';
import { handleStatic, hostAllowed, hostName, originAllowed, send } from './static.ts';
import { explainListenError } from './tls.ts';
import { acceptUpgrade, type WsConnection } from './ws.ts';

const MAX_MESSAGE_BYTES = 64 * 1024; // from the client: pads and small JSON only
const AUTH_TIMEOUT_MS = 5000;
const SILENCE_MS = 2000;
const BACKPRESSURE_BYTES = 1_500_000;
const MAX_PADS_PER_SECOND = 2000;

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
  root: string;
  createLink: () => ConsoleLink;
  /** Where registered consoles are kept. Without it the /api/ endpoints are off. */
  store?: ConsoleStore;
  /** Measurements and settings of the stream (see /api/stream/). */
  research?: StreamResearch;
  /** Handing the console over between this project's clients (see /api/handover). */
  handover?: Handover;
  /**
   * Put a stand-in for a worse network between this bridge and the page (linksim.ts): everything to and from the page
   * is delayed, held up now and then, and limited in rate. For trying things at a desk; off in normal use.
   */
  linkSim?: LinkSimProfile;
  /** Replaces network discovery and registration. For tests. */
  api?: Pick<ApiOptions, 'discover' | 'register' | 'psn' | 'session' | 'network' | 'wake'>;
  log?: (line: string) => void;
  /** Test hook: when set, a client message {type:'e2e', ...} is passed to it. Off in normal use. */
  onE2eReport?: (report: unknown) => void;
}

export interface Bridge {
  port: number;
  url: string;
  close(): Promise<void>;
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const log = opts.log ?? (() => {});
  const loopbackOnly = opts.host === '127.0.0.1' || opts.host === 'localhost' || opts.host === '::1';
  if (!loopbackOnly && !opts.token) throw new Error(`listening on ${opts.host} (beyond this computer) requires a token: pass --token or leave --host out`);
  const trusted = (opts.trustedHosts ?? []).map((h) => hostName(h)).filter(Boolean);
  if (trusted.length > 0 && !opts.token) throw new Error('trusting a host name lets other devices in through a proxy, which requires a token');
  /** Was the request sent to an address this bridge answers to? (Keeps a web page from reaching it under another name.) */
  const hostOk = (host: string | undefined): boolean => hostAllowed(host, { bound: opts.host, port: boundPort, trusted });
  let active: { conn: WsConnection; stop(): Promise<void> } | null = null;
  const connections = new Set<WsConnection>();
  let boundPort = opts.port;

  const handle: http.RequestListener = (req, res) => {
    if (!hostOk(req.headers.host)) return send(res, 421, { 'Content-Type': 'text/plain' }, 'Misdirected request');
    if (opts.store && (req.url ?? '').startsWith('/api/')) {
      const api: ApiOptions = { store: opts.store, ...(opts.token !== undefined ? { token: opts.token } : {}), ...(opts.research ? { research: opts.research } : {}), ...(opts.handover ? { handover: opts.handover } : {}), ...(trusted.length ? { trustedHosts: trusted } : {}), ...opts.api, log };
      void handleApi(req, res, api).catch(() => send(res, 500, { 'Content-Type': 'text/plain' }, 'error'));
      return;
    }
    void handleStatic(req, res, opts.root);
  };
  // Both kinds of server emit 'upgrade' for the WebSocket handshake, so everything below works for either.
  const server: http.Server = opts.tls ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key }, handle) : http.createServer(handle);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return void socket.destroy();
    if (!hostOk(req.headers.host)) return void socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n');
    // Same-origin only (or a trusted host name). Browsers always send Origin on WebSocket handshakes.
    if (!originAllowed(req.headers.origin, req.headers.host, trusted)) return void socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    const conn = acceptUpgrade(req, socket, head, MAX_MESSAGE_BYTES);
    if (conn) {
      connections.add(conn);
      handleClient(conn);
    }
  });

  function handleClient(conn: WsConnection): void {
    let authed = false;
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

    const release = (): void => {
      if (link && !isNeutral(lastPad)) {
        lastPad = emptyPadState();
        link.sendPad(++lastSeq, lastPad);
      }
    };

    const cleanup = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      connections.delete(conn);
      down?.close();
      up?.close();
      clearTimeout(authTimer);
      timers.forEach(clearInterval);
      release();
      if (active?.conn === conn) active = null;
      await link?.stop();
      log('client disconnected');
    };

    conn.onClose = () => void cleanup();

    async function authenticate(msg: ClientControl): Promise<void> {
      const tokenOk = opts.token === undefined || (typeof msg.token === 'string' && timingSafeEqual(sha(msg.token), sha(opts.token)));
      if (msg.type !== 'hello' || !tokenOk) {
        sendJson({ type: 'error', code: 'unauthorized', message: 'bad token' });
        return conn.close(4401, 'unauthorized');
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

      timers.push(
        setInterval(() => {
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

  if (opts.port !== 0) {
    const probeHost = opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host;
    if (await portInUse(probeHost, opts.port)) {
      throw new Error(`port ${opts.port} on ${probeHost} is already in use by another program. Choose another one with --port.`);
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => reject(explainListenError(error as NodeJS.ErrnoException, opts.host, opts.port)));
    server.listen(opts.port, opts.host, resolve);
  });
  boundPort = (server.address() as AddressInfo).port;
  const shownHost = opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host;
  return {
    port: boundPort,
    url: `${opts.tls ? 'https' : 'http'}://${shownHost}:${boundPort}/`,
    close: async () => {
      // Upgraded sockets are not tracked by http.Server, so close every WebSocket ourselves.
      for (const c of [...connections]) c.close(1001, 'bridge closing');
      await active?.stop();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

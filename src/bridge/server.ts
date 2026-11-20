// SPDX-License-Identifier: AGPL-3.0-only
//
// The bridge: serves the web client and relays between ONE browser client and a console link.
//
// Safety, because this process can press buttons on a console:
//  - binds to loopback unless told otherwise; a token is always required (first message, constant-time compare);
//  - the WebSocket upgrade must be same-origin, so a random web page cannot drive it;
//  - one client at a time; a second one is refused;
//  - when the client goes quiet or disconnects the pad is released, so no button can stay stuck on the console;
//  - messages are size limited and rate limited; video is dropped (not queued) when the client cannot keep up.

import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { emptyPadState, type VirtualPadState } from '../engine/types.ts';
import type { ConsoleLink } from './console-link.ts';
import { decodePad, decodePing, encodePong, encodeVideo, isNeutral, MSG, type ClientControl } from './protocol.ts';
import { DEFAULT_QUALITY, parseQuality, type QualityRequest } from './quality.ts';
import { portInUse } from './ports.ts';
import { handleStatic, isLoopbackHost, send } from './static.ts';
import { acceptUpgrade, type WsConnection } from './ws.ts';

const MAX_MESSAGE_BYTES = 64 * 1024; // from the client: pads and small JSON only
const AUTH_TIMEOUT_MS = 5000;
const SILENCE_MS = 2000;
const BACKPRESSURE_BYTES = 1_500_000;
const MAX_PADS_PER_SECOND = 2000;

export interface BridgeOptions {
  host: string;
  port: number;
  token: string;
  root: string;
  createLink: () => ConsoleLink;
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
  let active: { conn: WsConnection; stop(): Promise<void> } | null = null;
  const connections = new Set<WsConnection>();
  let boundPort = opts.port;

  const server = http.createServer((req, res) => {
    if (loopbackOnly && !isLoopbackHost(req.headers.host, boundPort)) return send(res, 421, { 'Content-Type': 'text/plain' }, 'Misdirected request');
    void handleStatic(req, res, opts.root);
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return void socket.destroy();
    if (loopbackOnly && !isLoopbackHost(req.headers.host, boundPort)) return void socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n');
    // Same-origin only. Browsers always send Origin on WebSocket handshakes.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        /* invalid origin */
      }
      if (originHost.toLowerCase() !== String(req.headers.host ?? '').toLowerCase()) {
        return void socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      }
    }
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
      clearTimeout(authTimer);
      timers.forEach(clearInterval);
      release();
      if (active?.conn === conn) active = null;
      await link?.stop();
      log('client disconnected');
    };

    conn.onClose = () => void cleanup();

    async function authenticate(msg: ClientControl): Promise<void> {
      if (msg.type !== 'hello' || typeof msg.token !== 'string' || !timingSafeEqual(sha(msg.token), sha(opts.token))) {
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
      const quality: QualityRequest = DEFAULT_QUALITY;
      link = opts.createLink();
      try {
        await link.start(
          {
            onVideo: (f) => {
              if (closed) return;
              if (conn.bufferedBytes > BACKPRESSURE_BYTES && !f.header.key) {
                counters.dropped++;
                if (!dropStreak) link?.requestKeyframe();
                dropStreak = true;
                return;
              }
              dropStreak = false;
              const bytes = encodeVideo(f.header, f.data);
              counters.frames++;
              counters.bytes += bytes.length;
              conn.sendBinary(bytes);
            },
            onStatus: (s) => sendJson({ type: 'status', state: s.state, detail: s.detail }),
          },
          quality,
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
        if (t !== null) conn.sendBinary(encodePong(t, Date.now()));
      }
    };
  }

  if (opts.port !== 0) {
    const probeHost = opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host;
    if (await portInUse(probeHost, opts.port)) {
      throw new Error(`port ${opts.port} on ${probeHost} is already in use by another program. Choose another one with --port.`);
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, resolve);
  });
  boundPort = (server.address() as AddressInfo).port;
  const shownHost = opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host;
  return {
    port: boundPort,
    url: `http://${shownHost}:${boundPort}/`,
    close: async () => {
      // Upgraded sockets are not tracked by http.Server, so close every WebSocket ourselves.
      for (const c of [...connections]) c.close(1001, 'bridge closing');
      await active?.stop();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

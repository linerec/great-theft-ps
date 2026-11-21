// SPDX-License-Identifier: AGPL-3.0-only
//
// The small JSON API the page uses to find and register consoles. Registration keys stay on this side: no response
// ever contains them, the PIN or the account id.
//
//   GET    /api/consoles          registered consoles (public fields) and whether an account id is saved
//   GET    /api/discover[?host=]  consoles answering on the network, each marked registered or not
//   POST   /api/register          { host, pin, accountId?, target? }  registers and stores the result
//   GET    /api/network           this computer's LAN addresses (the page uses them to tell which kind of route it is on)
//   POST   /api/session-check     { mac, host? }  asks the console for a session with the stored registration; answers ok
//                                 or the console's reason. Proves the registration works. Never returns keys or the nonce.
//   GET    /api/stream/stats      measurements of the running or last stream (totals, one sample per second, events)
//   GET    /api/stream/tuning     the settings that can be changed to study the stream
//   POST   /api/stream/tuning     { enableIdrOnFecFailure?, packetLossMax?, congestionIntervalMs?, heartbeatIntervalMs? }  for the next connection
//   GET    /api/psn/login-url     Sony's login page address (opened by the user in their own browser)
//   POST   /api/psn/account-id    { redirectUrl, acknowledge: true }  gets the PSN account id and saves it here. The answer
//                                 holds only its last four digits; tokens are never kept, logged or returned.
//   DELETE /api/consoles/<mac>    forgets a registration on this computer (the console keeps its own list)
//
// Same rules as the WebSocket: loopback Host, same-origin Origin when the browser sends one, and the token when one is
// configured (Authorization: Bearer). POST needs Content-Type: application/json, so a plain cross-site form cannot post.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { discover as realDiscover, type DiscoveredHost } from '../console/discovery.ts';
import { parseAccountId, register as realRegister, RegistError, type RegisterOptions, type RegisteredConsole } from '../console/regist.ts';
import { extractLoginCode, fetchAccountId, PSN_LOGIN_URL, PsnAccountError } from '../console/psn-account.ts';
import { isKnownTarget } from '../console/rpcrypt.ts';
import { requestSession, SessionError, type SessionRequestOptions } from '../console/session.ts';
import os from 'node:os';
import type { StreamResearch } from './ps5-link.ts';
import type { ConsoleStore } from '../console/store.ts';

export interface ApiOptions {
  store: ConsoleStore;
  token?: string;
  /** Replaced by tests. */
  discover?: (opts: { hosts?: string[]; timeoutMs?: number }) => Promise<{ hosts: DiscoveredHost[] }>;
  register?: (opts: RegisterOptions) => Promise<RegisteredConsole>;
  /** Exchanges a PSN login code for the account id (base64 of its 8 bytes). Replaced by tests. */
  psn?: (code: string) => Promise<string>;
  /** Asks a console for a session with a stored registration. Replaced by tests. */
  session?: (opts: SessionRequestOptions) => Promise<unknown>;
  /** Measurements and settings of the stream, for studying its delivery. Without it the /api/stream/ endpoints answer 404. */
  research?: StreamResearch;
  /** This computer's usable network addresses. Replaced by tests. */
  network?: () => NetworkInterfaceInfo[];
  log?: (line: string) => void;
}

export interface NetworkInterfaceInfo {
  iface: string;
  address: string;
  netmask: string;
}

/** IPv4 addresses this computer can reach a LAN with. Point-to-point links (VPN tunnels, /32) are left out. */
export function localNetworks(): NetworkInterfaceInfo[] {
  const out: NetworkInterfaceInfo[] = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && a.netmask !== '255.255.255.255') out.push({ iface, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

/** At most this many PSN exchanges per minute: a mistyped paste should not turn into a stream of requests to Sony. */
const PSN_PER_MINUTE = 6;
const psnAttempts: number[] = [];

const MAX_BODY = 4096;
const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('not JSON'));
      }
    });
    req.on('error', reject);
  });
}

const isIp = (s: string): boolean => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) || /^[0-9a-fA-F:]+$/.test(s);

function publicHost(h: DiscoveredHost, registered: Set<string>): Record<string, unknown> {
  return {
    address: h.address,
    name: h.hostName ?? '',
    type: h.hostType ?? (h.isPs5 ? 'PS5' : 'PS4'),
    state: h.state,
    target: h.target,
    id: h.hostId?.toLowerCase() ?? '',
    registered: !!h.hostId && registered.has(h.hostId.toLowerCase()),
  };
}

/** Returns true when the request was an API request (and has been answered). */
export async function handleApi(req: IncomingMessage, res: ServerResponse, opts: ApiOptions): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;
  const log = opts.log ?? (() => {});

  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* invalid */
    }
    if (originHost.toLowerCase() !== String(req.headers.host ?? '').toLowerCase()) return json(res, 403, { error: 'forbidden' }), true;
  }
  if (opts.token !== undefined) {
    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
    if (!timingSafeEqual(sha(auth), sha(opts.token))) return json(res, 401, { error: 'unauthorized' }), true;
  }
  if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    return json(res, 415, { error: 'send application/json' }), true;
  }

  const store = opts.store;
  const discover = opts.discover ?? realDiscover;
  const register = opts.register ?? realRegister;

  try {
    if (req.method === 'GET' && url.pathname === '/api/consoles') {
      json(res, 200, { consoles: store.list(), accountIdSaved: store.accountId !== undefined });
    } else if (req.method === 'GET' && url.pathname === '/api/discover') {
      const host = url.searchParams.get('host') ?? undefined;
      if (host !== undefined && !isIp(host)) return json(res, 400, { error: 'host must be an IP address' }), true;
      const result = await discover({ ...(host ? { hosts: [host] } : {}), timeoutMs: 2500 });
      const registered = new Set(store.list().map((c) => c.mac));
      json(res, 200, { hosts: result.hosts.map((h) => publicHost(h, registered)) });
    } else if (req.method === 'POST' && url.pathname === '/api/register') {
      const body = (await readBody(req)) as { host?: unknown; pin?: unknown; accountId?: unknown; target?: unknown };
      if (typeof body.host !== 'string' || !isIp(body.host)) return json(res, 400, { error: 'host must be an IP address' }), true;
      if (typeof body.pin !== 'string' && typeof body.pin !== 'number') return json(res, 400, { error: 'pin is missing' }), true;
      let accountText = typeof body.accountId === 'string' && body.accountId.trim() !== '' ? body.accountId : undefined;
      if (accountText === undefined && store.accountId) accountText = store.accountId;
      if (accountText === undefined) return json(res, 400, { error: 'account-id-needed', message: 'A PSN account id is needed for the first registration' }), true;

      let target = typeof body.target === 'string' ? body.target : undefined;
      if (!target || !isKnownTarget(target as never)) {
        const found = (await discover({ hosts: [body.host], timeoutMs: 2500 })).hosts[0];
        if (!found) return json(res, 404, { error: 'not-found', message: 'The console did not answer at that address' }), true;
        target = found.target;
      }
      log(`registering ${body.host}`);
      const result = await register({ host: body.host, target: target as never, pin: body.pin as string | number, accountId: accountText, log });
      store.setAccountId(Buffer.from(parseAccountId(accountText)).toString('base64'));
      json(res, 200, { console: store.put(result, body.host) });
    } else if (url.pathname.startsWith('/api/stream/') && !opts.research) {
      json(res, 404, { error: 'unknown endpoint' });
    } else if (req.method === 'GET' && url.pathname === '/api/stream/stats') {
      // Everything measured about the running (or last) stream. ?samples=N limits the per-second series.
      const asked = url.searchParams.get('samples');
      const n = asked === null || asked === '' ? NaN : Number(asked);
      json(res, 200, opts.research!.snapshot(Number.isInteger(n) && n >= 0 ? n : undefined));
    } else if (req.method === 'GET' && url.pathname === '/api/stream/tuning') {
      json(res, 200, { tuning: opts.research!.tuning, appliesTo: 'the next connection' });
    } else if (req.method === 'POST' && url.pathname === '/api/stream/tuning') {
      const body = await readBody(req);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return json(res, 400, { error: 'invalid-input', message: 'send an object of settings' }), true;
      const problems = opts.research!.setTuning(body as Record<string, unknown>);
      if (problems.length) return json(res, 400, { error: 'invalid-input', message: problems.join('; '), tuning: opts.research!.tuning }), true;
      log('stream settings changed for the next connection');
      json(res, 200, { tuning: opts.research!.tuning, appliesTo: 'the next connection' });
    } else if (req.method === 'GET' && url.pathname === '/api/network') {
      json(res, 200, { interfaces: (opts.network ?? localNetworks)() });
    } else if (req.method === 'POST' && url.pathname === '/api/session-check') {
      // Ask the console for a session with the stored registration. Proves the registration works; nothing more is done.
      const body = (await readBody(req)) as { mac?: unknown; host?: unknown };
      if (typeof body.mac !== 'string') return json(res, 400, { error: 'invalid-input', message: 'mac is missing' }), true;
      const rec = store.get(body.mac);
      if (!rec) return json(res, 404, { error: 'not-registered', message: 'That console is not registered on this computer' }), true;
      if (body.host !== undefined && (typeof body.host !== 'string' || !isIp(body.host))) return json(res, 400, { error: 'invalid-input', message: 'host must be an IP address' }), true;
      const host = typeof body.host === 'string' ? body.host : rec.host;
      log(`checking the registration of ${rec.nickname || rec.mac} at ${host}`);
      await (opts.session ?? requestSession)({ host, target: rec.target, registKey: Buffer.from(rec.registKey, 'hex'), rpKey: Buffer.from(rec.rpKey, 'hex'), log });
      store.markVerified(rec.mac, host);
      json(res, 200, { ok: true, console: store.list().find((c) => c.mac === rec.mac) });
    } else if (req.method === 'GET' && url.pathname === '/api/psn/login-url') {
      json(res, 200, { url: PSN_LOGIN_URL });
    } else if (req.method === 'POST' && url.pathname === '/api/psn/account-id') {
      const body = (await readBody(req)) as { redirectUrl?: unknown; acknowledge?: unknown };
      if (body.acknowledge !== true) return json(res, 400, { error: 'acknowledge-needed', message: 'The notice about using Sony application credentials must be accepted first' }), true;
      if (typeof body.redirectUrl !== 'string') return json(res, 400, { error: 'invalid-input', message: 'Paste the address of the page shown after the Sony login' }), true;
      const code = extractLoginCode(body.redirectUrl);
      const now = Date.now();
      while (psnAttempts.length && now - psnAttempts[0]! > 60_000) psnAttempts.shift();
      if (psnAttempts.length >= PSN_PER_MINUTE) return json(res, 429, { error: 'too-many', message: 'Too many attempts. Wait a minute' }), true;
      psnAttempts.push(now);
      log('exchanging a PSN login code for the account id'); // never the code, the tokens or the id
      const accountId = await (opts.psn ?? ((c: string) => fetchAccountId(c)))(code);
      store.setAccountId(accountId);
      // Only the last digits go back, enough to recognise the account. The full value stays in the store.
      json(res, 200, { accountIdSaved: true, hint: Buffer.from(accountId, 'base64').readBigUInt64LE().toString().slice(-4) });
    } else if (req.method === 'DELETE' && url.pathname.startsWith('/api/consoles/')) {
      const mac = decodeURIComponent(url.pathname.slice('/api/consoles/'.length));
      const removed = store.remove(mac);
      json(res, removed ? 200 : 404, { ok: removed });
    } else {
      json(res, 404, { error: 'unknown endpoint' });
    }
  } catch (e) {
    if (e instanceof SessionError) {
      const status = e.code === 'rejected' ? 403 : e.code === 'unsupported-target' ? 400 : e.code === 'version-mismatch' ? 409 : 502;
      json(res, status, { error: e.code, message: e.message, ...(e.reason !== undefined ? { reason: e.reason } : {}) });
    } else if (e instanceof PsnAccountError) {
      json(res, e.code === 'invalid-input' ? 400 : e.code === 'login-rejected' ? 403 : 502, { error: e.code, message: e.message });
    } else if (e instanceof RegistError) {
      const status = e.code === 'invalid-input' || e.code === 'unsupported-target' ? 400 : e.code === 'rejected' ? 403 : 502;
      json(res, status, { error: e.code, message: e.message, ...(e.reason !== undefined ? { reason: e.reason } : {}) });
    } else {
      log(`api error: ${(e as Error).message}`);
      json(res, 500, { error: 'internal', message: (e as Error).message === 'too large' || (e as Error).message === 'not JSON' ? (e as Error).message : 'internal error' });
    }
  }
  return true;
}

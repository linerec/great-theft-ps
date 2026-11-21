// SPDX-License-Identifier: AGPL-3.0-only
//
// The small JSON API the page uses to find and register consoles. Registration keys stay on this side: no response
// ever contains them, the PIN or the account id.
//
//   GET    /api/consoles          registered consoles (public fields) and whether an account id is saved
//   GET    /api/discover[?host=]  consoles answering on the network, each marked registered or not
//   POST   /api/register          { host, pin, accountId?, target? }  registers and stores the result
//   DELETE /api/consoles/<mac>    forgets a registration on this computer (the console keeps its own list)
//
// Same rules as the WebSocket: loopback Host, same-origin Origin when the browser sends one, and the token when one is
// configured (Authorization: Bearer). POST needs Content-Type: application/json, so a plain cross-site form cannot post.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { discover as realDiscover, type DiscoveredHost } from '../console/discovery.ts';
import { parseAccountId, register as realRegister, RegistError, type RegisterOptions, type RegisteredConsole } from '../console/regist.ts';
import { isKnownTarget } from '../console/rpcrypt.ts';
import type { ConsoleStore } from '../console/store.ts';

export interface ApiOptions {
  store: ConsoleStore;
  token?: string;
  /** Replaced by tests. */
  discover?: (opts: { hosts?: string[]; timeoutMs?: number }) => Promise<{ hosts: DiscoveredHost[] }>;
  register?: (opts: RegisterOptions) => Promise<RegisteredConsole>;
  log?: (line: string) => void;
}

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
    } else if (req.method === 'DELETE' && url.pathname.startsWith('/api/consoles/')) {
      const mac = decodeURIComponent(url.pathname.slice('/api/consoles/'.length));
      const removed = store.remove(mac);
      json(res, removed ? 200 : 404, { ok: removed });
    } else {
      json(res, 404, { error: 'unknown endpoint' });
    }
  } catch (e) {
    if (e instanceof RegistError) {
      const status = e.code === 'invalid-input' || e.code === 'unsupported-target' ? 400 : e.code === 'rejected' ? 403 : 502;
      json(res, status, { error: e.code, message: e.message, ...(e.reason !== undefined ? { reason: e.reason } : {}) });
    } else {
      log(`api error: ${(e as Error).message}`);
      json(res, 500, { error: 'internal', message: (e as Error).message === 'too large' || (e as Error).message === 'not JSON' ? (e as Error).message : 'internal error' });
    }
  }
  return true;
}

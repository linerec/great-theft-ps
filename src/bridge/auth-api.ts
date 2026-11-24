// SPDX-License-Identifier: AGPL-3.0-only
//
// Logging in to a bridge that is reachable from the internet: the part of /api/ that is about people (accounts.ts).
// This project's own.
//
//   GET  /api/me                 who is logged in: { user, accounts: true, needsSetup }, or 401 { login: true } when nobody is.
//                                Without accounts: { accounts: false } (nothing to log in to).
//   POST /api/login              { name, password }  → sets the session cookie, answers { user }
//   POST /api/logout             ends the session
//   POST /api/invite-info        { code }  → { name }: whom an invitation is for (the page asks for a new password then)
//   POST /api/accept-invite      { code, password }  → sets the password, logs in
//   GET  /api/users              (owner) everybody, with minutes per day and played today
//   POST /api/users/invite       (owner) { name, minutes? }  → { code }: invites a new member, or gives a member a new password
//   POST /api/users/minutes      (owner) { name, minutes }  minutes per day, null = no limit
//   POST /api/users/disable      (owner) { name, disabled }
//   POST /api/users/remove       (owner) { name }
//
// The session lives in an HttpOnly, SameSite=Strict cookie (Secure when the page came over HTTPS), so a script on the
// page cannot read it and another site cannot use it. Wrong logins are slowed down per address and per name.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { AccountError, type AccountStore, type PublicUser, SESSION_DAYS } from './accounts.ts';
import { json, readBody } from './http-util.ts';

export const COOKIE = 'gtp_session';

/** Failed logins slow the next one down: a handful are free, then the wait doubles up to half an hour. */
export class Throttle {
  #fails = new Map<string, { count: number; until: number; last: number }>();
  #now: () => number;
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  /** Milliseconds to wait before this key may try again (0 = go ahead). */
  wait(key: string): number {
    const f = this.#fails.get(key);
    return f ? Math.max(0, f.until - this.#now()) : 0;
  }
  fail(key: string): void {
    const now = this.#now();
    const f = this.#fails.get(key) ?? { count: 0, until: 0, last: now };
    if (now - f.last > 3600_000) f.count = 0; // an old streak is forgotten
    f.count++;
    f.last = now;
    if (f.count > 5) f.until = now + Math.min(30 * 60_000, 15_000 * 2 ** (f.count - 6));
    this.#fails.set(key, f);
    if (this.#fails.size > 5000) for (const [k, v] of this.#fails) if (now - v.last > 3600_000) this.#fails.delete(k);
  }
  ok(key: string): void {
    this.#fails.delete(key);
  }
}

const throttles = new WeakMap<AccountStore, Throttle>();
const throttleOf = (a: AccountStore): Throttle => {
  let t = throttles.get(a);
  if (!t) throttles.set(a, (t = new Throttle()));
  return t;
};

const isLoopback = (a: string | undefined): boolean => !!a && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1');

/** The address a request really came from: behind a proxy on this computer that is what the proxy says, otherwise the socket's. */
export function clientAddress(req: IncomingMessage): string {
  const socket = req.socket.remoteAddress;
  if (isLoopback(socket)) {
    const real = String(req.headers['x-real-ip'] ?? '').trim();
    if (real) return real;
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim();
    if (forwarded) return forwarded;
  }
  return socket ?? 'unknown';
}

/** Did the page come over HTTPS (directly, or through a proxy on this computer that said so)? */
export function isSecure(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return isLoopback(req.socket.remoteAddress) && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
}

export function sessionOf(req: { headers: IncomingMessage['headers'] }): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export const userOf = (req: { headers: IncomingMessage['headers'] }, accounts: AccountStore): PublicUser | null => accounts.userFor(sessionOf(req));

function setCookie(req: IncomingMessage, value: string, maxAgeSeconds: number): string {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${isSecure(req) ? '; Secure' : ''}`;
}

function jsonWithCookie(res: ServerResponse, status: number, body: unknown, cookie: string): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Set-Cookie': cookie, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** What the owner's controls need to be refused to anyone else. */
export const OWNER_ONLY: ReadonlyArray<{ method: string; test: (path: string) => boolean }> = [
  { method: 'POST', test: (p) => p === '/api/register' || p === '/api/session-check' || p.startsWith('/api/psn/') || p === '/api/stream/tuning' },
  { method: 'DELETE', test: (p) => p.startsWith('/api/consoles/') },
];
export const isOwnerOnly = (method: string | undefined, pathname: string): boolean => pathname.startsWith('/api/users') || OWNER_ONLY.some((o) => o.method === method && o.test(pathname));

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Answers the /api/ requests that are about people. Returns true when it did. */
export async function handleAuthApi(req: IncomingMessage, res: ServerResponse, url: URL, accounts: AccountStore): Promise<boolean> {
  const p = url.pathname;
  const user = userOf(req, accounts);

  if (req.method === 'GET' && p === '/api/me') {
    if (!user) return json(res, 401, { login: true, accounts: true, needsSetup: accounts.empty }), true;
    return json(res, 200, { accounts: true, user, timeZone: accounts.timeZone, remainingSeconds: accounts.remainingSeconds(user.name) }), true;
  }

  if (req.method === 'POST' && p === '/api/login') {
    const body = (await readBody(req).catch(() => ({}))) as { name?: unknown; password?: unknown };
    const name = str(body.name, 40);
    const throttle = throttleOf(accounts);
    const keys = [`ip:${clientAddress(req)}`, `name:${name.toLowerCase()}`];
    const wait = Math.max(...keys.map((k) => throttle.wait(k)));
    if (wait > 0) return json(res, 429, { error: 'slow-down', retryAfterSeconds: Math.ceil(wait / 1000) }), true;
    const ok = await accounts.login(name, str(body.password));
    if (!ok) {
      for (const k of keys) throttle.fail(k);
      return json(res, 401, { error: 'bad-login' }), true;
    }
    for (const k of keys) throttle.ok(k);
    jsonWithCookie(res, 200, { user: ok.user }, setCookie(req, ok.session, SESSION_DAYS * 86400));
    return true;
  }

  if (req.method === 'POST' && p === '/api/logout') {
    accounts.logout(sessionOf(req));
    jsonWithCookie(res, 200, { ok: true }, setCookie(req, '', 0));
    return true;
  }

  if (req.method === 'POST' && (p === '/api/invite-info' || p === '/api/accept-invite')) {
    const body = (await readBody(req).catch(() => ({}))) as { code?: unknown; password?: unknown };
    const throttle = throttleOf(accounts);
    const key = `invite:${clientAddress(req)}`;
    if (throttle.wait(key) > 0) return json(res, 429, { error: 'slow-down', retryAfterSeconds: Math.ceil(throttle.wait(key) / 1000) }), true;
    const code = str(body.code, 100);
    if (p === '/api/invite-info') {
      const name = accounts.inviteFor(code);
      if (!name) throttle.fail(key);
      return name ? json(res, 200, { name }) : json(res, 404, { error: 'bad-invite' }), true;
    }
    try {
      const ok = await accounts.acceptInvite(code, str(body.password));
      throttle.ok(key);
      jsonWithCookie(res, 200, { user: ok.user }, setCookie(req, ok.session, SESSION_DAYS * 86400));
    } catch (e) {
      if (!(e instanceof AccountError)) throw e;
      if (e.code === 'bad-invite') throttle.fail(key);
      json(res, e.code === 'bad-invite' ? 404 : 400, { error: e.code, message: e.message });
    }
    return true;
  }

  if (p.startsWith('/api/users')) {
    if (!user) return json(res, 401, { error: 'unauthorized', login: true }), true;
    if (user.role !== 'owner') return json(res, 403, { error: 'owner-only' }), true;
    if (req.method === 'GET' && p === '/api/users') return json(res, 200, { users: accounts.list(), timeZone: accounts.timeZone }), true;
    if (req.method !== 'POST') return json(res, 405, { error: 'method' }), true;
    const body = (await readBody(req).catch(() => ({}))) as { name?: unknown; minutes?: unknown; disabled?: unknown };
    const name = str(body.name, 40);
    const minutes = body.minutes === null ? null : typeof body.minutes === 'number' ? body.minutes : undefined;
    try {
      if (p === '/api/users/invite') {
        const target = accounts.get(name);
        if (target?.role === 'owner' && target.name.toLowerCase() !== user.name.toLowerCase()) return json(res, 403, { error: 'owner-only' }), true;
        const made = accounts.invite(name, minutes !== undefined ? { role: target?.role ?? 'member', dailyMinutes: minutes } : { role: target?.role ?? 'member' });
        return json(res, 200, { code: made.code, expiresAt: made.expiresAt, user: accounts.get(name) }), true;
      }
      if (p === '/api/users/minutes') return json(res, 200, { user: accounts.setMinutes(name, minutes === undefined ? null : minutes) }), true;
      if (p === '/api/users/disable') {
        if (name.toLowerCase() === user.name.toLowerCase()) return json(res, 400, { error: 'self', message: 'you cannot switch yourself off' }), true;
        return json(res, 200, { user: accounts.setDisabled(name, body.disabled === true) }), true;
      }
      if (p === '/api/users/remove') {
        if (name.toLowerCase() === user.name.toLowerCase()) return json(res, 400, { error: 'self', message: 'you cannot remove yourself' }), true;
        accounts.remove(name);
        return json(res, 200, { ok: true }), true;
      }
    } catch (e) {
      if (!(e instanceof AccountError)) throw e;
      return json(res, e.code === 'unknown' ? 404 : 400, { error: e.code, message: e.message }), true;
    }
    return json(res, 404, { error: 'unknown endpoint' }), true;
  }

  return false;
}

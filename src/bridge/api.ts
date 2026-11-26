// SPDX-License-Identifier: AGPL-3.0-only
//
// The small JSON API the page uses to find and register consoles. Registration keys stay on this side: no response
// ever contains them, the PIN or the account id.
//
//   GET    /api/consoles          registered consoles (public fields), for each the PSN accounts it is registered for
//                                 (`profiles`) and the one the person asking plays as (`profile`), and whether an
//                                 account id is saved (with its last digits)
//   POST   /api/consoles/profile  { mac, profile, user? }  which PSN account a person plays as on that console: one's own,
//                                 or (owner) somebody else's
//   POST   /api/consoles/profile-label  { mac, profile, label }  (owner) what an account is called here
//   DELETE /api/consoles/<mac>[?profile=]  (owner) forget a console, or only its registration for one account
//   GET    /api/discover[?host=]  consoles answering on the network, each marked registered or not
//   POST   /api/register          { host, pin, accountId?, target?, label? }  registers and stores the result. A console
//                                 is registered once per PSN account: another account is added next to the first
//   GET    /api/network           this computer's LAN addresses (the page uses them to tell which kind of route it is on)
//   POST   /api/session-check     { mac, host?, profile? }  asks the console for a session with the stored registration; answers ok
//                                 or the console's reason. Proves the registration works. Never returns keys or the nonce.
//   POST   /api/wake              { mac }  sends the wake-up datagram to a console in rest mode (it does not wait; connecting
//                                 does: the link wakes a console that is in rest mode before it asks for a session)
//   GET    /api/version           what is running: the commit, its subject and when it started
//   GET    /api/busy              (this computer only) whether a stream is running, for the updater
//   GET    /api/handover          whether this client hands the console over to this project's other clients, and its name
//   GET    /api/stream/stats      measurements of the running or last stream (totals, one sample per second, events)
//   GET    /api/stream/tuning     the settings that can be changed to study the stream
//   POST   /api/stream/tuning     { enableIdrOnFecFailure?, packetLossMax?, congestionIntervalMs?, heartbeatIntervalMs? }  for the next connection
//   GET    /api/psn/login-url     Sony's login page address (opened by the user in their own browser)
//   POST   /api/psn/account-id    { redirectUrl, acknowledge: true }  gets the PSN account id and saves it here. The answer
//                                 holds only its last four digits; tokens are never kept, logged or returned.
//   DELETE /api/consoles/<mac>    forgets a registration on this computer (the console keeps its own list)
//   GET    /api/study/ratings     the asker's own scores from the mouse-feel study (?user=all: everybody's, for the owner)
//   POST   /api/study/ratings     { ratings: [...] }  keeps the ones that pass the check and have not been kept before
//   DELETE /api/study/ratings/<id>  takes back one of the asker's own scores
//
// Same rules as the WebSocket: loopback Host, same-origin Origin when the browser sends one, and the token when one is
// configured (Authorization: Bearer). POST needs Content-Type: application/json, so a plain cross-site form cannot post.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { credentialFromStoredKey, discover as realDiscover, wakeup, type DiscoveredHost } from '../console/discovery.ts';
import { parseAccountId, register as realRegister, RegistError, type RegisterOptions, type RegisteredConsole } from '../console/regist.ts';
import { extractLoginCode, fetchAccountId, PSN_LOGIN_URL, PsnAccountError } from '../console/psn-account.ts';
import { isKnownTarget, isPs5Target } from '../console/rpcrypt.ts';
import { requestSession, SessionError, type SessionRequestOptions } from '../console/session.ts';
import os from 'node:os';
import type { Handover } from './handover.ts';
import type { StreamResearch } from './ps5-link.ts';
import { handleAuthApi, isOwnerOnly, userOf } from './auth-api.ts';
import type { AccountStore } from './accounts.ts';
import { json, readBody } from './http-util.ts';
import { parseRating } from '../engine/feel-study.ts';
import type { StudyStore } from './study-store.ts';
import { originAllowed } from './static.ts';
import { accountHint, profileIdOf, type ConsoleStore } from '../console/store.ts';

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
  /** Sends the wake-up datagram to a console in rest mode. Replaced by tests. */
  wake?: (host: string, credential: bigint, ps5: boolean) => Promise<void>;
  /** Measurements and settings of the stream, for studying its delivery. Without it the /api/stream/ endpoints answer 404. */
  research?: StreamResearch;
  /** Host names the bridge is reached under through a local proxy (see BridgeOptions.trustedHosts). */
  trustedHosts?: string[];
  /** What is running (commit, its subject, when it started). */
  version?: { commit: string; subject: string; startedAt: string };
  /** People who log in (accounts.ts). When set, every request needs a login (or the token), and members may not change what the owner owns. */
  accounts?: AccountStore;
  /** Handing the console over between this project's clients. Without it /api/handover says it is off. */
  handover?: Handover;
  /** Where the scores of the mouse-feel study are kept. Without it /api/study/ answers 404. */
  study?: StudyStore;
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
/** A wake-up datagram is not sent again for the same console within this time: a held-down button is not a stream of them. */
const WAKE_MIN_GAP_MS = 3000;
/** When each console was last sent a wake-up datagram, kept per console store so that two bridges in one process do not share it. */
const wakeTimes = new WeakMap<object, Map<string, number>>();

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

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

  if (!originAllowed(req.headers.origin, req.headers.host, opts.trustedHosts ?? [])) return json(res, 403, { error: 'forbidden' }), true;
  if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    return json(res, 415, { error: 'send application/json' }), true;
  }
  // For the program that keeps this one up to date (tools/supervise.mjs): is a stream running? Only when asked on a loopback name from this computer.
  if (req.method === 'GET' && url.pathname === '/api/busy' && /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(String(req.headers.host ?? '')) && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? '')) {
    return json(res, 200, { busy: opts.research ? opts.research.state === 'streaming' || opts.research.state === 'connecting' : false }), true;
  }
  const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
  const tokenOk = opts.token !== undefined && timingSafeEqual(sha(bearer), sha(opts.token));
  let who: ReturnType<typeof userOf> = null;
  if (opts.accounts) {
    // People log in: who is asking decides what they may do. The token (when there is one) is the owner's, for tools.
    if (await handleAuthApi(req, res, url, opts.accounts)) return true;
    who = userOf(req, opts.accounts);
    if (!who && !tokenOk) return json(res, 401, { error: 'unauthorized', login: true }), true;
    if (who && who.role !== 'owner' && !tokenOk && isOwnerOnly(req.method, url.pathname)) return json(res, 403, { error: 'owner-only' }), true;
  } else {
    if (opts.token !== undefined && !tokenOk) return json(res, 401, { error: 'unauthorized' }), true;
    if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { accounts: false }), true;
  }

  if (req.method === 'GET' && url.pathname === '/api/version') return json(res, 200, opts.version ?? { commit: '', subject: '', startedAt: '' }), true;

  const store = opts.store;
  const discover = opts.discover ?? realDiscover;
  const register = opts.register ?? realRegister;
  // Who is asking, for what is a person's own (the PSN account they play as, their scores). Without logins there is one
  // person ("local"); the token of a tool is the owner's.
  const me = opts.accounts ? (who?.name ?? 'owner') : 'local';
  const isOwner = !opts.accounts || who?.role === 'owner' || (!who && tokenOk);
  const withProfiles = <T extends { mac: string }>(c: T): T & { profiles: ReturnType<ConsoleStore['profiles']>; profile: string | undefined } => ({ ...c, profiles: store.profiles(c.mac), profile: store.chosen(me, c.mac) });
  const profileOf = (v: unknown): string | undefined | null => (v === undefined ? undefined : typeof v === 'string' && /^[0-9a-z]{1,16}$/.test(v) ? v : null);

  try {
    if (req.method === 'GET' && url.pathname === '/api/consoles') {
      json(res, 200, { consoles: store.list().map(withProfiles), accountIdSaved: store.accountId !== undefined, accountHint: accountHint(store.accountId), owner: isOwner });
    } else if (req.method === 'POST' && url.pathname === '/api/consoles/profile') {
      // Which PSN account somebody plays as. Anyone sets their own; the owner also sets it for the others.
      const body = (await readBody(req)) as { mac?: unknown; profile?: unknown; user?: unknown };
      const profile = profileOf(body.profile);
      if (typeof body.mac !== 'string' || !profile) return json(res, 400, { error: 'invalid-input', message: 'mac and profile are needed' }), true;
      let person = me;
      if (body.user !== undefined && body.user !== me) {
        if (!isOwner) return json(res, 403, { error: 'owner-only' }), true;
        if (typeof body.user !== 'string' || !opts.accounts?.get(body.user)) return json(res, 404, { error: 'unknown-user', message: 'Nobody with that name' }), true;
        person = body.user;
      }
      if (!store.choose(person, body.mac, profile)) return json(res, 404, { error: 'not-registered', message: 'That console is not registered for that account on this computer' }), true;
      log(`${person} now plays as another PSN account`); // never which one
      json(res, 200, { ok: true, user: person, profile });
    } else if (req.method === 'POST' && url.pathname === '/api/consoles/profile-label') {
      if (!isOwner) return json(res, 403, { error: 'owner-only' }), true;
      const body = (await readBody(req)) as { mac?: unknown; profile?: unknown; label?: unknown };
      const profile = profileOf(body.profile);
      if (typeof body.mac !== 'string' || !profile || typeof body.label !== 'string') return json(res, 400, { error: 'invalid-input', message: 'mac, profile and label are needed' }), true;
      if (!store.setLabel(body.mac, profile, body.label)) return json(res, 404, { error: 'not-registered', message: 'That console is not registered for that account on this computer' }), true;
      json(res, 200, { ok: true, profiles: store.profiles(body.mac) });
    } else if (req.method === 'GET' && url.pathname === '/api/discover') {
      const host = url.searchParams.get('host') ?? undefined;
      if (host !== undefined && !isIp(host)) return json(res, 400, { error: 'host must be an IP address' }), true;
      const result = await discover({ ...(host ? { hosts: [host] } : {}), timeoutMs: 2500 });
      const registered = new Set(store.list().map((c) => c.mac));
      json(res, 200, { hosts: result.hosts.map((h) => publicHost(h, registered)) });
    } else if (req.method === 'POST' && url.pathname === '/api/register') {
      const body = (await readBody(req)) as { host?: unknown; pin?: unknown; accountId?: unknown; target?: unknown; label?: unknown };
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
      const account = Buffer.from(parseAccountId(accountText)).toString('base64');
      store.setAccountId(account);
      // Kept for this account: it replaces an earlier registration of the same account and leaves those of other accounts.
      const saved = store.put(result, body.host, { accountId: account, ...(typeof body.label === 'string' ? { label: body.label } : {}) });
      json(res, 200, { console: withProfiles(saved), registered: profileIdOf(account) });
    } else if (req.method === 'GET' && url.pathname === '/api/handover') {
      // Whether this client takes part in handing the console over, and under which name the others see it.
      const h = opts.handover?.status();
      json(res, 200, h ? { enabled: true, listening: h.listening, port: h.port, name: h.name, holding: h.holding } : { enabled: false });
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
      const body = (await readBody(req)) as { mac?: unknown; host?: unknown; profile?: unknown };
      if (typeof body.mac !== 'string') return json(res, 400, { error: 'invalid-input', message: 'mac is missing' }), true;
      const asked = profileOf(body.profile);
      if (asked === null) return json(res, 400, { error: 'invalid-input', message: 'profile is not valid' }), true;
      // Without a profile: the account the person asking plays as.
      const rec = asked ? store.get(body.mac, asked) : store.getFor(body.mac, me);
      if (!rec) return json(res, 404, { error: 'not-registered', message: 'That console is not registered on this computer' }), true;
      if (body.host !== undefined && (typeof body.host !== 'string' || !isIp(body.host))) return json(res, 400, { error: 'invalid-input', message: 'host must be an IP address' }), true;
      const host = typeof body.host === 'string' ? body.host : rec.host;
      log(`checking the registration of ${rec.nickname || rec.mac} at ${host}`);
      await (opts.session ?? requestSession)({ host, target: rec.target, registKey: Buffer.from(rec.registKey, 'hex'), rpKey: Buffer.from(rec.rpKey, 'hex'), log });
      store.markVerified(rec.mac, host, profileIdOf(rec.accountId));
      const checked = store.list().find((c) => c.mac === rec.mac);
      json(res, 200, { ok: true, console: checked ? withProfiles(checked) : undefined, profile: profileIdOf(rec.accountId) });
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
      json(res, 200, { accountIdSaved: true, hint: accountHint(accountId) });
    } else if (req.method === 'POST' && url.pathname === '/api/wake') {
      // Wake a console in rest mode: one UDP datagram with the credential made from the stored registration key. It
      // does not wait for the console (connecting does that); GET /api/discover?host= shows when it says "ready".
      const body = (await readBody(req)) as { mac?: unknown };
      if (typeof body.mac !== 'string') return json(res, 400, { error: 'invalid-input', message: 'mac is missing' }), true;
      const rec = store.getFor(body.mac, me);
      if (!rec) return json(res, 404, { error: 'not-registered', message: 'That console is not registered on this computer' }), true;
      let credential: bigint;
      try {
        credential = credentialFromStoredKey(rec.registKey);
      } catch {
        return json(res, 409, { error: 'key-unusable', message: 'The stored registration cannot be used to wake the console. Register it again.' }), true;
      }
      const now = Date.now();
      const lastWake = wakeTimes.get(store) ?? new Map<string, number>();
      wakeTimes.set(store, lastWake);
      if (now - (lastWake.get(rec.mac) ?? 0) < WAKE_MIN_GAP_MS) return json(res, 429, { error: 'too-soon', message: 'Wait a few seconds before waking it again' }), true;
      lastWake.set(rec.mac, now);
      log(`waking ${rec.nickname || rec.mac} at ${rec.host}`);
      await (opts.wake ?? ((host, c, ps5) => wakeup(host, c, ps5)))(rec.host, credential, isPs5Target(rec.target));
      json(res, 200, { ok: true, sent: true });
    } else if (url.pathname.startsWith('/api/study/')) {
      const study = opts.study;
      if (!study) return json(res, 404, { error: 'unknown endpoint' }), true;
      // Scores are a person's own (see `me` above).
      if (req.method === 'GET' && url.pathname === '/api/study/ratings') {
        const wanted = url.searchParams.get('user');
        if (wanted === 'all' || (wanted !== null && wanted !== me)) {
          if (!isOwner) return json(res, 403, { error: 'owner-only' }), true;
          const items = wanted === 'all' ? study.list() : study.list(wanted);
          return json(res, 200, { ratings: items.map((s) => ({ ...s.rating, user: s.user })) }), true;
        }
        json(res, 200, { ratings: study.list(me).map((s) => s.rating) });
      } else if (req.method === 'POST' && url.pathname === '/api/study/ratings') {
        const body = (await readBody(req, 64 * 1024)) as { ratings?: unknown };
        if (!Array.isArray(body.ratings) || body.ratings.length === 0 || body.ratings.length > 40) return json(res, 400, { error: 'invalid-input', message: 'send { ratings: [1 to 40 scores] }' }), true;
        let stored = 0;
        let duplicates = 0;
        let full = 0;
        const rejected: Array<{ id: string | null; error: string }> = [];
        for (const raw of body.ratings) {
          const parsed = parseRating(raw);
          if (!parsed.ok) {
            rejected.push({ id: typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id.slice(0, 64) : null, error: parsed.error });
            continue;
          }
          const result = study.add(me, parsed.rating);
          if (result === 'stored') stored++;
          else if (result === 'duplicate') duplicates++;
          else full++;
        }
        json(res, 200, { stored, duplicates, full, rejected });
      } else if (req.method === 'DELETE' && url.pathname.startsWith('/api/study/ratings/')) {
        const removed = study.remove(me, decodeURIComponent(url.pathname.slice('/api/study/ratings/'.length)));
        json(res, removed ? 200 : 404, { ok: removed });
      } else {
        json(res, 404, { error: 'unknown endpoint' });
      }
    } else if (req.method === 'DELETE' && url.pathname.startsWith('/api/consoles/')) {
      const mac = decodeURIComponent(url.pathname.slice('/api/consoles/'.length));
      const only = profileOf(url.searchParams.get('profile') ?? undefined);
      if (only === null) return json(res, 400, { error: 'invalid-input', message: 'profile is not valid' }), true;
      const removed = store.remove(mac, only);
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

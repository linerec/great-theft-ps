// SPDX-License-Identifier: AGPL-3.0-only
//
// People who may use a bridge that is reachable from the internet: logins, the time each may play per day, and the
// sessions they get when they log in. This project's own.
//
//  - Two roles. The owner has no limit and manages the others; a member has a number of minutes per day (or none: no limit).
//  - Nobody's password is ever typed to whoever sets this up: the owner (and later each member) is invited with a
//    one-time code, and sets the password in the page. Passwords are kept only as scrypt hashes.
//  - A login gives a random session value that is kept only as a hash on this side. It lives for 30 days from the last
//    use and ends when the person logs out, is disabled or gets a new password.
//  - Play time is counted per person per calendar day in one time zone (so "per day" means the family's day, not UTC's),
//    from when the stream starts until it ends, and kept in a file so a restart does not give the day back.
//
// Everything is kept in one directory (`GTP_HOME`, next to the console registrations) as three small files that only
// this user can read. No external library: node:crypto does the hashing.

import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Role = 'owner' | 'member';

export interface UserRecord {
  name: string;
  role: Role;
  /** Minutes per day; null = no limit. */
  dailyMinutes: number | null;
  /** "scrypt$N$r$p$salt$hash" (base64), or null until the invited person has set a password. */
  password: string | null;
  disabled: boolean;
  createdAt: string;
}

export interface PublicUser {
  name: string;
  role: Role;
  dailyMinutes: number | null;
  disabled: boolean;
  /** Has set a password (false while an invitation is still open). */
  active: boolean;
  usedSecondsToday: number;
}

interface Invite {
  /** sha256 of the code, hex. */
  hash: string;
  name: string;
  expiresAt: number;
}

interface SessionRecord {
  /** sha256 of the session value, hex. */
  hash: string;
  name: string;
  expiresAt: number;
}

interface UsageFile {
  [day: string]: { [name: string]: number };
}

export interface AccountOptions {
  dir: string;
  /** IANA time zone that decides where a day ends. Default America/New_York. */
  timeZone?: string;
  now?: () => number;
}

export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;
const INVITE_MS = 48 * 3600 * 1000;
export const MIN_PASSWORD = 8;
const NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const sameHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, key) => (e ? reject(e) : resolve(key))));
}

export async function hashPassword(password: string, params = { n: 16384, r: 8, p: 1 }): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, params.n, params.r, params.p);
  return `scrypt$${params.n}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p)).catch(() => null);
  return key !== null && key.length === expected.length && timingSafeEqual(key, expected);
}

/** What kind of change a person asked for failed, in a word the page can show. */
export class AccountError extends Error {
  code: 'bad-name' | 'bad-password' | 'exists' | 'unknown' | 'bad-invite' | 'bad-minutes' | 'last-owner';
  constructor(code: AccountError['code'], message: string) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

export interface LoginOk {
  session: string;
  user: PublicUser;
}

export class AccountStore {
  readonly dir: string;
  readonly timeZone: string;
  #now: () => number;
  #users: UserRecord[] = [];
  #invites: Invite[] = [];
  #sessions: SessionRecord[] = [];
  #usage: UsageFile = {};
  #dayFormat: Intl.DateTimeFormat;
  /** A password hash that nobody has the password for, checked when the name is unknown so that both cases take the same time. */
  #dummy: Promise<string>;

  constructor(opts: AccountOptions) {
    this.dir = opts.dir;
    this.timeZone = opts.timeZone ?? 'America/New_York';
    this.#now = opts.now ?? Date.now;
    this.#dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.#users = this.#load<UserRecord[]>('accounts.json', []);
    this.#invites = this.#load<Invite[]>('invites.json', []);
    this.#sessions = this.#load<SessionRecord[]>('sessions.json', []);
    this.#usage = this.#load<UsageFile>('usage.json', {});
    this.#dummy = hashPassword(randomBytes(16).toString('hex'));
  }

  #load<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  #save(file: string, data: unknown): void {
    const target = path.join(this.dir, file);
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temp, target);
    try {
      chmodSync(target, 0o600);
    } catch {
      /* not every file system has modes */
    }
  }

  /** The calendar day (YYYY-MM-DD) in this store's time zone. */
  dayOf(ms = this.#now()): string {
    return this.#dayFormat.format(new Date(ms));
  }

  /** True before anyone has been set up: the first thing to do is to invite the owner. */
  get empty(): boolean {
    return this.#users.length === 0;
  }

  #user(name: string): UserRecord | undefined {
    const lower = name.toLowerCase();
    return this.#users.find((u) => u.name.toLowerCase() === lower);
  }

  #public(u: UserRecord): PublicUser {
    return { name: u.name, role: u.role, dailyMinutes: u.dailyMinutes, disabled: u.disabled, active: u.password !== null, usedSecondsToday: this.usedSeconds(u.name) };
  }

  list(): PublicUser[] {
    return this.#users.map((u) => this.#public(u));
  }

  get(name: string): PublicUser | null {
    const u = this.#user(name);
    return u ? this.#public(u) : null;
  }

  // ---------------------------------------------------------------- inviting and passwords

  #checkMinutes(minutes: number | null): void {
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60)) throw new AccountError('bad-minutes', 'minutes per day must be a whole number from 0 to 1440, or none');
  }

  /**
   * Make room for a person and return the one-time code that lets them set their password. The same call for the
   * owner and for members, and again for someone who lost their password (it ends their sessions).
   */
  invite(name: string, o: { role?: Role; dailyMinutes?: number | null } = {}): { code: string; expiresAt: number } {
    if (!NAME_RE.test(name)) throw new AccountError('bad-name', 'a name is 1 to 24 letters, digits, - or _');
    const existing = this.#user(name);
    const role = o.role ?? existing?.role ?? 'member';
    const minutes = o.dailyMinutes !== undefined ? o.dailyMinutes : role === 'owner' ? null : (existing?.dailyMinutes ?? 120);
    this.#checkMinutes(minutes);
    if (existing) {
      existing.password = null;
      if (o.role) existing.role = o.role;
      if (o.dailyMinutes !== undefined) existing.dailyMinutes = o.dailyMinutes;
      this.#sessions = this.#sessions.filter((s) => s.name !== existing.name);
      this.#save('sessions.json', this.#sessions);
    } else {
      this.#users.push({ name, role, dailyMinutes: role === 'owner' ? null : minutes, password: null, disabled: false, createdAt: new Date(this.#now()).toISOString() });
    }
    this.#save('accounts.json', this.#users);
    const code = randomBytes(18).toString('base64url');
    const name2 = (this.#user(name) as UserRecord).name;
    this.#invites = this.#invites.filter((i) => i.name !== name2 && i.expiresAt > this.#now());
    const expiresAt = this.#now() + INVITE_MS;
    this.#invites.push({ hash: sha(code), name: name2, expiresAt });
    this.#save('invites.json', this.#invites);
    return { code, expiresAt };
  }

  /** Which name a code is for, if it is still good. For showing "set a password for <name>". */
  inviteFor(code: string): string | null {
    const h = sha(code);
    const found = this.#invites.find((i) => sameHex(i.hash, h) && i.expiresAt > this.#now());
    return found ? found.name : null;
  }

  async acceptInvite(code: string, password: string): Promise<LoginOk> {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) throw new AccountError('bad-password', `a password is at least ${MIN_PASSWORD} characters`);
    const name = this.inviteFor(code);
    const user = name ? this.#user(name) : undefined;
    if (!name || !user) throw new AccountError('bad-invite', 'this invitation is not valid any more');
    user.password = await hashPassword(password);
    this.#invites = this.#invites.filter((i) => !sameHex(i.hash, sha(code)));
    this.#save('accounts.json', this.#users);
    this.#save('invites.json', this.#invites);
    return { session: this.#newSession(user.name), user: this.#public(user) };
  }

  // ---------------------------------------------------------------- logging in

  /** The person, when name and password are right. Null otherwise; a wrong name and a wrong password look the same. */
  async login(name: string, password: string): Promise<LoginOk | null> {
    const user = typeof name === 'string' ? this.#user(name) : undefined;
    const stored = user?.password ?? (await this.#dummy);
    const ok = typeof password === 'string' && password.length <= 200 && (await verifyPassword(password, stored));
    if (!user || !user.password || user.disabled || !ok) return null;
    return { session: this.#newSession(user.name), user: this.#public(user) };
  }

  #newSession(name: string): string {
    const value = randomBytes(32).toString('base64url');
    const now = this.#now();
    this.#sessions = this.#sessions.filter((s) => s.expiresAt > now);
    this.#sessions.push({ hash: sha(value), name, expiresAt: now + SESSION_MS });
    this.#save('sessions.json', this.#sessions);
    return value;
  }

  /** Who a session value belongs to (and renews it). Null when unknown, ended, or the person is disabled. */
  userFor(session: string | undefined): PublicUser | null {
    if (!session) return null;
    const h = sha(session);
    const now = this.#now();
    const found = this.#sessions.find((s) => sameHex(s.hash, h) && s.expiresAt > now);
    if (!found) return null;
    const user = this.#user(found.name);
    if (!user || user.disabled || user.password === null) return null;
    // Renew at most once an hour, so that using it does not rewrite a file every time.
    if (found.expiresAt - now < SESSION_MS - 3600_000) {
      found.expiresAt = now + SESSION_MS;
      this.#save('sessions.json', this.#sessions);
    }
    return this.#public(user);
  }

  logout(session: string | undefined): void {
    if (!session) return;
    const h = sha(session);
    const before = this.#sessions.length;
    this.#sessions = this.#sessions.filter((s) => !sameHex(s.hash, h));
    if (this.#sessions.length !== before) this.#save('sessions.json', this.#sessions);
  }

  // ---------------------------------------------------------------- the owner's controls

  setMinutes(name: string, minutes: number | null): PublicUser {
    this.#checkMinutes(minutes);
    const u = this.#user(name);
    if (!u) throw new AccountError('unknown', 'no such person');
    u.dailyMinutes = u.role === 'owner' ? null : minutes;
    this.#save('accounts.json', this.#users);
    return this.#public(u);
  }

  setDisabled(name: string, disabled: boolean): PublicUser {
    const u = this.#user(name);
    if (!u) throw new AccountError('unknown', 'no such person');
    if (disabled && u.role === 'owner' && this.#users.filter((x) => x.role === 'owner' && !x.disabled).length <= 1) throw new AccountError('last-owner', 'the only owner cannot be switched off');
    u.disabled = disabled;
    if (disabled) {
      this.#sessions = this.#sessions.filter((s) => s.name !== u.name);
      this.#save('sessions.json', this.#sessions);
    }
    this.#save('accounts.json', this.#users);
    return this.#public(u);
  }

  remove(name: string): void {
    const u = this.#user(name);
    if (!u) throw new AccountError('unknown', 'no such person');
    if (u.role === 'owner' && this.#users.filter((x) => x.role === 'owner').length <= 1) throw new AccountError('last-owner', 'the only owner cannot be removed');
    this.#users = this.#users.filter((x) => x !== u);
    this.#sessions = this.#sessions.filter((s) => s.name !== u.name);
    this.#invites = this.#invites.filter((i) => i.name !== u.name);
    this.#save('accounts.json', this.#users);
    this.#save('sessions.json', this.#sessions);
    this.#save('invites.json', this.#invites);
  }

  // ---------------------------------------------------------------- play time

  usedSeconds(name: string, day = this.dayOf()): number {
    const key = this.#user(name)?.name ?? name;
    return Math.round(this.#usage[day]?.[key] ?? 0);
  }

  /** Seconds left today: null = no limit. Never below 0. */
  remainingSeconds(name: string): number | null {
    const u = this.#user(name);
    if (!u || u.dailyMinutes === null) return null;
    return Math.max(0, u.dailyMinutes * 60 - this.usedSeconds(u.name));
  }

  /** Add played seconds to today. Old days (more than 40 back) are dropped so the file stays small. */
  addUsage(name: string, seconds: number): void {
    if (!(seconds > 0)) return;
    const u = this.#user(name);
    if (!u) return;
    const day = this.dayOf();
    const today = (this.#usage[day] ??= {});
    today[u.name] = (today[u.name] ?? 0) + seconds;
    const cutoff = this.dayOf(this.#now() - 40 * 24 * 3600 * 1000);
    for (const d of Object.keys(this.#usage)) if (d < cutoff) delete this.#usage[d];
    this.#save('usage.json', this.#usage);
  }

  /** For the command line: has anything been set up in this directory? */
  static exists(dir: string): boolean {
    return existsSync(path.join(dir, 'accounts.json'));
  }
}
